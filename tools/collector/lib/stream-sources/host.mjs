import { cpus, freemem, totalmem, loadavg, hostname, platform } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { recordFor } from './records.mjs';

const execute = promisify(execFile);
const capabilities = Object.freeze({ mode: 'poll', replay: 'none', checkpoint: false });
const gpuFields = [['index', 1], ['utilization_percent', 1], ['memory_used_bytes', 1024 * 1024],
  ['memory_total_bytes', 1024 * 1024], ['temperature_c', 1]];

function gpuRow(line) {
  const values = line.split(','), result = {}, unavailable = {};
  if (values.length !== gpuFields.length) throw Error('Malformed nvidia-smi output');
  for (const [offset, [field, scale]] of gpuFields.entries()) {
    const text = values[offset].trim();
    let reason = !text ? 'not_reported' : /^(?:N\/A|\[N\/A\])$/i.test(text) ? 'not_available'
      : /^(?:Not Supported|\[Not Supported\])$/i.test(text) ? 'not_supported' : null;
    // Number('') and Number(' ') are zero; neither is a reported measurement.
    const value = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text) ? Number(text) * scale : NaN;
    if (!reason && (!Number.isFinite(value) || field === 'index' && (!Number.isSafeInteger(value) || value < 0)
      || field.startsWith('memory_') && value < 0)) reason = 'invalid_value';
    result[field] = reason ? null : value;
    if (reason) unavailable[field] = reason;
  }
  if (Object.keys(unavailable).length) result.unavailable = unavailable;
  return result;
}

export function cpuSnapshot() {
  return cpus().reduce((sum, cpu) => ({ idle: sum.idle + cpu.times.idle,
    total: sum.total + Object.values(cpu.times).reduce((n, t) => n + t, 0) }), { idle: 0, total: 0 });
}

export async function sampleHost(previous, { gpu = false } = {}, { executeGpu = execute } = {}) {
  const now = cpuSnapshot(), elapsed = previous ? now.total - previous.total : 0;
  const sample = { host: hostname(), platform: platform(), metrics: {
    cpu_percent: elapsed > 0 ? Math.max(0, Math.min(100, 100 * (1 - (now.idle - previous.idle) / elapsed))) : null,
    memory_used_bytes: totalmem() - freemem(), memory_total_bytes: totalmem(), load1: loadavg()[0],
  }, gpus: [] };
  if (gpu) {
    try {
      const { stdout } = await executeGpu('nvidia-smi', ['--query-gpu=index,utilization.gpu,memory.used,memory.total,temperature.gpu', '--format=csv,noheader,nounits'],
        { timeout: 3000, maxBuffer: 64 * 1024, windowsHide: true });
      sample.gpus = stdout.split('\n').filter(line => line.trim()).map(gpuRow);
      sample.gpu_status = sample.gpus.length ? 'available' : 'unavailable';
      if (!sample.gpus.length) sample.gpu_reason = 'no_devices_reported';
    } catch { sample.gpu_status = 'unavailable'; sample.gpu_reason = 'query_failed'; }
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
    failure: error => error.code || 'source_error',
    close() {},
  };
}
