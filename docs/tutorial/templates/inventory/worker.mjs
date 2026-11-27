import sqliteCasWasmUrl from '@chronolog/peer-session/sqlite-cas.wasm';
import { servePageWorker } from '../../shared/helpers/page-worker.mjs';
import { definition, imports, topics } from './domain.mjs';

servePageWorker({ definition, imports, topics, sqliteWasmUrl });
