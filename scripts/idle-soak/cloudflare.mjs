import { execFileSync } from 'node:child_process';
import { digest } from './state.mjs';

const endpoint = 'https://api.cloudflare.com/client/v4/graphql';
const reference = 'kind name ofType { kind name ofType { kind name ofType { kind name } } }';
const typeName = t => t ? t.name || typeName(t.ofType) : undefined;
export function wranglerHeaders(path) {
  let c;
  try { c = JSON.parse(execFileSync(process.execPath, [path, 'auth', 'token', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, maxBuffer: 1024 * 1024 })); }
  catch { throw Error('WRANGLER_AUTH_UNAVAILABLE'); }
  if (c.token) return { Authorization: 'Bearer ' + c.token };
  if (c.key && c.email) return { 'X-Auth-Key': c.key, 'X-Auth-Email': c.email };
  throw Error('WRANGLER_AUTH_UNAVAILABLE');
}
export async function graphql(headers, query, fetcher = fetch) {
  let response;
  try { response = await fetcher(endpoint, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }), signal: AbortSignal.timeout(30000) }); }
  catch { return { status: 'unavailable', reason: 'NETWORK_OR_TIMEOUT' }; }
  let body; try { body = await response.json(); } catch { return { status: 'unavailable', reason: 'INVALID_JSON', httpStatus: response.status }; }
  if (!response.ok || body.errors?.length || !body.data) return { status: 'unavailable', reason: 'HTTP_OR_GRAPHQL_DENIED', httpStatus: response.status,
    // Error messages can echo queries / private account scope. Retain only numeric error codes.
    codes: (body.errors ?? []).map(x => x.extensions?.code ?? x.code).filter(x => typeof x === 'number') };
  return { status: 'available', data: body.data };
}
export async function discover(headers, fetcher) {
  const r = await graphql(headers, `{ __schema { types { name description fields { name description type { ${reference} } args { name type { ${reference} } } } inputFields { name type { ${reference} } } } } }`, fetcher);
  if (r.status !== 'available') return r;
  return { status: 'available', types: r.data.__schema.types, schemaHash: digest(JSON.stringify(r.data.__schema)) };
}
const specs = [
  { dataset: 'workersInvocationsAdaptive', scope: 'worker', groups: { sum: ['requests', 'errors', 'cpuTimeUs', 'duration', 'wallTime'] } },
  { dataset: 'durableObjectsInvocationsAdaptiveGroups', scope: 'namespace', groups: { sum: ['requests', 'errors', 'wallTime'] } },
  { dataset: 'durableObjectsPeriodicGroups', scope: 'namespace', groups: { sum: ['activeTime', 'cpuTime', 'duration', 'inboundWebsocketMsgCount', 'outboundWebsocketMsgCount', 'rowsRead', 'rowsWritten', 'storageReadUnits', 'storageWriteUnits', 'storageDeletes'] } },
  { dataset: 'durableObjectsStorageGroups', scope: 'namespace', groups: { max: ['storedBytes'] } },
];
export function planQueries(types, c, start, end) {
  const type = name => types.find(x => x.name === name);
  const result = [];
  for (const spec of specs) {
    const field = types.flatMap(t => t.fields ?? []).find(f => f.name === spec.dataset && f.args?.some(a => a.name === 'filter'));
    const filterType = type(typeName(field?.args.find(a => a.name === 'filter')?.type));
    const filters = new Set(filterType?.inputFields?.map(x => x.name));
    const scopeField = spec.scope === 'worker' ? 'scriptName' : filters.has('namespaceId') ? 'namespaceId' : 'namespaceIds_has';
    const groupType = type(typeName(field?.type));
    const selected = [], fields = [];
    for (const [group, wanted] of Object.entries(spec.groups)) {
      const available = type(typeName(groupType?.fields?.find(f => f.name === group)?.type))?.fields ?? [];
      const found = wanted.filter(k => available.some(x => x.name === k));
      if (found.length) selected.push(`${group} { ${found.join(' ')} }`);
      for (const name of found) fields.push({ group, name, description: available.find(x => x.name === name).description });
    }
    for (const [index, scope] of (spec.scope === 'worker' ? [c.worker] : c.namespaces).entries()) {
      const missingFields = Object.entries(spec.groups).flatMap(([group, names]) => names.filter(name => !fields.some(f => f.group === group && f.name === name)).map(name => `${group}.${name}`));
      const common = { missingFields, dataset: spec.dataset, scope: spec.scope === 'worker' ? 'worker' : `namespace-${index + 1}`, fields, start, end };
      if (!filters.has(scopeField) || !filters.has('datetime_geq') || !filters.has('datetime_lt') || !selected.length) {
        result.push({ ...common, status: 'unavailable', reason: 'SCHEMA_UNSUPPORTED' }); continue;
      }
      const filter = `datetime_geq:${JSON.stringify(new Date(start).toISOString())},datetime_lt:${JSON.stringify(new Date(end).toISOString())},${scopeField}:${JSON.stringify(scope)}`;
      result.push({ ...common, query: `{ viewer { accounts(filter:{accountTag:${JSON.stringify(c.account)}}) { ${spec.dataset}(limit:1,filter:{${filter}}) { ${selected.join(' ')} } } } }` });
    }
  }
  return result;
}
export async function measure(c, start, end, { headers, schema, fetcher } = {}) {
  try { headers ??= wranglerHeaders(c.wrangler); } catch { return [{ start, end, status: 'unavailable', reason: 'WRANGLER_AUTH_UNAVAILABLE' }]; }
  schema ??= await discover(headers, fetcher);
  if (schema.status !== 'available') return [{ start, end, ...schema }];
  const output = [];
  // 1h windows satisfy narrow plan limits and avoid a 48h dataset query limit. No target Worker requests.
  for (let from = start; from < end; from = Math.min(from + 3600000, end)) {
    const until = Math.min(from + 3600000, end);
    for (const { query, ...p } of planQueries(schema.types, c, from, until)) {
      if (!query) { output.push(p); continue; }
      const r = await graphql(headers, query, fetcher);
      if (r.status !== 'available') { output.push({ ...p, ...r }); continue; }
      const accounts = r.data.viewer?.accounts;
      const rows = accounts?.length === 1 ? accounts[0][p.dataset] : null;
      if (!rows?.length) { output.push({ ...p, status: 'unavailable', reason: 'NO_DATA_OR_INGESTION_DELAY' }); continue; }
      const values = {};
      for (const f of p.fields) {
        const value = rows[0]?.[f.group]?.[f.name];
        values[`${f.group}.${f.name}`] = typeof value === 'number' && Number.isFinite(value) ? value : null;
      }
      output.push({ ...p, schemaHash: schema.schemaHash, status: p.missingFields.length > 0 || Object.values(values).some(x => x === null) ? 'unavailable' : 'available',
        overruns: Object.entries(values).filter(([key,value]) => ['sum.requests','sum.duration','sum.rowsRead','sum.rowsWritten','sum.inboundWebsocketMsgCount','sum.outboundWebsocketMsgCount'].includes(key) && value > 0).map(([counter,actual]) => ({counter,actual,budget:0})),
        values, sampled: /Adaptive/.test(p.dataset), collectedAt: Date.now() });
    }
  }
  return output;
}
