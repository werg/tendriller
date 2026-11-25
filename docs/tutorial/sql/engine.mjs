import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { bytesToHex, executionManifestArtifacts } from '@chronolog/peer-session';

const browserFiles = ['manifest.json', 'sqlite3.mjs', 'sqlite3.wasm', 'sqlite3-opfs-async-proxy.js'];
/** Package-public assets only; no supplemental download, native SQL addon or private source lookup. */
export async function prepareBrowserEngine({ directory = new URL('./engine/', import.meta.url) } = {}) {
  const packageEntry = new URL(import.meta.resolve('@chronolog/peer-session'));
  const proof = JSON.parse(await readFile(new URL('./provenance.json', packageEntry), 'utf8'));
  if (proof.profile !== 'chronolog-crdt-v1' || !proof.sqlEngines?.includes('browser') || !proof.wasmEngine) throw Error('SQL_BROWSER_PROFILE_REQUIRED: install the exact SQL kit selected by first-app-profile.json');
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const files = new Map(await Promise.all(browserFiles.map(async name => {
    const bytes = await readFile(new URL(`./wasm/${name}`, packageEntry));
    if (hash(bytes) !== proof.sha256?.[`wasm/${name}`]) throw Error('SQL_BROWSER_ASSET_PROVENANCE_MISMATCH');
    return [name, bytes];
  })));
  const manifest = JSON.parse(files.get('manifest.json').toString('utf8'));
  const { verifyWasmBuild } = await import('@chronolog/peer-session/sql-browser');
  verifyWasmBuild(new Uint8Array(files.get('sqlite3.wasm')), manifest);
  if (hash(files.get('sqlite3.mjs')) !== manifest.loaderSha256 || proof.wasmEngine.loaderSha256 !== manifest.loaderSha256 || proof.wasmEngine.wasmSha256 !== manifest.wasmSha256 || proof.wasmEngine.wasmBytes !== manifest.wasmBytes) throw Error('SQL_BROWSER_MANIFEST_MISMATCH');
  const absent = [];
  for (const [name, bytes] of files) {
    let existing;
    try { existing = await readFile(new URL(name, directory)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing && !existing.equals(bytes)) throw Error(`SQL_BROWSER_GRAPH_CONFLICT: retained engine/${name} differs from the selected exact public package; restore its verified artifact rather than silently replacing it`);
    if (!existing) absent.push([name, bytes]);
  }
  await mkdir(directory, { recursive: true });
  for (const [name, bytes] of absent) {
    try { await writeFile(new URL(name, directory), bytes, { flag: 'wx', flush: true }); }
    catch (error) { if (error.code !== 'EEXIST' || !(await readFile(new URL(name, directory))).equals(bytes)) throw error; }
  }
  return manifest;
}

export async function createNativeEngine() {
  try {
    const { createNativeSqlEngine } = await import('@chronolog/peer-session/sql-native');
    return createNativeSqlEngine();
  } catch (cause) {
    throw new Error(`SQL_ENGINE_UNAVAILABLE: install an exact --sql-native Chronolog archive built for this OS, architecture and native ABI, or build it locally with scripts enabled. The events archive and stock DoltLite binary cannot run this app. Original error: ${cause.message}`, { cause });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const engine = await createNativeEngine();
    const artifacts = await executionManifestArtifacts(engine.executionManifest);
    console.log(JSON.stringify({ available: true, platform: process.platform, arch: process.arch,
      node: process.version, executionManifestDigest: bytesToHex(artifacts.executionManifestDigest) }, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
