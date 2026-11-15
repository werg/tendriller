#!/usr/bin/env node
// Stream count-only wake notices for one tendril, one JSON line per wake.
// Built for host tools that turn each stdout line into a notification for the
// same agent session, such as the Monitor tool in Claude Code and Claude Duet.
// The private token is read from the creation-response file, so it never
// appears on the command line, in a tool call, or in the output.
import { readFileSync } from 'node:fs';
import { parseArgs } from '../lib/args.mjs';
import { readCheckpoint } from '../lib/pending-events.mjs';

let parsed;
try { parsed = parseArgs(process.argv.slice(2)); } catch (error) { process.stderr.write(error.message + '\n'); process.exit(2); }
const { cmd: file, args, flags } = parsed;
if (!file || args.length || Object.keys(flags).some(key => key !== 'checkpoint-file')) {
  process.stderr.write('Usage: tendril-watch.mjs <private creation-response file> [--checkpoint-file PATH]\n');
  process.exit(2);
}
function load() {
  let cfg;
  try { cfg = JSON.parse(readFileSync(file, 'utf8')); } catch { throw Error('Cannot read the private creation-response file as JSON'); }
  const api = cfg.api;
  const ok = /^https:\/\/[^/]+\/api\/t\/[a-z2-7]{12}$/.test(api || '')
    || /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/api\/t\/[a-z2-7]{12}$/.test(api || '');
  if (!ok || !/^tk_[a-z2-7]{32}$/.test(cfg.token || '')) throw Error('The file needs the creation response with api and token');
  // Once pending/ack is used, its handled checkpoint is authoritative. Never
  // let a legacy read cursor skip unhandled application input on reconnect.
  const saved = readCheckpoint(flags['checkpoint-file'] || `${file}.events.json`, cfg, cfg.cursor ?? 0);
  return { api, token: cfg.token, after: saved.handled_cursor };
}
if (typeof WebSocket !== 'function') {
  console.log('tendril-watch: stopped, this needs Node.js 22.15 or newer');
  process.exit(1);
}

function connect() {
  return new Promise((resolve) => {
    let cfg;
    try { cfg = load(); } catch (error) { resolve({ fatal: error.message }); return; }
    const url = new URL(`${cfg.api}/events/socket`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    // The server sends a catch-up wake at once if waking events newer than the cursor are queued.
    url.searchParams.set('after', String(cfg.after));
    const ws = new WebSocket(url, ['tendriller.agent.v1', cfg.token]);
    let opened = false, lastPong = Date.now(), timer = null;
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true; clearInterval(timer); try { ws.close(); } catch {} resolve(result);
    };
    ws.addEventListener('open', () => {
      if (ws.protocol !== 'tendriller.agent.v1') { done({ fatal: 'the server did not accept the agent protocol' }); return; }
      opened = true;
      timer = setInterval(() => {
        if (Date.now() - lastPong > 150000) { done({ opened }); return; }
        try { ws.send('{"t":"ping"}'); } catch { done({ opened }); }
      }, 60000);
    });
    ws.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.t === 'pong') lastPong = Date.now();
      else if (message.t === 'wake' && Number.isSafeInteger(message.seq)) console.log(JSON.stringify({ t: 'wake', seq: message.seq }));
    });
    // Failing before the upgrade completes means the token was refused, the page is gone or the network is blocked.
    const ended = () => done(opened ? { opened } : { rejected: true });
    ws.addEventListener('error', ended);
    ws.addEventListener('close', ended);
  });
}

const baseDelay = Number(process.env.TENDRIL_WATCH_RETRY_MS) || 1000;
let failures = 0;
for (;;) {
  const result = await connect();
  if (result.fatal) { console.log(`tendril-watch: stopped, ${result.fatal}`); process.exit(1); }
  if (result.opened) failures = 0; else failures++;
  if (failures >= 5) {
    console.log('tendril-watch: stopped, the socket was refused five times; check the token, the page and network access to the service');
    process.exit(1);
  }
  process.stderr.write('tendril-watch: socket closed; reconnecting\n');
  await new Promise((r) => setTimeout(r, Math.min(baseDelay * 2 ** failures, 30000)));
}
