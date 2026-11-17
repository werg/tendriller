import type { Tendril } from "./tendril";
import { checkGenerations, preconditions, mutate, replay, type Preconditions } from "./scopes";
import { addActivity } from "./activity";
import { createVersion, servedVersion, versionFiles, type VersionFile } from "./files";
import { assertStoredContent, deleteUnreferencedContent, fileKey, storeContent } from "./content";
import { HttpError, isPlainObject, json } from "./http";
import { fromBase64, sha256Hex, toBase64 } from "./ids";
import { MAX_STATE } from "./limits";
import { publicBase } from "./urls";
import { commitImportedFiles } from "./storage";
import { assertFilePath, assertValid } from "../../contract/index.mjs";
import { listTimers } from "./timers";
import { selectedApplication } from "./application";
import type { SessionBrief, SessionResult, SessionSummary, PortableBundle } from "../../contract/index.mjs";
export type { SessionBrief, SessionResult, SessionSummary, PortableBundle } from "../../contract/index.mjs";
type SharedFile = NonNullable<PortableBundle["shared_files"]>[number];
interface StagedBundle {
  name: string; entry: string; files: VersionFile[]; state?: Record<string, unknown>; session?: SessionBrief;
  media: string[]; shared_files: SharedFile[]; expected_head_revision: number; expected_file_revisions: Record<string, number>;
}
export const MAX_BUNDLE_BYTES = 36 * 1024 * 1024;
const EMPTY_BRIEF: SessionBrief = { purpose: "", current_task: "", completed: [], decisions: [], open_questions: [], last_handled_seq: 0 };
const bundleOperations = new WeakSet<Tendril>();
function requireHostedPublication(t: Tendril): void {
  if (selectedApplication(t).kind === 'peer')
    throw new HttpError(409, 'signed_release_required', 'Peer page portability uses signed Chronolog release manifests and exact content');
}
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

/** Find immutable IDs in application values without treating arbitrary state as a retention root. */
function referencedBlobs(value: unknown, ids = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    for (const match of value.matchAll(/(?:^|[^A-Za-z0-9_])(b_[a-z2-7]{20})(?![A-Za-z0-9_])/g)) ids.add(match[1]);
  } else if (Array.isArray(value)) for (const item of value) referencedBlobs(item, ids);
  else if (isPlainObject(value)) for (const [key, item] of Object.entries(value)) { referencedBlobs(key, ids); referencedBlobs(item, ids); }
  return ids;
}

async function snapshotBytes(t: Tendril, hash: string, size: number, label: string): Promise<ArrayBuffer> {
  const object = await t.env.FILES.get(fileKey(t, hash));
  if (!object) throw new HttpError(409, "incomplete_bundle", `Missing ${label}`);
  const bytes = await object.arrayBuffer();
  if (bytes.byteLength !== size || await sha256Hex(bytes) !== hash)
    throw new HttpError(409, "incomplete_bundle", `Changed ${label}; prepare a verified copy again`);
  return bytes;
}

export async function exportBundle(t: Tendril, includeData: boolean): Promise<PortableBundle> {
  requireHostedPublication(t);
  // Snapshot every logical reference before the first asynchronous content read.
  const version = servedVersion(t), fileRows = versionFiles(t, version);
  const entry = t.db.one<{ entry: string }>("SELECT entry FROM versions WHERE version=?", version)?.entry;
  if (!entry || !fileRows.some(file => file.path === entry)) throw new HttpError(409, "no_publication", "Publish a complete page before exporting a portable bundle");
  const brief = structuredClone(t.db.get<SessionBrief>("session_brief", EMPTY_BRIEF));
  const state = structuredClone(t.getState().state), name = t.db.get("name", "Tendril");
  const sharedFiles: SharedFile[] = includeData ? t.db.all<{ path: string; blob_id: string; name: string | null; type: string | null }>(
    "SELECT path,blob_id,name,type FROM file_refs WHERE blob_id IS NOT NULL ORDER BY path").map(file => ({
      path: file.path, blob_id: file.blob_id, ...(file.name === null ? {} : { name: file.name }), ...(file.type === null ? {} : { type: file.type }),
    })) : [];
  const explicit = referencedBlobs(state);
  for (const file of sharedFiles) explicit.add(file.blob_id);
  const publicationBlobs = new Set(t.db.all<{ blob_id: string }>("SELECT DISTINCT blob_id FROM publication_blobs").map(row => row.blob_id));
  const mediaRows = includeData ? t.db.all<{ id: string; sha256: string; size: number; type: string; name: string | null }>(
    "SELECT id,sha256,size,type,name FROM blobs ORDER BY id").filter(row => !publicationBlobs.has(row.id) || explicit.has(row.id)) : [];
  const selected = new Set(mediaRows.map(row => row.id));
  if (sharedFiles.some(file => !selected.has(file.blob_id))) throw new HttpError(409, "incomplete_bundle", "A shared-file head has no retained immutable content");
  const bundle: PortableBundle = {
    format: "tendriller-bundle", version: 3, entry, name,
    files: fileRows.map(file => ({ path: file.path, type: file.type, base64: "" })),
    media: mediaRows.map(item => ({ id: item.id, type: item.type, name: item.name, base64: "" })),
    ...(includeData ? { state, shared_files: sharedFiles, session: { ...brief, last_handled_seq: 0 } }
      : { session: { ...EMPTY_BRIEF, purpose: brief.purpose, source: brief.source } }),
  };
  // Logical aliases can exceed physical storage: bound the actual portable payload
  // before fetching repeated bodies rather than allocating an unbounded export.
  const encodedBytes = [...fileRows, ...mediaRows].reduce((sum, row) => sum + 4 * Math.ceil(row.size / 3), 0);
  if (new TextEncoder().encode(JSON.stringify(bundle)).byteLength + encodedBytes > MAX_BUNDLE_BYTES)
    throw new HttpError(413, "bundle_too_large", "Selected portable content exceeds the bundle transfer limit", { limit: MAX_BUNDLE_BYTES });
  for (let i = 0; i < fileRows.length; i++) {
    const file = fileRows[i];
    bundle.files[i].base64 = toBase64(await snapshotBytes(t, file.hash, file.size, `file ${file.path}`));
  }
  for (let i = 0; i < mediaRows.length; i++) {
    const item = mediaRows[i];
    bundle.media[i].base64 = toBase64(await snapshotBytes(t, item.sha256, item.size, `media ${item.id}`));
  }
  return bundle;
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
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [rewrite(k, mapping), rewrite(v, mapping)]));
  return value;
}

/** Validate the entire bundle before storing bytes; publication is a separate operation. */
export async function stageBundle(t: Tendril, value: unknown, by: string): Promise<StagedBundle> {
  requireHostedPublication(t);
  return withBundleLock(t, () => stageBundleUnlocked(t, value, by));
}
async function stageBundleUnlocked(t: Tendril, value: unknown, by: string): Promise<StagedBundle> {
  const bundle = assertValid("bundle", value);
  if (t.db.get("staged_bundle", null)) throw new HttpError(409, "staged_bundle_exists", "Publish or discard the prepared copy first");
  if (new TextEncoder().encode(JSON.stringify(bundle)).byteLength > MAX_BUNDLE_BYTES)
    throw new HttpError(413, "bundle_too_large", "Portable content exceeds the bundle transfer limit", { limit: MAX_BUNDLE_BYTES });
  const seen = new Set<string>();
  const files = bundle.files.map(f => {
    try { assertFilePath(f.path); } catch { throw new HttpError(400, "bad_bundle", "Invalid file path"); }
    if (seen.has(f.path)) throw new HttpError(400, "bad_bundle", "Duplicate file path");
    seen.add(f.path);
    return { path: f.path, type: f.type, bytes: decode(f.base64, t.fileLimit()) };
  });
  const entry = files.find(file => file.path === bundle.entry);
  if (!entry || !/\.html?$/i.test(entry.path) || !/^text\/html(?:;|$)/i.test(entry.type))
    throw new HttpError(400, "bad_bundle", "The bundle requires its declared authored HTML entry");
  const seenMedia = new Set<string>();
  const media = bundle.media.map(m => {
    if (seenMedia.has(m.id)) throw new HttpError(400, "bad_bundle", "Duplicate media identity");
    seenMedia.add(m.id);
    return { id: m.id, type: m.type, name: m.name, bytes: decode(m.base64, t.blobLimit()) };
  });
  const sharedPaths = new Set<string>();
  const sharedFiles = (bundle.shared_files ?? []).map(file => {
    assertValid("fileWrite", { ...file, cid: "bundle-stage", expected_generations: {}, expected_revision: 0 });
    if (sharedPaths.has(file.path) || !seenMedia.has(file.blob_id))
      throw new HttpError(400, "bad_bundle", "Shared-file paths must be unique and reference media included in this bundle");
    sharedPaths.add(file.path);
    return { ...file };
  });
  // Capture the destination preconditions now, before storage awaits allow another writer.
  const expectedHeadRevision = t.db.get<number>("publication_head_revision", 0);
  const expectedRevisions = Object.fromEntries(sharedFiles.map(file => [file.path,
    t.db.one<{ revision: number }>("SELECT revision FROM file_refs WHERE path=?", file.path)?.revision ?? 0]));
  if (bundle.state !== undefined && JSON.stringify(bundle.state).length > MAX_STATE) throw new HttpError(400, "bad_bundle", "Invalid shared state");
  const session = bundle.session === undefined ? undefined : { ...validateBrief(bundle.session), last_handled_seq: 0 };
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
    const state = bundle.state === undefined ? undefined : rewrite(bundle.state, mapping);
    const staged: StagedBundle = { name: bundle.name.trim(), entry: entry.path, files: prepared, media: createdMedia,
      shared_files: sharedFiles.map(file => ({ ...file, blob_id: mapping.get(file.blob_id)! })), expected_head_revision: expectedHeadRevision, expected_file_revisions: expectedRevisions,
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

export async function publishStaged(t: Tendril, by: string, expectedHeadRevision: number, command: Preconditions) {
  requireHostedPublication(t);
  return withBundleLock(t, () => publishStagedUnlocked(t, by, expectedHeadRevision, command));
}
async function publishStagedUnlocked(t: Tendril, by: string, expectedHeadRevision: number, command: Preconditions) {
  preconditions(command);
  const actor = `agent:${by}`, targets = { paths: [["publications"]], operations: ["bundle.publish", "publication.publish"] },
    payload = { expected_head_revision: expectedHeadRevision };
  const previous = replay<{ version: number; head_revision: number; restored: true }>(t, actor, command, targets, payload);
  if (previous.found) return previous.result;
  const staged = t.db.get<StagedBundle | null>("staged_bundle", null);
  if (!staged) throw new HttpError(404, "not_found", "No prepared copy");
  const headRevision = t.db.get<number>("publication_head_revision", 0);
  if (expectedHeadRevision !== headRevision) throw new HttpError(409, "publication_conflict", "The publication head changed; review it before replacing the page", { head_revision: headRevision });
  const writeTargets = {
    paths: [...targets.paths, ...(staged.state ? [[]] : []), ...(staged.shared_files.length ? [["files"]] : [])],
    operations: [...targets.operations, ...(staged.shared_files.length ? ["file.write"] : [])],
  };
  checkGenerations(t, command, writeTargets);
  if (!t.db.get<number>("latest", 0)) {
    const facts = t.presenceFacts();
    if (t.db.get<string>("mode", "interactive") !== "dashboard" && !facts.agentSocket && !facts.webhook)
      throw new HttpError(428, "listener_required", "Connect this page to its agent conversation before publishing the prepared copy");
  }
  // Staging may be reviewed across browser closures and deployments. Do not
  // publish broken references if storage was removed before the review finished.
  for (const file of staged.files) await snapshotBytes(t, file.hash, file.size, `prepared file ${file.path}`);
  for (const id of staged.media) {
    const stored = t.db.one<{ sha256: string; size: number }>("SELECT sha256,size FROM blobs WHERE id=?", id);
    if (!stored) throw new HttpError(409, "incomplete_bundle", "Prepared media is missing; discard and prepare the bundle again");
    await snapshotBytes(t, stored.sha256, stored.size, `prepared media ${id}`);
  }
  const version = await createVersion(t, new Map(staged.files.map(f => [f.path, f])), "Restored from a portable bundle", by, {
    entry: staged.entry, expectedHeadRevision,
    commit: () => { mutate(t, actor, command, targets, payload, () => {
      checkGenerations(t, command, writeTargets);
      commitImportedFiles(t, staged.shared_files, staged.expected_file_revisions, actor, command.cid);
      if (staged.state) t.applyState([{ op: "set", path: [], value: staged.state }], `agent:${by}`, undefined, command);
      if (staged.session) { t.db.set("session_brief", staged.session); t.db.set("session_revision", t.db.get("session_revision", 0) + 1); }
      t.db.del("staged_bundle");
      return { version: t.db.get("current", 0), head_revision: t.db.get<number>("publication_head_revision", 0), restored: true };
    }); },
    beforeReload: () => { if (staged.state) t.broadcast({ t: "state_reset", ...t.getState() }); },
  });
  addActivity(t, { kind: "remix", summary: `Published prepared copy as version ${version}`, by });
  return { version, head_revision: t.db.get<number>("publication_head_revision", 0), restored: true as const };
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
  const setup = { staged: true, requires_receiver: true, publish_url: `${handle.api}/bundle/publish`, expected_head_revision: (await staged.json<{ expected_head_revision: number }>()).expected_head_revision };
  return json(ownerPage ? { page_url: handle.page_url, remix: setup,
    next_step: "Open your copy, then use Connect an agent to continue and publish it." } : { ...handle, remix: setup }, 201);
}
