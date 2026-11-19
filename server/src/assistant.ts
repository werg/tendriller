import { connection } from './assistant-admission';
import { makeActivityTicket } from './assistant-activity';
import { assistantDeliveryStatus, assistantInbox, changeAssistantSubscription } from './assistant-events';
import { onlineAssistantAdapters, callAssistantAdapter } from './assistant-socket';
import { MCP_APPLICATION_EVENT, REQUEST_LIMIT, assistantOAuth, requireScope, string, type Principal } from './assistant-shared';
import { HttpError, json, readJson } from './http';
import { requireWritesOpen } from './service-state';
import { withSelectedAssistantGeneration } from './peer-generations';
import { activeGrant } from './accounts/oauth-data';
import { sha256Hex } from './ids';
import type { Tendril } from './tendril';

export async function assistantRequest(t: Tendril, req: Request): Promise<Response> {
  const { principal, applicationId, method, params } = await readJson<{
    principal: Principal; applicationId: string; method: string; params: Record<string, unknown>;
  }>(req, REQUEST_LIMIT + 2048);
  const approved = connection(t);
  if (!approved || t.db.get('disabled', false) || approved.applicationId !== applicationId || approved.owner !== principal.account ||
    principal.expires <= Date.now()) throw new HttpError(404, 'application_not_connected');
  const check = () => {
    if (connection(t)?.version !== approved.version || t.db.get('disabled', false) || principal.expires <= Date.now())
      throw new HttpError(403, 'connection_changed');
  };
  if (method === 'describe_application') {
    requireScope(principal, 'applications:read');
    const onlineParticipants = onlineAssistantAdapters(t).length;
    return json({ value: { applicationId, pageId: t.tid, label: approved.label, online: onlineParticipants > 0, onlineParticipants,
      queries: approved.queries, commands: approved.commands, events: approved.events,
      eventDelivery: { webhook: MCP_APPLICATION_EVENT, catchUpTool: 'read_application_events', liveInboxTool: 'open_application_inbox' } } });
  }
  if (method === 'open_application_inbox') {
    requireScope(principal, 'applications:read');
    const metadata = await makeActivityTicket(t, principal, approved.inboxVersion);
    check();
    return json({ value: { applicationId, label: approved.label, pageId: t.tid }, metadata });
  }
  if (method === 'get_application_delivery') {
    requireScope(principal, 'events:subscribe');
    return json({ value: assistantDeliveryStatus(t, principal) });
  }
  if (method === 'read_application_events') {
    requireScope(principal, 'applications:read');
    return json({ value: await assistantInbox(t, approved, params) });
  }
  if (method === 'events/subscribe' || method === 'events/unsubscribe') {
    // Revocation remains available during read-only service operation.
    if (method === 'events/subscribe') await requireWritesOpen(t.env);
    return json({ value: await t.serializeAssistant(() => changeAssistantSubscription(t, approved, principal, method, params, req.signal)) });
  }

  const isCommand = method === 'call_application_command';
  if (!isCommand && method !== 'query_application') throw new HttpError(404, 'method_not_found');
  requireScope(principal, isCommand ? 'applications:write' : 'applications:read');
  const kind = isCommand ? 'command' : 'query';
  const name = string(params[kind], 128);
  if (!(isCommand ? approved.commands : approved.queries).some(item => item.name === name)) throw new HttpError(403, 'operation_not_approved');

  // A request author cannot collide with an original local operation ID.
  const clientOperationId = isCommand ? string(params.operationId, 200, /^[A-Za-z0-9_.:-]+$/u) : null;
  const operationId = clientOperationId && 'assistant_' + await sha256Hex(JSON.stringify([applicationId, principal.account, clientOperationId]));
  const inputHash = operationId && await sha256Hex(JSON.stringify([name, params.input, params.basedOn ?? null], (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value));
  const checkGrant = async () => {
    const oauth = await assistantOAuth(t.env);
    const grant = oauth && await activeGrant(t.env, oauth, principal.grant, principal.account);
    if (!grant?.scope.split(' ').includes(isCommand ? 'applications:write' : 'applications:read'))
      throw new HttpError(403, 'authorization_revoked');
  };

  const excluded = new Set<string>();
  const deadline = AbortSignal.any([req.signal, AbortSignal.timeout(7000)]);
  let response;
  for (;;) {
    const { generation, adapter, pending } = await withSelectedAssistantGeneration(t, async (generation, canUseDevice) => {
      if (!generation) throw new HttpError(409, 'application_generation_missing');
      if (isCommand) await requireWritesOpen(t.env);
      check();
      deadline.throwIfAborted();
      const online = onlineAssistantAdapters(t).filter(candidate => !excluded.has(candidate.hash));
      const candidates = [];
      for (const candidate of online) {
        if (await canUseDevice(candidate.deviceId, isCommand)) candidates.push(candidate);
      }
      check();
      await checkGrant();
      check();
      deadline.throwIfAborted();
      const existing = operationId && t.db.one<{ input_hash: string; device_id: string }>(
        'SELECT input_hash,device_id FROM assistant_commands WHERE operation_id=?', operationId);
      if (existing && existing.input_hash !== inputHash)
        throw new HttpError(409, 'operation_id_conflict', 'This operation ID already identifies a different command or input.');
      const adapter = existing ? candidates.find(candidate => candidate.deviceId === existing.device_id) : candidates[0];
      if (!adapter) throw existing
        ? new HttpError(503, 'application_operation_unresolved', 'Resume the original participant and retry the same operation ID. Its outcome may already be committed.')
        : new HttpError(503, 'application_participant_offline', 'Start an enrolled application participant, then try again.');
      if (operationId && !existing) {
        if ((t.db.one<{ rowid: number }>('SELECT rowid FROM assistant_commands ORDER BY rowid DESC LIMIT 1')?.rowid ?? 0) >= 4096)
          throw new HttpError(429, 'application_operation_capacity', 'This page reached its retained assistant command limit.');
        t.db.run('INSERT INTO assistant_commands(operation_id,input_hash,device_id) VALUES(?,?,?)', operationId, inputHash, adapter.deviceId);
      }
      return { generation, adapter, pending: callAssistantAdapter(t, adapter.socket, {
        applicationId, generation, kind, name, input: params.input,
        ...(operationId ? { operationId, ...(params.basedOn !== undefined ? { basedOn: params.basedOn } : {}) } : {}),
      }, deadline) };
    });
    try {
      response = { generation, value: await pending };
      break;
    } catch (error) {
      if (operationId || !(error instanceof HttpError) ||
        !['application_participant_offline', 'application_call_timed_out'].includes(error.code) || deadline.aborted) throw error;
      excluded.add(adapter.hash);
    }
  }
  const { generation, value } = response;
  await checkGrant();
  return withSelectedAssistantGeneration(t, selected => {
    check();
    if (generation !== selected) throw new HttpError(409, 'application_generation_changed');
    return json({ value: isCommand ? { operationId: clientOperationId, operation: value } : value });
  });
}
