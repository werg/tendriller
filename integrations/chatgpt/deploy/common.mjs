import { readFile, lstat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, resolve, relative, sep } from 'node:path';

export const CHRONOLOG_SOURCE = 'e8bb116a72b5a3d2119729e263f1a1a62dabfa73';
export const fail = code => { throw Object.assign(Error(code), { code }); };
export const json = async path => JSON.parse(await readFile(path, 'utf8'));
export function absolutePath(value, code = 'DEPLOYMENT_PATH_INVALID') {
  if (typeof value !== 'string' || !isAbsolute(value) || !/^\/[A-Za-z0-9_./-]+$/u.test(value) ||
      value.split('/').includes('..') || resolve(value) !== value || value === '/') fail(code);
  return value;
}
export function within(parent, child) {
  const path = relative(parent, child);
  return path === '' || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
export function httpsUrl(value, { origin = false, resource = false, redirect = false } = {}) {
  let url; try { url = new URL(value); } catch { fail('DEPLOYMENT_HTTPS_URL_REQUIRED'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
      !redirect && url.search || origin && url.pathname !== '/' || resource && url.pathname !== '/mcp' ||
      /[\s*]/u.test(value)) fail('DEPLOYMENT_HTTPS_URL_REQUIRED');
  return origin ? url.origin : url.href;
}
export async function privateFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o027) !== 0) fail('DEPLOYMENT_PRIVATE_FILE_PERMISSIONS');
  return info;
}
export async function writablePrivateDirectory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) fail('DEPLOYMENT_PRIVATE_DIRECTORY_PERMISSIONS');
  await access(path, constants.R_OK | constants.W_OK | constants.X_OK);
}
export async function loadEnvironment(path) {
  await privateFile(path);
  for (const line of (await readFile(path, 'utf8')).split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const match = /^(TENDRILLER_[A-Z0-9_]+)=(".*")$/u.exec(line);
    if (!match) fail('DEPLOYMENT_ENVIRONMENT_INVALID');
    const value = JSON.parse(match[2]);
    if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/u.test(value)) fail('DEPLOYMENT_ENVIRONMENT_INVALID');
    process.env[match[1]] = value;
  }
}
