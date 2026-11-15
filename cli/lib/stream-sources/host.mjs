import { cpus, freemem, totalmem, loadavg, hostname, platform } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { recordFor } from './records.mjs';

const execute = promisify(execFile);
const capabilities = Object.freeze({ mode: 'poll', replay: 'none', checkpoint: false });

export function cpuSnapshot() {
  return cpus().reduce((sum, cpu) => ({ idle: sum.idle + cpu.times.idle,
    total: sum.total + Object.values(cpu.times).reduce((n, t) => n + t, 0) }), { idle: 0, total: 0 });
}

export async function sampleHost(previous, { gpu = false } = {}) {
  const now = cpuSnapshot(), elapsed = previous ? now.total - previous.total : 0;
  const sample = { host: hostname(), platform: platform(), metrics: {
    cpu_percent: elapsed > 0 ? Math.max(0, Math.min(100, 100 * (1 - (now.idle - previous.idle) / elapsed))) : null,
    memory_used_bytes: totalmem() - freemem(), memory_total_bytes: totalmem(), load1: loadavg()[0],
  }, gpus: [] };
  if (gpu) {
    try {
      const { stdout } = await execute('nvidia-smi', ['--query-gpu=index,utilization.gpu,memory.used,memory.total,temperature.gpu', '--format=csv,noheader,nounits'],
        { timeout: 3000, maxBuffer: 64 * 1024, windowsHide: true });
      sample.gpus = stdout.trim().split('\n').filter(Boolean).map(line => {
        const values = line.split(',').map(x => Number(x.trim()));
        const [index, utilization_percent, used, total, temperature_c] = values;
        return { index, utilization_percent: Number.isFinite(utilization_percent) ? utilization_percent : null,
          memory_used_bytes: Number.isFinite(used) ? used * 1024 * 1024 : null,
          memory_total_bytes: Number.isFinite(total) ? total * 1024 * 1024 : null,
          temperature_c: Number.isFinite(temperature_c) ? temperature_c : null };
      });
      sample.gpu_status = 'available';
    } catch { sample.gpu_status = 'unavailable'; }
  }
  return { sample, cpu: now };
}

/** A poll is a fresh observation. Its previous CPU counters are not a replay checkpoint. */
export function createHostSource(source, { sample = sampleHost } = {}) {
  let previous;
  return {
    source, capabilities,
    async read() {
      const { sample: value, cpu } = await sample(previous, source);
      previous = cpu;
      return { records: [recordFor(source, 'host', value)],
        health: source.gpu && value.gpu_status !== 'available' ? 'gpu_unavailable' : 'collecting' };
    },
    failure: error => error.code === 'spool_full' ? 'spool_full' : 'source_error',
    close() {},
  };
}
