// Minimal stand-in for the Tendriller server (PROTOCOL 2.1, 7) used by the runtime tests.
import http from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const asset = (p: string) => readFileSync(join(root, "server/public/_tendril", p));

export interface MockTendril {
  id: string;
  version: number;
  /** Body HTML (after the injected scripts). */
  html: string;
  files: Record<string, { type: string; body: string }>;
  noSw: boolean;
  state: any;
  rev: number;
  seq: number;
  sockets: Set<WebSocket>;
  msgs: any[];
  refuse: boolean;
  dedupe: Set<string>;
  blobs: Map<string, { type: string; body: Buffer; name?: string }>;
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
      id, version: 1, html: "<h1>Hello</h1>", files: {}, noSw: true, state: {}, rev: 0, seq: 0,
      sockets: new Set(), msgs: [], refuse: false, dedupe: new Set(), blobs: new Map(), pageLoads: 0, welcomeExtra: {},
      ...over,
    };
    this.tendrils.set(id, t);
    return t;
  }

  base(t: MockTendril) { return `/t/${t.id}/s/key/`; }
  url(t: MockTendril) { return this.origin + this.base(t); }

  page(t: MockTendril): string {
    const base = this.base(t);
    const cfg = { id: t.id, base, version: t.version, ws: base + "_tendril/ws", features: { transcribe: false, voice: false, push: false, vapid: null } };
    return `<!doctype html><html><head><script>window.__TENDRIL__=${JSON.stringify(cfg)};</script><script src="${base}_tendril/tendril.js"></script>` +
      (t.noSw ? "<script>window.__TENDRIL_NO_SW__=true</script>" : "") +
      `<title>Test ${t.id} v${t.version}</title></head><body>${t.html}</body></html>`;
  }

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
        const id = "b_" + String(t.blobs.size + 1).padStart(20, "a");
        t.blobs.set(id, { type: String(req.headers["content-type"] || ""), body: Buffer.concat(chunks), name: req.headers["x-tendril-name"] as string });
        send(200, "application/json", JSON.stringify({ id, url: "_tendril/blob/" + id }));
      });
      return;
    }
    if (rel === "" || rel === "index.html") { t.pageLoads++; return send(200, "text/html; charset=utf-8", this.page(t)); }
    if (rel === "_tendril/tendril.js") return send(200, "text/javascript", asset("tendril.js"));
    if (rel === "_tendril/sw.js") return send(200, "text/javascript", asset("sw.js"), { "Service-Worker-Allowed": this.base(t) });
    if (rel === "_tendril/info") return send(200, "application/json", JSON.stringify({ id: t.id, version: t.version, files: ["index.html", ...Object.keys(t.files)], features: {} }));
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
            state: t.state, rev: t.rev, presence: { state: "listening", text: "Listening", last_seen: Date.now(), schedule_minutes: null, withheld: 0, wake: "long_poll" },
            transcript: [], rules: [], features: {}, budget: { owner_per_hour: 60, page_per_hour: 12 }, ...t.welcomeExtra,
          });
          break;
        case "send":
          if (t.dedupe.has(m.cid)) { reply({ t: "ack", cid: m.cid }); break; }
          t.dedupe.add(m.cid);
          reply({ t: "ack", cid: m.cid, seq: ++t.seq });
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
