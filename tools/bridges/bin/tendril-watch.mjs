#!/usr/bin/env node
// Stream count-only wake notices for one tendril, one JSON line per wake.
// Built for host tools that turn each stdout line into a notification for the
// same agent session, such as the Monitor tool in Claude Code and Claude Duet.
// The private token is read from the creation-response file, so it never
// appears on the command line, in a tool call, or in the output.
import { readFileSync } from 'node:fs';
import { parseArgs } from '../../cli/lib/args.mjs';
import { readCheckpoint } from '../lib/pending-events.mjs';

const iso = () => new Date().toISOString();
const PING_MS = Math.max(1000, Number(process.env.TENDRIL_WATCH_PING_MS) || 25000);
const PONG_TIMEOUT_MS = Math.max(1000, Number(process.env.TENDRIL_WATCH_PONG_TIMEOUT_MS) || 12000);
const WARN_GAP_MS = Math.max(3000, Number(process.env.TENDRIL_WATCH_WARN_GAP_MS) || 15000);
const diagnostic = (state, data = {}) => process.stderr.write(JSON.stringify({watch:'tendril-watch',at:iso(),state,...data})+'\n');
const notify = (t, data = {}) => console.log(JSON.stringify({t,at:iso(),...data}));
let armed=false, outageAt=null, outageReason=null, warningSent=false, lastNotifiedSeq=0;

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
  // let a read cursor skip unhandled application input on reconnect.
  const saved = readCheckpoint(flags['checkpoint-file'] || `${file}.events.json`, cfg, 0);
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
    lastNotifiedSeq = Math.max(lastNotifiedSeq, cfg.after);
    const url = new URL(`${cfg.api}/events/socket`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    // The server sends a catch-up wake at once if waking events newer than the cursor are queued.
    url.searchParams.set('after', String(cfg.after));
    const ws = new WebSocket(url, ['tendriller.agent.v2', cfg.token]);
    let opened=false, connectedAt=0, timer=null, pongTimeout=null, errored=false, settled=false;
    const done = result => {
      if (settled) return;
      settled=true; clearInterval(timer); clearTimeout(pongTimeout);
      try { ws.close(); } catch { /* already closed */ }
      resolve({opened,connected_ms:opened ? Date.now()-connectedAt : 0,...result});
    };
    ws.addEventListener('open', () => {
      if (ws.protocol !== 'tendriller.agent.v2') {done({fatal:'the server did not accept the agent protocol'}); return;}
      opened=true; connectedAt=Date.now();
      if (!armed) {diagnostic('connected, listening',{heartbeat_ms:PING_MS}); armed=true;}
      else if (outageAt !== null) {
        diagnostic('reconnected, listening',{gap_ms:Date.now()-outageAt,previous:outageReason});
        outageAt=null; outageReason=null; warningSent=false;
      }
      timer=setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN || pongTimeout !== null) return;
        try {ws.send('{"t":"ping"}');}
        catch {done({code:1006,reason:'ping_send_failed'}); return;}
        pongTimeout=setTimeout(() => {
          try {ws.close(4000,'heartbeat timeout');} catch {}
          done({code:4000,reason:'pong_timeout'});
        },PONG_TIMEOUT_MS);
      },PING_MS);
    });
    ws.addEventListener('message', event => {
      let message;
      try {message=JSON.parse(String(event.data));} catch {return;}
      if (message.t === 'pong') {clearTimeout(pongTimeout); pongTimeout=null;}
      else if (message.t === 'wake' && Number.isSafeInteger(message.seq) && message.seq > lastNotifiedSeq) {
        lastNotifiedSeq=message.seq;
        notify('wake',{seq:message.seq});
      }
    });
    ws.addEventListener('error', () => {
      errored=true;
      // A refused WebSocket upgrade may emit only "error" and never "close".
      // Settle the connection attempt instead of hanging the watcher.
      if (!opened) done({code:1006,reason:'handshake_error'});
    });
    ws.addEventListener('close', event => done({
      code:event.code || 1006,
      reason:event.reason || (errored?'socket_error':'peer_closed'),
    }));
  });
}

const baseDelay = Number(process.env.TENDRIL_WATCH_RETRY_MS) || 1000;
let failures=0;
for (;;) {
  const result=await connect();
  if (result.fatal) {
    console.log(`tendril-watch: stopped at ${iso()}, ${result.fatal}`);
    process.exit(1);
  }
  failures=result.opened?0:failures+1;
  if (outageAt === null) {
    outageAt=Date.now();
    outageReason={code:result.code??1006,reason:result.reason||'connection_refused'};
  }
  const gap=()=>Date.now()-outageAt;
  const retryMs=Math.min(baseDelay*2**failures,30000);
  diagnostic('socket closed; reconnecting',{
    code:result.code??1006,reason:result.reason||'connection_refused',
    connected_ms:result.connected_ms,gap_ms:gap(),retry_in_ms:retryMs,
  });
  if (failures>=5) {
    console.log(`tendril-watch: stopped at ${iso()}, socket refused five times (code ${result.code??1006}; ${result.reason||'connection_refused'}; gap ${gap()}ms); check the token, page and network`);
    process.exit(1);
  }
  await new Promise(resolve=>setTimeout(resolve,retryMs));
  if (!warningSent && gap()>=WARN_GAP_MS) {
    notify('watch_warning',{code:outageReason.code,reason:outageReason.reason,gap_ms:gap()});
    warningSent=true;
  }
}
