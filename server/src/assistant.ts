import { connection } from './assistant-admission';
import { makeActivityTicket } from './assistant-activity';
import { assistantDeliveryStatus, assistantInbox, changeAssistantSubscription, revokeAssistantConsumer } from './assistant-events';
import { onlineAssistantAdapters, callAssistantAdapter } from './assistant-socket';
import { MCP_APPLICATION_EVENT, REQUEST_LIMIT, assistantOAuth, requireScope, string, type Principal } from './assistant-shared';
import { callerContext, CONSUMER_KEY, consumerCurrent, registerConsumer, requireConsumerOperation, resolveConsumer, selectedProvider } from './assistant-bindings';
import { HttpError, isPlainObject, json, readJson } from './http';
import { requireWritesOpen } from './service-state';
import { withAssistantAuthority } from './authority';
import { activeGrant } from './accounts/oauth-data';
import { sha256Hex } from './ids';
import { publicBase } from './urls';
import type { Tendril } from './tendril';
import { assistantObservation } from '../../contract/assistant.mjs';
import { parseApplicationInput, type ApplicationInputSchema } from '@chronolog/authority';

type OperationContext = {
  operation_id: string; binding_id: string; client_operation_id: string; provider_binding_id: string;
  command: string; context: string; reference: string | null; device_id: string; input_hash: string;
};
const operationQuery = `SELECT c.*,j.device_id,j.input_hash FROM assistant_operation_context c
  JOIN assistant_commands j ON j.operation_id=c.operation_id WHERE c.binding_id=? AND c.client_operation_id=?`;
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
const operationMethods: Record<string, string> = {
  inspect_application_operation: 'inspect', retry_application_operation: 'retry', wait_application_operation: 'wait',
};

/** OAuth authenticates the host; the proof binding identifies an independently revocable consuming agent. */
export async function assistantRequest(t: Tendril, req: Request): Promise<Response> {
  const { principal, applicationId, method, params } = await readJson<{
    principal: Principal; applicationId: string; method: string; params: Record<string, unknown>;
  }>(req, REQUEST_LIMIT + 2048);
  const approved = connection(t);
  if (!approved || t.db.get('disabled', false) || approved.applicationId !== applicationId || approved.owner !== principal.account ||
    principal.expires <= Date.now()) throw new HttpError(404, 'application_not_connected');
  const checkConnection = () => {
    if (connection(t)?.version !== approved.version || t.db.get('disabled', false) || principal.expires <= Date.now())
      throw new HttpError(403, 'connection_changed');
  };
  const checkGrant = async (scope: string) => {
    requireScope(principal, scope);
    const oauth = await assistantOAuth(t.env);
    const grant = oauth && await activeGrant(t.env, oauth, principal.grant, principal.account);
    if (!grant?.scope.split(' ').includes(scope) || grant.client_id !== principal.client)
      throw new HttpError(403, 'authorization_revoked');
    checkConnection();
  };
  if (method === 'register_application_agent') {
    await checkGrant('applications:read');
    await requireWritesOpen(t.env);
    const value = await t.serializeAssistant(async () => {
      checkConnection();
      const registration = await registerConsumer(t, approved, principal, params);
      checkConnection();
      return registration;
    });
    return json({ value: { ...value, reviewUrl: publicBase(t.env) + '/connections/' + t.tid,
      nextAction: 'The owner reviews this exact agent and its requested capabilities. Retain the binding token privately.' } });
  }
  const consumer = await resolveConsumer(t, approved, principal);
  principal.consumer = consumer;
  const check = () => {
    checkConnection();
    if (!consumerCurrent(t, consumer)) throw new HttpError(403, 'agent_binding_revoked');
  };
  check();
  if (method === 'revoke_application_agent') {
    await checkGrant('applications:read'); check();
    if (consumer.verification !== 'approved-binding') throw new HttpError(400, 'agent_binding_proof_required');
    t.transaction(() => revokeAssistantConsumer(t, consumer.id));
    return json({ value: { agentBindingId: consumer.id, status: 'revoked' } });
  }
  if (method === 'rotate_application_agent') {
    await checkGrant('applications:read'); await requireWritesOpen(t.env);
    const token = string(params.nextBindingToken, 120), next = CONSUMER_KEY.exec(token);
    if (consumer.verification !== 'approved-binding' || next?.[1] !== consumer.id) throw new HttpError(400, 'agent_binding_identity_mismatch');
    const hash = await sha256Hex(token); check();
    t.db.run('UPDATE assistant_consumers SET credential_hash=?,revision=revision+1 WHERE id=?', hash, consumer.id);
    return json({ value: { agentBindingId: consumer.id, revision: consumer.revision + 1, status: 'active' } });
  }
  if (method === 'describe_application') {
    await checkGrant('applications:read'); check();
    const online = await onlineAssistantAdapters(t), provider = selectedProvider(t), active = online.find(item => item.hash === provider?.adapterHash);
    return json({ value: { applicationId, pageId: t.tid, label: approved.label, online: online.length > 0, onlineParticipants: online.length,
      caller: consumer, provider: provider && { ...provider, online: !!active, deviceId: active?.deviceId ?? null, connectionEpoch: active?.connectionEpoch ?? null },
      queries: approved.queries.filter(item => consumer.queries.includes(item.name)),
      commands: approved.commands.filter(item => consumer.commands.includes(item.name)), events: approved.events.filter(item => consumer.events.includes(item.name)),
      operationTools: ['inspect_application_operation', 'retry_application_operation', 'wait_application_operation'],
      eventDelivery: { webhook: MCP_APPLICATION_EVENT, catchUpTool: 'read_application_events', liveInboxTool: 'open_application_inbox',
        evidence: 'approved-exporter-assertion', retentionEvents: 256, cursorVersion: 1, conversationalWake: 'not-established' } } });
  }
  if (method === 'open_application_inbox') {
    await checkGrant('applications:read');
    const metadata = await makeActivityTicket(t, principal, approved.inboxVersion); check();
    return json({ value: { applicationId, label: approved.label, pageId: t.tid, agentBindingId: consumer.id }, metadata });
  }
  if (method === 'get_application_delivery') {
    await checkGrant('events:subscribe'); check();
    return json({ value: assistantDeliveryStatus(t, principal) });
  }
  if (method === 'read_application_events') {
    await checkGrant('applications:read'); check();
    return json({ value: await assistantInbox(t, approved, params, consumer) });
  }
  if (method === 'events/subscribe' || method === 'events/unsubscribe') {
    await checkGrant('events:subscribe');
    if (method === 'events/subscribe') await requireWritesOpen(t.env);
    return json({ value: await changeAssistantSubscription(t, approved, principal, method, params, req.signal) });
  }

  const journalKind = operationMethods[method];
  const isCommand = method === 'call_application_command';
  if (!isCommand && !journalKind && method !== 'query_application') throw new HttpError(404, 'method_not_found');
  const writes = isCommand || journalKind === 'retry', scope = writes ? 'applications:write' : 'applications:read';
  await checkGrant(scope); check();
  const clientOperationId = isCommand || journalKind ? string(params.operationId, 200, /^[A-Za-z0-9_.:-]+$/u) : null;
  let existing = clientOperationId ? t.db.one<OperationContext>(operationQuery, consumer.id, clientOperationId) : null;
  if (journalKind && !existing) {
    throw new HttpError(404, 'operation_not_admitted', 'No admitted operation belongs to this binding and operation ID.');
  }
  if (journalKind === 'wait' && params.fact !== undefined && !['materialized', 'retained', 'finalized'].includes(String(params.fact))) throw new HttpError(400, 'invalid_arguments');
  const kind = journalKind ?? (isCommand ? 'command' : 'query');
  const name = journalKind ? existing!.command : string(params[isCommand ? 'command' : 'query'], 128);
  if (!journalKind || journalKind === 'retry') {
    const operation = (writes ? approved.commands : approved.queries).find(item => item.name === name);
    if (!operation) throw new HttpError(403, 'operation_not_approved');
    requireConsumerOperation(consumer, writes ? 'commands' : 'queries', name);
    if (!journalKind) {
      try { parseApplicationInput(operation.input as ApplicationInputSchema, params.input); }
      catch { throw new HttpError(400, 'invalid_application_input', 'Input does not match the approved application operation schema.'); }
    }
  }
  const operationId = existing?.operation_id ??
    (clientOperationId && 'assistant_' + await sha256Hex(JSON.stringify([applicationId, consumer.id, clientOperationId])));
  const context = callerContext(params.context);
  const inputHash = isCommand ? await sha256Hex(canonical([name, params.input, params.basedOn ?? null, context])) : null;
  if (existing && isCommand && existing.input_hash !== inputHash)
    throw new HttpError(409, 'operation_id_conflict', 'This operation ID already identifies different signed work.');
  const deadline = AbortSignal.any([req.signal, AbortSignal.timeout(7000)]), excluded = new Set<string>();
  let selectedDevice = '', providerBinding = '', value: unknown, uncertain: string | null = null;
  let readTimeout: HttpError | undefined;
  const reference = () => ({ applicationId, deviceId: selectedDevice || existing?.device_id, requestOperationId: operationId,
    ...(existing?.reference ? JSON.parse(existing.reference) : {}), agentBindingId: consumer.id,
    providerBindingId: providerBinding || existing?.provider_binding_id,
    ...(existing ? { sourceContext: JSON.parse(existing.context) } : {}) });
  for (;;) {
    const admitted = await withAssistantAuthority(t, async canUseDevice => {
      if (writes) await requireWritesOpen(t.env);
      check(); deadline.throwIfAborted();
      const online = (await onlineAssistantAdapters(t)).filter(candidate => !excluded.has(candidate.hash));
      const candidates = [];
      for (const candidate of online) if (await canUseDevice(candidate.deviceId, writes)) candidates.push(candidate);
      await checkGrant(scope); check(); deadline.throwIfAborted();
      // Reread under the authority serializer: concurrent calls using
      // one semantic ID must select the same signer and immutable digest.
      existing = clientOperationId ? t.db.one<OperationContext>(operationQuery, consumer.id, clientOperationId) : null;
      if (existing && existing.operation_id !== operationId) throw new HttpError(409, 'operation_id_conflict');
      if (existing && isCommand && existing.input_hash !== inputHash) throw new HttpError(409, 'operation_id_conflict');
      const provider = selectedProvider(t);
      const adapter = existing ? candidates.find(candidate => candidate.deviceId === existing!.device_id && candidate.bindingId === existing!.provider_binding_id)
        : writes ? candidates.find(candidate => candidate.hash === provider?.adapterHash) : candidates[0];
      if (!adapter) {
        if (existing) {
          selectedDevice = existing.device_id; providerBinding = existing.provider_binding_id;
          return { adapter: null, pending: null };
        }
        // Admission above rechecks the grant and connection. Exhausting read
        // fallbacks must not turn a connected participant's timeout into offline.
        if (readTimeout) throw readTimeout;
        throw new HttpError(503, writes ? 'provider_offline' : 'application_participant_offline',
          writes ? 'Start the selected provider or have the owner explicitly hand over new work. Existing operations keep their original signer.'
            : 'Start an enrolled application participant.');
      }
      selectedDevice = adapter.deviceId; providerBinding = adapter.bindingId;
      if (operationId && !existing) {
        if ((t.db.one<{ n: number }>('SELECT COUNT(*) AS n FROM assistant_commands')?.n ?? 0) >= 4096)
          throw new HttpError(429, 'application_operation_capacity');
        t.transaction(() => {
          t.db.run('INSERT INTO assistant_commands(operation_id,input_hash,device_id) VALUES(?,?,?)', operationId, inputHash, adapter.deviceId);
          t.db.run(`INSERT INTO assistant_operation_context(operation_id,binding_id,client_operation_id,provider_binding_id,command,context,created_at)
            VALUES(?,?,?,?,?,?,?)`, operationId, consumer.id, clientOperationId, adapter.bindingId, name,
            JSON.stringify({ evidence: 'caller-asserted', ...context }), t.now());
        });
        existing = t.db.one<OperationContext>(operationQuery, consumer.id, clientOperationId!);
      }
      return { adapter, pending: callAssistantAdapter(t, adapter.socket, {
        applicationId, kind, name, input: params.input,
        ...(kind === 'wait' ? { fact: params.fact ?? 'materialized' } : {}),
        providerBindingId: adapter.bindingId, connectionEpoch: adapter.connectionEpoch,
        caller: { account: principal.account, agentBindingId: consumer.id, bindingRevision: consumer.revision,
          verification: consumer.verification, context: existing ? JSON.parse(existing.context) : { evidence: 'caller-asserted', ...context } },
        ...(operationId ? { operationId, ...(params.basedOn !== undefined ? { basedOn: params.basedOn } : {}) } : {}),
      }, deadline, consumer.id) };
    });
    if (!admitted.pending) { uncertain = 'provider_offline'; break; }
    try { value = await admitted.pending; break; }
    catch (error) {
      if (journalKind === 'wait' && error instanceof HttpError && error.extra?.providerCode === 'FINALITY_UNSUPPORTED')
        throw new HttpError(400, 'finality_unsupported', 'This application has no configured finality; local storage and materialization remain available.');
      if (operationId) { uncertain = error instanceof HttpError ? error.code : 'operation_uncertain'; break; }
      if (!(error instanceof HttpError) || !['application_participant_offline', 'application_call_timed_out'].includes(error.code) || deadline.aborted) throw error;
      if (error.code === 'application_call_timed_out') readTimeout = error;
      excluded.add(admitted.adapter!.hash);
    }
  }
  return withAssistantAuthority(t, async canUseDevice => {
    await checkGrant(scope); check();
    if (!await canUseDevice(selectedDevice, false)) throw new HttpError(403, 'adapter_device_not_enrolled');
    if (!operationId) { check(); return json({ value }); }
    const state = isPlainObject(value) && isPlainObject(value.state) ? value.state : isPlainObject(value) ? value : null;
    const nativeReference = isPlainObject(value) && isPlainObject(value.operationReference) ? value.operationReference : null;
    if (nativeReference && (nativeReference.applicationId !== applicationId || nativeReference.deviceId !== selectedDevice || typeof nativeReference.operationId !== 'string' || !nativeReference.operationId || nativeReference.operationId.length > 512))
      throw new HttpError(502, 'invalid_adapter_operation_reference');
    if (state && (!nativeReference || !isPlainObject(value) || value.requestOperationId !== operationId || state.operationId !== nativeReference.operationId || state.author !== selectedDevice || state.applicationId !== applicationId))
      throw new HttpError(502, 'invalid_adapter_operation_reference');
    if (state?.proposalId !== undefined) {
      const proposalId = string(state.proposalId, 64, /^[a-f0-9]{64}$/u);
      if (!nativeReference || nativeReference.proposalId !== proposalId)
        throw new HttpError(502, 'invalid_adapter_operation_reference');
      try {
        if (state.materialized !== null && (!isPlainObject(state.materialized) || state.materialized.proposalId !== proposalId)) throw Error();
        assistantObservation({stored:state.stored,materialized:isPlainObject(state.materialized)?{outcome:state.materialized.outcome,revision:state.materialized.revision}:null,
          retained:state.retained,finalized:state.finalized,excluded:state.excluded});
      } catch { throw new HttpError(502,'invalid_adapter_operation_observation'); }
      const prior = existing?.reference ? JSON.parse(existing.reference) : null;
      if (prior?.proposalId && (prior.proposalId !== proposalId || prior.operationId !== state.operationId)) throw new HttpError(502, 'adapter_proposal_identity_changed');
      t.db.run('UPDATE assistant_operation_context SET reference=? WHERE operation_id=?', JSON.stringify({ proposalId, operationId: state.operationId }), operationId);
      existing = t.db.one<OperationContext>(operationQuery, consumer.id, clientOperationId!);
    }
    check();
    return json({ value: { operationId: clientOperationId, operationReference: reference(),
      stored: state?.stored === true, materialized: state?.materialized ?? null, retained: state?.retained ?? [],
      finalized: state?.finalized === true, excluded: state?.excluded === true,
      operation: value ?? null, evidence: 'approved-provider-assertion',
      ...(uncertain ? { code: 'operation_uncertain', reason: uncertain,
        nextAction: 'Inspect this original operation; retry only with the same ID, original provider and exact inputs.' } : {}) } });
  });
}
