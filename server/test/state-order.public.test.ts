import { expect, it } from "vitest";
import { inDO } from "./helpers";
import { handleWsMessage } from "../src/ws";

it("each accepted state mutation commits and acknowledges synchronously before the next mutation", async () => {
  await inDO("state-order-proof", async t => {
    t.db.set("id", "state-order-proof"); t.db.set("owner_account", "owner");
    const linkId = "l_state_order", sessionHash = "state-order-owner-session";
    t.db.run("INSERT INTO links(id,key,key_hash,role,created_at) VALUES(?,?,?,'owner',?)",
      linkId, "state-order-key", "state-order-key-hash", t.now());
    t.db.run("INSERT INTO page_sessions(hash,account_id,role,expires_at) VALUES(?,'owner','owner',?)",
      sessionHash, t.now() + 60_000);
    const seen: string[] = [], broadcast = t.broadcast, send = t.send;
    t.broadcast = message => { if ((message as any).t === "state") seen.push(`state:${(message as any).rev}`); };
    t.send = (_ws, message) => { if ((message as any).t === "ack") seen.push(`ack:${(message as any).rev}`); };
    const sockets = ["a", "b"].map(id => {
      t.db.run("INSERT INTO devices(id,secret_hash,role,pending,created_at,link) VALUES(?,?,'owner',0,?,?)", id, "unused", t.now(), linkId);
      const attachment = { deviceId: id, accountId: "owner", sessionRole: "owner", sessionHash, linkId, checkedAt: t.now() };
      return { deserializeAttachment: () => attachment } as unknown as WebSocket;
    });
    try {
      await Promise.all(sockets.map((ws, index) => handleWsMessage(t, ws, JSON.stringify({ t: "state", expected_generations: {}, cid: `state-${index}`,
        ops: [{ op: "set", path: [`key${index}`], value: index }] }))));
      expect(seen).toEqual(["state:1", "ack:1", "state:2", "ack:2"]);
    } finally { t.broadcast = broadcast; t.send = send; }
  });
});
