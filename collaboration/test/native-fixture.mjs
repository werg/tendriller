import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const packageRoot = process.env.CHRONOLOG_SESSION_PACKAGE;
export const peerModule = suffix => packageRoot ? pathToFileURL(join(resolve(packageRoot), suffix ? suffix + '.mjs' : 'index.mjs')).href :
  import.meta.resolve('@chronolog/peer-session' + (suffix ? '/' + suffix : ''));
export const p = await import(peerModule(''));
export const native = await import(peerModule('native'));
export const worker = await import(peerModule('worker'));
export const browser = await import(peerModule('browser'));
export const definition = p.defineApplication({ id: 'native-owner-check', version: '1', commands: {
  add: p.defineCommand({ description: 'Add one attributed observation', input: { type: 'string' }, prepare: text => p.program(p.emit('note', { text })) }),
}, queries: {
  notes: p.defineQuery({ description: 'Read accepted observations', input: { type: 'null' }, read: view => view.readEvents({ topics: ['note'] }).events.map(event => event.payload) }),
  types: p.defineQuery({ description: 'Preserve exact native wire types', input: { type: 'null' }, read: () => ({ integer: 9223372036854775807n, bytes: new Uint8Array([0, 127, 255]) }) }),
} });
export async function openRetainedOwner({ devicePath, authority, key }) {
  const device = await native.openNativeDevice({ path: devicePath });
  const session = await native.openNativeApplication({ device, definition, authority, epochKeys: new Map([[0, new Uint8Array(key)]]) });
  return worker.createApplicationOwner(session);
}
