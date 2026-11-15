import { spawn } from 'node:child_process';
import { createLineDecoder, MAX_INPUT_LINE_BYTES, validateRecordOptions } from './records.mjs';

const capabilities = Object.freeze({ mode: 'poll', replay: 'none', checkpoint: false });
const failure = code => Object.assign(Error(code), { code });

export function commandArguments(source) {
  if (!Array.isArray(source.command) || !source.command.length || source.command.length > 32
    || source.command.some(x => typeof x !== 'string' || !x.length || x.length > 2048 || x.includes('\0')))
    throw Error('command must be an explicit array of 1–32 nonempty arguments.');
  if (source.format !== undefined && !['jsonl', 'log'].includes(source.format)) throw Error('Command format must be jsonl or log.');
  return source.command;
}

export function commandTimeout(source) {
  const timeout = source.timeout_ms ?? 10_000;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 300_000) throw Error('timeout_ms must be 100–300000.');
  return timeout;
}

/** One finite local observation. Scheduling, buffering and uploads stay with the collector. */
export function createCommandSource(source, { spawn: launch = spawn } = {}) {
  validateRecordOptions(source);
  const [executable, ...args] = commandArguments(source), timeout = commandTimeout(source);
  let session;
  return {
    source, capabilities,
    async read({ signal, maxRecords = 100 } = {}) {
      if (signal?.aborted) throw failure('command_cancelled');
      if (session) throw failure('command_already_running');
      const processGroup = process.platform !== 'win32';
      const child = launch(executable, args, { shell: false, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, detached: processGroup,
        ...(source.cwd ? { cwd: source.cwd } : {}) });
      let spawnError = false, timedOut = false, finished = false, stopping = false, killTimer;
      const closed = new Promise(resolve => child.once('close', code => { finished = true; resolve(code); }));
      child.on('error', () => { spawnError = true; });
      const kill = signal => {
        if (processGroup && child.pid) {
          try { process.kill(-child.pid, signal); return; }
          catch (error) { if (error.code === 'ESRCH') return; }
        }
        child.kill(signal);
      };
      const stop = () => {
        if (finished || stopping) return;
        stopping = true;
        // A descendant can inherit stdout after its parent exits. Do not let
        // that pipe keep this observation (or collector shutdown) alive.
        child.stdout.destroy(); kill('SIGTERM');
        killTimer = setTimeout(() => kill('SIGKILL'), 2000); killTimer.unref();
        void closed.then(() => {
          // The leader may exit before a descendant that ignored SIGTERM.
          // Its remaining process group must not outlive this cancelled sample.
          kill('SIGKILL'); clearTimeout(killTimer);
        });
      };
      const deadline = setTimeout(() => { timedOut = true; stop(); }, timeout);
      deadline.unref();
      session = { stop, closed };
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) stop();
      const records = [];
      let bytes = 0, decodeError;
      const decoder = createLineDecoder(source, state => { decodeError ??= state; });
      const append = record => {
        if (records.length >= maxRecords) throw failure('command_output_too_large');
        records.push(record);
      };
      try {
        for await (const chunk of child.stdout) {
          if (signal?.aborted || timedOut) break;
          bytes += chunk.length;
          if (bytes > MAX_INPUT_LINE_BYTES) throw failure('command_output_too_large');
          for (const record of decoder.push(chunk)) append(record);
        }
        const exitCode = await closed;
        if (signal?.aborted || (stopping && !timedOut)) throw failure('command_cancelled');
        if (timedOut) throw failure('command_timeout');
        if (spawnError) throw failure('command_unavailable');
        if (exitCode !== 0) throw failure('command_failed');
        for (const record of decoder.finish()) append(record);
        if (decodeError) throw failure(decodeError);
        return { records, health: 'collecting' };
      } catch (error) {
        // destroy() can interrupt an outstanding stdout read. Preserve the
        // actionable cancellation/timeout result instead of a stream exception.
        if (signal?.aborted || (stopping && !timedOut)) throw failure('command_cancelled');
        if (timedOut) throw failure('command_timeout');
        throw error;
      } finally {
        clearTimeout(deadline); signal?.removeEventListener('abort', stop);
        stop(); await closed; session = undefined;
      }
    },
    failure: error => error.code === 'spool_full' ? 'spool_full_command_gap' : error.code || 'command_failed',
    async close() { if (session) { session.stop(); await session.closed; } },
  };
}
