// A bounded local outbox. A file checkpoint and its records commit together.
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export class SpoolFull extends Error {
  constructor() { super('The durable spool is full; file readers will resume after uploads recover.'); this.code = 'spool_full'; }
}

async function atomicWrite(path, text) {
  const temp = `${path}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temp, 'wx', 0o600);
    await file.writeFile(text);
    await file.sync();
    await file.close(); file = null;
    await rename(temp, path);
    // A rename must survive a power loss, as well as a process restart.
    const directory = await open(join(path, '..'), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    await file?.close().catch(() => {});
    await unlink(temp).catch(() => {});
    throw error;
  }
}

export class StreamSpool {
  static async open(directory, { api, token, maxBytes = 16 * 1024 * 1024 } = {}) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lockPath = join(directory, 'collector.lock');
    let lock;
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = JSON.parse(await readFile(lockPath, 'utf8')); } catch { throw Error('Collector spool is locked; inspect collector.lock before removing it.'); }
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw Error('Invalid collector lock; inspect collector.lock before removing it.');
      try { process.kill(owner.pid, 0); throw Error('Another collector is using this spool.'); }
      catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
      // Unlink-and-retry can delete a competing process's newly acquired lock.
      // A crash needs deliberate recovery rather than risking two outbox writers.
      throw Error('Stale collector.lock: verify its PID is stopped, remove only that lock, then restart; keep outbox.json.');
    }
    if (!lock) throw Error('Could not acquire collector spool lock.');
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid }));
      await lock.sync();
    } catch (error) {
      await lock.close();
      await unlink(lockPath).catch(() => {});
      throw error;
    }
    const spool = new StreamSpool(directory, maxBytes, lock, lockPath);
    try {
      const identity = createHash('sha256').update(`${api}\n${token}`).digest('hex');
      try { spool.state = JSON.parse(await readFile(spool.path, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (spool.state && (spool.state.version !== 1 || spool.state.identity !== identity || !Array.isArray(spool.state.queue) || !spool.state.checkpoints))
        throw Error('Spool belongs to another producer or has an unsupported format. Use its original configuration or a new spool directory.');
      spool.state ||= { version: 1, identity, queue: [], checkpoints: {} };
      return spool;
    } catch (error) { await spool.close(); throw error; }
  }

  constructor(directory, maxBytes, lock, lockPath) {
    this.path = join(directory, 'outbox.json');
    this.maxBytes = maxBytes;
    this.lock = lock;
    this.lockPath = lockPath;
    this.work = Promise.resolve();
    this.state = null;
  }

  transaction(change) {
    const work = this.work.then(async () => {
      const next = structuredClone(this.state);
      const result = change(next);
      const text = JSON.stringify(next);
      if (Buffer.byteLength(text) > this.maxBytes) throw new SpoolFull();
      await atomicWrite(this.path, text);
      this.state = next;
      return result;
    });
    this.work = work.catch(() => {});
    return work;
  }

  enqueue(stream, records, checkpoint) {
    return this.transaction(state => {
      state.queue.push(...records.map(record => ({ stream, record })));
      if (checkpoint) state.checkpoints[checkpoint.source] = checkpoint.value;
    });
  }

  checkpoint(source) { return Object.hasOwn(this.state.checkpoints, source) ? this.state.checkpoints[source] : null; }
  get size() { return this.state.queue.length; }

  batch(maxRecords = 100, maxBytes = 128 * 1024) {
    const stream = this.state.queue[0]?.stream;
    if (!stream) return null;
    const records = [];
    let bytes = 16;
    for (const entry of this.state.queue) {
      if (entry.stream !== stream) continue;
      const size = Buffer.byteLength(JSON.stringify(entry.record)) + 1;
      if (records.length && (records.length >= maxRecords || bytes + size > maxBytes)) break;
      records.push(entry.record); bytes += size;
    }
    return { stream, records };
  }

  acknowledge(stream, ids) {
    const accepted = new Set(ids);
    return this.transaction(state => {
      state.queue = state.queue.filter(entry => entry.stream !== stream || !accepted.has(entry.record.id));
    });
  }

  async close() {
    await this.work;
    if (!this.lock) return;
    await this.lock.close(); this.lock = null;
    await unlink(this.lockPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
