// Shared setup for every server test file: the accounts database and an open service.
import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, inject } from "vitest";

beforeAll(async () => {
  await applyD1Migrations(env.ACCOUNTS!, inject("d1Migrations"));
  await env.ACCOUNTS!.prepare("UPDATE service_state SET mode = 'open' WHERE id = 1").run();
});
