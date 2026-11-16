import { checkService } from "../../cli/lib/service.mjs";
// Provision existing stream APIs and save the one-time producer credential locally.
import { readFile, mkdir, lstat, open, link, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertValid } from '@tendriller/core/contract';
import { ApiError, createClient } from '@tendriller/core';
import { STREAM_SNAPSHOT_RECORD_BYTES } from '@tendriller/core/contract';
import { validateConfig } from './stream-collector.mjs';
import { recordLimit } from './stream-sources/records.mjs';

export const INIT_USAGE = 'tendril-stream init --page <private-page.json> --streams <spec.json> --out <private-collector.json>';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const placeholderToken = 'tp_' + 'a'.repeat(40); // Pure local validation; never sent or saved.
const defaultRecordBytes = recordLimit({});

export function parseInitArguments(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].slice(2), value = args[i + 1];
    if (!['--page', '--streams', '--out'].includes(args[i]) || Object.hasOwn(options, key)
      || !value || value.startsWith('--')) throw Error(`Usage: ${INIT_USAGE}`);
    options[key] = value;
  }
  if (!options.page || !options.streams || !options.out) throw Error(`Usage: ${INIT_USAGE}`);
  return options;
}

async function readJson(file, label) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch { throw Error(`Cannot read ${label} as JSON.`); } // Parse errors can quote credentials.
}

function policy(stream) {
  return { name: stream.name, durability: stream.durability, readers: stream.readers ?? 'owner', builtin: false,
    max_records: stream.durability === 'durable' ? stream.max_records ?? 10000 : null,
    max_age_seconds: stream.durability === 'durable' ? stream.max_age_seconds ?? 86400 : null };
}
const matches = (expected, actual) => Object.entries(expected).every(([key, value]) => actual[key] === value);

function prepare(handle, spec, specBase, outBase) {
  if (!object(handle) || typeof handle.api !== 'string' || !/^tk_[a-z2-7]{32}$/.test(handle.token))
    throw Error('The private page handle must contain api and an administrative tk_ token.');
  if (!object(spec) || Object.keys(spec).some(key => !['producer', 'streams', 'sources', 'spool_dir', 'max_spool_bytes'].includes(key)))
    throw Error('The stream spec accepts producer, streams, sources, spool_dir and max_spool_bytes.');
  if (!Array.isArray(spec.streams) || !spec.streams.length || spec.streams.length > 32) throw Error('Declare 1–32 streams.');
  const definitions = new Map();
  for (const stream of spec.streams) {
    assertValid('streamCreate', stream);
    if (definitions.has(stream.name)) throw Error(`Duplicate stream '${stream.name}'.`);
    definitions.set(stream.name, policy(stream));
  }
  const producer = assertValid('producerCreate', { name: spec.producer, streams: [...definitions.keys()] });
  if (!Array.isArray(spec.sources) || !spec.sources.length || spec.sources.length > 32) throw Error('Configure 1–32 sources.');
  const used = new Set();
  const sources = spec.sources.map(source => {
    const stream = object(source) && definitions.get(source.stream);
    if (!stream) throw Error('Every source must reference a stream declared in streams.');
    if (source.durability !== undefined && source.durability !== stream.durability)
      throw Error(`Source durability disagrees with stream '${stream.name}'.`);
    const snapshot = stream.durability === 'durable' && stream.max_records === 1;
    const max_record_bytes = source.max_record_bytes ?? (snapshot ? STREAM_SNAPSHOT_RECORD_BYTES : defaultRecordBytes);
    if (!snapshot && max_record_bytes > defaultRecordBytes)
      throw Error('max_record_bytes above 49152 requires a durable stream with max_records: 1.');
    if (typeof source.path === 'string' && source.path.includes('\0')) throw Error('Source paths cannot contain NUL.');
    used.add(stream.name);
    return { ...source, durability: stream.durability, max_record_bytes };
  });
  if (used.size !== definitions.size) throw Error('Every declared stream must be referenced by a source.');
  if (spec.spool_dir !== undefined && (typeof spec.spool_dir !== 'string' || !spec.spool_dir || spec.spool_dir.includes('\0')))
    throw Error('spool_dir must be a nonempty directory path.');
  const config = validateConfig({ api: handle.api, token: placeholderToken, sources,
    spool_dir: resolve(outBase, spec.spool_dir ?? './stream-spool'), max_spool_bytes: spec.max_spool_bytes }, specBase);
  return { definitions, producer, config };
}

async function request(label, action) {
  try { return await action(); }
  catch (error) {
    // Neither upstream bodies nor fetch errors belong in credential-safe output.
    const reason = error instanceof ApiError ? error.status >= 400 ? `HTTP ${error.status}` : 'invalid service response' : 'request failed or timed out';
    throw Error(`${label}: ${reason}.`);
  }
}

export async function initializeCollector({ page, streams, out }, { fetch: fetcher = globalThis.fetch } = {}) {
  const output = resolve(out);
  const pageFile = await readJson(page, 'the private page handle');
  const handle = object(pageFile?.handle) ? pageFile.handle : pageFile;
  const spec = await readJson(streams, 'the stream spec');
  const { definitions, producer, config } = prepare(handle, spec, dirname(resolve(streams)), dirname(output));
  try { await lstat(output); throw Error('Output already exists; keep using it or choose a new --out path. It was not overwritten.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  const temporary = `${output}.${randomUUID()}.tmp`;
  let file = await open(temporary, 'wx', 0o600);
  const api = createClient({ api: config.api, token: handle.token }, { fetch: (url, options) => fetcher(url, {
    ...options, redirect: 'error', signal: AbortSignal.timeout(15_000),
  }) });
  const created = [], reused = [];
  let attempted = false, producerRequested = false, credentialReceived = false, complete = false, published = false;
  try {
    await checkService(config.api, { fetch: fetcher });
    const existing = await request('List streams', () => api.streams.list());
    const grants = await request('List producers', () => api.producers.list());
    if (grants.producers.some(item => item.name === producer.name))
      throw Error(`Producer '${producer.name}' already exists; its credential cannot be retrieved. Use its saved configuration or explicitly choose a new producer name. Nothing was revoked.`);
    for (const [name, expected] of definitions) {
      const found = existing.streams.find(item => item.name === name);
      if (found && !matches(expected, found)) throw Error(`Stream '${name}' has a different policy (durability, readers or retention); it was not changed.`);
      if (found) reused.push(name);
    }
    for (const [name, expected] of definitions) {
      if (reused.includes(name)) continue;
      const { builtin, ...body } = expected;
      if (body.durability === 'ephemeral') { delete body.max_records; delete body.max_age_seconds; }
      attempted = true;
      const result = await request(`Create stream '${name}'`, () => api.streams.create(body));
      if (!matches(expected, result)) throw Error(`Created stream '${name}' returned a different policy.`);
      created.push(name);
    }
    producerRequested = attempted = true;
    const issued = await request(`Create producer '${producer.name}'`, () => api.producers.create(producer));
    if (issued.producer.name !== producer.name || issued.producer.streams.length !== producer.streams.length
      || !producer.streams.every(name => issued.producer.streams.includes(name))) throw Error('The service returned a different producer grant.');
    credentialReceived = true;
    config.token = issued.token;
    await file.writeFile(JSON.stringify(config, null, 2) + '\n');
    await file.sync();
    await file.close(); file = undefined; complete = true;
    // link is atomic and fails if any file or symlink appeared at --out meanwhile.
    await link(temporary, output); published = true;
    return { config_file: output, producer: producer.name, streams: producer.streams, created_streams: created, reused_streams: reused };
  } catch (error) {
    if (credentialReceived) throw Error(`${complete ? 'Complete' : 'Possibly incomplete'} private recovery configuration retained at ${temporary}. Producer '${producer.name}' was created but --out could not be saved; no resources were rolled back.`);
    if (producerRequested) throw Error(`${error.message} Producer creation may have completed without a recoverable credential; inspect '${producer.name}' before retrying. No resources were rolled back.`);
    if (attempted) throw Error(`${error.message} Stream setup may be partial. No resources were rolled back.`);
    throw error;
  } finally {
    if (file) await file.close();
    if (!credentialReceived || published) await unlink(temporary);
  }
}
