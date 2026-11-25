import { createCliLifetime } from '../helpers/cli-lifetime.mjs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createNativeBootstrap } from '../helpers/native-session.mjs';
import { definition } from './domain.mjs';
import { createNativeEngine } from './engine.mjs';
import * as local from './local.mjs';
const bootstrap = createNativeBootstrap({ definition, local,
  async createMaterializer({ signal, rootPrincipal, profile }) {
    const { createSqlMaterializationRuntime } = await import('@chronolog/peer-session/sql');
    const engine = await createNativeEngine(); signal.throwIfAborted();
    return createSqlMaterializationRuntime({ engine, rootPrincipal,
      path: profile === 'main' ? local.databasePath : fileURLToPath(new URL(`profiles/${profile}/materialized.sqlite`, local.privateDirectory)) });
  },
});
export const openSession = bootstrap.openSession;
export const attachSession = bootstrap.attachSession;
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cli = createCliLifetime();
  try { const result = await bootstrap.main(process.argv.slice(2), { lifetime: cli }); if (result) console.log(JSON.stringify(result, null, 2)); }
  catch (error) { cli.fail(error); }
  // Only the standalone entry owns process disposal; imported hooks never exit.
  process.exit(await cli.finish());
}
