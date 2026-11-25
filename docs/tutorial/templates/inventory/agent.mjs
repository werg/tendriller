// This page's part of the agent program; `tendril agent run` serves the returned owner.
// One supervisor fence (the agent program's) protects both the signer and SQL materialization.
import { openSqlApplication } from '@chronolog/peer-session/sql';
import { openNativePage } from '../../shared/native-page.mjs';
import { definition } from './domain.mjs';
import { createNativeEngine } from './engine.mjs';
import { databasePathOf } from './setup.mjs';

export { definition };
export const openPage = context => openNativePage(context, {
  openApplication: async ({ device, authority }) => {
    const prepared = await context.readPrivate('schema.json');
    return openSqlApplication({ device, definition, authority, schema: prepared.schema, databasePath: databasePathOf(context),
      async createEngine({ signal }) { signal.throwIfAborted(); return createNativeEngine(); } });
  },
});
