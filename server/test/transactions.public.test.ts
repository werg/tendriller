import { expect, it } from "vitest";
import { addEvent } from "../src/events";
import { DEFAULT_WAKE, type Tendril } from "../src/tendril";
import { Transactions } from "../src/transactions";
import { api, create, inDO, PageClient, sleep } from "./helpers";

function stored(t: Tendril, key: string): unknown {
  const row = t.db.one<{ v: string }>("SELECT v FROM meta WHERE k=?", key);
  return row ? JSON.parse(row.v) : null;
}

it("holds nested effects until outer commit and rolls back only the failed savepoint", async () => {
  const h = await create({ listener: false });
  await inDO(h.id, t => {
    const effects: { name: string; committed: boolean }[] = [];
    const effect = (name: string) => () => { effects.push({ name, committed: t.db.get("tx_complete", false) }); };
    t.db.set("tx_cached", { value: "before" });
    expect(t.transaction(() => {
      t.db.set("tx_cached", { value: "outer" });
      t.afterCommit(effect("outer-before"));
      expect(t.transaction(() => {
        t.db.set("tx_inner_kept", true);
        t.afterCommit(effect("inner"));
        return "nested result";
      })).toBe("nested result");
      expect(effects).toEqual([]);
      expect(() => t.transaction(() => {
        // Mutating a cached object must not make a rolled-back value survive.
        const cached = t.db.get("tx_cached", { value: "missing" });
        cached.value = "rolled back";
        t.db.set("tx_cached", cached);
        t.db.set("tx_inner_lost", true);
        t.afterCommit(effect("discarded"));
        throw Error("inner savepoint failed");
      })).toThrow("inner savepoint failed");
      expect(t.db.get("tx_cached", null)).toEqual({ value: "outer" });
      expect(stored(t, "tx_cached")).toEqual({ value: "outer" });
      expect(t.db.get("tx_inner_kept", false)).toBe(true);
      expect(t.db.get("tx_inner_lost", null)).toBeNull();
      expect(effects).toEqual([]);
      t.afterCommit(effect("outer-after"));
      t.db.set("tx_complete", true);
      return "outer result";
    })).toBe("outer result");
    expect(effects).toEqual([
      { name: "outer-before", committed: true },
      { name: "inner", committed: true },
      { name: "outer-after", committed: true },
    ]);
    expect(stored(t, "tx_inner_kept")).toBe(true);
    expect(stored(t, "tx_inner_lost")).toBeNull();
  });
});

it("drops rolled-back metadata, legacy broadcasts, built-in signals and agent wakes together", async () => {
  const h = await create({ listener: false });
  const page = await PageClient.connect(h.page_url);
  const response = await api(h, "GET", "events/socket", undefined,
    { Upgrade: "websocket", "Sec-WebSocket-Protocol": `tendriller.agent.v1, ${h.token}` });
  expect(response.status).toBe(101);
  const agent = response.webSocket!, wakes: any[] = [];
  agent.addEventListener("message", event => { wakes.push(JSON.parse(event.data as string)); });
  agent.accept();
  try {
    for (const stream of ["system.state", "system.transcript", "system.presence"])
      expect(await page.request({ t: "stream_subscribe", stream })).toMatchObject({ t: "ack", stream });
    await sleep(30); page.drain(); wakes.length = 0;
    await inDO(h.id, t => {
      t.db.set("tx_cached", { value: "committed" });
      const before = {
        state: structuredClone(t.getState()), transcript: t.transcript(),
        events: t.db.all("SELECT * FROM events"), counters: t.db.all("SELECT * FROM stream_counters ORDER BY name"),
        bound: structuredClone(t.db.get("wake_bound", null)), pending: t.db.get("wake_pending_since", null),
      };
      expect(() => t.transaction(() => {
        const cached = t.db.get("tx_cached", { value: "missing" });
        cached.value = "phantom"; t.db.set("tx_cached", cached);
        t.applyState([{ op: "set", path: ["phantom"], value: true }], "transaction-test");
        t.say("phantom reply", false, "transaction-test");
        addEvent(t, { type: "event", data: { phantom: true }, wake: true, cls: "owner" });
        t.broadcast({ t: "transaction_probe", phantom: true });
        expect(t.getState().rev).toBe(before.state.rev + 1);
        throw Error("outer write failed");
      })).toThrow("outer write failed");
      // No manual clearCache: the transaction helper must restore its own view.
      expect(t.db.get("tx_cached", null)).toEqual({ value: "committed" });
      expect(stored(t, "tx_cached")).toEqual({ value: "committed" });
      expect(t.getState()).toEqual(before.state);
      expect(t.transcript()).toEqual(before.transcript);
      expect(t.db.all("SELECT * FROM events")).toEqual(before.events);
      expect(t.db.all("SELECT * FROM stream_counters ORDER BY name")).toEqual(before.counters);
      expect(t.db.get("wake_bound", null)).toEqual(before.bound);
      expect(t.db.get("wake_pending_since", null)).toEqual(before.pending);
    });
    await sleep(30);
    expect(page.drain().filter(message => ["state", "say", "transaction_probe", "stream_record"].includes(message.t))).toEqual([]);
    expect(wakes).toEqual([]);

    // Positive control: the same paths still deliver after a successful commit.
    const seq = await inDO(h.id, t => t.transaction(() => {
      t.applyState([{ op: "set", path: ["committed"], value: true }], "transaction-test");
      t.say("committed reply", false, "transaction-test");
      return addEvent(t, { type: "event", data: { committed: true }, wake: true, cls: "owner" }).seq;
    }));
    expect((await page.next("state")).ops[0].path).toEqual(["committed"]);
    expect((await page.next("say")).text).toBe("committed reply");
    expect((await page.next(message => message.t === "stream_record" && message.record.stream === "system.state")).record.data.ops[0].path).toEqual(["committed"]);
    expect((await page.next(message => message.t === "stream_record" && message.record.stream === "system.transcript")).record.data.text).toBe("committed reply");
    await sleep(20);
    expect(wakes.filter(message => message.t === "wake")).toEqual([{ t: "wake", seq }]);
  } finally { page.close(); agent.close(1000, "done"); }
});

it("keeps committed writes and later effects when synchronous or asynchronous effects fail", async () => {
  const h = await create({ listener: false });
  await inDO(h.id, async t => {
    const failures: string[] = [], waiting: Promise<unknown>[] = [], delivered: string[] = [];
    const transactions = new Transactions(t.ctx.storage, () => t.db.clearCache(), work => {
      waiting.push(work); t.ctx.waitUntil(work);
    }, error => { failures.push((error as Error).message); });
    expect(transactions.run(() => {
      t.db.set("tx_committed", { value: 42 });
      transactions.afterCommit(() => { throw Error("socket failed"); });
      transactions.afterCommit(async () => { throw Error("provider failed"); });
      transactions.afterCommit(() => { delivered.push("later effect"); });
      return "write accepted";
    })).toBe("write accepted");
    await Promise.all(waiting);
    expect(failures).toEqual(["socket failed", "provider failed"]);
    expect(delivered).toEqual(["later effect"]);
    expect(t.db.get("tx_committed", null)).toEqual({ value: 42 });
    expect(stored(t, "tx_committed")).toEqual({ value: 42 });
  });
});

it("rejects async transaction callbacks before execution and rolls back returned promises", async () => {
  const h = await create({ listener: false });
  await inDO(h.id, async t => {
    const attempted: string[] = [];
    expect(() => t.transaction(async () => {
      attempted.push("started");
      t.db.set("tx_async", "before await");
      await Promise.resolve();
      t.db.set("tx_async", "after await");
    })).toThrow(/must be synchronous/);
    await Promise.resolve();
    expect(attempted).toEqual([]);
    expect(t.db.get("tx_async", null)).toBeNull();
    expect(stored(t, "tx_async")).toBeNull();
    expect(() => t.transaction(() => {
      t.db.set("tx_thenable", true);
      t.afterCommit(() => { attempted.push("effect"); });
      return Promise.resolve("not synchronous");
    })).toThrow(/must be synchronous/);
    expect(t.db.get("tx_thenable", null)).toBeNull();
    expect(stored(t, "tx_thenable")).toBeNull();
    expect(attempted).toEqual([]);
    t.transaction(() => t.db.set("tx_after_rejection", true));
    expect(stored(t, "tx_after_rejection")).toBe(true);
  });
});

it("commits source events and webhook/MCP wake intent atomically, including failed intent updates", async () => {
  const h = await create({ listener: false });
  await inDO(h.id, t => {
    t.db.set("wake", { ...DEFAULT_WAKE, webhook: { url: "https://example.org/transaction-test", token: null } });
    t.db.set("mcp_subs", [{ id: "sub_transaction", name: "tendril.events_waiting", args: "{}",
      url: "https://example.org/transaction-mcp", secret: "unused-test-secret", expires: t.now() + 60_000 }]);
    try {
      const before = t.db.all("SELECT * FROM events");
      const failIntent = () => {
        const set = t.db.set;
        t.db.set = (key, value) => {
          if (key === "mcp_job") {
            expect(t.db.get("webhook_job", null)).not.toBeNull();
            throw Error("MCP intent storage fault");
          }
          set.call(t.db, key, value);
        };
        try {
          expect(() => addEvent(t, { type: "event", data: { failed: true }, wake: true, cls: "owner" }))
            .toThrow("MCP intent storage fault");
        } finally { t.db.set = set; }
      };
      failIntent();
      expect(t.db.all("SELECT * FROM events")).toEqual(before);
      expect(t.db.get("webhook_job", null)).toBeNull();
      expect(t.db.get("mcp_job", null)).toBeNull();
      expect(stored(t, "webhook_job")).toBeNull();
      expect(stored(t, "mcp_job")).toBeNull();
      expect(t.db.get("wake_bound", null)).toBeNull();

      const accepted = addEvent(t, { type: "event", data: { accepted: true }, wake: true, cls: "owner" });
      const webhook = structuredClone(t.db.get("webhook_job", null));
      const mcp = structuredClone(t.db.get("mcp_job", null));
      expect(webhook).toMatchObject({ seq: accepted.seq, attempt: 0 });
      expect(mcp).toMatchObject({ seq: accepted.seq, attempt: 0, pending: ["sub_transaction"] });
      expect(stored(t, "webhook_job")).toEqual(webhook);
      expect(stored(t, "mcp_job")).toEqual(mcp);

      // Both existing jobs are mutated in memory before the second write fails.
      failIntent();
      expect(t.db.get("webhook_job", null)).toEqual(webhook);
      expect(t.db.get("mcp_job", null)).toEqual(mcp);
      expect(stored(t, "webhook_job")).toEqual(webhook);
      expect(stored(t, "mcp_job")).toEqual(mcp);
      expect(t.db.all("SELECT seq FROM events WHERE seq>?", before.at(-1)?.seq ?? 0)).toEqual([{ seq: accepted.seq }]);
      t.db.clearCache();
      expect(t.db.get("webhook_job", null)).toEqual(webhook);
      expect(t.db.get("mcp_job", null)).toEqual(mcp);
    } finally {
      // Keep the real alarm from trying the example delivery destinations.
      t.db.del("webhook_job"); t.db.del("mcp_job"); t.db.del("mcp_subs");
      t.db.set("wake", DEFAULT_WAKE);
      t.scheduleAlarm();
    }
  });
});
