import { parseArgs } from 'node:util';
import { privateJSON, save, report } from './state.mjs';
// Build evidence from the closed vocabulary. Never copy config, native records, browser profile or raw GraphQL responses.
const { values } = parseArgs({ options: { checkpoint: { type: 'string' }, output: { type: 'string' } } });
if (!values.checkpoint || !values.output) throw Error('Use --checkpoint PRIVATE_CHECKPOINT --output REPORT_JSON');
const s = privateJSON(values.checkpoint);
// Reports originate only from trusted local runner checkpoints, not arbitrary imported JSON.
save(values.output, report(s));
