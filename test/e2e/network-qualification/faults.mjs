import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';

const execute = promisify(execFile);
const chain = 'TD_NETWORK_LAB';

// This controller is only for the disposable container's network namespace.
// No caller-supplied command, interface, address, or shell expression is accepted.
export function createFaults({ run = execute, isolated = process.env.TENDRILLER_NETWORK_LAB === '1' && existsSync('/.dockerenv') } = {}) {
  let installed = false;
  const shaped = new Set();
  const command = (file, args) => run(file, args, { timeout: 5000, maxBuffer: 16384 });
  const requireIsolation = () => {
    if (!isolated) throw new Error('NETWORK_LAB_CONTAINER_REQUIRED');
  };
  return {
    async blockUdp({ service = false } = {}) {
      requireIsolation();
      if (typeof service !== 'boolean') throw new Error('NETWORK_LAB_INVALID_FAULT');
      if (installed) throw new Error('NETWORK_LAB_FAULT_ALREADY_ACTIVE');
      // Both address families matter: IPv4-only blocking can silently use IPv6 RTC.
      const completed = [];
      try {
        for (const tool of ['iptables', 'ip6tables']) {
          await command(tool, ['-w', '-N', chain]);
          completed.push(tool);
          await command(tool, ['-w', '-A', chain, '-p', 'udp', '--dport', '53', '-j', 'RETURN']);
          await command(tool, ['-w', '-A', chain, '-p', 'udp', '-j', 'DROP']);
          if (service) await command(tool, ['-w', '-A', chain, '-p', 'tcp', '--dport', '8790', '-j', 'DROP']);
          await command(tool, ['-w', '-I', 'OUTPUT', '1', '-j', chain]);
        }
        installed = true;
      } catch (error) {
        const failures = [];
        for (const tool of completed) {
          // Hook may not yet exist when installation failed; flush/delete must still run.
          await command(tool, ['-w', '-D', 'OUTPUT', '-j', chain]).catch(() => {});
          for (const args of [['-w', '-F', chain], ['-w', '-X', chain]]) {
            try { await command(tool, args); } catch (failure) { failures.push(failure); }
          }
        }
        if (failures.length) throw new AggregateError([error, ...failures], 'NETWORK_LAB_ROLLBACK_FAILED');
        throw error;
      }
    },
    blockApplicationNetwork() { return this.blockUdp({ service: true }); },
    async restoreUdp() {
      requireIsolation();
      if (!installed) return;
      const errors = [];
      for (const tool of ['iptables', 'ip6tables']) {
        for (const args of [['-w', '-D', 'OUTPUT', '-j', chain], ['-w', '-F', chain], ['-w', '-X', chain]]) {
          try { await command(tool, args); } catch (error) { errors.push(error); }
        }
      }
      if (errors.length) throw new AggregateError(errors, 'NETWORK_LAB_RESTORE_FAILED');
      installed = false;
    },
    async impair() {
      requireIsolation();
      if (shaped.size) throw new Error('NETWORK_LAB_FAULT_ALREADY_ACTIVE');
      // Noble's iproute2 has no netem seed option. Loss is stochastic, not a
      // claim of identical packet selection on repeated runs.
      try {
        // Local host candidates use lo, whereas a selected server-reflexive
        // route can leave through the container's bridge interface.
        for (const device of ['lo', 'eth0']) {
          await command('tc', ['qdisc', 'add', 'dev', device, 'root', 'netem', 'delay', '60ms', 'loss', 'random', '1%']);
          shaped.add(device);
        }
      } catch (error) {
        try { await this.restoreImpairment(); }
        catch (rollback) { throw new AggregateError([error, rollback], 'NETWORK_LAB_ROLLBACK_FAILED'); }
        throw error;
      }
    },
    async restoreImpairment() {
      requireIsolation();
      const failures = [];
      for (const device of [...shaped]) {
        try { await command('tc', ['qdisc', 'del', 'dev', device, 'root']); shaped.delete(device); }
        catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, 'NETWORK_LAB_RESTORE_FAILED');
    },
    async close() {
      const results = await Promise.allSettled([this.restoreUdp(), this.restoreImpairment()]);
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'NETWORK_LAB_CLEANUP_FAILED');
    },
  };
}
