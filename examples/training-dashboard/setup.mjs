// Create a passive dashboard and a narrowly scoped machine producer. Node 22.15+.
import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const service = (process.env.TENDRILLER_SERVICE_BASE || 'https://tendriller.dev').replace(/\/$/, '');
const owner = process.env.TENDRILLER_OWNER;
const directory = resolve(process.env.TENDRILLER_DASHBOARD_DIR || './tendriller-training');
const handleFile = join(directory, 'page.json'), configFile = join(directory, 'collector.json');
if (!owner) throw Error('Set TENDRILLER_OWNER to your verified GitHub or Google email.');
await mkdir(directory, { recursive: true, mode: 0o700 });

async function load(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}
async function save(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, path); await chmod(path, 0o600);
}
async function request(url, { token, body, method = body === undefined ? 'GET' : 'POST' } = {}) {
  const response = await fetch(url, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json().catch(() => null);
  if (!response.ok) throw Error(`Setup request failed: HTTP ${response.status} (${value?.error?.code || 'unavailable'}).`);
  return value;
}

let saved = await load(handleFile);
if (saved && (saved.owner !== owner || saved.service !== service)) throw Error('Saved dashboard belongs to another owner/service. Choose another TENDRILLER_DASHBOARD_DIR.');
if (!saved) {
  const handle = await request(service + '/api/tendrils', { body: { owner, name: 'Training observatory', mode: 'dashboard' } });
  saved = { owner, service, handle, producer: 'training-' + randomUUID().slice(0, 8) };
  await save(handleFile, saved);
}
const { api, token } = saved.handle;
const desired = [
  { name: 'machine.utilization', durability: 'ephemeral', readers: 'owner' },
  { name: 'training.metrics', durability: 'durable', readers: 'owner', max_records: 10000, max_age_seconds: 86400 },
  { name: 'training.logs', durability: 'durable', readers: 'owner', max_records: 10000, max_age_seconds: 86400 },
];
const existing = await request(api + '/streams', { token });
for (const stream of desired) {
  const present = existing.streams.find(item => item.name === stream.name);
  if (!present) await request(api + '/streams', { token, body: stream });
  else if (present.durability !== stream.durability || present.readers !== stream.readers)
    throw Error(`The existing ${stream.name} stream has a different policy; inspect it before reusing this dashboard.`);
}
if (!await load(configFile)) {
  // Recover only this setup's own orphan credential after an interrupted setup.
  const { producers } = await request(api + '/producers', { token });
  if (producers.some(p => p.name === saved.producer)) await request(`${api}/producers/${saved.producer}`, { token, method: 'DELETE' });
  const producer = await request(api + '/producers', { token, body: { name: saved.producer, streams: desired.map(s => s.name) } });
  await save(configFile, {
    api, token: producer.token, spool_dir: './spool', max_spool_bytes: 16 * 1024 * 1024,
    sources: [
      { id: 'local-machine', type: 'host', stream: 'machine.utilization', durability: 'ephemeral', interval_ms: 5000, gpu: true },
      { id: 'training-metrics', type: 'jsonl', stream: 'training.metrics', durability: 'durable',
        run: process.env.TRAINING_RUN || 'training', path: resolve(process.env.TRAINING_METRICS || './metrics.jsonl') },
      { id: 'training-logs', type: 'log', stream: 'training.logs', durability: 'durable',
        run: process.env.TRAINING_RUN || 'training', path: resolve(process.env.TRAINING_LOG || './training.log') },
    ],
  });
}
const files = {};
for (const name of ['index.html', 'app.js', 'model.mjs']) files[name] = await readFile(new URL('./' + name, import.meta.url), 'utf8');
await request(api + '/files', { token, body: { files, replace: true, message: 'Training dashboard with typed durable and ephemeral streams' } });
console.log(`Dashboard: ${saved.handle.page_url}`);
console.log(`Collector configuration: ${configFile}`);
console.log('Open the dashboard to claim it, then start:');
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
console.log(`node cli/bin/tendril-stream.mjs ${shellQuote(configFile)}`);
console.log('Edit the source paths/run name in collector.json. Keep both JSON credential files private.');
