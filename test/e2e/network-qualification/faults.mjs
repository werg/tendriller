import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';

const execute = promisify(execFile);
const chain = 'TD_NETWORK_LAB';

// This controller is only for the disposable container's network namespace.
// No caller-supplied command, interface, address, or shell expression is accepted.
export function createFaults({ run = execute, isolated = process.env.TENDRILLER_NETWORK_LAB === '1' && existsSync('/.dockerenv'), cleanupTimeoutMs = 45_000 } = {}) {
  if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1 || cleanupTimeoutMs > 60_000) throw new Error('NETWORK_LAB_INVALID_TIMEOUT');
  const chains = new Set();
  const hooks = new Set();
  const shaped = new Set();
  let stopped = false, queue = Promise.resolve(), cleanupTask;
  const command = (file, args) => run(file, args, { timeout: 5000, maxBuffer: 16384 });
  const requireIsolation = () => {
    if (!isolated) throw new Error('NETWORK_LAB_CONTAINER_REQUIRED');
  };
  // Reserve ownership synchronously, before any syscall or its first await.
  // Restores use the same queue so close cannot race any admitted mutation.
  const enqueue = action => {
    const task = queue.then(action);
    queue = task.catch(() => {});
    return task;
  };
  const admit = action => {
    requireIsolation();
    if (stopped) return Promise.reject(new Error('NETWORK_LAB_CLOSED'));
    return enqueue(action);
  };
  const install = (file, args) => {
    if (stopped) throw new Error('NETWORK_LAB_CLOSED');
    return command(file, args);
  };
  async function restoreUdp() {
    const errors = [];
    for (const tool of ['iptables', 'ip6tables']) {
      if (hooks.has(tool)) {
        try { await command(tool, ['-w', '-D', 'OUTPUT', '-j', chain]); hooks.delete(tool); }
        catch (error) { errors.push(error); }
      }
      if (chains.has(tool)) {
        try { await command(tool, ['-w', '-F', chain]); } catch (error) { errors.push(error); }
        try { await command(tool, ['-w', '-X', chain]); chains.delete(tool); }
        catch (error) { errors.push(error); }
      }
    }
    if (errors.length) throw new AggregateError(errors, 'NETWORK_LAB_RESTORE_FAILED');
  }
  async function restoreImpairment() {
    const failures = [];
    for (const device of [...shaped]) {
      try { await command('tc', ['qdisc', 'del', 'dev', device, 'root']); shaped.delete(device); }
      catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'NETWORK_LAB_RESTORE_FAILED');
  }
  return {
    async blockUdp({ service = false } = {}) {
      if (typeof service !== 'boolean') throw new Error('NETWORK_LAB_INVALID_FAULT');
      return admit(async () => {
        if (chains.size || hooks.size) throw new Error('NETWORK_LAB_FAULT_ALREADY_ACTIVE');
        // Both address families matter: IPv4-only blocking can silently use IPv6 RTC.
        try {
          for (const tool of ['iptables', 'ip6tables']) {
            await install(tool, ['-w', '-N', chain]);
            chains.add(tool);
            await install(tool, ['-w', '-A', chain, '-p', 'udp', '--dport', '53', '-j', 'RETURN']);
            await install(tool, ['-w', '-A', chain, '-p', 'udp', '-j', 'DROP']);
            if (service) await install(tool, ['-w', '-A', chain, '-p', 'tcp', '--dport', '8790', '-j', 'DROP']);
            await install(tool, ['-w', '-I', 'OUTPUT', '1', '-j', chain]);
            hooks.add(tool);
          }
        } catch (error) {
          try { await restoreUdp(); }
          catch (rollback) { throw new AggregateError([error, rollback], 'NETWORK_LAB_ROLLBACK_FAILED'); }
          throw error;
        }
      });
    },
    blockApplicationNetwork() { return this.blockUdp({ service: true }); },
    async restoreUdp() { return admit(restoreUdp); },
    async impair() {
      return admit(async () => {
        if (shaped.size) throw new Error('NETWORK_LAB_FAULT_ALREADY_ACTIVE');
        // Noble's iproute2 has no netem seed option. Loss is stochastic, not a
        // claim of identical packet selection on repeated runs.
        try {
          // Local host candidates use lo, whereas a selected server-reflexive
          // route can leave through the container's bridge interface.
          for (const device of ['lo', 'eth0']) {
            await install('tc', ['qdisc', 'add', 'dev', device, 'root', 'netem', 'delay', '60ms', 'loss', 'random', '1%']);
            shaped.add(device);
          }
        } catch (error) {
          try { await restoreImpairment(); }
          catch (rollback) { throw new AggregateError([error, rollback], 'NETWORK_LAB_ROLLBACK_FAILED'); }
          throw error;
        }
      });
    },
    async restoreImpairment() { return admit(restoreImpairment); },
    async close() {
      requireIsolation();
      // Permanently fence new setups/restores even when cleanup needs a retry.
      stopped = true;
      if (!cleanupTask) {
        const task = enqueue(async () => {
          const results = await Promise.allSettled([restoreUdp(), restoreImpairment()]);
          const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
          if (errors.length) throw new AggregateError(errors, 'NETWORK_LAB_CLEANUP_FAILED');
        });
        cleanupTask = task;
        void task.catch(() => { if (cleanupTask === task) cleanupTask = undefined; });
      }
      let timer;
      try {
        // Real syscalls also have a five-second execFile bound. A faulty injected
        // runner cannot turn an uncertain cleanup into success or hold it forever.
        await Promise.race([cleanupTask, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('NETWORK_LAB_CLEANUP_TIMEOUT')), cleanupTimeoutMs);
        })]);
      } finally { clearTimeout(timer); }
    },
  };
}
