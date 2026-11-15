import type { Tendril } from "./tendril";
import type { ParticipantAssignment, AssignmentCreate, AssignmentUpdate } from "../../contract/index.mjs";
import { assertValid } from "../../contract/index.mjs";
import { addEvent } from "./events";
import { addActivity } from "./activity";
import { HttpError, json, readJson } from "./http";

export function interactionChanged(t: Tendril): number {
  const revision = t.db.get<number>("interaction_revision", 0) + 1;
  t.db.set("interaction_revision", revision);
  return revision;
}

export function listAssignments(t: Tendril, participant?: string): ParticipantAssignment[] {
  return t.db.all<{ data: string }>("SELECT data FROM participant_assignments" + (participant ? " WHERE participant=?" : "") +
    " ORDER BY updated_at DESC, id LIMIT 500", ...(participant ? [participant] : [])).map(row => JSON.parse(row.data));
}

export function assignmentForAnswer(t: Tendril, prompt: string, participant: string, revision: unknown): void {
  if (!prompt.startsWith("assignment:")) return;
  const row = t.db.one<{ participant: string; data: string }>("SELECT participant,data FROM participant_assignments WHERE id=?", prompt.slice(11));
  if (!row || row.participant !== participant) throw new HttpError(404, "not_found", "No assignment for this participant");
  const current: ParticipantAssignment = JSON.parse(row.data);
  if (current.status !== "open") throw new HttpError(409, "assignment_closed", "This assignment is closed");
  if (revision !== current.revision) throw new HttpError(409, "version_conflict", "The assignment changed; review its latest instructions before answering");
}

function eligible(t: Tendril, participant: string): boolean {
  return participant === t.db.get("owner_account", null) || !!t.db.one("SELECT 1 AS found FROM guest_accounts g JOIN links l ON l.id=g.link_id WHERE g.account_id=? AND g.approved=1 AND l.role='guest' AND (l.expires_at IS NULL OR l.expires_at>?)", participant, t.now());
}

export function participants(t: Tendril) {
  const owner = t.db.get<string | null>("owner_account", null);
  const guests = t.db.all<{ account_id: string }>("SELECT DISTINCT g.account_id FROM guest_accounts g JOIN links l ON l.id=g.link_id WHERE g.approved=1 AND l.role='guest' AND (l.expires_at IS NULL OR l.expires_at>?) ORDER BY g.account_id", t.now());
  return [...(owner ? [{ id: owner, label: "Facilitator", role: "owner" as const }] : []),
    ...guests.filter(row => row.account_id !== owner).map((row, index) => ({ id: row.account_id, label: `Participant ${index + 1}`, role: "guest" as const }))];
}

export function saveAssignment(t: Tendril, body: any, by: string, id?: string): ParticipantAssignment {
  const value: Partial<AssignmentCreate & AssignmentUpdate> = assertValid(id ? "assignmentUpdate" : "assignmentCreate", body);
  const result = t.ctx.storage.transactionSync(() => {
    if (!id) {
      const active = t.getState().state.facilitation as { session_id?: string } | undefined;
      const generation = typeof active?.session_id === "string" ? active.session_id : "initial";
      if ((value.expected_session_id !== undefined || generation !== "initial") && value.expected_session_id !== generation)
        throw new HttpError(409, "stale_session", "This task belongs to an archived session. Review its draft and the current session before assigning it again.");
    }
    const row = id ? t.db.one<{ data: string }>("SELECT data FROM participant_assignments WHERE id=?", id) : null;
    if (id && !row) throw new HttpError(404, "not_found", "No such assignment");
    const previous: ParticipantAssignment | null = row ? JSON.parse(row.data) : null;
    if (previous && value.expected_revision !== previous.revision) throw new HttpError(409, "version_conflict", "The assignment changed; reload before editing");
    if (!previous && !eligible(t, value.participant!)) throw new HttpError(400, "unknown_participant", "Choose an approved participant on this page");
    if (!previous && (t.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM participant_assignments")?.n ?? 0) >= 500)
      throw new HttpError(429, "quota", "Archive this session before creating more assignments");
    const now = t.now(), assignmentId = id ?? crypto.randomUUID();
    const assignment: ParticipantAssignment = {
      id: assignmentId, participant: previous?.participant ?? value.participant!, prompt_id: `assignment:${assignmentId}`,
      title: (value.title ?? previous?.title ?? "").trim(), prompt: (value.prompt ?? previous?.prompt ?? "").trim(),
      feedback: (value.feedback ?? previous?.feedback ?? "").trim(), status: value.status ?? previous?.status ?? "open",
      revision: (previous?.revision ?? 0) + 1, created_at: previous?.created_at ?? now, updated_at: now,
    };
    if (!assignment.title || !assignment.prompt) throw new HttpError(400, "bad_request", "Assignment title and instructions cannot be blank");
    t.db.run("INSERT INTO participant_assignments(id,participant,data,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at",
      assignment.id, assignment.participant, JSON.stringify(assignment), now);
    interactionChanged(t);
    // Identity, prompt, and feedback never enter shared state, logs, or broadcasts.
    addEvent(t, { type: "event", by, role: null, wake: false, data: { type: "assignment_changed", assignment_id: assignment.id, revision: assignment.revision } });
    return assignment;
  });
  addActivity(t, { kind: "assignment", summary: id ? "Updated a private assignment" : "Created a private assignment", by });
  t.broadcast({ t: "assignments_changed" }, device => device.role === "owner" && !device.pending);
  return result;
}

export async function handleAssignments(t: Tendril, req: Request, rest: string, participant: string | null, manage: boolean, by: string): Promise<Response> {
  if (rest === "assignments/participants" && req.method === "GET" && manage) return json({ participants: participants(t) });
  if ((rest === "assignments" || rest === "assignments/all") && req.method === "GET") {
    if (!manage && (rest.endsWith("/all") || !participant)) throw new HttpError(403, "forbidden");
    return json({ ...(!manage ? { participant } : {}), assignments: listAssignments(t, manage ? undefined : participant!) });
  }
  if (!manage) throw new HttpError(403, "forbidden", "Only the facilitator can assign tasks or write feedback");
  if (rest === "assignments" && req.method === "POST") return json(saveAssignment(t, await readJson(req, 32000), by), 201);
  const match = /^assignments\/([a-zA-Z0-9-]+)$/.exec(rest);
  if (match && req.method === "PATCH") return json(saveAssignment(t, await readJson(req, 32000), by, match[1]));
  throw new HttpError(405, "method_not_allowed");
}
