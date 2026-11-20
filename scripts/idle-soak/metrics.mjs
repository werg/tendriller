// Read-only provider collection can be rerun after analytics ingestion catches up, without restarting a soak.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { privateJSON, validateConfig, save, digest, report } from './state.mjs';
import { measure } from './cloudflare.mjs';
export async function collect(configPath, directory, probe = false) {
  const c = validateConfig(privateJSON(configPath));
  if (probe) {
    const end = Date.now() - (c.metricsLagMs ?? 900000);
    const values = await measure(c, end - 3600000, end);
    save(resolve(directory, 'metric-probe.json'), values);
    console.log(JSON.stringify(values.map(({ dataset, scope, status, reason, httpStatus, codes, missingFields }) => ({ dataset, scope, status, reason, httpStatus, codes, missingFields }))));
    return;
  }
  // Run only after stopping the service: checkpoint is a single-writer document.
  const s = privateJSON(resolve(directory, 'checkpoint.json'));
  if (s.configHash !== digest(JSON.stringify(c))) throw Error('CONFIG_MISMATCH');
  if (!['complete','interrupted'].includes(s.status)) throw Error('STOP_RUNNER_BEFORE_RECOLLECTION');
  s.metrics = [];
  for (const segment of s.segments.filter(x => x.endedAt && !x.incomplete)) {
    s.metrics.push(...(await measure(c, segment.startedAt, segment.endedAt)).map(m => ({ phase: segment.phase, ...m })));
  }
  save(resolve(directory, 'checkpoint.json'), s); save(resolve(directory, 'report.json'), report(s));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { config: { type: 'string' }, state: { type: 'string' }, probe: { type: 'boolean' } } });
  if (!values.config || !values.state) throw Error('Use --config PRIVATE_JSON --state PRIVATE_DIRECTORY [--probe]');
  collect(values.config, values.state, values.probe).catch(() => { console.error('Provider collection incomplete; private input/auth or API permission needs attention.'); process.exitCode = 1; });
}
