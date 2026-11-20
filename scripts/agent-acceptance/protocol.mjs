import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/** Only observable output is retained. Never persist whole notifications or turn objects. */
export function observable(message) {
  const p = message.params ?? {};
  if (message.method === 'turn/completed') return { event: 'turn', id: p.turn?.id, status: p.turn?.status };
  if (message.method === 'error') return { event: 'error', code: p.error?.codexErrorInfo ?? 'host-error' };
  if (message.method !== 'item/completed') return null;
  const i = p.item ?? {}, base = { event: 'item', type: i.type, id: i.id };
  switch (i.type) {
    case 'agentMessage': return { ...base, text: i.text };
    case 'commandExecution': return { ...base, command: i.command, cwd: i.cwd, output: i.aggregatedOutput, exitCode: i.exitCode };
    case 'mcpToolCall': return { ...base, server: i.server, tool: i.tool, arguments: i.arguments, result: i.result, status: i.status };
    case 'webSearch': return { ...base, query: i.query, action: i.action };
    default: return null;
  }
}

export function observableTracker(clock = () => new Date().toISOString()) {
  const started = new Map(), timed = new Set(['commandExecution', 'mcpToolCall']);
  return message => {
    const item = message.params?.item;
    if (message.method === 'item/started') {
      if (timed.has(item?.type) && typeof item.id === 'string' && item.id.length <= 256) {
        const key = item.type + ':' + item.id;
        if (!started.has(key)) {
          if (started.size >= 4096) started.delete(started.keys().next().value);
          started.set(key, clock());
        }
      }
      return null; // No start payload, reasoning, or raw notification is retained.
    }
    const event = observable(message);
    if (event?.event === 'item' && timed.has(event.type)) {
      const key = event.type + ':' + event.id;
      event.startedAt = started.get(key) ?? null; event.completedAt = clock(); started.delete(key);
    }
    if (event?.event === 'turn') started.clear();
    return event;
  };
}

export class AppServer {
  constructor({ cwd, env, config = [], onEvent = () => {}, spawnHost = spawn, deadlineMs = 60000, executable = 'codex' }) {
    this.pending = new Map(); this.sequence = 0; this.deadlineMs = deadlineMs;
    this.child = spawnHost(executable, [...config.flatMap(value => ['-c', value]), 'app-server', '--listen', 'stdio://'],
      { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.resume(); // Raw diagnostics can contain secrets and reasoning; never log them.
    this.child.once('error', () => this.fail('App-server failed to start'));
    this.child.once('exit', () => this.fail('App-server exited'));
    this.child.stdin.on('error', () => this.fail('App-server input closed'));
    this.lines = createInterface({ input: this.child.stdout });
    const track = observableTracker();
    this.lines.on('line', line => {
      let m; try { m = JSON.parse(line); } catch { return; }
      if (m.method) {
        if (m.id !== undefined) this.write({ id: m.id, error: { code: -32601, message: 'Interactive requests unsupported; report the missing capability.' } });
        else { const event = track(m); if (event) onEvent(event); }
      } else {
        const entry = this.pending.get(m.id);
        if (!entry) return;
        clearTimeout(entry.timer); this.pending.delete(m.id);
        if (m.error) entry.reject(Error('App-server RPC failed: ' + entry.method));
        else entry.resolve(m.result);
      }
    });
  }
  write(message) { if (!this.stopped) this.child.stdin.write(JSON.stringify(message) + '\n'); }
  fail(message) {
    this.stopped = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(Error(message)); }
    this.pending.clear();
  }
  rpc(method, params = {}) {
    if (this.stopped) return Promise.reject(Error('App-server is closed'));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error('App-server deadline: ' + method)); }, this.deadlineMs);
      this.pending.set(id, { resolve, reject, timer, method }); this.write({ id, method, params });
    });
  }
  async initialize() {
    const result = await this.rpc('initialize', { clientInfo: { name: 'tendriller-fresh-agent', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    this.write({ method: 'initialized' }); return result;
  }
  async close() {
    const child = this.child;
    // The process group includes foreground participant children. Detached services
    // remain an explicitly reported cleanup responsibility, never a hidden handoff.
    if (child.exitCode === null && child.signalCode == null && child.pid) await new Promise(resolve => {
      const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 2000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
    });
    this.fail('App-server closed'); this.lines.close();
  }
}
