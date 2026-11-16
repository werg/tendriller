import type { WorkflowHost, WorkflowModule, WorkflowIdentity, ValidatedContext, Preconditions } from '../../contract/host.d.mts';
import type { Tendril } from './tendril';
import { assertValid, validateSchema } from '../../contract/index.mjs';
import type { Principal } from './access';
import { HttpError, json, readJson } from './http';
import { checkGenerations, mutate, preconditions, registerScope, rotateScope, scope, scopes } from './scopes';
import { addEvent } from './events';
import { validateOps } from './state';
import { BLOB_ID_RE } from './ids';
import { RESOURCE_LIMITS } from '../../contract/limits.mjs';

let modules: ReadonlyMap<string, WorkflowModule> = new Map();
/** Called only by the trusted deployment entry point. Page data is never consulted. */
export function configureWorkflows(selected: readonly WorkflowModule[]): void {
  const next = new Map<string, WorkflowModule>();
  for (const module of selected) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(module.id) || next.has(module.id)) throw new Error('Invalid or duplicate workflow module');
    for (const field of ['interfaceVersion', 'schemaVersion', 'implementationVersion'] as const)
      if (typeof module[field] !== 'string' || !module[field] || module[field].length > 200) throw new Error(`Invalid workflow ${field}`);
    const operations: Record<string, WorkflowModule['operations'][string]> = Object.create(null);
    for (const [name, operation] of Object.entries(module.operations)) {
      if (!/^[a-zA-Z][a-zA-Z0-9]{0,79}$/.test(name)) throw new Error('Invalid workflow operation');
      if (!['controller', 'owner', 'participant'].includes(operation.access) || typeof operation.mutate !== 'boolean' || typeof operation.run !== 'function')
        throw new TypeError('Workflow operations require an access policy, mutation flag and implementation');
      if (operation.run.constructor.name === 'AsyncFunction') throw new TypeError('Workflow operations must be synchronous');
      operations[name] = Object.freeze({ ...operation, ...(operation.schema ? { schema: structuredClone(operation.schema) } : {}) });
    }
    next.set(module.id, Object.freeze({ ...module, operations: Object.freeze(operations) }));
  }
  modules = next;
}
export function workflowDescriptors() {
  return [...modules.values()].map(module => ({ id: module.id, interface_version: module.interfaceVersion, schema_version: module.schemaVersion, implementation_version: module.implementationVersion,
    operations: Object.fromEntries(Object.entries(module.operations).map(([name, op]) => [name, { access: op.access, mutate: op.mutate, ...(op.schema ? { schema: op.schema } : {}), ...(op.description ? { description: op.description } : {}) }])) }));
}
function identity(principal: Principal): WorkflowIdentity {
  if (principal.kind === 'producer') throw new HttpError(403, 'forbidden', 'Producer credentials cannot invoke workflows');
  return { kind: principal.kind, actor: `${principal.kind}:${principal.name}`, accountId: principal.kind === 'page' ? principal.accountId : null, role: principal.kind === 'page' ? principal.role : null };
}
function allowed(who: WorkflowIdentity, permission: 'controller' | 'owner' | 'participant'): boolean {
  if (permission === 'controller') return who.kind === 'agent' || who.role === 'owner';
  if (permission === 'owner') return who.kind === 'page' && who.role === 'owner' && !!who.accountId;
  return who.kind === 'page' && who.role !== 'display' && !!who.accountId;
}
function keyPart(value: string): string {
  if (!/^[A-Za-z0-9_.:@-]{1,200}$/.test(value)) throw new HttpError(400, 'bad_record_key', 'Invalid workflow record key');
  return value;
}
function host(t: Tendril, module: WorkflowModule, who: WorkflowIdentity, command: Preconditions, context: ValidatedContext, writable: boolean, alive: () => void): WorkflowHost {
  const write = () => { alive(); if (!writable) throw new Error('Read-only workflow operations cannot write'); };
  const owner = module.id;
  const owned = (id: string) => {
    const row = t.db.one<{ owner: string | null }>('SELECT owner FROM scopes WHERE id=?', id);
    if (row && row.owner !== owner) throw new HttpError(403, 'scope_owner', 'The workflow does not own this scope');
  };
  const pin = (value: unknown): void => {
    if (typeof value === 'string' && BLOB_ID_RE.test(value)) t.db.run('UPDATE blobs SET pinned=1 WHERE id=?', value);
    else if (Array.isArray(value)) value.forEach(pin);
    else if (value && typeof value === 'object') Object.values(value).forEach(pin);
  };
  const records: WorkflowHost['records'] = {
    get: <T>(collection: string, key: string) => {
      alive();
      const row = t.db.one<{ value: string }>('SELECT value FROM workflow_records WHERE module=? AND collection=? AND key=?', owner, keyPart(collection), keyPart(key));
      return row ? JSON.parse(row.value) as T : null;
    },
    list: <T>(collection: string) => { alive(); return t.db.all<{ key: string; value: string }>('SELECT key,value FROM workflow_records WHERE module=? AND collection=? ORDER BY key', owner, keyPart(collection)).map(row => ({ key: row.key, value: JSON.parse(row.value) as T })); },
    put: (collection, key, value) => {
      write(); keyPart(collection); keyPart(key);
      const serialized = JSON.stringify(value);
      if (typeof serialized !== 'string') throw new HttpError(400, 'bad_record', 'Workflow records must contain JSON data');
      const bytes = new TextEncoder().encode(serialized).byteLength;
      if (bytes > RESOURCE_LIMITS.private_record_bytes) throw new HttpError(413, 'too_large', 'Private record exceeds its byte allowance');
      const previous = t.db.one<{ bytes: number }>('SELECT length(CAST(value AS BLOB)) AS bytes FROM workflow_records WHERE module=? AND collection=? AND key=?', owner, collection, key);
      const usage = t.db.one<{ count: number; bytes: number }>('SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(value AS BLOB))),0) AS bytes FROM workflow_records')!;
      if (usage.count + (previous ? 0 : 1) > RESOURCE_LIMITS.private_records || usage.bytes - (previous?.bytes ?? 0) + bytes > RESOURCE_LIMITS.private_records_bytes)
        throw new HttpError(429, 'resource_quota', 'This page has reached its private-record allowance', { resource: 'private_records', count: usage.count, bytes: usage.bytes });
      t.db.run('INSERT INTO workflow_records(module,collection,key,value) VALUES(?,?,?,?) ON CONFLICT(module,collection,key) DO UPDATE SET value=excluded.value', owner, collection, key, serialized);
    },
    delete: (collection, key) => { write(); t.db.run('DELETE FROM workflow_records WHERE module=? AND collection=? AND key=?', owner, keyPart(collection), keyPart(key)); },
    clear: collection => { write(); t.db.run('DELETE FROM workflow_records WHERE module=? AND collection=?', owner, keyPart(collection)); },
  };
  return {
    identity: Object.freeze({ ...who }), context: Object.freeze({ ...context, generations: Object.freeze({ ...context.generations }), workflow: owner }), now: () => { alive(); return t.now(); }, id: () => { alive(); return crypto.randomUUID(); },
    fail: (status, code, message): never => { alive(); throw new HttpError(status, code, message); }, records,
    state: { get: () => { alive(); return structuredClone(t.getState()); }, apply: (ops, checks = {}) => { write(); return t.applyState(validateOps(ops), `workflow:${owner}`, undefined, { ...checks, ...command, scope: command.scope }); } },
    scopes: {
      get: id => { alive(); owned(id); return scope(t, id); },
      register: (id, bindings, expected) => { write(); if (!id.startsWith(owner + ':')) throw new HttpError(400, 'bad_scope', 'Module scope IDs must start with the module namespace'); owned(id); return registerScope(t, id, bindings, owner, expected); },
      rotate: id => { write(); owned(id); checkGenerations(t, command, { scopes: [id] }); return rotateScope(t, id, owner); },
      retire: id => { write(); owned(id); checkGenerations(t, command, { scopes: [id] }); rotateScope(t, id, owner, true); },
    },
    participants: () => {
      alive();
      const account = t.db.get<string | null>('owner_account', null);
      const guests = t.db.all<{ account_id: string }>("SELECT DISTINCT g.account_id FROM guest_accounts g JOIN links l ON l.id=g.link_id WHERE g.approved=1 AND l.role='guest' AND (l.expires_at IS NULL OR l.expires_at>?) ORDER BY g.account_id", t.now());
      return [...(account ? [{ id: account, role: 'owner' as const }] : []), ...guests.filter(row => row.account_id !== account).map(row => ({ id: row.account_id, role: 'guest' as const }))];
    },
    pinBlobs: value => { write(); pin(value); },
    emit: (data, options = {}) => { write(); addEvent(t, { type: 'event', data, context: { ...context, workflow: owner }, by: `workflow:${owner}`, role: who.role, wake: !!options.wake, cls: who.role === 'owner' ? 'owner' : 'page' }); },
    notify: (topic, audience = 'owner') => { write(); t.broadcast({ t: 'workflow', module: owner, topic }, device => !device.pending && (audience === 'participants' ? device.role !== 'display' : device.role === 'owner')); },
    afterCommit: effect => { write(); t.afterCommit(effect); },
  };
}
function reconcileModule(t: Tendril, module: WorkflowModule): void {
  const version = `${module.interfaceVersion}/${module.schemaVersion}/${module.implementationVersion}`;
  const key = `workflow-version:${module.id}`;
  if (t.db.get<string | null>(key, null) === version) return;
  t.transaction(() => {
    // A newly composed implementation has a new meaning even if its state paths
    // stayed the same. Rotate outside the request transaction so rejection does
    // not undo the replacement boundary.
    for (const row of t.db.all<{ id: string }>('SELECT id FROM scopes WHERE owner=? AND retired=0', module.id)) rotateScope(t, row.id, module.id);
    t.db.set(key, version);
  });
}
/** Reconcile trusted composition changes independently of any app payload. */
export function synchronizeWorkflows(t: Tendril): void {
  for (const module of modules.values()) reconcileModule(t, module);
  const removed = t.db.all<{ id: string; owner: string }>('SELECT id,owner FROM scopes WHERE retired=0 AND owner IS NOT NULL').filter(row => !modules.has(row.owner));
  if (removed.length) t.transaction(() => { for (const entry of removed) rotateScope(t, entry.id, entry.owner, true); });
}
export async function handleWorkflows(t: Tendril, req: Request, rest: string, principal: Principal): Promise<Response> {
  if (rest === 'workflows' && req.method === 'GET') return json({ workflows: workflowDescriptors() });
  const match = /^workflows\/([a-z][a-z0-9-]{0,63})\/([a-zA-Z][a-zA-Z0-9]{0,79})$/.exec(rest);
  if (!match || req.method !== 'POST') throw new HttpError(404, 'not_found', 'Unknown workflow operation');
  const module = modules.get(match[1]);
  const operation = module?.operations[match[2]];
  if (!module || !operation) throw new HttpError(404, 'workflow_unavailable', 'This workflow operation is not installed');
  const who = identity(principal);
  if (!allowed(who, operation.access)) throw new HttpError(403, 'forbidden', 'This identity cannot invoke the workflow operation');
  const body = assertValid("command", await readJson(req, 1024 * 1024));
  const command = preconditions(body);
  reconcileModule(t, module);
  const data = body.data ?? null;
  const issues = operation.schema ? validateSchema(operation.schema, data) : [];
  if (issues.length) throw new HttpError(400, "bad_request", "Invalid workflow data", { details: issues });
  const targets = { operations: [`workflow:${module.id}:${match[2]}`], scopes: operation.scopes?.(data) ?? [] };
  const invoke = (context: ValidatedContext, writable: boolean) => {
    let active = true;
    const alive = () => { if (!active) throw new Error('Workflow host capabilities expire when the operation returns'); };
    const capability = host(t, module, who, command, { ...context, operation: match[2] }, writable, alive);
    try {
      const result = operation.run(capability, data);
      if (result && typeof (result as any).then === 'function') {
        void Promise.resolve(result).catch(() => {});
        throw new TypeError('Workflow operations must return synchronously');
      }
      return result;
    } finally { active = false; }
  };
  const result = operation.mutate
    ? mutate(t, who.actor, command, targets, data, context => invoke(context, true))
    : t.transaction(() => invoke(checkGenerations(t, command, targets), false));
  return json(result);
}

export async function handleScopes(t: Tendril, req: Request, rest: string, principal: Principal): Promise<Response> {
  const who = identity(principal);
  if (req.method === 'GET' && rest === 'scopes') return json({ scopes: scopes(t) });
  if (!allowed(who, 'controller')) throw new HttpError(403, 'forbidden', 'Only a controller may change scope bindings');
  const match = /^scopes\/([A-Za-z0-9_.:-]{1,160})(\/rotate)?$/.exec(rest);
  if (!match) throw new HttpError(404, 'not_found', 'Unknown scope operation');
  const body = await readJson(req, 32768);
  const existing = scope(t, match[1]);
  const targets = existing ? { scopes: [match[1]] } : {};
  return json(mutate(t, who.actor, body, targets, { method: req.method, path: rest, paths: body.paths, operations: body.operations }, () => {
    if (req.method === 'PUT' && !match[2]) return registerScope(t, match[1], { paths: body.paths, operations: body.operations }, null, body.expected_generations?.[match[1]]);
    if (req.method === 'POST' && match[2]) return rotateScope(t, match[1]);
    if (req.method === 'DELETE' && !match[2]) { rotateScope(t, match[1], null, true); return { retired: true }; }
    throw new HttpError(405, 'method_not_allowed', 'Unknown scope mutation');
  }, { scopes: [match[1]] }));
}
