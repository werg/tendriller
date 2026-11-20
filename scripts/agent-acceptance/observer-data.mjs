import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { hash } from './evidence.mjs';

export class MeasurementError extends Error {
  constructor(metric, status = 'blocked') { super(metric); this.metric = metric; this.status = status; }
}
export function need(value, metric) { if (value === undefined || value === null || value === '') throw new MeasurementError(metric); return value; }
export function same(a, b, metric) { if (a !== b) throw new MeasurementError(metric, 'failed'); }
export function at(value, pointer = '') {
  if (!pointer) return value;
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) throw new MeasurementError('invalid-json-pointer', 'failed');
  return pointer.slice(1).split('/').reduce((v, key) => v?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], value);
}
export function inside(directory, path) {
  const rel = relative(directory, path); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../');
}
export function recordFile(base, ref) {
  need(ref?.file, 'record-file');
  const path = resolve(base, ref.file);
  let bytes;
  try {
    if (statSync(path).size > 8 * 1024 * 1024) throw new MeasurementError('record-size', 'failed');
    bytes = readFileSync(path);
  } catch (error) { if (error instanceof MeasurementError) throw error; throw new MeasurementError('record-unavailable'); }
  let value;
  try {
    value = ref.format === 'jsonl' ? bytes.toString().trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : JSON.parse(bytes);
    if (ref.format === 'jsonl') value = value[ref.line === undefined || ref.line === 'last' ? value.length - 1 : ref.line];
  } catch { throw new MeasurementError('record-json', 'failed'); }
  return { value: need(at(value, ref.pointer), 'record-value'), sha256: hash(bytes), path };
}
export function loadObserverConfig(path, request) {
  let config;
  try { config = recordFile('/', { file: path }).value; } catch (error) { throw error; }
  same(config.protocol, 'tendriller-starter-observer-v1', 'observer-config-version');
  same(config.origin, request.origin, 'observer-origin');
  const project = realpathSync(need(config.native?.project, 'native-project'));
  if (inside(project, realpathSync(path))) throw new MeasurementError('observer-config-inside-model-project', 'failed');
  // The project can be a selected nested directory within the fresh agent's workspace.
  if (!inside(realpathSync(request.project), project)) throw new MeasurementError('native-project-outside-this-run', 'failed');
  const applicationId = need(config.applicationId, 'application-id'), historyId = need(config.historyId, 'history-id');
  if (!/^[a-f0-9]{64}$/.test(applicationId)) throw new MeasurementError('application-id-format', 'failed');
  const deviceId = typeof config.native.deviceId === 'string' ? config.native.deviceId : recordFile(project, config.native.deviceId).value;
  if (!/^[a-f0-9]{64}$/.test(need(deviceId, 'native-device-id'))) throw new MeasurementError('native-device-id-format', 'failed');
  const descriptor = recordFile(project, need(config.native.descriptor, 'pinned-descriptor')).value;
  same(descriptor.payload?.applicationId, applicationId, 'descriptor-application');
  same(descriptor.payload?.historyId, historyId, 'descriptor-history');
  const handle = recordFile(project, need(config.native.handle, 'host-handle')).value;
  same(handle.application?.id, applicationId, 'handle-application');
  same(handle.api, request.origin + '/api/t/' + handle.id, 'handle-origin-and-page');
  if (!/^[a-z2-7]{12}$/.test(handle.id ?? '')) throw new MeasurementError('handle-page-id', 'failed');
  need(handle.token, 'host-credential');
  const page = new URL(handle.page_url);
  if (page.protocol !== 'https:' || page.username || page.password || page.search || page.hash ||
      !page.hostname.startsWith(handle.id + '.') && !page.hostname.startsWith(handle.id + '--p-') ||
      !/^\/s\/[a-z2-7]{26}\/$/.test(page.pathname)) throw new MeasurementError('handle-page-url', 'failed');
  const modulePath = realpathSync(resolve(project, config.native.module ?? 'session.mjs'));
  if (!inside(project, modulePath)) throw new MeasurementError('native-module-outside-project', 'failed');
  return { ...config, native: { ...config.native, project, modulePath, deviceId }, descriptor, handle };
}

/** Linux birth token prevents accepting an unrelated process after PID reuse. No signals are sent. */
export function processMeasurement(project, config) {
  if (process.platform !== 'linux') throw new MeasurementError('native-process-platform');
  const pid = Number(typeof config?.pid === 'number' ? config.pid : recordFile(project, need(config?.pid, 'native-pid-file')).value);
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new MeasurementError('native-pid-format', 'failed');
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'), fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const cwd = realpathSync(`/proc/${pid}/cwd`);
    same(cwd, project, 'native-process-cwd');
    const command = readFileSync(`/proc/${pid}/cmdline`).toString().split('\0').filter(Boolean);
    if (!Array.isArray(config.argv) || JSON.stringify(config.argv) !== JSON.stringify(command)) throw new MeasurementError('native-process-argv', 'failed');
    return { pid, birth: fields[19], startedAt: new Date(Date.now() - (Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]) - Number(fields[19]) / 100) * 1000).toISOString(),
      command, resume: need(config.resume, 'native-resume'), storage: need(config.storage, 'native-storage') };
  } catch (error) { if (error instanceof MeasurementError) throw error; throw new MeasurementError('native-process-unavailable'); }
}
