import type { Tendril } from "./tendril";
import { assertValid } from "../../contract/index.mjs";
import { deviceConfiguration, getFocus, setFocus, updateDevice } from "./device-roles";
import { deleteTimer, listTimers, saveTimer, timerHistory } from "./timers";
import { discardStaged, exportBundle, MAX_BUNDLE_BYTES, publishStaged, putSession, remix, sessionSummary, stageBundle } from "./portability";
import { HttpError, json, readJson } from "./http";
import type { AgentPrincipal, PagePrincipal } from "./access";

export const EXPERIENCE_ROUTE = /^(?:focus|timers(?:\/[^/]+)?|session|bundle(?:\/publish)?|remix)$/;

export async function handleExperience(t: Tendril, req: Request, url: URL, principal: AgentPrincipal | PagePrincipal, rest: string): Promise<Response> {
  const method = req.method === "HEAD" ? "GET" : req.method;
  const ownerPage = principal.kind === "page", by = ownerPage ? "owner" : principal.name;
  const actor = `${principal.kind}:${principal.name}`;
  if (rest === "focus") {
    if (method === "GET") return json({ focus: getFocus(t) });
    if (method === "POST") { setFocus(t, assertValid("focusRequest", await readJson(req, 4096)), by); return json(deviceConfiguration(t)); }
  }
  if (rest === "devices" && ownerPage) {
    if (method === "GET") return json(deviceConfiguration(t));
    if (method === "PATCH") { const body = assertValid("deviceUpdate", await readJson(req, 4096)); updateDevice(t, body.id ?? "", body, by); return json(deviceConfiguration(t)); }
  }
  if (rest === "timers") {
    if (method === "GET") return json({ timers: listTimers(t), execution: "server", lifetime: t.db.get("lifetime", "ad_hoc"), expires_at: t.expiresAt() });
    if (method === "POST") return json(saveTimer(t, await readJson(req, 64 * 1024), actor, undefined, by), 201);
  }
  if (rest === "timers/history" && method === "GET") return json({ runs: timerHistory(t) });
  const timer = /^timers\/([a-zA-Z0-9-]+)$/.exec(rest);
  if (timer && timer[1] !== "history") {
    if (method === "PATCH") return json(saveTimer(t, await readJson(req, 64 * 1024), actor, timer[1], by));
    if (method === "DELETE") return json(deleteTimer(t, timer[1], await readJson(req, 64 * 1024), actor, by));
  }
  if (rest === "session") {
    if (method === "GET") return json(sessionSummary(t));
    if (method === "PUT") return json(putSession(t, assertValid("sessionWrite", await readJson(req, 256 * 1024)), by));
  }
  if (rest === "bundle" && method === "GET") return json(await exportBundle(t, url.searchParams.get("include_data") === "true"), 200,
    { "Content-Disposition": 'attachment; filename="tendriller-bundle.json"' });
  if (rest === "bundle" && method === "PUT") {
    const body = assertValid("bundle", await readJson(req, MAX_BUNDLE_BYTES));
    const staged = await stageBundle(t, body, by);
    return json({ staged: true, files: staged.files.length, media: staged.media.length, expected_head_revision: staged.expected_head_revision, requires_publication: true }, 202);
  }
  if (rest === "bundle/publish" && method === "POST") {
    const body = assertValid("bundlePublish", await readJson(req, 32 * 1024));
    return json(await publishStaged(t, by, body.expected_head_revision, body));
  }
  if (rest === "bundle" && method === "DELETE") { await discardStaged(t); return new Response(null, { status: 204 }); }
  if (rest === "remix" && method === "POST") return remix(t, req, assertValid(ownerPage ? "remixPage" : "remix", await readJson(req, 4096)), by, ownerPage);
  throw new HttpError(405, "method_not_allowed", `${req.method} is not available for ${rest}`);
}
