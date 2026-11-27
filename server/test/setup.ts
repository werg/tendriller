// Shared setup for every server test file: the accounts database and an open service.
import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, inject } from "vitest";
import { clearIsolateCaches } from "../src/isolate-cache";

beforeAll(async () => {
  await applyD1Migrations(env.ACCOUNTS!, inject("d1Migrations"));
  await env.ACCOUNTS!.prepare("UPDATE service_state SET mode = 'open' WHERE id = 1").run();
  clearIsolateCaches();
});

// Routing caches are per isolate; tests that edit D1 directly start each case fresh.
beforeEach(() => clearIsolateCaches());
