import type { Tendril } from "./tendril";
import type { ArchiveScope, SessionArchive, StateOperation, ParticipantResponse } from "../../contract/index.mjs";
import { assertValid } from "../../contract/index.mjs";
import { HttpError, isPlainObject, json, readJson } from "./http";
import { addActivity } from "./activity";
import { addEvent } from "./events";
import { listDecisions } from "./interactions";
import { interactionChanged, listAssignments } from "./assignments";
import { BLOB_ID_RE } from "./ids";
import { applyOps, validateOps } from "./state";

const KEYS: Record<ArchiveScope, string[]> = {
  notebook: ["notebook"], guide: ["guide", "guide_progress"], workshop: ["workshop"],
  experiment: ["experiment"], decisions: [], facilitation: ["facilitation"],
};
export const ARCHIVE_LIMIT = 20, ARCHIVE_BYTES = 8 * 1024 * 1024;
const generationKey = (scope: ArchiveScope) => scope === "guide" ? "guide_progress" : scope;
export function sessionGeneration(t: Tendril, scope: ArchiveScope): string {
  const value = t.getState().state[generationKey(scope)];
  return isPlainObject(value) && typeof value.session_id === "string" ? value.session_id : "initial";
}

/** An offline event belongs to the session in which it was captured. */
export function checkEventSession(t: Tendril, data: unknown): void {
  if (!isPlainObject(data)) return;
  const kind = typeof data.type === "string" ? data.type : "";
  const guideInput = kind === "checkpoint" && typeof data.guide_id === "string" || kind === "input" &&
    (isPlainObject(data.context) && typeof data.context.guide_id === "string" || data.block === "guide-evidence");
  const implied: ArchiveScope | null = kind.startsWith("notebook.") ? "notebook" : kind.startsWith("guide.") || guideInput ? "guide" : kind.startsWith("workshop.") ? "workshop" : kind.startsWith("experiment.") ? "experiment" : kind === "facilitation_summary_request" ? "facilitation" : null;
  if (data.session === undefined) {
    if (implied && sessionGeneration(t, implied) !== "initial") throw new HttpError(409, "stale_session", "This workflow input has no current session ID. Refresh before sending it again.");
    return;
  }
  const session = data.session;
  if (!isPlainObject(session) || !Object.hasOwn(KEYS, session.scope) || typeof session.id !== "string")
    throw new HttpError(400, "bad_session", "session needs a supported scope and an ID");
  if (implied && implied !== session.scope) throw new HttpError(400, "bad_session", "Input type and session scope must match");
  if (session.id !== sessionGeneration(t, session.scope)) throw new HttpError(409, "stale_session", "This input belongs to an archived session. Export or discard it before continuing.");
}

/** Fence old queued state operations after a workflow rolls over. */
export function checkStateSessions(t: Tendril, ops: StateOperation[], supplied: unknown): void {
  const sessions = isPlainObject(supplied) ? supplied : {};
  const next = applyOps(structuredClone(t.getState().state), validateOps(ops));
  for (const scope of Object.keys(KEYS) as ArchiveScope[]) {
    const affected = ops.some(op => {
      const path = Array.isArray(op.path) ? op.path.map(String) : op.path.split(".").filter(Boolean);
      return !path.length || KEYS[scope].includes(path[0]);
    });
    if (!affected) continue;
    const current = sessionGeneration(t, scope);
    const nextSection = next[generationKey(scope)];
    const nextId = isPlainObject(nextSection) && typeof nextSection.session_id === "string" ? nextSection.session_id : "initial";
    if (nextId !== current) throw new HttpError(409, "bad_session", "Only the archive action can start a new session");
    if ((sessions[scope] === undefined && current === "initial") || sessions[scope] === current) continue;
    throw new HttpError(409, "stale_session", "This edit belongs to an archived session. The latest session has been restored.");
  }
}

function scopeOf(value: unknown): ArchiveScope {
  if (typeof value !== "string" || !Object.hasOwn(KEYS, value)) throw new HttpError(400, "bad_scope", "Choose a supported workflow scope");
  return value as ArchiveScope;
}
function snapshot(t: Tendril, scope: ArchiveScope) {
  const shared_state = Object.fromEntries(KEYS[scope].filter(key => Object.hasOwn(t.getState().state, key)).map(key => [key, structuredClone(t.getState().state[key])]));
  return { shared_state, ...(scope === "decisions" ? { decisions: listDecisions(t) } : {}),
    ...(scope === "facilitation" ? { responses: t.db.all<ParticipantResponse>("SELECT * FROM participant_responses ORDER BY updated_at,id"), assignments: listAssignments(t) } : {}) };
}
export function archivePreview(t: Tendril, scope: ArchiveScope) {
  const data = snapshot(t, scope);
  const record = (key: string) => isPlainObject(data.shared_state[key]) ? data.shared_state[key] : {};
  const count = (value: unknown) => Array.isArray(value) ? value.length : isPlainObject(value) ? Object.keys(value).length : 0;
  const counts: Record<string, number> = {};
  if (scope === "notebook") counts.observations = count(record("notebook").entries);
  if (scope === "guide") { counts.steps = count(record("guide").steps); counts.completed_checkpoints = count(record("guide_progress").completed); }
  if (scope === "workshop") { counts.steps = count(record("workshop").steps); counts.shared_frames = record("workshop").frame ? 1 : 0; counts.step_receipts = count(record("workshop").receipts); }
  if (scope === "experiment") { counts.runs = count(record("experiment").runs); counts.interpretations = count(record("experiment").results); }
  if (scope === "decisions") counts.decisions = data.decisions?.length ?? 0;
  if (scope === "facilitation") { counts.responses = data.responses?.length ?? 0; counts.assignments = data.assignments?.length ?? 0; counts.shared_summaries = record("facilitation").summary ? 1 : 0; }
  return { scope, state_revision: t.getState().rev, interaction_revision: t.db.get<number>("interaction_revision", 0),
    counts };
}

function keepReferences(t: Tendril, value: unknown): void {
  if (typeof value === "string" && BLOB_ID_RE.test(value)) t.db.run("UPDATE blobs SET pinned=1 WHERE id=?", value);
  else if (Array.isArray(value)) for (const entry of value) keepReferences(t, entry);
  else if (isPlainObject(value)) for (const entry of Object.values(value)) keepReferences(t, entry);
}

export function createArchive(t: Tendril, body: unknown, by: string) {
  const value = assertValid("archiveCreate", body), scope = scopeOf(value.scope);
  const request = JSON.stringify({ scope, title: value.title?.trim() || scope, expected_state_revision: value.expected_state_revision,
    expected_interaction_revision: value.expected_interaction_revision });
  const existing = t.db.one<{ data: string; request: string }>("SELECT data,request FROM session_archives WHERE id=?", value.request_id);
  if (existing) {
    if (existing.request !== request) throw new HttpError(409, "request_conflict", "This archive request ID was already used for another snapshot");
    return { archive: JSON.parse(existing.data) as SessionArchive, state_revision: t.getState().rev, interaction_revision: t.db.get<number>("interaction_revision", 0) };
  }
  let ops: StateOperation[] = [];
  const result = t.transaction(() => {
    const current = archivePreview(t, scope);
    if (current.state_revision !== value.expected_state_revision || current.interaction_revision !== value.expected_interaction_revision)
      throw new HttpError(409, "version_conflict", "Work changed during review. Review a fresh snapshot before starting the next session.");
    const archive: SessionArchive = { format: "tendriller-session-archive", version: 1, id: value.request_id, scope,
      title: value.title?.trim() || scope, created_at: t.now(), ...snapshot(t, scope) };
    if (archive.decisions?.some(decision => decision.status === "approved" || decision.status === "working"))
      throw new HttpError(409, "work_in_progress", "Finish or record the outcome of approved work before archiving these proposals.");
    const serialized = JSON.stringify(archive), bytes = new TextEncoder().encode(serialized).byteLength;
    const stored = t.db.one<{ n: number; bytes: number }>("SELECT COUNT(*) AS n,COALESCE(SUM(bytes),0) AS bytes FROM session_archives")!;
    if (stored.n >= ARCHIVE_LIMIT || stored.bytes + bytes > ARCHIVE_BYTES)
      throw new HttpError(429, "archive_quota", "Download and remove an older archive first. Your current session has been kept.");
    t.db.run("INSERT INTO session_archives(id,scope,title,created_at,bytes,request,data) VALUES(?,?,?,?,?,?,?)",
      archive.id, scope, archive.title, archive.created_at, bytes, request, serialized);
    keepReferences(t, archive.shared_state);
    if (scope === "decisions") t.db.run("DELETE FROM decisions");
    if (scope === "facilitation") { t.db.run("DELETE FROM participant_responses"); t.db.run("DELETE FROM participant_assignments"); }
    const next = structuredClone(t.getState().state), key = generationKey(scope);
    if (scope !== "decisions") {
      const reset = scope === "facilitation" ? { session_id: archive.id, stage: "collect", prompt: { id: crypto.randomUUID(), text: "What would you like to explore next?", description: "A new session with space for everyone." }, summary: "" } : { session_id: archive.id };
      next[key] = reset; ops = [{ op: "set", path: [key], value: reset }];
      t.db.set("state", next); t.db.set("rev", current.state_revision + 1);
    }
    const interaction_revision = interactionChanged(t);
    return { archive, state_revision: t.getState().rev, interaction_revision };
  });
  // No observers see a reset before its archive is safely committed.
  if (ops.length) t.broadcast({ t: "state", ops, rev: result.state_revision, by });
  if (scope === "decisions") t.broadcast({ t: "decisions_changed" }, device => device.role === "owner" && !device.pending);
  addActivity(t, { kind: "archive", summary: `Archived ${scope} session`, by });
  addEvent(t, { type: "event", by, role: null, wake: false, data: { type: "session_archived", scope, archive_id: result.archive.id } });
  return result;
}

export async function handleArchives(t: Tendril, req: Request, url: URL, rest: string, by: string): Promise<Response> {
  if (rest === "archives/preview" && req.method === "GET") return json(archivePreview(t, scopeOf(url.searchParams.get("scope"))));
  if (rest === "archives" && req.method === "GET") return json({ archives: t.db.all("SELECT id,scope,title,created_at,bytes FROM session_archives ORDER BY created_at DESC,id"), limit: ARCHIVE_LIMIT, byte_limit: ARCHIVE_BYTES });
  if (rest === "archives" && req.method === "POST") return json(createArchive(t, await readJson(req, 4096), by), 201);
  const match = /^archives\/([a-zA-Z0-9-]+)$/.exec(rest);
  if (match) {
    const row = t.db.one<{ data: string }>("SELECT data FROM session_archives WHERE id=?", match[1]);
    if (!row) throw new HttpError(404, "not_found", "No such archive");
    if (req.method === "GET") return new Response(row.data, { headers: { "Content-Type": "application/json", "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="tendriller-session-${match[1]}.json"` } });
    if (req.method === "DELETE") { t.db.run("DELETE FROM session_archives WHERE id=?", match[1]); return new Response(null, { status: 204 }); }
  }
  throw new HttpError(405, "method_not_allowed");
}
