import { APPLICATION_LIMITS, applicationFilter, applicationSelection, assertApplicationOperationId, validateCloudflareProgram, ApplicationError } from '../../contract/application.mjs';
import type { ApplicationEvent, ApplicationEventBatch, ApplicationOperation, ApplicationSelection } from '../../contract/application.mjs';
import type { Principal } from './access';
import { currentPrincipal } from './access';
import { checkGenerations, preconditions } from './scopes';
import { HttpError, json, readJson } from './http';
import { sha256Hex } from './ids';
import { statePaths, validateOps, validateStateChecks } from './state';
import type { Tendril } from './tendril';

export const APPLICATION_ROUTE = /^application(?:\/(?:changes|events|view|operations\/[A-Za-z0-9_.:-]+))?$/;
export function selectedApplication(t: Tendril): ApplicationSelection {
  return applicationSelection(t.db.get('application', undefined), `cf:${t.tid}`);
}
/** The selection is made at creation. An outage can never switch its authority. */
export function requireCloudflareApplication(t: Tendril): void {
  if (selectedApplication(t).kind !== 'cloudflare') throw new HttpError(409, 'application_backend', 'This page stores application data in its selected peer backend');
}
export function isApplicationPath(path: string): boolean {
  return /^(?:state|events|say|streams|producers|consumers|timers|session|scopes|workflows|files|file-refs|bundle|remix)(?:\/|$)/.test(path)
    && !/^events\/socket(?:\/|$)/.test(path);
}
const stable = (value: unknown): string => Array.isArray(value) ? `[${value.map(stable).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`
    : JSON.stringify(value);
const actorKey = (principal: Principal) => `${principal.kind}:${principal.name}`;
function authorize(t: Tendril, principal: Principal, write = false): void {
  const current = currentPrincipal(t, principal);
  if (!current || current.kind === 'producer' || current.kind === 'page' && current.role === 'display')
    throw new HttpError(403, 'forbidden', 'Application history requires an authorized peer host identity');
  if (write && current.kind === 'page' && current.role !== 'owner') throw new HttpError(403, 'forbidden', 'Application writes require the page owner');
}
interface ChangeRow { seq: number; actor: string; operation_id: string; proposal_id: string; program: string; result: string; events: string; bytes: number }
function head(t: Tendril): number { return t.db.one<{ seq: number }>('SELECT COALESCE(MAX(seq),0) AS seq FROM application_changes')!.seq; }
function revision(t: Tendril, position = head(t)): string { return btoa(JSON.stringify(['tendriller.application.view', 1, t.tid, selectedApplication(t).id, position, t.getState().rev])); }
function readRevision(t: Tendril, value?: string): { position: number; revision: string } {
  if (value === undefined) return { position: head(t), revision: revision(t) };
  let fields: unknown;
  try { fields = JSON.parse(atob(value)); } catch { throw new HttpError(400, 'invalid_revision', 'Invalid application revision'); }
  if (!Array.isArray(fields) || fields.length !== 6 || fields[0] !== 'tendriller.application.view' || fields[1] !== 1 ||
      fields[2] !== t.tid || fields[3] !== selectedApplication(t).id || !Number.isSafeInteger(fields[4]) || fields[4] < 0 || fields[4] > head(t) ||
      !Number.isSafeInteger(fields[5]) || fields[5] < 0 || btoa(JSON.stringify(fields)) !== value)
    throw new HttpError(409, 'revision_mismatch', 'The revision does not identify this applied application history');
  return { position: fields[4], revision: value };
}
function cursor(t: Tendril, position: number, topics: readonly string[] | null): string {
  return btoa(JSON.stringify(['tendriller.application.events', 1, t.tid, selectedApplication(t).id, position, topics]));
}
function readCursor(t: Tendril, value: string | undefined, topics: readonly string[] | null, through: number): number {
  if (value === undefined) return 0;
  let fields: unknown;
  try { fields = JSON.parse(atob(value)); } catch { throw new HttpError(400, 'invalid_cursor', 'Invalid event continuation'); }
  if (!Array.isArray(fields) || fields.length !== 6 || fields[0] !== 'tendriller.application.events' || fields[1] !== 1 ||
      fields[2] !== t.tid || fields[3] !== selectedApplication(t).id || JSON.stringify(fields[5]) !== JSON.stringify(topics) ||
      !Number.isSafeInteger(fields[4]) || fields[4] < 0 || fields[4] > through || btoa(JSON.stringify(fields)) !== value)
    throw new HttpError(409, 'cursor_mismatch', 'Cursor history, filter, or applied position does not match');
  return fields[4];
}
export async function submitApplication(t: Tendril, principal: Principal, input: unknown): Promise<ApplicationOperation> {
  requireCloudflareApplication(t); authorize(t, principal, true);
  if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['program', 'operationId'].includes(key))) throw new HttpError(400, 'bad_request', 'Expected program and operationId');
  const { operationId: rawId, program: rawProgram } = input as { operationId: unknown; program: unknown };
  const operationId = assertApplicationOperationId(rawId), program = validateCloudflareProgram(rawProgram);
  preconditions({ ...program, cid: operationId });
  const canonical = stable(program), actor = actorKey(principal);
  const proposalId = await sha256Hex(stable(['tendriller.application.change', t.tid, selectedApplication(t).id, actor, operationId, program]));
  return t.transaction(() => {
    authorize(t, principal, true);
    const previous = t.db.one<ChangeRow>('SELECT * FROM application_changes WHERE actor=? AND operation_id=?', actor, operationId);
    if (previous) {
      if (previous.program !== canonical) throw new HttpError(409, 'operation_conflict', 'Operation identity already binds different contents');
      return JSON.parse(previous.result);
    }
    let events: ApplicationEvent[] = [];
    let result: ApplicationOperation;
    try {
      t.transaction(() => {
        for (const step of program.steps) {
          if (step.kind === 'state') {
            const ops = validateOps(step.ops), checks = validateStateChecks(step);
            checkGenerations(t, program, { paths: statePaths(ops, checks), operations: ['state'] });
            t.applyState(ops, actor, undefined, { ...program, ...checks });
          } else {
            checkGenerations(t, program, { operations: ['event'] });
            const eventOrdinal = events.length;
            events.push({ id: `${proposalId}:${eventOrdinal}`, proposalId, eventOrdinal, topic: step.topic, payload: step.payload });
          }
        }
      });
      result = { operationId, proposalId, status: 'final', outcome: 'accepted' };
    } catch (error) {
      if (!(error instanceof HttpError) || !['state_conflict', 'stale_generation', 'generation_required', 'too_large', 'bad_request'].includes(error.code)) throw error;
      events = [];
      result = { operationId, proposalId, status: 'rejected', outcome: 'rejected', error: error.code, message: error.message };
    }
    const next = head(t) + 1;
    result = { ...result, revision: revision(t, next) };
    const encodedResult = JSON.stringify(result), encodedEvents = JSON.stringify(events);
    const bytes = new TextEncoder().encode(canonical + encodedResult + encodedEvents + actor + operationId).length;
    const used = t.db.one<{ bytes: number; count: number }>('SELECT COALESCE(SUM(bytes),0) AS bytes,COUNT(*) AS count FROM application_changes')!;
    if (used.bytes + bytes > APPLICATION_LIMITS.historyBytes || used.count >= APPLICATION_LIMITS.historyTransactions)
      throw new HttpError(429, 'history_quota', 'Application history is full; retained history is never silently pruned');
    t.db.run('INSERT INTO application_changes(seq,actor,operation_id,proposal_id,program,result,events,bytes) VALUES(?,?,?,?,?,?,?,?)',
      next, actor, operationId, proposalId, canonical, encodedResult, encodedEvents, bytes);
    t.afterCommit(() => t.broadcast({ t: 'application_revision', revision: result.revision }));
    return result;
  });
}
export function readApplicationEvents(t: Tendril, input: { cursor?: string; topics?: readonly string[]; limit?: number; revision?: string } = {}): ApplicationEventBatch {
  const target = readRevision(t, input.revision), topics = applicationFilter(input.topics);
  const limit = input.limit ?? 32;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > APPLICATION_LIMITS.batchTransactions) throw new HttpError(400, 'bad_request', 'Invalid transaction batch limit');
  const start = readCursor(t, input.cursor, topics, target.position);
  let position = start, bytes = 0;
  const transactions: { proposalId: string; events: ApplicationEvent[] }[] = [];
  // Scan bounds include rejected and nonmatching records, so idle topics progress.
  for (let scanned = 0; scanned < limit && position < target.position; scanned++) {
    const row = t.db.one<Pick<ChangeRow, 'seq' | 'proposal_id' | 'events'>>('SELECT seq,proposal_id,events FROM application_changes WHERE seq>? AND seq<=? ORDER BY seq LIMIT 1', position, target.position);
    if (!row) throw new HttpError(409, 'history_gap', 'The application history is incomplete');
    const events = (JSON.parse(row.events) as ApplicationEvent[]).filter(event => topics === null || topics.includes(event.topic));
    const size = new TextEncoder().encode(JSON.stringify(events)).length;
    if (bytes + size > 1024 * 1024 && position !== start) break;
    bytes += size; position = row.seq;
    if (events.length) transactions.push({ proposalId: row.proposal_id, events });
  }
  return { transactions, scannedThrough: cursor(t, position, topics), hasMore: position < target.position, revision: target.revision };
}
export async function handleApplication(t: Tendril, req: Request, url: URL, path: string, principal: Principal): Promise<Response> {
  try {
    authorize(t, principal);
    if (path === 'application' && req.method === 'GET') return json({ selection: selectedApplication(t) });
    requireCloudflareApplication(t);
    if (path === 'application/changes' && req.method === 'POST') return json(await submitApplication(t, principal, await readJson(req, APPLICATION_LIMITS.programBytes + 4096)));
    if (path === 'application/view' && req.method === 'GET') return json(t.transaction(() => ({ revision: revision(t), ...t.getState() })));
    if (path === 'application/events' && req.method === 'GET') {
      const topics = url.searchParams.has('topics') ? JSON.parse(url.searchParams.get('topics')!) : undefined;
      return json(readApplicationEvents(t, { cursor: url.searchParams.get('cursor') ?? undefined, topics,
        limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined, revision: url.searchParams.get('revision') ?? undefined }));
    }
    if (path.startsWith('application/operations/') && req.method === 'GET') {
      const operationId = assertApplicationOperationId(path.slice('application/operations/'.length));
      const row = t.db.one<{ result: string }>('SELECT result FROM application_changes WHERE actor=? AND operation_id=?', actorKey(principal), operationId);
      return json(row ? JSON.parse(row.result) : null);
    }
    throw new HttpError(405, 'method_not_allowed');
  } catch (error) {
    if (error instanceof ApplicationError) throw new HttpError(400, error.code, error.message);
    if (error instanceof TypeError) throw new HttpError(400, 'bad_request', error.message);
    if (error instanceof SyntaxError) throw new HttpError(400, 'bad_request', 'Malformed application filter');
    throw error;
  }
}
