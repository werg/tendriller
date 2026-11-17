import { test, expect } from "@playwright/test";
import { agent, deletePage, openClaimed, publishFiles, requester, SERVICE, OWNER, signInFixture, type Handle } from "./local-helpers";

type StreamTestWindow = typeof window & {
  __streamNetwork: { blocked: boolean; sockets: Set<WebSocket> };
};

test("a passive dashboard replays training history and receives live samples from a scoped producer", async ({ page, context }) => {
  await page.addInitScript(() => {
    const network = { blocked: false, sockets: new Set<WebSocket>() };
    (window as StreamTestWindow).__streamNetwork = network;
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args: ConstructorParameters<typeof NativeWebSocket>) {
        if (network.blocked) throw new DOMException("Test network is offline", "NetworkError");
        super(...args);
        network.sockets.add(this);
        this.addEventListener("close", () => network.sockets.delete(this), { once: true });
      }
    };
  });
  const request = await requester();
  const created = await request.post(`${SERVICE}/api/tendrils`, { headers: { "CF-Connecting-IP": "198.19.1.23" },
    data: { owner: OWNER, name: "Training streams", mode: "dashboard", application: { kind: "cloudflare", id: `cf:${crypto.randomUUID()}` } } });
  expect(created.status(), await created.text()).toBe(201);
  const h = await created.json() as Handle;
  try {
    expect((await agent(h, "/streams", "POST", { name: "training.metrics", durability: "durable" })).status).toBe(201);
    expect((await agent(h, "/streams", "POST", { name: "gpu.live", durability: "ephemeral" })).status).toBe(201);
    const grant = await agent(h, "/producers", "POST", { name: "machine", streams: ["training.metrics", "gpu.live"] });
    expect(grant.status).toBe(201);
    const append = async (stream: string, id: string, data: unknown) => {
      const response = await request.post(`${h.api}/streams/${stream}/records`, {
        headers: { Authorization: `Bearer ${grant.data.token}` }, data: { records: [{ id, type: "sample", data }] },
      });
      expect(response.status(), await response.text()).toBe(200);
      return response.json();
    };
    await append("training.metrics", "step-1", { step: 1, loss: 2.4 });
    await append("gpu.live", "before-viewer", { percent: 50 });
    // No polling bridge or fake wake receiver is needed for dashboard publication.
    await publishFiles(h, { "index.html": { type: "text/html", body: `<!doctype html><html><head><meta charset="utf-8"><title>Training streams</title></head><body>
      <h1>Training</h1><pre id="history"></pre><output id="gpu">Waiting for live sample</output>
      <script>
      window.samples = []; window.errors = [];
      window.stopTraining = tendril.streams.subscribe('training.metrics', record => {
        window.samples.push(record); document.querySelector('#history').textContent = JSON.stringify(window.samples);
      }, {after: 0, onError: error => window.errors.push(error.message)});
      tendril.streams.subscribe('gpu.live', record => {
        document.querySelector('#gpu').textContent = String(record.data.percent);
      });
      </script></body></html>` } });
    await signInFixture(context); await openClaimed(page, h);
    await expect.poll(() => page.evaluate(() => (window as any).samples.length)).toBe(1);
    await expect(page.locator("#gpu")).toHaveText("Waiting for live sample");
    await append("gpu.live", "current", { percent: 72 });
    await expect(page.locator("#gpu")).toHaveText("72");

    await append("training.metrics", "step-1", { step: 1, loss: 2.4 });
    const step2 = await append("training.metrics", "step-2", { step: 2, loss: 2.1 });
    await expect.poll(() => page.evaluate(() => (window as any).samples.map((r: any) => r.data.step))).toEqual([1, 2]);
    // HTTP offline emulation leaves established WebSockets connected in Chromium.
    // Finish their close handshake before blocking HTTP, and hold reconnects.
    await page.evaluate(() => {
      const network = (window as StreamTestWindow).__streamNetwork;
      network.blocked = true;
      for (const socket of network.sockets) socket.close(1000, "Test network outage");
    });
    await page.waitForFunction(() => !window.tendril.connected);
    await context.setOffline(true);
    await append("training.metrics", "step-3", { step: 3, loss: 1.9 });
    await append("gpu.live", "missed", { percent: 88 });
    await context.setOffline(false);
    await page.evaluate(() => {
      (window as StreamTestWindow).__streamNetwork.blocked = false;
      window.dispatchEvent(new Event("online"));
    });
    await expect.poll(() => page.evaluate(() => (window as any).samples.map((r: any) => r.data.step))).toEqual([1, 2, 3]);
    const replay = await page.evaluate(after => window.tendril.streams.read("training.metrics", { after }), step2.cursor);
    expect(replay.records.map(r => (r.data as any).step)).toEqual([3]);
    await expect(page.locator("#gpu")).toHaveText("72");
    await append("gpu.live", "fresh", { percent: 91 });
    await expect(page.locator("#gpu")).toHaveText("91");

    await page.evaluate(() => (window as any).stopTraining());
    await append("training.metrics", "step-4", { step: 4, loss: 1.7 });
    await append("gpu.live", "after-unsubscribe", { percent: 92 });
    await expect(page.locator("#gpu")).toHaveText("92");
    expect(await page.evaluate(() => (window as any).samples.map((r: any) => r.data.step))).toEqual([1, 2, 3]);
    expect(await page.evaluate(() => (window as any).errors)).toEqual([]);
  } finally {
    await context.setOffline(false);
    await page.evaluate(() => {
      const network = (window as StreamTestWindow).__streamNetwork;
      if (network) network.blocked = false;
    }).catch(() => {});
    await deletePage(h);
  }
});
