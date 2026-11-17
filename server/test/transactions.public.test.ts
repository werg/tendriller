import { expect, it } from "vitest";
import { type Tendril } from "../src/tendril";
import { Transactions } from "../src/transactions";
import { create, inDO } from "./helpers";

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
