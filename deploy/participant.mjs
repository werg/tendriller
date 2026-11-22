// Executable host for the public starter's exported runPeer lifecycle.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { writeSync } from 'node:fs';

export async function runParticipant({ sessionPath, signal, load = url => import(url) }) {
  let opened = false, closed = false;
  try {
    const { runPeer } = await load(pathToFileURL(resolve(sessionPath)).href);
    if (typeof runPeer !== 'function') throw Error('The selected session module must export runPeer(options, lifecycle).');
    signal.throwIfAborted();
    await runPeer({ signal }, { onOwned() { opened = true; }, onClosed() { closed = true; } });
    if (!signal.aborted) throw Error('Participant returned before a shutdown request; it is no longer available.');
    if (!opened || !closed) throw Error('Participant shutdown did not verify owned cleanup. Preserve the original device store.');
    return 0;
  } catch (cause) {
    if (signal.aborted && cause === signal.reason && opened && closed) return 0;
    throw cause;
  }
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw Error('This starter launcher requires Node 24 or newer.');
  const { values } = parseArgs({ options: { session: { type: 'string', default: 'session.mjs' } }, allowPositionals: false });
  const stopped = new AbortController();
  let deadline;
  const stop = () => {
    if (stopped.signal.aborted) return;
    deadline = setTimeout(() => {
      // Executable-only last resort: never report successful cleanup on expiry.
      writeSync(2, 'Participant shutdown exceeded 10s; cleanup unverified. Preserve original device and operation IDs.\n');
      process.exit(1);
    }, 10_000);
    stopped.abort(new Error('Participant shutdown requested'));
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  let code = 0;
  const outputError = () => { code = 1; stop(); };
  process.stdout.on('error', outputError); process.stderr.on('error', outputError);
  try { await runParticipant({ sessionPath: values.session, signal: stopped.signal }); }
  catch (cause) { code = 1; console.error(cause?.message ?? String(cause)); }
  finally { clearTimeout(deadline); process.off('SIGINT', stop); process.off('SIGTERM', stop); }
  const flush = stream => new Promise(resolveFlush => {
    const timer = setTimeout(() => { code = 1; resolveFlush(); }, 1000);
    try { stream.write('', error => { clearTimeout(timer); if (error) code = 1; resolveFlush(); }); }
    catch { clearTimeout(timer); code = 1; resolveFlush(); }
  });
  await flush(process.stdout); await flush(process.stderr);
  process.exit(code);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(cause => { writeSync(2, `${cause?.message ?? String(cause)}\n`); process.exit(1); });
}
