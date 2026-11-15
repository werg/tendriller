// Minimal stand-in for the Tendriller server (PROTOCOL 2.1, 7) used by the runtime tests.
import http from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const asset = (p: string) => readFileSync(join(root, "dist/runtime/assets", p));
const runtimeManifest = JSON.parse(asset("manifest.json").toString());
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export interface MockTendril {
  id: string;
  version: number;
  /** Body HTML (after the injected scripts). */
  html: string;
  publications: Map<number, { html: string; files: MockTendril["files"]; manifest: any }>;
  files: Record<string, { type: string; body: string }>;
  noSw: boolean;
  preview: boolean;
  state: any;
  scopes: any[];
  rev: number;
  seq: number;
  sockets: Set<WebSocket>;
  msgs: any[];
  refuse: boolean;
  dedupe: Set<string>;
  blobs: Map<string, { type: string; body: Buffer; name?: string }>;
  uploadReceipts: Map<string, any>;
  uploadFailureStatus: number;
  dropUploadResponses: number;
  sendReceipts: Map<string, any>;
  pageLoads: number;
  welcomeExtra: any;
  onMessage?: (m: any, ws: WebSocket) => boolean | void;
}

function applyOps(state: any, ops: any[]) {
  for (const op of ops) {
    let node = state;
    for (const k of op.path.slice(0, -1)) {
      if (node[k] === null || typeof node[k] !== "object") node[k] = {};
      node = node[k];
    }
    const last = op.path[op.path.length - 1];
    if (op.op === "delete") delete node[last];
    else node[last] = structuredClone(op.value);
  }
}

export class MockServer {
  server!: http.Server;
  wss!: WebSocketServer;
  port = 0;
  tendrils = new Map<string, MockTendril>();
  private n = 0;

  get origin() { return `http://127.0.0.1:${this.port}`; }

  create(over: Partial<MockTendril> = {}): MockTendril {
    const id = "t" + (++this.n).toString().padStart(11, "a");
    const t: MockTendril = {
      id, version: 1, html: "<h1>Hello</h1>", publications: new Map(), files: {}, noSw: true, preview: false, state: {}, scopes: [], rev: 0, seq: 0,
      sockets: new Set(), msgs: [], refuse: false, dedupe: new Set(), blobs: new Map(), pageLoads: 0, welcomeExtra: {},
      uploadReceipts: new Map(), uploadFailureStatus: 0, dropUploadResponses: 0, sendReceipts: new Map(),
      ...over,
    };
    this.tendrils.set(id, t);
    return t;
  }

  base(t: MockTendril) { return `/t/${t.id}/s/key/`; }
  url(t: MockTendril) { return this.origin + this.base(t); }

  runtimeUrl(t: MockTendril) { return `${this.base(t)}_tendril/runtime/${runtimeManifest.id}/`; }
  publication(t: MockTendril, version = t.version) {
    const previous = t.publications.get(version);
    if (previous) return previous;
    const base = this.base(t), publicationBase = `${base}_publications/${version}/`;
    const files = structuredClone(t.files);
    const manifest = { id: String(version), base: publicationBase, entry: "index.html",
      runtime: { version: runtimeManifest.version, id: runtimeManifest.id, base: this.runtimeUrl(t) },
      assets: [{ path: "index.html", sha256: hash(t.html), type: "text/html" }, ...Object.entries(files).map(([path, file]) => ({ path, sha256: hash(file.body), type: file.type }))],
    };
    const cfg = { id: t.id, base, publication: manifest, preview: t.preview, version, ws: base + "_tendril/ws", features: { push: false, vapid: null, shared_by: "Fixture", speech: { model: "fixture", url: "model", sha256: "0".repeat(64), engine: { script: "engine.js", wasm: "engine.wasm", wasm_sha256: "0".repeat(64) } } } };
    const html = `<!doctype html><html><head><base href="${publicationBase}"><script>window.__TENDRIL__=${JSON.stringify(cfg)};</script>` +
      (t.noSw ? "<script>window.__TENDRIL_NO_SW__=true</script>" : "") +
      `<script src="${this.runtimeUrl(t)}tendril.js"></script><title>Test ${t.id} v${version}</title></head><body>${t.html}</body></html>`;
    const publication = { html, files, manifest }; t.publications.set(version, publication);
    return publication;
  }
  page(t: MockTendril): string { return this.publication(t).html; }

  async start() {
    this.server = http.createServer((req, res) => this.http(req, res));
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on("upgrade", (req, sock, head) => {
      const m = /^\/t\/([^/]+)\/s\/key\/_tendril\/ws/.exec(req.url || "");
      const t = m && this.tendrils.get(m[1]);
      if (!t || t.refuse) { sock.destroy(); return; }
      this.wss.handleUpgrade(req, sock, head, (ws) => this.socket(t, ws));
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
    this.port = (this.server.address() as any).port;
  }

  async stop() {
    for (const t of this.tendrils.values()) for (const s of t.sockets) s.terminate();
    this.wss.close();
    await new Promise((r) => this.server.close(r));
  }

  private http(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url || "/", this.origin);
    const m = /^\/t\/([^/]+)\/s\/key\/(.*)$/.exec(url.pathname);
    const t = m && this.tendrils.get(m[1]);
    if (!t) { res.writeHead(404).end("not found"); return; }
    const rel = m![2];
    const send = (status: number, type: string, body: string | Buffer, extra: Record<string, string> = {}) => {
      res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-cache", ...extra }).end(body);
    };
    if (req.method === "POST" && rel === "_tendril/blob") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        if (t.uploadFailureStatus) return send(t.uploadFailureStatus, "application/json", JSON.stringify({ error: { code: "quota", message: "Capture storage is full." } }));
        const cid = String(req.headers["x-tendril-cid"] || "");
        if (cid && t.uploadReceipts.has(cid)) return send(200, "application/json", JSON.stringify(t.uploadReceipts.get(cid)));
        const id = "b_" + String(t.blobs.size + 1).padStart(20, "a");
        t.blobs.set(id, { type: String(req.headers["content-type"] || ""), body: Buffer.concat(chunks), name: req.headers["x-tendril-name"] as string });
        const keep = req.headers["x-tendril-keep"] === "true";
        const receipt = { id, url: "_tendril/blob/" + id, retention: { keep, expires_at: keep ? null : Date.now() + 30 * 86_400_000 } };
        if (cid) t.uploadReceipts.set(cid, receipt);
        if (t.dropUploadResponses > 0) { t.dropUploadResponses--; req.socket.destroy(); return; }
        send(200, "application/json", JSON.stringify(receipt));
      });
      return;
    }
    if (rel === "" || rel === "index.html") { t.pageLoads++; return send(200, "text/html; charset=utf-8", this.page(t)); }
    const runtime = `_tendril/runtime/${runtimeManifest.id}/`;
    if (rel.startsWith(runtime)) {
      const path = rel.slice(runtime.length), entry = runtimeManifest.assets.find((item: any) => item.path === path);
      if (path === "manifest.json") return send(200, "application/json", JSON.stringify(runtimeManifest));
      if (entry) return send(200, entry.type, asset(path));
      return send(404, "text/plain", "not found");
    }
    const publicationPath = /^_publications\/(\d+)\/(.*)$/.exec(rel);
    if (publicationPath) {
      const publication = t.publications.get(Number(publicationPath[1]));
      if (!publication) return send(404, "text/plain", "not found");
      const extra = { "X-Tendril-Publication": publicationPath[1] };
      if (!publicationPath[2] || publicationPath[2] === "index.html") return send(200, "text/html", publication.html, extra);
      const file = publication.files[publicationPath[2]];
      return file ? send(200, file.type, file.body, extra) : send(404, "text/plain", "not found");
    }
    if (rel === "_tendril/sw.js") return send(200, "text/javascript", asset("sw.js"), { "Service-Worker-Allowed": this.base(t) });
    if (rel === "_tendril/devices") return send(200, "application/json", JSON.stringify({ devices: [{ id: "d_x" }] }));
    if (rel === "_tendril/adopt_code") return send(403, "application/json", JSON.stringify({ error: { code: "forbidden", message: "no" } }));
    if (rel === "_tendril/info") return send(200, "application/json", JSON.stringify({ id: t.id, version: t.version, publication: this.publication(t).manifest, features: {} }));
    const f = t.files[rel];
    if (f) return send(200, f.type, f.body);
    send(404, "text/plain", "not found");
  }

  private socket(t: MockTendril, ws: WebSocket) {
    t.sockets.add(ws);
    ws.on("close", () => t.sockets.delete(ws));
    ws.on("message", (buf) => {
      let m: any;
      try { m = JSON.parse(String(buf)); } catch { return; }
      t.msgs.push(m);
      if (t.onMessage && t.onMessage(m, ws)) return;
      const reply = (x: any) => ws.send(JSON.stringify(x));
      switch (m.t) {
        case "hello":
          reply({
            t: "welcome", device_id: m.device_id, role: "owner", pending: false, primary: true,
            tendril: { id: t.id, name: "Test" }, version: { current: t.version, latest: t.version, healthy: t.version },
            state: t.state, rev: t.rev, scopes: t.scopes, presence: { state: "listening", text: "Listening", last_seen: Date.now(), schedule_minutes: null, withheld: 0, wake: "long_poll" },
            transcript: [], rules: [], features: {}, budget: { owner_per_hour: 60, page_per_hour: 12 }, ...t.welcomeExtra,
          });
          break;
        case "capture_complete":
        case "send":
          if (t.sendReceipts.has(m.cid)) { reply(t.sendReceipts.get(m.cid)); break; }
          t.dedupe.add(m.cid);
          const ack = { t: "ack", cid: m.cid, seq: ++t.seq };
          t.sendReceipts.set(m.cid, ack);
          reply(ack);
          break;
        case "state":
          if (!t.dedupe.has(m.cid)) { t.dedupe.add(m.cid); applyOps(t.state, m.ops); t.rev++; }
          reply({ t: "ack", cid: m.cid, rev: t.rev });
          for (const s of t.sockets) if (s !== ws) s.send(JSON.stringify({ t: "state", ops: m.ops, rev: t.rev, by: "device:" + m.cid }));
          break;
        case "ping":
          reply({ t: "pong" });
          break;
      }
    });
  }

  /** Server-side state change broadcast to all pages. */
  pushState(t: MockTendril, ops: any[], by = "agent:main") {
    applyOps(t.state, ops);
    t.rev++;
    this.broadcast(t, { t: "state", ops, rev: t.rev, by });
  }

  broadcast(t: MockTendril, msg: any) {
    for (const s of t.sockets) s.send(JSON.stringify(msg));
  }

  /** Drops all sockets; with `refuse`, new connections are rejected until `goOnline`. */
  goOffline(t: MockTendril) {
    t.refuse = true;
    for (const s of t.sockets) s.terminate();
  }
  goOnline(t: MockTendril) { t.refuse = false; }

  messages(t: MockTendril, type: string) { return t.msgs.filter((m) => m.t === type); }

  async waitFor<T>(fn: () => T | undefined | false | null, timeout = 8000): Promise<T> {
    const end = Date.now() + timeout;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > end) throw new Error("waitFor timed out: " + fn.toString());
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /** Runs an eval in the page via the socket and resolves with the eval_result. */
  async eval(t: MockTendril, code: string): Promise<any> {
    const call_id = "e" + Math.random().toString(36).slice(2);
    this.broadcast(t, { t: "eval", call_id, code });
    return this.waitFor(() => t.msgs.find((m) => m.t === "eval_result" && m.call_id === call_id));
  }
}
