import type { Tendril } from "./tendril";
import { checkGenerations, preconditions, mutate, replay, type Preconditions } from "./scopes";
import { addActivity } from "./activity";
import { assertStoredContent, createVersion, deleteUnreferencedContent, fileKey, latestFileMap, servedVersion, storeContent, versionFiles, type VersionFile } from "./files";
import { HttpError, isPlainObject, json } from "./http";
import { BLOB_ID_RE, fromBase64, toBase64 } from "./ids";
import { MAX_FILES_PER_VERSION, MAX_STATE } from "./limits";
import { normalizeFilePath, publicBase } from "./urls";
import { listTimers } from "./timers";
import type { SessionBrief, SessionResult, SessionSummary, PortableBundle } from "../../contract/index.mjs";
export type { SessionBrief, SessionResult, SessionSummary, PortableBundle } from "../../contract/index.mjs";
interface SharedBundleFile { path: string; blob_id: string; name: string | null; type: string | null }
interface StagedBundle { name: string; files: VersionFile[]; state?: Record<string, unknown>; session?: SessionBrief;
  media: string[]; sharedFiles: SharedBundleFile[]; expectedFileCursor: number }
const EMPTY_BRIEF: SessionBrief = { purpose: "", current_task: "", completed: [], decisions: [], open_questions: [], last_handled_seq: 0 };
const bundleOperations = new WeakSet<Tendril>();
async function withBundleLock<T>(t: Tendril, work: () => Promise<T>): Promise<T> {
  if (bundleOperations.has(t)) throw new HttpError(409, "bundle_busy", "Another bundle operation is in progress; try again when it finishes");
  bundleOperations.add(t);
  try { return await work(); } finally { bundleOperations.delete(t); }
}

export function validateBrief(value: unknown): SessionBrief {
  if (!isPlainObject(value)) throw new HttpError(400, "bad_request", "Expected a session brief");
  const brief: SessionBrief = { ...EMPTY_BRIEF };
  for (const field of ["purpose", "current_task", "source"] as const) {
    if (value[field] === undefined) continue;
    if (typeof value[field] !== "string" || value[field].length > 4000) throw new HttpError(400, "bad_request", `${field} must be at most 4000 characters`);
    brief[field] = value[field];
  }
  for (const field of ["completed", "decisions", "open_questions"] as const) {
    const items = value[field] ?? [];
    if (!Array.isArray(items) || items.length > 50 || items.some(v => typeof v !== "string" || v.length > 2000))
      throw new HttpError(400, "bad_request", `${field} must be up to 50 short strings`);
    brief[field] = [...items];
  }
  const seq = value.last_handled_seq ?? 0;
  if (!Number.isSafeInteger(seq) || seq < 0) throw new HttpError(400, "bad_request", "last_handled_seq must be a non-negative integer");
  brief.last_handled_seq = seq;
  return brief;
}

export function sessionSummary(t: Tendril): SessionSummary {
  const session = t.db.get<SessionBrief>("session_brief", EMPTY_BRIEF);
  const earliest = t.db.one<{ seq: number | null }>("SELECT MIN(seq) AS seq FROM events")?.seq ?? null;
  const lastSequence = eventHighWater(t);
  return { session, revision: t.db.get("session_revision", 0), version: t.db.get("current", 0), staged_remix: !!t.db.get("staged_bundle", null),
    pending_inputs: { after: session.last_handled_seq, count: t.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE seq > ? AND type IN ('instruction','event')", session.last_handled_seq)?.n ?? 0,
      earliest_available_seq: earliest, history_gap: earliest === null
        ? lastSequence > session.last_handled_seq : earliest > session.last_handled_seq + 1 },
    timers: listTimers(t), devices: t.listDevices(),
    recent_activity: t.db.all<SessionSummary["recent_activity"][number]>("SELECT ts, kind, summary FROM activity ORDER BY seq DESC LIMIT 20") };
}
function eventHighWater(t: Tendril): number {
  // AUTOINCREMENT retains the issued sequence even when retention removes every
  // event. A checkpoint must remain valid after the referenced events expire.
  return t.db.one<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name='events'")?.seq ?? 0;
}
function fileHighWater(t: Tendril): number {
  return t.db.one<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name='file_ref_changes'")?.seq ?? 0;
}
export function putSession(t: Tendril, value: unknown, by: string): SessionResult {
  const brief = validateBrief(value);
  const previous = t.db.get("session_revision", 0);
  if (isPlainObject(value) && value.expected_revision !== undefined && value.expected_revision !== previous)
    throw new HttpError(409, "version_conflict", "The saved context changed; read it again before saving", { current_revision: previous });
  const max = eventHighWater(t);
  if (brief.last_handled_seq > max) throw new HttpError(400, "bad_request", "last_handled_seq is beyond the event history");
  t.db.set("session_brief", brief);
  t.db.set("session_revision", previous + 1);
  addActivity(t, { kind: "session", summary: "Updated the context for continuing this task", by });
  return { session: brief, revision: previous + 1 };
}

export async function exportBundle(t: Tendril, includeData: boolean): Promise<PortableBundle> {
  // Capture the logical snapshot before the first asynchronous R2 read. Later
  // state edits must not reference media that was absent from this export.
  const version = servedVersion(t);
  const fileRows = versionFiles(t, version);
  const mediaRows = includeData ? t.db.all<{ id: string; type: string; name: string | null }>(
    "SELECT id,type,name FROM blobs WHERE id NOT IN (SELECT blob_id FROM publication_blobs) OR id IN (SELECT blob_id FROM file_refs WHERE blob_id IS NOT NULL) ORDER BY id") : [];
  const shared_files = includeData ? t.db.all<SharedBundleFile>(
    "SELECT path,blob_id,name,type FROM file_refs WHERE blob_id IS NOT NULL ORDER BY path") : [];
  const brief = structuredClone(t.db.get<SessionBrief>("session_brief", EMPTY_BRIEF));
  const state = structuredClone(t.getState().state);
  const name = t.db.get("name", "Tendril");
  const files = await Promise.all(fileRows.map(async file => {
    const data = await t.env.FILES.get(fileKey(t, file.hash));
    if (!data) throw new HttpError(409, "incomplete_bundle", `Missing file ${file.path}`);
    return { path: file.path, type: file.type, base64: toBase64(await data.arrayBuffer()) };
  }));
  const media = await Promise.all(mediaRows.map(async item => {
    const data = await t.env.FILES.get(t.blobKey(item.id));
    if (!data) throw new HttpError(409, "incomplete_bundle", `Missing media ${item.id}`);
    return { ...item, base64: toBase64(await data.arrayBuffer()) };
  }));
  return { format: "tendriller-bundle", version: 2, name, files, media, shared_files,
    ...(includeData ? { state, session: { ...brief, last_handled_seq: 0 } }
      : { session: { ...EMPTY_BRIEF, purpose: brief.purpose, source: brief.source } }) };
}

function decode(value: unknown, limit: number): Uint8Array {
  if (typeof value !== "string" || value.length > Math.ceil(limit / 3) * 4 + 8 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))
    throw new HttpError(400, "bad_bundle", "Invalid or oversized base64 content");
  let bytes: Uint8Array;
  try { bytes = fromBase64(value); } catch { throw new HttpError(400, "bad_bundle", "Invalid base64 content"); }
  if (bytes.byteLength > limit) throw new HttpError(413, "too_large", "Bundle entry exceeds the file limit");
  return bytes;
}
function rewrite(value: unknown, mapping: Map<string, string>): any {
  if (typeof value === "string") { let text = value; for (const [before, after] of mapping) text = text.replaceAll(before, after); return text; }
  if (Array.isArray(value)) return value.map(v => rewrite(v, mapping));
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v, mapping)]));
  return value;
}

/** Validate the entire bundle before storing bytes; publication is a separate operation. */
export async function stageBundle(t: Tendril, value: unknown, by: string): Promise<StagedBundle> {
  return withBundleLock(t, () => stageBundleUnlocked(t, value, by));
}
async function stageBundleUnlocked(t: Tendril, value: unknown, by: string): Promise<StagedBundle> {
  if (!isPlainObject(value) || value.format !== "tendriller-bundle" || value.version !== 2) throw new HttpError(400, "bad_bundle", "Unsupported bundle format or version");
  if (t.db.get("staged_bundle", null)) throw new HttpError(409, "staged_bundle_exists", "Publish or discard the prepared copy first");
  if (typeof value.name !== "string" || !value.name.trim() || value.name.length > 200) throw new HttpError(400, "bad_bundle", "Invalid bundle name");
  if (!Array.isArray(value.files) || !value.files.length || value.files.length > MAX_FILES_PER_VERSION || !Array.isArray(value.media) ||
      !Array.isArray(value.shared_files) || value.shared_files.length > 1000)
    throw new HttpError(400, "bad_bundle", "Invalid bundle entries");
  const seen = new Set<string>();
  const files = value.files.map((f: any) => {
    if (!isPlainObject(f) || typeof f.path !== "string" || normalizeFilePath(f.path) !== f.path || seen.has(f.path) || typeof f.type !== "string" || f.type.length > 200)
      throw new HttpError(400, "bad_bundle", "Invalid or duplicate file path");
    seen.add(f.path);
    return { path: f.path, type: f.type, bytes: decode(f.base64, t.fileLimit()) };
  });
  if (!seen.has("index.html")) throw new HttpError(400, "bad_bundle", "A bundle needs index.html");
  const seenMedia = new Set<string>();
  const media = value.media.map((m: any) => {
    if (!isPlainObject(m) || typeof m.id !== "string" || !BLOB_ID_RE.test(m.id) || seenMedia.has(m.id) || typeof m.type !== "string" || m.type.length > 200 || (m.name !== null && (typeof m.name !== "string" || m.name.length > 200)))
      throw new HttpError(400, "bad_bundle", "Invalid media entry");
    seenMedia.add(m.id);
    return { id: m.id, type: m.type, name: m.name, bytes: decode(m.base64, t.blobLimit()) };
  });
  const seenShared = new Set<string>();
  const sharedFiles: SharedBundleFile[] = value.shared_files.map((f: any) => {
    if (!isPlainObject(f) || typeof f.path !== "string" || normalizeFilePath(f.path) !== f.path || seenShared.has(f.path) ||
        typeof f.blob_id !== "string" || !seenMedia.has(f.blob_id) ||
        (f.name !== null && (typeof f.name !== "string" || f.name.length > 200)) ||
        (f.type !== null && (typeof f.type !== "string" || f.type.length > 200)))
      throw new HttpError(400, "bad_bundle", "Invalid shared file reference");
    seenShared.add(f.path);
    return { path: f.path, blob_id: f.blob_id, name: f.name, type: f.type };
  });
  if (value.state !== undefined && (!isPlainObject(value.state) || JSON.stringify(value.state).length > MAX_STATE)) throw new HttpError(400, "bad_bundle", "Invalid shared state");
  const session = value.session === undefined ? undefined : { ...validateBrief(value.session), last_handled_seq: 0 };
  // Existing content-addressed files consume no additional storage. Each write
  // below checks the actual new bytes; failed staging rolls its writes back.
  const mapping = new Map<string, string>(), createdMedia: string[] = [];
  const originalHashes = new Set(t.db.all<{ hash: string }>("SELECT hash FROM stored_files").map(x => x.hash));
  const createdHashes: string[] = [];
  try {
    for (const m of media) {
      const saved = await t.storeBlob(m.bytes.buffer as ArrayBuffer, m.type, m.name, null, "agent");
      mapping.set(m.id, saved.id); createdMedia.push(saved.id);
    }
    const prepared: VersionFile[] = [];
    for (const f of files) {
      let bytes = f.bytes;
      if (/(?:text|javascript|json|xml|svg)/i.test(f.type)) bytes = new TextEncoder().encode(rewrite(new TextDecoder().decode(bytes), mapping));
      const saved = await storeContent(t, bytes.buffer as ArrayBuffer, f.type);
      if (!originalHashes.has(saved.hash)) createdHashes.push(saved.hash);
      prepared.push({ path: f.path, type: f.type, ...saved });
    }
    const state = value.state === undefined ? undefined : rewrite(value.state, mapping);
    const staged: StagedBundle = { name: value.name.trim(), files: prepared, media: createdMedia,
      sharedFiles: sharedFiles.map(f => ({ ...f, blob_id: mapping.get(f.blob_id)! })), expectedFileCursor: fileHighWater(t),
      ...(state ? { state } : {}), ...(session ? { session } : {}) };
    t.transaction(() => {
      assertStoredContent(t, prepared);
      t.db.set("staged_bundle", staged);
      addActivity(t, { kind: "remix", summary: "Prepared an independent copy; waiting for publication", by });
    });
    return staged;
  } catch (e) {
    for (const id of createdMedia) await t.deleteBlob(id);
    for (const hash of new Set(createdHashes)) await deleteUnreferencedContent(t, hash);
    throw e;
  }
}

export async function publishStaged(t: Tendril, by: string, expectedVersion: unknown, command: Preconditions) {
  return withBundleLock(t, () => publishStagedUnlocked(t, by, expectedVersion, command));
}
async function publishStagedUnlocked(t: Tendril, by: string, expectedVersion: unknown, command: Preconditions) {
  preconditions(command);
  const actor = `agent:${by}`, targets = { operations: ["bundle.publish"] }, payload = { expected_version: expectedVersion };
  const previous = replay<{ version: number; restored: boolean }>(t, actor, command, targets, payload);
  if (previous.found) return previous.result;
  const staged = t.db.get<StagedBundle | null>("staged_bundle", null);
  if (!staged) throw new HttpError(404, "not_found", "No prepared copy");
  const current = t.db.get("current", 0);
  if (expectedVersion !== current) throw new HttpError(409, "version_conflict", "The page changed; review its current version before replacing it", { current });
  if (fileHighWater(t) !== staged.expectedFileCursor)
    throw new HttpError(409, "file_conflict", "Shared files changed since this bundle was staged; discard and stage it again");
  if (!latestFileMap(t).has("index.html")) {
    const facts = t.presenceFacts();
    if (t.db.get<string>("mode", "interactive") !== "dashboard" && !facts.agentSocket && !facts.longPollHeld && !facts.webhook)
      throw new HttpError(428, "listener_required", "Connect this page to its agent conversation before publishing the prepared copy");
  }
  // Staging may be reviewed across browser closures and deployments. Do not
  // publish broken references if storage was removed before the review finished.
  for (const file of staged.files) {
    const stored = t.db.one<{ size: number }>("SELECT size FROM stored_files WHERE hash=?", file.hash);
    const object = stored ? await t.env.FILES.head(fileKey(t, file.hash)) : null;
    if (!object || object.size !== file.size) throw new HttpError(409, "incomplete_bundle", `Prepared file ${file.path} is missing; discard and prepare the bundle again`);
  }
  for (const id of staged.media) {
    const stored = t.db.one<{ size: number }>("SELECT size FROM blobs WHERE id=?", id);
    const object = stored ? await t.env.FILES.head(t.blobKey(id)) : null;
    if (!object || object.size !== stored!.size) throw new HttpError(409, "incomplete_bundle", "Prepared media is missing; discard and prepare the bundle again");
  }
  const version = await createVersion(t, new Map(staged.files.map(f => [f.path, f])), "Restored from a portable bundle", by, {
    expectedCurrent: current,
    commit: () => { mutate(t, actor, command, targets, payload, () => {
      checkGenerations(t, command, { paths: staged.state ? [[]] : [], operations: ["bundle.publish"] });
      if (staged.state) t.applyState([{ op: "set", path: [], value: staged.state }], `agent:${by}`, undefined, command);
      if (staged.session) { t.db.set("session_brief", staged.session); t.db.set("session_revision", t.db.get("session_revision", 0) + 1); }
      const nextFiles = new Map(staged.sharedFiles.map(file => [file.path, file]));
      const oldFiles = t.db.all<{ path: string; revision: number; blob_id: string | null }>("SELECT path,revision,blob_id FROM file_refs ORDER BY path");
      const oldRevisions = new Map(oldFiles.map(file => [file.path, file.revision]));
      const now = t.now(), fileActor = `agent:${by}`;
      for (const old of oldFiles) {
        if (old.blob_id === null || nextFiles.has(old.path)) continue;
        const revision = old.revision + 1;
        t.db.run("UPDATE file_refs SET revision=?,blob_id=NULL,name=NULL,type=NULL,scope=NULL,updated_at=?,by_actor=? WHERE path=?",
          revision, now, fileActor, old.path);
        t.db.run("INSERT INTO file_ref_changes(path,revision,blob_id,name,type,scope,updated_at,by_actor,cid) VALUES(?,?,NULL,NULL,NULL,NULL,?,?,?)",
          old.path, revision, now, fileActor, command.cid);
      }
      for (const file of staged.sharedFiles) {
        const revision = (oldRevisions.get(file.path) ?? 0) + 1;
        t.db.run("INSERT INTO file_refs(path,revision,blob_id,name,type,scope,updated_at,by_actor) VALUES(?,?,?,?,?,NULL,?,?) ON CONFLICT(path) DO UPDATE SET revision=excluded.revision,blob_id=excluded.blob_id,name=excluded.name,type=excluded.type,scope=NULL,updated_at=excluded.updated_at,by_actor=excluded.by_actor",
          file.path, revision, file.blob_id, file.name, file.type, now, fileActor);
        t.db.run("INSERT INTO file_ref_changes(path,revision,blob_id,name,type,scope,updated_at,by_actor,cid) VALUES(?,?,?,?,?,NULL,?,?,?)",
          file.path, revision, file.blob_id, file.name, file.type, now, fileActor, command.cid);
      }
      t.db.del("staged_bundle");
      return { version: t.db.get("current", 0), restored: true };
    }); },
    beforeReload: () => { if (staged.state) t.broadcast({ t: "state_reset", ...t.getState() }); },
  });
  addActivity(t, { kind: "remix", summary: `Published prepared copy as version ${version}`, by });
  return { version, restored: true };
}

export async function discardStaged(t: Tendril): Promise<void> {
  return withBundleLock(t, () => discardStagedUnlocked(t));
}
async function discardStagedUnlocked(t: Tendril): Promise<void> {
  const staged = t.db.get<StagedBundle | null>("staged_bundle", null);
  if (!staged) return;
  t.db.del("staged_bundle");
  for (const id of staged.media) await t.deleteBlob(id);
  for (const file of staged.files) await deleteUnreferencedContent(t, file.hash);
}

export async function remix(t: Tendril, req: Request, body: unknown, by: string, ownerPage = false): Promise<Response> {
  if (!isPlainObject(body)) throw new HttpError(400, "bad_request", "Expected remix settings");
  let owner = body.owner;
  if (ownerPage) {
    owner = (await t.env.ACCOUNTS.prepare("SELECT email FROM accounts WHERE id=?").bind(t.db.get("owner_account", null)).first<{ email: string }>())?.email;
  }
  if (typeof owner !== "string" || !owner.includes("@")) throw new HttpError(400, "bad_request", "Supply the new owner's verified email");
  const bundle = await exportBundle(t, body.include_data === true);
  const { route } = await import("./router");
  const created = await route(new Request(`${publicBase(t.env)}/api/tendrils`, { method: "POST", headers: {
    "Content-Type": "application/json", "CF-Connecting-IP": req.headers.get("CF-Connecting-IP") ?? "remix" },
    body: JSON.stringify({ owner, name: body.name ?? `${bundle.name.slice(0, 85)} copy` }) }), t.env);
  if (!created.ok) return created;
  const handle = await created.json<{ id: string; api: string; token: string; page_url: string }>();
  const destination = t.env.TENDRIL.get(t.env.TENDRIL.idFromName(handle.id));
  const staged = await destination.fetch(new Request("https://tendril.internal/agent", { method: "PUT", headers: {
    Authorization: `Bearer ${handle.token}`, "Content-Type": "application/json", "x-tendril-rest": "bundle" }, body: JSON.stringify(bundle) }));
  if (!staged.ok) {
    await destination.fetch(new Request("https://tendril.internal/agent", { method: "DELETE", headers: { Authorization: `Bearer ${handle.token}`, "x-tendril-rest": "" } }));
    return staged;
  }
  addActivity(t, { kind: "remix", summary: "Created an independent copy", by });
  const setup = { staged: true, requires_receiver: true, publish_url: `${handle.api}/bundle/publish`, expected_version: 0 };
  return json(ownerPage ? { page_url: handle.page_url, remix: setup,
    next_step: "Open your copy, then use Connect an agent to continue and publish it." } : { ...handle, remix: setup }, 201);
}
