import { expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { assertValid } from "../../contract/index.mjs";
import { createClient } from "../../contract/client.mjs";
import { route } from "../src/router";
import { api, apiJson, advance, create, req } from "./helpers";

it("discovers optional releases and serves the generic public contract", async () => {
  const home = await (await req("/")).text();
  expect(home).toContain("Agents: read");
  expect(home).toContain("https://github.com/werg/tendriller-contrib");
  const index = await req("/llms.txt");
  expect(index.status).toBe(200);
  const discovery = await index.text();
  // Discovery may move, but the catalog advertised as a tested pairing must
  // identify a real, immutable release rather than a mutable latest alias.
  expect(discovery).toContain("https://api.github.com/repos/werg/tendriller-contrib/releases");
  expect(discovery).toContain("https://github.com/werg/tendriller-contrib/releases/download/v0.2.0-rc.2/catalog.json");
  expect(discovery).not.toContain("/releases/latest/download/");
  expect(discovery).toContain("https://tendriller.dev/docs/BROWSER_API.md");
  for (const path of ["/docs/STREAMS.md","/docs/DURABILITY.md","/docs/ARCHITECTURE.md","/docs/PROTOCOL.md","/docs/BROWSER_API.md"]){
    const response=await req(path);expect(response.status,path).toBe(200);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  }
  const descriptor = await (await req("/api/service")).json();
  assertValid("serviceDescriptor", descriptor);
  expect(descriptor).toMatchObject({contract:2,limits:{streams:{record_bytes:65536}}});
  const schema = await (await req("/contract/v2.json")).json<any>();
  expect(schema.$defs.command).toBeDefined();
  expect(schema.$defs.archive).toBeUndefined();
  for (const path of ["/contract/v1.json","/recipes/catalog.json","/snippets/README.md","/cli/README.md","/examples/training-dashboard/index.html"])
    expect((await req(path)).status,path).toBe(404);
});

it("keeps agent discovery links on the configured service origin", async () => {
  const config = { ...env, PUBLIC_BASE: "https://preview-0123456789ab.tendriller.dev", PAGE_BASE_DOMAIN: "tendriller.dev", PAGE_HOST_SUFFIX: "--p-0123456789ab" };
  for (const path of ["/", "/llms.txt", "/agent.md"]) {
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
