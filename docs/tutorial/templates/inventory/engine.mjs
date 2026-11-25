import { pathToFileURL } from 'node:url';
import { bytesToHex, executionManifestArtifacts } from '@chronolog/peer-session';

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
