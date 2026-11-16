import { readResource, hasResource, resourceFiles } from "./resources.mjs";
// Resolve the complete immutable asset graph at publication time.
import { readFileSync, existsSync, lstatSync, mkdirSync, copyFileSync, cpSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
// Check every managed path component with lstat (rather than following symlinks).
// A manifest or stale lock must not cause a push to read/write files outside the page.
function checkedAssetPath(directory, path) {
  if (typeof path !== 'string' || !/^assets\/(?:components|workflows)\/[a-zA-Z0-9_.\/-]+$/.test(path)
    || path.split('/').some(segment => segment === '.' || segment === '..'))
    throw Error('Invalid managed asset path in lock: ' + path);
  const root = resolve(directory), parts = path.split('/');
  let location = root;
  for (let index = 0; index < parts.length; index++) {
    location = join(location, parts[index]);
    try {
      const entry = lstatSync(location);
      if (entry.isSymbolicLink()) throw Error('Managed asset path traverses a symlink: ' + path);
      if (index < parts.length - 1 && !entry.isDirectory())
        throw Error('Managed asset parent is not a directory: ' + path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return location;
}
function rejectSymlink(path) {
  try { if (lstatSync(path).isSymbolicLink()) throw Error('Asset lock must not be a symlink: ' + path); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
export function catalog() {
  const source = JSON.parse(readResource('recipes/catalog.json'));
  return { ...source, release: JSON.parse(readResource('package.json')).version,
    recipes: source.recipes.map(item => {
      const declaration = JSON.parse(readResource(item.path + '/tendril.json'));
      return { ...item, maintainer: 'werg', requires: declaration.requires, components: declaration.components || [], workflows: declaration.workflows || [] };
    }) };
}
export function componentAssets(names, { workflows = false } = {}) {
  const catalog = JSON.parse(readResource('components/catalog.json'));
  const chosen = new Map(), visiting = new Set();
  const visit = name => {
    if (chosen.has(name)) return;
    const component = catalog.components.find(item => item.id === name);
    if (!component || component.status !== 'supported') throw Error(`Component '${name}' is not in the supported catalog. Declare custom experimental assets explicitly.`);
    if (visiting.has(name)) throw Error(`Component dependency cycle at '${name}'.`);
    visiting.add(name);
    for (const dependency of component.dependencies) visit(dependency);
    visiting.delete(name); chosen.set(name, component);
  };
  names.forEach(visit);
  const files = new Map();
  for (const component of chosen.values()) for (const path of component.files) files.set('assets/components/' + path, 'components/' + path);
  if (workflows) for (const name of ['browser.js', 'session-archive.js']) {
    const source = 'workflows/' + name;
    if (!hasResource(source)) throw Error(`The selected workflow browser artifact is missing: ${name}`);
    files.set('assets/workflows/' + name, source);
  }
  return [...files].map(([path, source]) => ({ path, bytes: readResource(source), sha256: sha256(readResource(source)) }));
}
export function assetLock(declaration, assets = componentAssets(declaration.components || [], { workflows: !!declaration.workflows?.length })) {
  const core = JSON.parse(readResource('core.lock.json'));
  return { format: 'tendriller-page-assets', version: 1, contrib: JSON.parse(readResource('package.json')).version,
    requires: declaration.requires || { contract: 2, workflows: {} }, core: core.artifacts,
    files: assets.map(({ path, sha256 }) => ({ path, sha256 })) };
}
export function vendorAssets(directory, declaration) {
  const assets = componentAssets(declaration.components || [], { workflows: !!declaration.workflows?.length });
  for (const asset of assets) {
    const destination = join(directory, asset.path);
    mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, asset.bytes);
  }
  const lock = assetLock(declaration, assets);
  writeFileSync(join(directory, 'tendril.assets.json'), JSON.stringify(lock, null, 2) + '\n');
  return lock;
}
/** Complete the declared closure before publication without discarding hand edits.
 * Existing locked bytes can be upgraded; divergent/unmanaged bytes require --force. */
export function syncAssets(directory, { force = false } = {}) {
  const manifest = join(directory, 'tendril.json');
  if (!existsSync(manifest)) throw Error('Missing tendril.json in '+directory);
  const declaration = json(manifest);
  if (!Array.isArray(declaration.components || []) || (declaration.components || []).some(name => typeof name !== 'string'))
    throw Error('tendril.json components must be an array of IDs.');
  const assets = componentAssets(declaration.components || [], { workflows: !!declaration.workflows?.length });
  const lockPath = join(directory, 'tendril.assets.json');
  rejectSymlink(lockPath);
  const old = existsSync(lockPath) ? json(lockPath) : null;
  if (old && (old.format !== 'tendriller-page-assets' || old.version !== 1 || !Array.isArray(old.files)))
    throw Error('Invalid page asset lock.');
  const prior = new Map((old?.files || []).map(item => [item.path, item.sha256]));
  const desired = new Set(assets.map(asset => asset.path));
  const localPath = path => checkedAssetPath(directory, path);
  // Check every path before modifying any file.
  for (const asset of assets) {
    const path = localPath(asset.path);
    if (existsSync(path)) {
      const hash = sha256(readFileSync(path));
      if (hash !== asset.sha256 && hash !== prior.get(asset.path) && !force)
        throw Error(`Modified or unmanaged component '${asset.path}'; review or run tendril assets sync <dir> --force.`);
    }
  }
  for (const [name, hash] of prior) if (!desired.has(name)) {
    const path = localPath(name);
    if (existsSync(path) && sha256(readFileSync(path)) !== hash && !force)
      throw Error(`Modified obsolete component '${name}'; review or run tendril assets sync <dir> --force.`);
  }
  let written = 0, removed = 0;
  for (const [name] of prior) if (!desired.has(name)) {
    const path = localPath(name);
    if (existsSync(path)) { rmSync(path); removed++; }
  }
  for (const asset of assets) {
    const path = localPath(asset.path);
    if (!existsSync(path) || sha256(readFileSync(path)) !== asset.sha256) {
      mkdirSync(dirname(path), {recursive:true}); writeFileSync(path, asset.bytes); written++;
    }
  }
  const lock = assetLock(declaration, assets);
  writeFileSync(lockPath, JSON.stringify(lock,null,2)+'\n');
  return {...lock, written, removed};
}
export function verifyAssets(directory) {
  const lockPath = join(directory, 'tendril.assets.json');
  const manifest = join(directory, 'tendril.json');
  rejectSymlink(lockPath);
  if (!existsSync(lockPath)) {
    if (existsSync(manifest)) throw Error('Missing tendril.assets.json; run tendril assets sync <dir>.');
    return null;
  }
  const lock = json(lockPath);
  if (lock.format !== 'tendriller-page-assets' || lock.version !== 1 || !Array.isArray(lock.files)) throw Error('Invalid page asset lock.');
  if (existsSync(manifest)) {
    const expected = assetLock(json(manifest));
    if (JSON.stringify(lock.files) !== JSON.stringify(expected.files) || JSON.stringify(lock.requires) !== JSON.stringify(expected.requires)
      || JSON.stringify(lock.core) !== JSON.stringify(expected.core) || lock.contrib !== expected.contrib)
      throw Error('Page asset lock does not match the declaration; run tendril assets sync <dir>.');
  }
  for (const { path, sha256: expected } of lock.files) {
    const local = checkedAssetPath(directory, path);
    if (!existsSync(local) || sha256(readFileSync(local)) !== expected) throw Error(`Pinned page asset '${path}' is missing or has changed. Resolve and lock the asset set before publication.`);
  }
  return lock;
}
export function scaffold(name, directory) {
  const item = catalog().recipes.find(item => item.id === name);
  if (!item) throw Error(`Unknown recipe: ${name}`);
  if (existsSync(directory)) throw Error(`Target already exists: ${directory}`);
  for (const path of resourceFiles(item.path)) { const target = join(directory,path.slice(item.path.length+1)); mkdirSync(dirname(target),{recursive:true}); writeFileSync(target,readResource(path)); }
  const declaration = JSON.parse(readResource(item.path + '/tendril.json'));
  const lock = vendorAssets(directory, declaration);
  return { recipe: name, path: resolve(directory), assets: lock.files.length, requires: lock.requires, workflows: declaration.workflows || [] };
}
