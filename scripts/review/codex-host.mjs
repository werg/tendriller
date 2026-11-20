import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/** Exercise the real Codex MCP host without starting a model turn or changing user configuration. */
export async function nativeHost({ origin, token, cwd, spawnHost = spawn, deadlineMs = 45000 }) {
  const child = spawnHost('codex', [
    '-c', 'mcp_servers.tendriller_review.url=' + JSON.stringify(origin + '/mcp'),
    '-c', 'mcp_servers.tendriller_review.bearer_token_env_var="TENDRILLER_REVIEW_TOKEN"',
    '-c', 'mcp_servers.tendriller_review.startup_timeout_sec=30',
    'app-server', '--listen', 'stdio://',
  ], { cwd, env: { ...process.env, TENDRILLER_REVIEW_TOKEN: token }, stdio: ['pipe', 'pipe', 'pipe'] });
  let sequence = 0, stopped = false;
  const pending = new Map();
  // Diagnostics can include host-specific context: do not publish the raw stderr stream.
  child.stderr.resume();
  const fail = message => {
    stopped = true;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error(message)); }
    pending.clear();
  };
  child.once('error', () => fail('Codex could not start. Install the qualified Codex CLI.'));
  child.once('exit', () => fail('Codex MCP host exited before completing the request.'));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const entry = pending.get(message.id);
    if (entry) {
      pending.delete(message.id); clearTimeout(entry.timer);
      // Never copy arbitrary child diagnostics into a public qualification report.
      if (message.error) entry.reject(Error('Codex MCP RPC failed: ' + entry.method));
      else entry.resolve(message.result);
    } else if (message.id !== undefined) {
      child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Interactive requests are not accepted by this qualification client.' } }) + '\n');
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    if (stopped) { reject(Error('Codex MCP host is closed')); return; }
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error('Codex MCP request deadline: ' + method)); }, deadlineMs);
    pending.set(id, { resolve, reject, timer, method });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const close = () => new Promise(resolve => {
    if (child.exitCode !== null || stopped) { lines.close(); resolve(); return; }
    child.once('exit', () => { clearTimeout(timer); lines.close(); resolve(); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.kill('SIGTERM');
  });
  try {
    await rpc('initialize', { clientInfo: { name: 'tendriller-review-qualification', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    // An ephemeral RPC context owns the connection. No turn/start or LLM call is made.
    const thread = await rpc('thread/start', { cwd, ephemeral: true });
    const status = await rpc('mcpServerStatus/list', { threadId: thread.thread.id, serverName: 'tendriller_review', detail: 'full' });
    return { status, call: (tool, args = {}) => rpc('mcpServer/tool/call', {
      threadId: thread.thread.id, server: 'tendriller_review', tool, arguments: args,
    }), close };
  } catch (error) { await close(); throw error; }
}
