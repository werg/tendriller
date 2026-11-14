import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { Env } from "../src/env";

const ns = (env as Env).ADMISSION!;
const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
const id = (n: number) => `aaaaaaaaaa${alphabet[Math.floor(n / 32)]}${alphabet[n % 32]}`;
const call = (stub: DurableObjectStub, action: string, tendrilId: string) => stub.fetch(new Request(`https://admission.internal/${action}`, {
  method: "POST", headers: { "x-tendril-id": tendrilId },
}));

it("caps anonymous creations exactly and releases live slots", async () => {
  const stub = ns.get(ns.idFromName(`test-${crypto.randomUUID()}`));
  for (let n = 2; n < 102; n++) expect((await call(stub, "reserve", id(n))).status).toBe(200);
  expect((await call(stub, "reserve", id(102))).status).toBe(503);
  expect((await call(stub, "reserve", id(2))).status).toBe(200); // retry is idempotent
  expect((await call(stub, "release", id(2))).status).toBe(200);
  // The per-hour ceiling still holds after release; it counts completed creations.
  expect((await call(stub, "reserve", id(103))).status).toBe(503);
  expect((await call(stub, "cancel", id(3))).status).toBe(200);
  expect((await call(stub, "reserve", id(103))).status).toBe(200);
});
