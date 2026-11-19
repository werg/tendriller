import { activeAdapter, connection } from './assistant-admission';
import { assistantInbox, changeAssistantSubscription } from './assistant-events';
import { assistantOnline, callAssistantAdapter } from './assistant-socket';
import { APP_NAME, REQUEST_LIMIT, eventDefinition, requireScope, string, type Principal } from './assistant-shared';
import { HttpError, json, readJson } from './http';
import { requireWritesOpen } from './service-state';
import { withSelectedAssistantGeneration } from './peer-generations';
import { sha256Hex } from './ids';
import type { Tendril } from './tendril';

export async function assistantRequest(t: Tendril, req: Request): Promise<Response> {
  const { principal, applicationId, method, params } = await readJson<{
    principal: Principal; applicationId: string; method: string; params: Record<string, unknown>;
  }>(req, REQUEST_LIMIT + 2048);
  const approved = connection(t);
  if (!approved || !activeAdapter(t) || approved.applicationId !== applicationId || approved.owner !== principal.account ||
    principal.expires <= Date.now()) throw new HttpError(404, 'application_not_connected');
  const check = () => {
    if (connection(t)?.version !== approved.version || !activeAdapter(t) || principal.expires <= Date.now())
      throw new HttpError(403, 'connection_changed');
  };
  if (method === 'describe_application') {
    requireScope(principal, 'applications:read');
    return json({ value: { applicationId, pageId: t.tid, label: approved.label, online: assistantOnline(t, approved.id),
      queries: approved.queries, commands: approved.commands, events: approved.events.map(event => eventDefinition(applicationId, event)),
      eventDelivery: { webhook: true, catchUpTool: 'read_application_events' } } });
  }
  if (method === 'read_application_events') {
    requireScope(principal, 'applications:read');
    return json({ value: await assistantInbox(t, approved, params) });
  }
  if (method === 'events/subscribe' || method === 'events/unsubscribe')
    return json({ value: await t.serializeAssistant(() => changeAssistantSubscription(t, approved, principal, method, params, req.signal)) });

  const isCommand = method === 'call_application_command';
  if (!isCommand && method !== 'query_application') throw new HttpError(404, 'method_not_found');
  requireScope(principal, isCommand ? 'applications:write' : 'applications:read');
  const kind = isCommand ? 'command' : 'query';
  const name = string(params[kind], 80, APP_NAME);
  if (!(isCommand ? approved.commands : approved.queries).some(item => item.name === name)) throw new HttpError(403, 'operation_not_approved');

  // A request author cannot collide with an original local operation ID.
  const clientOperationId = isCommand ? string(params.operationId, 200, /^[A-Za-z0-9_.:-]+$/u) : null;
  if (isCommand) await requireWritesOpen(t.env);
  const operationId = clientOperationId && 'assistant_' + await sha256Hex(JSON.stringify([applicationId, principal.account, clientOperationId]));
  const { generation, pending } = await withSelectedAssistantGeneration(t, generation => {
    check();
    if (!generation) throw new HttpError(409, 'application_generation_missing');
    return { generation, pending: callAssistantAdapter(t, { applicationId, generation, kind, name, input: params.input,
      ...(operationId ? { operationId, ...(params.basedOn !== undefined ? { basedOn: params.basedOn } : {}) } : {}) }, req.signal) };
  });
  const value = await pending;
  return withSelectedAssistantGeneration(t, selected => {
    check();
    if (generation !== selected) throw new HttpError(409, 'application_generation_changed');
    return json({ value: isCommand ? { operationId: clientOperationId, operation: value } : value });
  });
}
