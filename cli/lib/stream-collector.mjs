import { open, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { cpus, freemem, totalmem, loadavg, hostname, platform } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { StreamSpool, SpoolFull } from './stream-spool.mjs';

const execute = promisify(execFile);
const STREAM = /^[a-z][a-z0-9._-]{0,63}$/;
const MAX_RECORD_BYTES = 48 * 1024;
const MAX_LINE_BYTES = 32 * 1024;
const own = (v, k) => Object.prototype.hasOwnProperty.call(v, k);
const object = v => v && typeof v === 'object' && !Array.isArray(v);
const digest = b => createHash('sha256').update(b).digest('hex');
const pause = async (ms, signal) => { try { await delay(ms, undefined, { signal }); } catch (e) { if (e.name !== 'AbortError') throw e; } };

export function validateConfig(input, base = process.cwd()) {
  if (!object(input)) throw Error('Collector configuration must be an object.');
  const api = new URL(input.api);
  if (api.username || api.password || api.search || api.hash || !/^\/api\/t\/[a-z2-7]{12}\/?$/.test(api.pathname)
    || !(api.protocol === 'https:' || api.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(api.hostname)))
    throw Error('api must be a Tendriller HTTPS API URL (HTTP is allowed only on localhost).');
  if (typeof input.token !== 'string' || !/^tp_[a-z2-7]{32,64}$/.test(input.token)) throw Error('token must be a scoped tp_ producer credential.');
  if (!Array.isArray(input.sources) || !input.sources.length || input.sources.length > 32) throw Error('Configure 1–32 sources.');
  const ids = new Set(), policies = new Map();
  const sources = input.sources.map(source => {
    if (!object(source) || typeof source.id !== 'string' || !/^[a-zA-Z0-9_.-]{1,64}$/.test(source.id) || ids.has(source.id)
      || ['__proto__', 'constructor', 'prototype'].includes(source.id)) throw Error('Each source needs a unique safe id (letters, numbers, dots, underscores or hyphens).');
    ids.add(source.id);
    if (typeof source.stream !== 'string' || !STREAM.test(source.stream) || source.stream.startsWith('system.')) throw Error('Sources must publish to a custom stream.');
    if (!['durable', 'ephemeral'].includes(source.durability)) throw Error('Every source must declare its stream durability.');
    if (policies.has(source.stream) && policies.get(source.stream) !== source.durability) throw Error('Sources sharing a stream must agree on durability.');
    policies.set(source.stream, source.durability);
    if (!['host', 'jsonl', 'log', 'ssh'].includes(source.type)) throw Error('Source type must be host, jsonl, log or ssh.');
    const interval_ms = source.interval_ms ?? (source.type === 'host' ? 5000 : 1000);
    if (!Number.isInteger(interval_ms) || interval_ms < 500 || interval_ms > 3_600_000) throw Error('interval_ms must be 500–3600000.');
    if (source.run !== undefined && (typeof source.run !== 'string' || source.run.length > 200)) throw Error('run must be a string of at most 200 characters.');
    const out = { ...source, interval_ms };
    if (source.type === 'jsonl' || source.type === 'log') {
      if (typeof source.path !== 'string' || !source.path) throw Error('File sources need a path.');
      if (source.durability !== 'durable') throw Error('File sources require durable streams so checkpointing cannot silently skip records.');
      out.path = resolve(base, source.path);
    }
    if (source.type === 'ssh') sshArguments(source); // Validate before starting any process.
    return out;
  });
  const max_spool_bytes = input.max_spool_bytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(max_spool_bytes) || max_spool_bytes < 65536 || max_spool_bytes > 64 * 1024 * 1024) throw Error('max_spool_bytes must be 65536–67108864.');
  return { api: api.href.replace(/\/$/, ''), token: input.token, sources,
    spool_dir: resolve(base, input.spool_dir || './stream-spool'), max_spool_bytes };
}

export async function readConfig(file) { return validateConfig(JSON.parse(await readFile(file, 'utf8')), dirname(resolve(file))); }

export function parseSampleArguments(args) {
  let interval = 5000, gpu = false, hasInterval = false;
  for (const argument of args) {
    if (argument === '--gpu' && !gpu) { gpu = true; continue; }
    if (!hasInterval && /^\d+$/.test(argument)) { interval = Number(argument); hasInterval = true; continue; }
    throw Error('Usage: tendril-stream --sample [interval_ms] [--gpu]');
  }
  if (!Number.isInteger(interval) || interval < 500 || interval > 3_600_000) throw Error('Sample interval must be 500–3600000 milliseconds.');
  return { interval, gpu };
}

export function sshArguments(source) {
  if (typeof source.host !== 'string' || !/^(?:[a-zA-Z0-9_.-]+@)?[a-zA-Z0-9][a-zA-Z0-9._-]{0,252}$/.test(source.host))
    throw Error('SSH host must be a host alias or hostname, optionally prefixed with user@.');
  if (!Array.isArray(source.command) || !source.command.length || source.command.length > 32
    || source.command.some(x => typeof x !== 'string' || !x.length || x.length > 2048 || x.includes('\0')))
    throw Error('SSH command must be an explicit array of nonempty arguments.');
  if (source.port !== undefined && (!Number.isInteger(source.port) || source.port < 1 || source.port > 65535)) throw Error('Invalid SSH port.');
  if (source.format !== undefined && !['jsonl', 'log'].includes(source.format)) throw Error('SSH format must be jsonl or log.');
  // OpenSSH joins command arguments into a shell command on the remote host.
  // Quote every argument ourselves; never interpolate a host into a local shell.
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  return ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2',
    ...(source.port ? ['-p', String(source.port)] : []), '--', source.host, source.command.map(quote).join(' ')];
}

export function recordFor(source, type, value, ts = Date.now()) {
  const data = { ...(object(value) ? value : { value }), source: source.id, run: source.run ?? null };
  const record = { id: randomUUID(), ts, type, data };
  if (Buffer.byteLength(JSON.stringify(record)) > MAX_RECORD_BYTES) throw Error('record_too_large');
  return record;
}

function lineRecord(source, line) {
  if (source.type === 'log' || source.format === 'log') return recordFor(source, 'log', { line });
  let parsed;
  try { parsed = JSON.parse(line); }
  catch { return recordFor(source, 'collector_error', { reason: 'invalid_json' }); }
  const ts = Number.isSafeInteger(parsed?.ts) && parsed.ts >= 0 ? parsed.ts : Date.now();
  const type = typeof parsed?.type === 'string' && parsed.type.length > 0 && parsed.type.length <= 80 ? parsed.type : 'metrics';
  return recordFor(source, type, object(parsed) && own(parsed, 'data') ? parsed.data : parsed, ts);
}

/** Reads complete UTF-8 lines; stores no uncommitted partial line in memory. */
export async function readFileBatch(source, checkpoint, maxRecords = 100) {
  const file = await open(source.path, 'r');
  try {
    const stat = await file.stat();
    const identity = `${stat.dev}:${stat.ino}`;
    let offset = checkpoint?.identity === identity && checkpoint.offset <= stat.size ? checkpoint.offset : 0;
    let discarding = offset ? !!checkpoint?.discarding : false;
    // Detect copytruncate followed by regrowth beyond the previous offset.
    if (offset && checkpoint.anchor) {
      const anchor = Buffer.alloc(Math.min(offset, 64));
      const read = await file.read(anchor, 0, anchor.length, offset - anchor.length);
      if (digest(anchor.subarray(0, read.bytesRead)) !== checkpoint.anchor) { offset = 0; discarding = false; }
    }
    const buffer = Buffer.alloc(Math.min(128 * 1024, Math.max(0, stat.size - offset)));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
    const records = [];
    let start = 0, consumed = 0;
    while (start < bytesRead && records.length < maxRecords) {
      const newline = buffer.indexOf(10, start);
      if (newline < 0 || newline >= bytesRead) {
        if (discarding || bytesRead - start > MAX_LINE_BYTES) {
          if (!discarding) records.push(recordFor(source, 'collector_error', { reason: 'line_too_large', offset: offset + start }));
          discarding = true; consumed = bytesRead;
        }
        break;
      }
      if (!discarding) {
        if (newline - start > MAX_LINE_BYTES) records.push(recordFor(source, 'collector_error', { reason: 'line_too_large', offset: offset + start }));
        else {
          const line = buffer.subarray(start, newline).toString('utf8').replace(/\r$/, '');
          if (line.trim()) {
            try { records.push(lineRecord(source, line)); }
            catch { records.push(recordFor(source, 'collector_error', { reason: 'record_too_large', offset: offset + start })); }
          }
        }
      }
      discarding = false;
      start = consumed = newline + 1;
    }
    const nextOffset = offset + consumed;
    const anchor = Buffer.alloc(Math.min(nextOffset, 64));
    const read = await file.read(anchor, 0, anchor.length, nextOffset - anchor.length);
    const after = await file.stat();
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size
      || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs)
      throw Error('file_changed_during_read');
    return { records, checkpoint: { identity, offset: nextOffset, anchor: digest(anchor.subarray(0, read.bytesRead)), discarding } };
  } finally { await file.close(); }
}

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

export class Collector {
  static async open(config, options = {}) {
    const spool = await StreamSpool.open(config.spool_dir, { api: config.api, token: config.token, maxBytes: config.max_spool_bytes });
    return new Collector(config, spool, options);
  }

  constructor(config, spool, { fetch: fetcher = globalThis.fetch, status = message => process.stderr.write(JSON.stringify(message) + '\n') } = {}) {
    this.config = config; this.spool = spool; this.fetch = fetcher; this.status = status;
    this.live = new Map(); this.states = new Map(); this.cpu = new Map(); this.last = new Map();
    this.abort = new AbortController(); this.tasks = []; this.children = new Set(); this.stopped = false;
    this.abort.signal.addEventListener('abort', () => {
      for (const child of this.children) this.terminate(child);
    }, { once: true });
  }

  report(source, state) {
    if (this.states.get(source) === state) return;
    this.states.set(source, state);
    this.status({ collector: 'tendril-stream', source, state, at: Date.now() });
  }

  async accept(source, records, checkpoint) {
    if (source.durability === 'durable') await this.spool.enqueue(source.stream, records, checkpoint);
    else if (records.length) {
      // Only the most recent sample from each source waits in memory. Failed
      // ephemeral uploads are discarded, never retried or written to disk.
      this.live.set(source.id, { stream: source.stream, records: records.slice(-1) });
    }
  }

  async collectOnce(now = Date.now()) {
    await Promise.all(this.config.sources.filter(source => source.type !== 'ssh').map(async source => {
      if (now - (this.last.get(source.id) ?? 0) < source.interval_ms) return;
      this.last.set(source.id, now);
      try {
        if (source.type === 'host') {
          const { sample, cpu } = await sampleHost(this.cpu.get(source.id), source);
          this.cpu.set(source.id, cpu);
          await this.accept(source, [recordFor(source, 'host', sample)]);
          this.report(source.id, source.gpu && sample.gpu_status !== 'available' ? 'gpu_unavailable' : 'collecting');
        } else {
          const previous = this.spool.checkpoint(source.id);
          let maxRecords = 100;
          for (;;) {
            const batch = await readFileBatch(source, previous, maxRecords);
            if (JSON.stringify(batch.checkpoint) === JSON.stringify(previous)) break;
            try {
              await this.accept(source, batch.records, { source: source.id, value: batch.checkpoint });
              break;
            } catch (error) {
              if (!(error instanceof SpoolFull) || batch.records.length <= 1) throw error;
              // The configured spool can be smaller than a normal read batch.
              // Re-read a smaller prefix from the same uncommitted checkpoint;
              // never advance past records that did not fit the atomic write.
              maxRecords = Math.max(1, Math.floor(batch.records.length / 2));
            }
          }
          this.report(source.id, 'collecting');
        }
      } catch (error) { this.report(source.id, error instanceof SpoolFull ? 'spool_full' : error.code === 'ENOENT' ? 'waiting_for_file' : 'source_error'); }
    }));
  }

  async post(batch) {
    const response = await this.fetch(`${this.config.api}/streams/${encodeURIComponent(batch.stream)}/records`, {
      method: 'POST', headers: { Authorization: `Bearer ${this.config.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: batch.records }), signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(10_000)]),
    });
    if (!response.ok) {
      const error = new Error('upload_rejected'); error.status = response.status;
      // Never print server bodies; an upstream could reflect a credential.
      throw error;
    }
    const result = await response.json();
    if (!Array.isArray(result.records) || result.records.length !== batch.records.length
      || result.records.some((record, i) => record.id !== batch.records[i].id || record.stream !== batch.stream))
      throw Error('invalid_acknowledgement');
    return result;
  }

  async flushOnce() {
    let failed = false;
    const ephemeral = [...this.live.values()]; this.live.clear();
    for (const batch of ephemeral) {
      try {
        const result = await this.post(batch);
        if (result.durability !== 'ephemeral') { const error = Error('durability_mismatch'); error.status = 400; throw error; }
      } catch (error) {
        failed = true; this.report(batch.stream, 'ephemeral_sample_dropped');
        if ([400, 401, 403, 404, 409].includes(error.status)) { this.fatal = true; this.abort.abort(); }
      }
    }
    const batch = this.spool.batch();
    if (batch) {
      try {
        const result = await this.post(batch);
        if (result.durability !== 'durable') { const error = Error('durability_mismatch'); error.status = 400; throw error; }
        await this.spool.acknowledge(batch.stream, batch.records.map(record => record.id));
        this.report(batch.stream, 'delivering');
      } catch (error) {
        failed = true;
        const permanent = [400, 401, 403, 404, 409].includes(error.status);
        this.report(batch.stream, permanent ? 'upload_rejected_check_configuration' : 'buffering');
        if (permanent) { this.abort.abort(); this.fatal = true; }
      }
    }
    return !failed;
  }

  terminate(child) {
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    timer.unref();
    child.once('close', () => clearTimeout(timer));
  }

  async runSsh(source) {
    let backoff = 1000;
    while (!this.abort.signal.aborted) {
      const child = spawn('ssh', sshArguments(source), { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      this.children.add(child);
      let spawnError = false;
      child.on('error', () => { spawnError = true; });
      let buffered = Buffer.alloc(0), discarding = false;
      const started = Date.now();
      this.report(source.id, 'ssh_connecting');
      try {
        for await (const chunk of child.stdout) {
          if (this.abort.signal.aborted) break;
          buffered = Buffer.concat([buffered, chunk]);
          for (;;) {
            const newline = buffered.indexOf(10);
            if (newline < 0) {
              if (buffered.length > MAX_LINE_BYTES) { buffered = Buffer.alloc(0); discarding = true; this.report(source.id, 'line_too_large'); }
              break;
            }
            const line = buffered.subarray(0, newline); buffered = buffered.subarray(newline + 1);
            if (discarding || line.length > MAX_LINE_BYTES) { discarding = false; this.report(source.id, 'line_too_large'); continue; }
            if (!line.toString('utf8').trim()) continue;
            await this.accept(source, [lineRecord(source, line.toString('utf8').replace(/\r$/, ''))]);
            this.report(source.id, 'collecting');
          }
        }
      } catch (error) { this.report(source.id, error instanceof SpoolFull ? 'spool_full_ssh_gap' : 'ssh_gap'); }
      finally { this.terminate(child); this.children.delete(child); }
      if (this.abort.signal.aborted) break;
      this.report(source.id, spawnError ? 'ssh_unavailable' : 'ssh_disconnected_gap');
      backoff = Date.now() - started > 30_000 ? 1000 : Math.min(backoff * 2, 30_000);
      await pause(backoff, this.abort.signal);
    }
  }

  async run() {
    this.tasks = [
      (async () => { while (!this.abort.signal.aborted) { await this.collectOnce(); await pause(250, this.abort.signal); } })(),
      (async () => {
        let backoff = 500;
        while (!this.abort.signal.aborted) {
          const ok = await this.flushOnce();
          backoff = ok ? 500 : Math.min(backoff * 2, 30_000);
          await pause(backoff, this.abort.signal);
        }
      })(),
      ...this.config.sources.filter(source => source.type === 'ssh').map(source => this.runSsh(source)),
    ];
    try { await Promise.all(this.tasks); }
    finally { await this.stop(); }
    if (this.fatal) throw Error('Producer upload was rejected; queued records remain on disk. Check configuration and permissions.');
  }

  stop() {
    if (this.stopping) return this.stopping;
    this.stopped = true; this.abort.abort();
    for (const child of this.children) child.kill('SIGTERM');
    this.stopping = (async () => {
      await Promise.allSettled(this.tasks);
      this.live.clear();
      await this.spool.close();
    })();
    return this.stopping;
  }
}

export async function emitHostSamples({ interval = 5000, gpu = false, signal } = {}) {
  let previous;
  while (!signal?.aborted) {
    const { sample, cpu } = await sampleHost(previous, { gpu }); previous = cpu;
    if (!process.stdout.write(JSON.stringify({ ts: Date.now(), type: 'host', data: sample }) + '\n'))
      await new Promise(resolve => {
        const finish = () => {
          process.stdout.off('drain', finish);
          signal?.removeEventListener('abort', finish);
          resolve();
        };
        process.stdout.once('drain', finish);
        signal?.addEventListener('abort', finish, { once: true });
        if (signal?.aborted) finish();
      });
    await pause(interval, signal);
  }
}
