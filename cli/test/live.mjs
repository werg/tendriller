// Live integration check against a running server (not part of `node --test`).
//   TENDRIL_SERVER=http://localhost:8707 node cli/test/live.mjs
// Simulates a page with a WebSocket (PROTOCOL section 7) and exercises every CLI
// command plus tendril-wait.sh. Prints one line per check; exits 1 on any failure.
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "../bin/tendril.mjs");
const WAIT = join(here, "../scripts/tendril-wait.sh");
const SERVER = process.env.TENDRIL_SERVER || "http://localhost:8707";
const cfgDir = mkdtempSync(join(tmpdir(), "tendril-live-"));
const env = { ...process.env, TENDRIL_SERVER: SERVER, TENDRIL_CONFIG_DIR: cfgDir };
let failures = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : "  " + JSON.stringify(detail)?.slice(0, 600)}`);
  if (!ok) failures++;
}
function cli(...args) {
  return new Promise((ok) => execFile("node", [CLI, "--tendril", "live", ...args], { env, timeout: 60000 }, (err, stdout, stderr) => {
    let json = null;
    try { json = JSON.parse(stdout.trim().split("\n").pop()); } catch { /* not json */ }
    ok({ code: err ? (err.code ?? 1) : 0, stdout, stderr, json });
  }));
}

// ---- fake page ---------------------------------------------------------------
class FakePage {
  constructor(pageUrl, name = "fake") {
    this.pageUrl = pageUrl; this.name = name; this.msgs = []; this.waiters = [];
    this.deviceId = "d_" + "abcdefghijklmnop".split("").sort(() => Math.random() - 0.5).join("");
    this.secret = "s".repeat(32);
    this.cid = 0;
  }
  async connect() {
    const html = await (await fetch(this.pageUrl)).text();
    const m = /window\.__TENDRIL__=(\{.*?\});<\/script>/.exec(html);
    if (!m) throw new Error("no __TENDRIL__ in page: " + html.slice(0, 200));
    this.cfg = JSON.parse(m[1]);
    const origin = new URL(this.pageUrl).origin.replace(/^http/, "ws");
    this.ws = new WebSocket(origin + this.cfg.ws);
    this.ws.onmessage = (e) => this.onMsg(JSON.parse(e.data));
    await new Promise((ok, no) => { this.ws.onopen = ok; this.ws.onerror = no; });
    this.ws.send(JSON.stringify({ t: "hello", device_id: this.deviceId, device_secret: this.secret, name: this.name, ua: "live-test", version: this.cfg.version, rev: 0, caps: {} }));
    this.welcome = await this.next("welcome");
    return this;
  }
  onMsg(msg) {
    this.msgs.push(msg);
    if (msg.t === "eval") this.runEval(msg);
    if (msg.t === "check") this.ws.send(JSON.stringify({ t: "eval_result", call_id: msg.call_id, ok: true, value: { ok: true, violations: [] } }));
    if (msg.t === "reload" && this.autoHealth) {
      this.ws.send(JSON.stringify({ t: "health", version: msg.version, ok: this.autoHealth === "ok", errors: this.autoHealth === "ok" ? [] : ["TypeError: boom"] }));
    }
    this.waiters = this.waiters.filter((w) => (w.t === msg.t ? (w.ok(msg), false) : true));
  }
  async runEval(msg) {
    try {
      const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
      const value = await new AsyncFunction("document", msg.code)({ title: "Fake page" });
      this.ws.send(JSON.stringify({ t: "eval_result", call_id: msg.call_id, ok: true, value: value ?? null }));
    } catch (e) {
      this.ws.send(JSON.stringify({ t: "eval_result", call_id: msg.call_id, ok: false, error: String(e) }));
    }
  }
  next(t, ms = 10000) {
    return new Promise((ok, no) => {
      this.waiters.push({ t, ok });
      setTimeout(() => no(new Error(`timeout waiting for ${t}`)), ms);
    });
  }
  send(data, wake = true) { this.ws.send(JSON.stringify({ t: "send", cid: "c" + ++this.cid, data, wake })); }
  request(msg) { const cid = "c" + ++this.cid; this.ws.send(JSON.stringify({ ...msg, cid })); return cid; }
  close() { this.ws.close(); }
}

// ---- run ---------------------------------------------------------------------
const r0 = await new Promise((ok) => execFile("node", [CLI, "new", "Live Test", "--as", "live"], { env }, (e, so, se) => ok({ e, so, se })));
let handle;
try { handle = JSON.parse(r0.so); } catch { /* */ }
check("new", handle && handle.token && handle.page_url, r0);
if (!handle) process.exit(1);
check("new prints QR/URL on stderr", r0.se.includes(handle.page_url), r0.se.slice(0, 200));
check("new writes config 600", (await import("node:fs")).statSync(join(cfgDir, "live.json")).mode % 512 === 0o600);

const page = await new FakePage(handle.page_url).connect();
check("fake page welcomed", page.welcome && page.welcome.role === "owner", page.welcome);
page.autoHealth = "ok";

const dir = mkdtempSync(join(tmpdir(), "tendril-page-"));
writeFileSync(join(dir, "index.html"), "<!doctype html><html><head><title>Live</title></head><body><button onclick=\"tendril.send({tap:1})\">Tap</button></body></html>");
writeFileSync(join(dir, ".secret"), "nope");
mkdirSync(join(dir, "img")); writeFileSync(join(dir, "img", "x.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 255]));
let r = await cli("push", dir, "--message", "first");
check("push dir -> healthy", r.json && r.json.status === "healthy" && r.json.files?.length === 2, r);
r = await cli("files");
check("files lists 2, no dotfile", r.json?.files?.length === 2 && !JSON.stringify(r.json).includes(".secret"), r.json);
r = await cli("versions");
check("versions", r.json?.versions?.length >= 1, r.json);
const served = await (await fetch(handle.page_url + "img/x.png")).arrayBuffer();
check("binary file served intact", Buffer.from(served).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 255])), Buffer.from(served));

// failing push -> rollback
page.autoHealth = "fail";
writeFileSync(join(dir, "index.html"), "<p>broken</p>");
r = await cli("push", dir);
check("push failing version -> failed, exit 3", r.json?.status === "failed" && r.code === 3, r);
page.autoHealth = "ok";
r = await cli("info");
check("info shows current = healthy after rollback", r.json?.version && r.json.version.current === r.json.version.healthy, r.json);

r = await cli("eval", "return 6*7");
check("eval", r.json?.ok === true && r.json.value === 42, r);
r = await cli("eval", "throw new Error('x')");
check("eval error -> ok:false exit 1", r.json?.ok === false && r.code === 1, r);

// state
r = await cli("state", "set", "items.k1", '{"text":"milk","done":false}');
check("state set", typeof r.json?.rev === "number", r);
r = await cli("state", "patch", '{"title":"Shop","_about":{"purpose":"test"}}');
check("state patch", typeof r.json?.rev === "number", r);
r = await cli("state", "get", "items.k1.text");
check("state get path", r.json === "milk", r);
r = await cli("state", "delete", "items.k1");
r = await cli("state", "get");
check("state delete + get", r.json?.state && !r.json.state.items?.k1 && r.json.state.title === "Shop", r.json);

// logs
page.ws.send(JSON.stringify({ t: "log", entries: [{ level: "warn", message: "hello log", ts: Date.now() }] }));
await sleep(500);
r = await cli("logs");
check("logs", JSON.stringify(r.json || {}).includes("hello log"), r.json);

// events + wait script
r = await cli("events", "--after", "0");
check("events (after 0)", Array.isArray(r.json?.events), r);
const waitEnv = { ...env, TENDRIL_API: handle.api, TENDRIL_TOKEN: handle.token };
const cursorFile = join(cfgDir, "wait.cursor");
writeFileSync(cursorFile, String(r.json?.cursor ?? 0));
page.send({ quiet: true }, false);
const t0 = Date.now();
const waiter = spawn("sh", [WAIT, cursorFile], { env: waitEnv });
let wout = "";
waiter.stdout.on("data", (d) => (wout += d));
waiter.stderr.on("data", (d) => (wout += d));
const exited = new Promise((ok) => waiter.on("exit", ok));
await sleep(3000);
check("wait.sh still blocking without wake", waiter.exitCode === null, wout);
page.send({ type: "dinner_request" }, true);
const code = await Promise.race([exited, sleep(15000).then(() => "timeout")]);
check(`tendril-wait.sh exits 0 on wake (${Date.now() - t0} ms)`, code === 0 && /2 event\(s\)/.test(wout) && wout.includes("dinner_request"), { code, wout });
check("cursor advanced", Number(readFileSync(cursorFile, "utf8")) > 0, readFileSync(cursorFile, "utf8"));
if (code === "timeout") waiter.kill();

// CLI wait
const cw = cli("wait", "--cursor-file", join(cfgDir, "cli.cursor"));
await sleep(1500);
page.send({ again: 1 }, true);
r = await cw;
check("tendril wait exits on wake", r.code === 0 && r.json?.events?.length >= 1, r);

// instruction from the control
page.ws.send(JSON.stringify({ t: "send", cid: "ins1", kind: "instruction", text: "add eggs", via: "text", data: null }));
await sleep(500);
r = await cli("events", "--peek");
const ins = (r.json?.events || []).find((e) => e.type === "instruction");
check("owner instruction event", ins && ins.role === "owner" && ins.data?.text === "add eggs", r.json);

r = await cli("say", "hello there");
await sleep(300);
const sayMsg = page.msgs.find((m) => m.t === "say");
check("say", r.json?.ok === true && sayMsg?.text === "hello there", { r: r.json, sayMsg });
r = await cli("status", "working", "Looking", "things", "up");
check("status", r.json?.presence !== undefined, r);
r = await cli("devices");
check("devices", r.json?.devices?.some((d) => d.connected), r.json);
r = await cli("link", "guest", "--label", "back seat");
check("link guest", r.json?.url && r.json.role === "guest", r);
r = await cli("link", "list");
check("link list", Array.isArray(r.json?.links), r);
r = await cli("rollback");
check("rollback (exit 0 or a clear error)", r.code === 0 ? typeof r.json?.version === "number" : /error/.test(r.stderr), r);
r = await cli("wake", "--schedule", "30", "--page-streak", "4");
check("wake schedule+budget", r.json?.schedule_minutes === 30 && r.json?.budget?.page_streak === 4, r);
r = await cli("wake", "--webhook", "https://example.invalid/hook", "--token", "sec");
check("wake webhook", r.json?.webhook?.url === "https://example.invalid/hook" && r.json.webhook.has_token === true, r);
r = await cli("wake", "--off", "--schedule", "off");
check("wake off", r.json?.webhook === null && r.json?.schedule_minutes == null, r);
r = await cli("activity", "--note", "added three items");
check("activity note", r.code === 0, r);
r = await cli("activity");
check("activity list", Array.isArray(r.json?.entries) && r.json.entries.some((e) => e.source === "agent"), r.json);
r = await cli("check");
check("check", r.code === 0 && r.json && "violations" in r.json, r);
r = await cli("notify", "Build done", "Approve?");
check("notify", r.code === 0 && typeof r.json?.sent === "number", r);
writeFileSync(join(cfgDir, "icon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
r = await cli("upload", join(cfgDir, "icon.svg"));
check("upload blob", r.json?.id?.startsWith("b_"), r);
r = await cli("meta", "--short-name", "Live", "--icon", r.json?.id || "x", "--resident");
check("meta", r.json?.lifetime === "resident", r);
r = await cli("tokens", "new", "sam-agent");
check("tokens new", r.json?.token?.startsWith("tk_"), r);
r = await cli("tokens");
check("tokens list", r.json?.tokens?.length >= 2, r);
r = await cli("rules", "set", '[{"id":"tick","when":{"type":"interval","minutes":30},"do":[{"type":"event","data":{"x":1}}]}]');
r = await cli("rules");
check("rules set/get", r.json?.rules?.[0]?.id === "tick", r);

// adoption via a code from the owner device
page.request({ t: "adopt_code" });
const codeMsg = await page.next("adopt_code").catch(() => null);
check("adopt code from owner device", codeMsg?.code, page.msgs.slice(-4));
if (codeMsg?.code) {
  const ra = await new Promise((ok) => execFile("node", [CLI, "adopt", codeMsg.code, "--as", "live"], { env }, (e, so, se) => ok({ e, so, se })));
  let h2; try { h2 = JSON.parse(ra.so); } catch { /* */ }
  check("adopt -> fresh token", h2?.token && h2.token !== handle.token, ra);
  const old = await fetch(handle.api, { headers: { authorization: `Bearer ${handle.token}` } });
  check("old token revoked", old.status === 401, old.status);
  r = await cli("info");
  check("config updated by adopt", r.code === 0, r);
}

page.close();
r = await cli("rm");
check("rm without --yes refused", r.code !== 0);
r = await cli("rm", "--yes");
check("rm", r.json?.ok === true, r);

console.log(failures ? `${failures} FAILED` : "ALL PASSED");
process.exit(failures ? 1 : 0);
