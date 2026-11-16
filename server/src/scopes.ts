import type { Tendril } from './tendril';
import type { Preconditions, ScopeDescriptor, ValidatedContext } from '../../contract/host.d.mts';
import { HttpError } from './http';
import { assertValid } from '../../contract/index.mjs';
import { RESOURCE_LIMITS } from '../../contract/limits.mjs';
import { selectScopes } from '../../contract/scopes.mjs';
export { pathsOverlap } from '../../contract/scopes.mjs';
import { validateOps } from './state';

export type { Preconditions, ScopeDescriptor, ValidatedContext };
export interface MutationTargets { paths?: string[][]; operations?: string[]; scopes?: string[] }
interface ScopeRow { id: string; generation: string; paths: string; operations: string; retired: number; owner: string | null }
const descriptor = (row: ScopeRow): ScopeDescriptor => ({ id: row.id, generation: row.generation, paths: JSON.parse(row.paths), operations: JSON.parse(row.operations) });
export const scopes = (t: Tendril): ScopeDescriptor[] => t.db.all<ScopeRow>('SELECT * FROM scopes WHERE retired=0 ORDER BY id').map(descriptor);
export function scope(t: Tendril, id: string): ScopeDescriptor | null {
  const row = t.db.one<ScopeRow>('SELECT * FROM scopes WHERE id=? AND retired=0', id);
  return row ? descriptor(row) : null;
}
export function preconditions(value: unknown): Preconditions {
  const command = assertValid('preconditions', value);
  return { cid: command.cid, ...(command.scope !== undefined ? { scope: command.scope } : {}), expected_generations: command.expected_generations };
}

/** The same path-overlap and target rule is used by every writer. */
export function checkGenerations(t: Tendril, input: Pick<Preconditions, 'scope' | 'expected_generations'>, targets: MutationTargets): ValidatedContext {
  const supplied = input.expected_generations ?? {};
  const required = new Set(targets.scopes ?? []);
  if (input.scope) required.add(input.scope);
  const active = scopes(t);
  for (const entry of selectScopes(active, targets)) required.add(entry.id);
  // Extra guards are checked too: an operation queued before retirement/rebinding
  // must not be reinterpreted just because its former binding disappeared.
  for (const id of Object.keys(supplied)) required.add(id);
  const generations: Record<string, string> = Object.create(null);
  for (const id of required) {
    const current = active.find(item => item.id === id);
    if (!current) throw new HttpError(409, 'stale_generation', `Scope ${id} is unknown or retired`);
    if (!Object.hasOwn(supplied, id)) throw new HttpError(428, 'generation_required', `Capture the current generation for scope ${id}`);
    if (supplied[id] !== current.generation) throw new HttpError(409, 'stale_generation', `Scope ${id} has changed`);
    generations[id] = current.generation;
  }
  return { ...(input.scope ? { scope: input.scope } : {}), generations };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable((value as any)[key])).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
/** Inspect an exact acknowledged command before asynchronous preparation. */
export function replay<T>(t: Tendril, actor: string, input: unknown, targets: MutationTargets, payload: unknown): { found: false } | { found: true; result: T } {
  const command = preconditions(input), fingerprint = stable({ command, targets, payload });
  const previous = t.db.one<{ fingerprint: string; result: string }>('SELECT fingerprint,result FROM commands WHERE actor=? AND cid=?', actor, command.cid);
  if (!previous) return { found: false };
  if (previous.fingerprint !== fingerprint) throw new HttpError(409, 'command_conflict', 'A command ID cannot be reused for different work');
  return { found: true, result: JSON.parse(previous.result) as T };
}
/** Validate, deduplicate and mutate synchronously under the local transaction. */
export function mutate<T>(t: Tendril, actor: string, input: unknown, targets: MutationTargets, payload: unknown, write: (context: ValidatedContext) => T,
  fingerprintTargets: MutationTargets = targets): T {
  const command = preconditions(input);
  const fingerprint = stable({ command, targets: fingerprintTargets, payload });
  return t.transaction(() => {
    const previous = replay<T>(t, actor, command, fingerprintTargets, payload);
    if (previous.found) return previous.result;
    const context = checkGenerations(t, command, targets);
    const result = write(context);
    if (result && typeof (result as any).then === 'function') throw new TypeError('Mutation callbacks must be synchronous');
    const serialized = JSON.stringify(result ?? null);
    const bytes = [actor, command.cid, fingerprint, serialized].reduce((total, value) => total + new TextEncoder().encode(value).byteLength, 0);
    const usage = t.db.one<{ count: number; bytes: number }>('SELECT count,bytes FROM command_usage WHERE id=1')!;
    if (usage.count >= RESOURCE_LIMITS.command_receipts || usage.bytes + bytes > RESOURCE_LIMITS.command_receipt_bytes)
      throw new HttpError(429, 'resource_quota', 'This page has reached its durable command receipt allowance. Export the work and continue on a fresh page; accepted commands can still be retried.', {
        resource: usage.count >= RESOURCE_LIMITS.command_receipts ? 'command_receipts' : 'command_receipt_bytes',
        limit: usage.count >= RESOURCE_LIMITS.command_receipts ? RESOURCE_LIMITS.command_receipts : RESOURCE_LIMITS.command_receipt_bytes,
        used: usage.count >= RESOURCE_LIMITS.command_receipts ? usage.count : usage.bytes,
      });
    t.db.run('INSERT INTO commands(actor,cid,fingerprint,result,created_at) VALUES(?,?,?,?,?)', actor, command.cid, fingerprint, serialized, t.now());
    t.db.run('UPDATE command_usage SET count=count+1,bytes=bytes+? WHERE id=1', bytes);
    return result;
  });
}

type CommandDecision<T> = { status: 'accepted'; value: T } | {
  status: 'rejected'; error: { status: number; code: string; message: string; extra?: Record<string, unknown> };
};

/** Save classified domain rejections as receipts after rolling back their writes and effects. */
export function mutateDecision<T>(t: Tendril, actor: string, input: unknown, targets: MutationTargets, payload: unknown,
  write: (context: ValidatedContext) => T, rejectedCodes: ReadonlySet<string>, fingerprintTargets: MutationTargets = targets): T {
  const decision = mutate<CommandDecision<T>>(t, actor, input, targets, payload, context => {
    try {
      return { status: 'accepted', value: t.transaction(() => write(context)) };
    } catch (error) {
      if (!(error instanceof HttpError) || !rejectedCodes.has(error.code)) throw error;
      return { status: 'rejected', error: { status: error.status, code: error.code, message: error.message,
        ...(error.extra !== undefined ? { extra: error.extra } : {}) } };
    }
  }, fingerprintTargets);
  // Throw only after mutate has committed the receipt. Authentication, guards,
  // and receipt-capacity failures occur outside the classified write callback.
  if (decision.status === 'rejected')
    throw new HttpError(decision.error.status, decision.error.code, decision.error.message, decision.error.extra);
  return decision.value;
}

function changed(t: Tendril): void { t.broadcast({ t: 'scopes', scopes: scopes(t) }); }
export function registerScope(t: Tendril, id: string, bindings: unknown, owner: string | null = null, expected?: string): ScopeDescriptor {
  assertValid('scopeId', id);
  const checked = assertValid('scopeBindings', bindings);
  const paths = checked.paths.map(path => validateOps([{ op: 'set', path, value: {} }])[0].path);
  const operations = checked.operations;
  return t.transaction(() => {
    const previous = t.db.one<ScopeRow>('SELECT * FROM scopes WHERE id=?', id);
    if (previous && previous.owner !== owner) throw new HttpError(403, 'scope_owner', 'This scope belongs to a different controller');
    if (previous && !previous.retired && previous.generation !== expected) throw new HttpError(409, 'stale_generation', 'Rebinding requires the current generation');
    if ((!previous || previous.retired) && scopes(t).length >= RESOURCE_LIMITS.active_scopes)
      throw new HttpError(429, 'resource_quota', `At most ${RESOURCE_LIMITS.active_scopes} active scopes per page. Retire unused scopes before adding another.`, { resource: 'active_scopes', limit: RESOURCE_LIMITS.active_scopes });
    if (!previous && t.db.one<{ count: number }>('SELECT COUNT(*) AS count FROM scopes')!.count >= RESOURCE_LIMITS.scope_bindings)
      throw new HttpError(429, 'resource_quota', 'This page has reached its lifetime scope binding allowance. Reuse a retained binding or export the work and continue on a fresh page.', { resource: 'scope_bindings', limit: RESOURCE_LIMITS.scope_bindings });
    const generation = crypto.randomUUID();
    t.db.run('INSERT INTO scopes(id,generation,paths,operations,retired,owner) VALUES(?,?,?,?,0,?) ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,paths=excluded.paths,operations=excluded.operations,retired=0,owner=excluded.owner', id, generation, JSON.stringify(paths), JSON.stringify(operations), owner);
    changed(t);
    return { id, generation, paths, operations };
  });
}
export function rotateScope(t: Tendril, id: string, owner: string | null = null, retire = false): ScopeDescriptor {
  const row = t.db.one<ScopeRow>('SELECT * FROM scopes WHERE id=? AND retired=0', id);
  if (!row) throw new HttpError(404, 'not_found', 'Unknown active scope');
  if (row.owner !== owner) throw new HttpError(403, 'scope_owner', 'This scope belongs to a different controller');
  const generation = crypto.randomUUID();
  t.db.run('UPDATE scopes SET generation=?,retired=? WHERE id=?', generation, retire ? 1 : 0, id);
  changed(t);
  return { ...descriptor(row), generation };
}
