import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { StreamSpool, SpoolFull } from './stream-spool.mjs';
import { createSourceAdapter } from './stream-sources/index.mjs';
import { sampleHost } from './stream-sources/host.mjs';
import { sshArguments } from './stream-sources/ssh.mjs';
import { commandArguments, commandTimeout } from './stream-sources/command.mjs';
import { validateRecordOptions } from './stream-sources/records.mjs';

// Preserve the existing helper imports while adapters own their implementations.
export { recordFor } from './stream-sources/records.mjs';
export { readFileBatch } from './stream-sources/file.mjs';
export { readLatestFile } from './stream-sources/latest.mjs';
export { cpuSnapshot, sampleHost } from './stream-sources/host.mjs';
export { sshArguments } from './stream-sources/ssh.mjs';

const STREAM = /^[a-z][a-z0-9._-]{0,63}$/;
const object = v => v && typeof v === 'object' && !Array.isArray(v);
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
    if (!['host', 'jsonl', 'log', 'latest', 'ssh', 'command'].includes(source.type)) throw Error('Source type must be host, jsonl, log, ssh or command.');
    const interval_ms = source.interval_ms ?? (source.type === 'host' ? 5000 : 1000);
    if (!Number.isInteger(interval_ms) || interval_ms < 500 || interval_ms > 3_600_000) throw Error('interval_ms must be 500–3600000.');
    if (source.run !== undefined && (typeof source.run !== 'string' || source.run.length > 200)) throw Error('run must be a string of at most 200 characters.');
    validateRecordOptions(source);
    const out = { ...source, interval_ms };
    if (['jsonl', 'log', 'latest'].includes(source.type)) {
      if (typeof source.path !== 'string' || !source.path) throw Error('File sources need a path.');
      if (source.durability !== 'durable') throw Error('File sources require durable streams so checkpointing cannot silently skip records.');
      if (source.type === 'latest' && source.format !== undefined && !['json','text'].includes(source.format))
        throw Error('Latest file format must be json or text.');
      out.path = resolve(base, source.path);
    }
    if (source.type === 'ssh') sshArguments(source); // Validate before starting any process.
    if (source.type === 'command') {
      commandArguments(source); out.timeout_ms = commandTimeout(source);
      if (source.cwd !== undefined) {
        if (typeof source.cwd !== 'string' || !source.cwd || source.cwd.includes('\0')) throw Error('Command cwd must be a directory path.');
        out.cwd = resolve(base, source.cwd);
      }
    }
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

export class Collector {
  static async open(config, options = {}) {
    const spool = await StreamSpool.open(config.spool_dir, { api: config.api, token: config.token, maxBytes: config.max_spool_bytes });
    try { return new Collector(config, spool, options); }
    catch (error) { await spool.close(); throw error; }
  }

  constructor(config, spool, { fetch: fetcher = globalThis.fetch,
    status = message => process.stderr.write(JSON.stringify(message) + '\n'), sourceFactory = createSourceAdapter } = {}) {
    this.config = config; this.spool = spool; this.fetch = fetcher; this.status = status;
    this.adapters = config.sources.map(source => sourceFactory(source));
    this.live = new Map(); this.states = new Map(); this.last = new Map(); this.polling = new Map();
    this.abort = new AbortController(); this.tasks = []; this.stopped = false;
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
    await Promise.all(this.adapters.filter(adapter => adapter.capabilities.mode === 'poll').map(adapter => this.collectSource(adapter, now)));
  }

  collectSource(adapter, now = Date.now()) {
    const { source, capabilities } = adapter;
    if (this.abort.signal.aborted || this.polling.has(source.id)
      || now - (this.last.get(source.id) ?? 0) < source.interval_ms) return Promise.resolve();
    this.last.set(source.id, now);
    const collecting = (async () => {
      try {
        const previous = capabilities.checkpoint ? this.spool.checkpoint(source.id) : null;
        let maxRecords = 100;
        for (;;) {
          const batch = await adapter.read({ checkpoint: previous, maxRecords, signal: this.abort.signal });
          const checkpoint = capabilities.checkpoint ? { source: source.id, value: batch.checkpoint } : undefined;
          if (!checkpoint || JSON.stringify(batch.checkpoint) !== JSON.stringify(previous)) {
            try { await this.accept(source, batch.records, checkpoint); }
            catch (error) {
              if (!(error instanceof SpoolFull) || capabilities.replay !== 'retained-file' || batch.records.length <= 1) throw error;
              // Retry a smaller prefix from the same uncommitted checkpoint.
              // A live source cannot promise that failed input can be reread.
              maxRecords = Math.max(1, Math.floor(batch.records.length / 2));
              continue;
            }
          }
          this.report(source.id, batch.health);
          break;
        }
      } catch (error) { this.report(source.id, adapter.failure(error)); }
    })();
    this.polling.set(source.id, collecting);
    return collecting.finally(() => this.polling.delete(source.id));
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

  async runStream(adapter) {
    const { source } = adapter;
    let backoff = 1000;
    while (!this.abort.signal.aborted) {
      const started = Date.now();
      try {
        for await (const batch of adapter.stream({ signal: this.abort.signal, report: state => this.report(source.id, state) })) {
          await this.accept(source, batch.records);
          this.report(source.id, batch.health);
        }
      } catch (error) { this.report(source.id, adapter.failure(error)); }
      if (this.abort.signal.aborted) break;
      backoff = Date.now() - started > 30_000 ? 1000 : Math.min(backoff * 2, 30_000);
      await pause(backoff, this.abort.signal);
    }
  }

  async run() {
    this.tasks = [
      ...this.adapters.filter(adapter => adapter.capabilities.mode === 'poll').map(adapter =>
        (async () => { while (!this.abort.signal.aborted) { await this.collectSource(adapter); await pause(250, this.abort.signal); } })()),
      (async () => {
        let backoff = 500;
        while (!this.abort.signal.aborted) {
          const ok = await this.flushOnce();
          backoff = ok ? 500 : Math.min(backoff * 2, 30_000);
          await pause(backoff, this.abort.signal);
        }
      })(),
      ...this.adapters.filter(adapter => adapter.capabilities.mode === 'stream').map(adapter => this.runStream(adapter)),
    ];
    try { await Promise.all(this.tasks); }
    finally { await this.stop(); }
    if (this.fatal) throw Error('Producer upload was rejected; queued records remain on disk. Check configuration and permissions.');
  }

  stop() {
    if (this.stopping) return this.stopping;
    this.stopped = true; this.abort.abort();
    const closing = this.adapters.map(adapter => Promise.resolve().then(() => adapter.close()));
    this.stopping = (async () => {
      await Promise.allSettled([...this.tasks, ...closing, ...this.polling.values()]);
      this.live.clear();
      await this.spool.close();
    })();
    return this.stopping;
  }
}

function waitForDrain(output, signal) {
  return new Promise((resolve, reject) => {
    const finish = (ready, error) => {
      output.off('drain', drained); output.off('close', closed); output.off('error', failed);
      signal?.removeEventListener('abort', closed);
      if (error) reject(error); else resolve(ready);
    };
    const drained = () => finish(true), closed = () => finish(false), failed = error => finish(false, error);
    output.once('drain', drained); output.once('close', closed); output.once('error', failed);
    signal?.addEventListener('abort', closed, { once: true });
    if (signal?.aborted || output.destroyed) closed();
  });
}

export async function emitHostSamples({ interval = 5000, gpu = false, signal, output = process.stdout, sample = sampleHost } = {}) {
  let previous;
  while (!signal?.aborted) {
    const { sample: value, cpu } = await sample(previous, { gpu }); previous = cpu;
    if (signal?.aborted) break;
    if (!output.write(JSON.stringify({ ts: Date.now(), type: 'host', data: value }) + '\n')
      && !await waitForDrain(output, signal)) break;
    await pause(interval, signal);
  }
}
