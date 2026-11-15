import { spawn } from 'node:child_process';
import { createLineDecoder, validateRecordOptions } from './records.mjs';
import { commandArguments } from './command.mjs';

const capabilities = Object.freeze({ mode: 'stream', replay: 'none', checkpoint: false });

export function sshArguments(source) {
  if (typeof source.host !== 'string' || !/^(?:[a-zA-Z0-9_.-]+@)?[a-zA-Z0-9][a-zA-Z0-9._-]{0,252}$/.test(source.host))
    throw Error('SSH host must be a host alias or hostname, optionally prefixed with user@.');
  commandArguments(source);
  if (source.port !== undefined && (!Number.isInteger(source.port) || source.port < 1 || source.port > 65535)) throw Error('Invalid SSH port.');
  if (source.format !== undefined && !['jsonl', 'log'].includes(source.format)) throw Error('SSH format must be jsonl or log.');
  // OpenSSH joins command arguments into a shell command on the remote host.
  // Quote every argument ourselves; never interpolate a host into a local shell.
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  return ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2',
    ...(source.port ? ['-p', String(source.port)] : []), '--', source.host, source.command.map(quote).join(' ')];
}

/** One bounded SSH session. The coordinator owns retry timing and upload backpressure. */
export function createSshSource(source, { spawn: launch = spawn } = {}) {
  validateRecordOptions(source);
  const args = sshArguments(source);
  let session;
  return {
    source, capabilities,
    async *stream({ signal, report }) {
      if (signal.aborted) return;
      if (session) throw Error('SSH source already has an active session.');
      const child = launch('ssh', args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      let spawnError = false, timer, stopping = false;
      const closed = new Promise(resolve => child.once('close', resolve));
      child.on('error', () => { spawnError = true; });
      const stop = () => {
        if (stopping) return;
        stopping = true; child.kill('SIGTERM');
        timer = setTimeout(() => child.kill('SIGKILL'), 2000); timer.unref();
        void closed.then(() => clearTimeout(timer));
      };
      session = { stop, closed };
      signal.addEventListener('abort', stop, { once: true });
      if (signal.aborted) stop();
      const decoder = createLineDecoder(source, report);
      report('ssh_connecting');
      try {
        for await (const chunk of child.stdout) {
          if (signal.aborted) break;
          for (const record of decoder.push(chunk)) yield { records: [record], health: 'collecting' };
        }
      } finally {
        signal.removeEventListener('abort', stop);
        stop(); await closed;
        session = undefined;
        if (!signal.aborted) report(spawnError ? 'ssh_unavailable' : 'ssh_disconnected_gap');
      }
    },
    failure: error => error.code === 'spool_full' ? 'spool_full_ssh_gap' : 'ssh_gap',
    async close() { if (session) { session.stop(); await session.closed; } },
  };
}
