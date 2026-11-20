import { spawn } from 'node:child_process';

/** Trusted evaluator executable, never application/model code. One request/response per process. */
export function adapterCall(executable, request, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH } });
    let output = '', settled = false;
    const finish = (error, result) => {
      if (settled) return; settled = true; clearTimeout(timer);
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(Error('Observer adapter deadline')); }, timeoutMs);
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.once('error', () => finish(Error('Observer adapter could not start')));
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.length > 1024 * 1024) { child.kill('SIGKILL'); finish(Error('Observer adapter response too large')); }
    });
    child.once('close', code => {
      if (code !== 0) { finish(Error('Observer adapter failed')); return; }
      try { finish(null, JSON.parse(output)); } catch { finish(Error('Observer adapter must return one JSON value')); }
    });
    child.stdin.end(JSON.stringify(request) + '\n');
  });
}
