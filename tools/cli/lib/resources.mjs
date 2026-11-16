// Installed release resources. Standalone builds embed the same bytes through
// this one boundary; tools never reach into another repository checkout.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const safe = path => { if (typeof path !== 'string' || path.startsWith('/') || path.split('/').some(part => !part || part === '..' || part === '.')) throw Error('Invalid release resource path'); return join(root,path); };
export const readResource = path => readFileSync(safe(path));
export const hasResource = path => existsSync(safe(path));
export function resourceFiles(prefix) {
  const walk = path => readdirSync(safe(path),{withFileTypes:true}).filter(entry=>!entry.name.startsWith('.')&&entry.name!=='test').flatMap(entry=>entry.isDirectory()?walk(path+'/'+entry.name):[path+'/'+entry.name]);
  return walk(prefix).sort();
}
