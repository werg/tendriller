import { expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { assertValid } from "../../contract/index.mjs";
import { createClient } from "../../contract/client.mjs";
import { route } from "../src/router";
import { api, apiJson, advance, create, req } from "./helpers";

it("puts the public API entry point in homepage text and serves docs and examples without GitHub", async () => {
  const home = await (await req("/")).text();
  expect(home).toContain("Agents: read");
  expect(home).toContain("HTTP API");
  expect(home).toContain("/agent.md</a>");
  const index = await req("/llms.txt");
  expect(index.status).toBe(200);
  expect(index.headers.get("Content-Type")).toContain("text/plain");
  expect(await index.text()).toContain("/tendril-stream.mjs");
  for (const path of ["/docs/STREAMS.md", "/docs/COLLECTOR.md", "/docs/DURABILITY.md", "/docs/E2E_TESTING.md", "/cli/README.md", "/snippets/README.md",
    "/examples/training-dashboard/README.md", "/examples/training-dashboard/setup.mjs", "/examples/training-dashboard/index.html",
    "/examples/training-dashboard/app.js", "/examples/training-dashboard/model.mjs"]) {
    const response = await req(path);
    expect(response.status, path).toBe(200);
    expect(response.headers.get("X-Content-Type-Options"), path).toBe("nosniff");
    expect(await response.text(), path).not.toBe("");
  }
  // Example HTML is source for publication; never execute it on the account origin.
  expect((await req("/examples/training-dashboard/index.html")).headers.get("Content-Type")).toContain("text/plain");
  expect((await req("/examples/training-dashboard/", { redirect: "manual" })).headers.get("Location")).toContain("/examples/training-dashboard/README.md");
  for (const path of ["/tendril-stream.mjs", "/tendril-events.mjs", "/tendril-preview.mjs"]) {
    const response = await req(path);
    expect(response.status, path).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/javascript");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  }
  expect((await req("/examples/training-dashboard/collector.json")).status).toBe(404);
  expect((await req("/docs/not-a-public-file.json")).status).toBe(404);
});

it("keeps agent discovery links on the configured service origin", async () => {
  const config = { ...env, PUBLIC_BASE: "https://preview-0123456789ab.tendriller.dev", PAGE_BASE_DOMAIN: "tendriller.dev", PAGE_HOST_SUFFIX: "--p-0123456789ab" };
  for (const path of ["/", "/llms.txt", "/agent.md", "/docs/COLLECTOR.md"]) {
    const response = await route(new Request(config.PUBLIC_BASE + path), config);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain(config.PUBLIC_BASE);
    expect(text).not.toContain("https://tendriller.dev");
  }
});

it("recovers the newest delivery probe through HTTP, its event, the client, and MCP", async () => {
  const h = await create({ listener: false });
  const client = createClient(h, { fetch: (input, init) => req(String(input), init) });
  expect((await api(h, "GET", "wake/probe")).status).toBe(404);
  const first = await client.probeDelivery();
  assertValid("deliveryProbe", first);
  expect(await client.checkDeliveryProbe()).toEqual(first);
  expect(await client.checkDeliveryProbe(first.nonce)).toEqual(first);
  // Merely recovering the URL does not satisfy the read prerequisite.
  expect((await api(h, "POST", `wake/probe/${first.nonce}/ack`)).status).toBe(409);
  const batch = await client.readEvents({ after: 0 });
  const event = batch.events.find(event => event.seq === first.seq)!;
  expect(event).toMatchObject({ type: "event", role: null, device: null, by: "agent_probe",
    data: { kind: "delivery_probe", nonce: first.nonce, status_url: first.status_url, ack_url: first.ack_url } });
  const ack = await client.acknowledgeDeliveryProbe(first.nonce);
  expect(ack.ack_at).toBeTypeOf("number");
  expect(await client.acknowledgeDeliveryProbe(first.nonce)).toEqual(ack);
  const checked = await apiJson(h, "POST", "mcp", { jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "check_delivery_probe", arguments: {} } });
  expect(checked.result.structuredContent).toEqual(ack);
  const next = await client.probeDelivery();
  expect(await client.checkDeliveryProbe()).toEqual(next);
  expect((await api(h, "GET", `wake/probe/${first.nonce}`)).status).toBe(404);
  await advance(h.id, 10 * 60_000 + 1);
  expect((await api(h, "GET", "wake/probe")).status).toBe(404);
});
