#!/usr/bin/env node
// Wait for one wake in a host background task, then exit with the event batch.
import { waitForAgentWake } from './agent-socket.mjs';

const api = process.env.TENDRIL_API;
const token = process.env.TENDRIL_TOKEN;
const after = Number(process.env.TENDRIL_AFTER || 0);
if ((!/^https:\/\/[^/]+\/api\/t\/[a-z2-7]{12}$/.test(api || '') && !/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/api\/t\/[a-z2-7]{12}$/.test(api || '')) || !/^tk_[a-z2-7]{32}$/.test(token || '') || !Number.isSafeInteger(after) || after < 0) {
  process.stderr.write('Set TENDRIL_API, TENDRIL_TOKEN, and optional TENDRIL_AFTER privately.\n');
  process.exit(2);
}
const cfg = { api, token };
const controller = new AbortController();
let finished = false;
async function readPending() {
  if (finished) return;
  const response = await fetch(`${api}/events?after=${after}&wait=0`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(40000),
  });
  if (!response.ok) throw Error(`Event read failed: HTTP ${response.status}`);
  const batch = await response.json();
  if (!batch.events?.some((event) => event.wake === true)) return;
  finished = true;
  process.stdout.write(JSON.stringify(batch) + '\n');
  controller.abort();
}
for (let backoff = 1000; !finished;) {
  try {
    await waitForAgentWake(cfg, readPending, undefined, controller.signal);
    if (finished) break;
  } catch (error) {
    process.stderr.write(`tendril-wait: ${error.message}; reconnecting\n`);
  }
  await new Promise((resolve) => setTimeout(resolve, backoff));
  backoff = Math.min(backoff * 2, 30000);
}
