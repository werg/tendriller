import type { Tendril } from "./tendril";
import { addEvent } from "./events";
import { addActivity } from "./activity";
import { HttpError, isPlainObject, json, readJson } from "./http";
import type { Decision, ParticipantResponse } from "../../contract/index.mjs";
export type { Decision, ParticipantResponse } from "../../contract/index.mjs";
function bounded(value: unknown, field: string, max: number, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > max) throw new HttpError(400, "bad_request", `${field} must be ${empty ? "0" : "1"}–${max} characters`);
  return value.trim();
}
export function listDecisions(t: Tendril): Decision[] {
  return t.db.all<{ data: string }>("SELECT data FROM decisions ORDER BY updated_at DESC LIMIT 100").map(row => JSON.parse(row.data));
}
function getDecision(t: Tendril, id: string): Decision {
  const row = t.db.one<{ data: string }>("SELECT data FROM decisions WHERE id=?", id);
  if (!row) throw new HttpError(404, "not_found", "No such proposal");
  return JSON.parse(row.data);
}
function writeDecision(t: Tendril, decision: Decision) {
  t.db.run("INSERT INTO decisions(id,data,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at", decision.id, JSON.stringify(decision), decision.updated_at);
}
function changed(t: Tendril) { t.broadcast({ t: "decisions_changed" }, d => d.role === "owner" && !d.pending); }

export function saveDecision(t: Tendril, body: unknown, by: string, id?: string): Decision {
  if (!isPlainObject(body)) throw new HttpError(400, "bad_request", "Expected a proposal");
  const previous = id ? getDecision(t, id) : null;
  if (previous && body.expected_version !== previous.version) throw new HttpError(409, "version_conflict", "The proposal changed", { current_version: previous.version });
  if (!previous && (t.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM decisions")?.n ?? 0) >= 100) throw new HttpError(429, "quota", "At most 100 proposals per page");
  const now = t.now();
  const decision: Decision = previous ? { ...previous, version: previous.version + 1, updated_at: now }
    : { id: crypto.randomUUID(), title: "", summary: "", version: 1, status: "pending", expires_at: null, created_at: now, updated_at: now };
  if (body.status !== undefined && !["pending", "working", "completed", "failed"].includes(body.status)) throw new HttpError(403, "forbidden", "Only the owner may decide a proposal");
  const state = body.status ?? (previous ? previous.status : "pending");
  if (state !== "pending") {
    if (!previous || !["approved", "working"].includes(previous.status) || !["working", "completed", "failed"].includes(state))
      throw new HttpError(409, "invalid_transition", "Only an approved proposal can run or receive an outcome");
    if (["title", "summary", "proposal", "expires_at"].some(k => body[k] !== undefined)) throw new HttpError(409, "proposal_immutable", "Reissue a proposal before changing the approved work");
    decision.status = state;
    if (body.result !== undefined) decision.result = bounded(body.result, "result", 8000, true);
  } else {
    decision.title = bounded(body.title ?? previous?.title, "title", 200);
    decision.summary = bounded(body.summary ?? previous?.summary, "summary", 8000);
    const expires = body.expires_at === undefined ? previous?.expires_at ?? null : body.expires_at;
    if (expires !== null && (!Number.isSafeInteger(expires) || expires <= now)) throw new HttpError(400, "bad_request", "expires_at must be a future epoch time");
    const proposal = body.proposal ?? previous?.proposal;
    if (proposal !== undefined && JSON.stringify(proposal).length > 16000) throw new HttpError(413, "too_large", "Proposal details are too large");
    decision.proposal = proposal; decision.expires_at = expires; decision.status = "pending";
    delete decision.responded_at; delete decision.event_seq; delete decision.note; delete decision.result;
  }
  writeDecision(t, decision);
  addActivity(t, { kind: "decision", summary: `${previous ? "Updated" : "Requested"} proposal: ${decision.title}`, by });
  changed(t);
  return decision;
}

export function respondDecision(t: Tendril, id: string, body: unknown): Decision {
  if (!isPlainObject(body) || !["approve", "reject", "revise"].includes(body.decision)) throw new HttpError(400, "bad_request", "decision must be approve, reject or revise");
  const note = body.note === undefined ? "" : bounded(body.note, "note", 4000, true);
  const decision = t.ctx.storage.transactionSync(() => {
    const current = getDecision(t, id);
    if (body.expected_version !== current.version) throw new HttpError(409, "version_conflict", "The proposal changed; review the latest version", { current_version: current.version });
    if (current.status !== "pending") throw new HttpError(409, "already_decided", "This proposal already has a decision");
    if (current.expires_at !== null && current.expires_at <= t.now()) throw new HttpError(410, "expired", "This proposal has expired");
    // This endpoint has authenticated the owner and atomically accepted one
    // decision. It is human attention, not another background page wake.
    const event = addEvent(t, { type: "event", role: "owner", wake: true, cls: "owner", by: "owner",
      data: { type: "decision", decision_id: id, decision: body.decision, version: current.version, note } });
    const updated: Decision = { ...current, status: body.decision === "approve" ? "approved" : body.decision === "reject" ? "rejected" : "revision_requested",
      version: current.version + 1, updated_at: t.now(), responded_at: t.now(), event_seq: event.seq, note };
    writeDecision(t, updated);
    return updated;
  });
  addActivity(t, { kind: "decision", summary: `Owner ${decision.status.replaceAll("_", " ")}: ${decision.title}`, by: "owner" });
  changed(t);
  return decision;
}

export async function handleDecisions(t: Tendril, req: Request, rest: string, by: string, ownerPage: boolean): Promise<Response> {
  if (rest === "decisions" && req.method === "GET") return json({ decisions: listDecisions(t) });
  if (rest === "decisions" && req.method === "POST" && !ownerPage) return json(saveDecision(t, await readJson(req, 32000), by), 201);
  const match = /^decisions\/([a-zA-Z0-9-]+)(\/respond)?$/.exec(rest);
  if (match?.[2] && req.method === "POST" && ownerPage) return json(respondDecision(t, match[1], await readJson(req, 8192)));
  if (match && !match[2] && req.method === "PATCH" && !ownerPage) return json(saveDecision(t, await readJson(req, 32000), by, match[1]));
  throw new HttpError(405, "method_not_allowed");
}

/** Private group answers are never inserted into shared state, transcript or broadcast messages. */
export async function handleResponses(t: Tendril, req: Request, participant: string | null, readAll: boolean): Promise<Response> {
  if (req.method === "GET") {
    return json({ ...(!readAll ? { participant } : {}), responses: t.db.all<ParticipantResponse>("SELECT id, participant, prompt_id, answer, revision, created_at, updated_at FROM participant_responses" +
      (readAll ? "" : " WHERE participant=?") + " ORDER BY updated_at DESC LIMIT 500", ...(readAll ? [] : [participant])) });
  }
  if (req.method !== "POST" || !participant || readAll) throw new HttpError(405, "method_not_allowed");
  const body = await readJson(req, 16384);
  if (!isPlainObject(body)) throw new HttpError(400, "bad_request", "Expected a response");
  const prompt = bounded(body.prompt_id, "prompt_id", 100), answer = bounded(body.answer, "answer", 8000);
  const record = t.ctx.storage.transactionSync(() => {
    const previous = t.db.one<{ id: string; revision: number; answer: string }>("SELECT id, revision, answer FROM participant_responses WHERE participant=? AND prompt_id=?", participant, prompt);
    if (previous?.answer === answer) return t.db.one<ParticipantResponse>("SELECT * FROM participant_responses WHERE id=?", previous.id)!;
    if (previous && body.expected_revision !== previous.revision) throw new HttpError(409, "version_conflict", "Reload your previous response before editing it");
    if (!previous && (t.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM participant_responses")?.n ?? 0) >= 500) throw new HttpError(429, "quota", "This session has reached its response limit");
    const id = previous?.id ?? crypto.randomUUID(), now = t.now(), revision = (previous?.revision ?? 0) + 1;
    t.db.run("INSERT INTO participant_responses(id,participant,prompt_id,answer,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET answer=excluded.answer, revision=excluded.revision, updated_at=excluded.updated_at",
      id, participant, prompt, answer, revision, now, now);
    addEvent(t, { type: "event", role: null, by: "participant", wake: true, cls: "page", data: { type: "response_submitted", response_id: id, prompt_id: prompt, revision } });
    return t.db.one<ParticipantResponse>("SELECT * FROM participant_responses WHERE id=?", id)!;
  });
  return json(record, 201);
}
