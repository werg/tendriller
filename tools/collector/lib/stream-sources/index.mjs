import { createHostSource } from './host.mjs';
import { createFileSource } from './file.mjs';
import { createLatestSource } from './latest.mjs';
import { createSshSource } from './ssh.mjs';
import { createCommandSource } from './command.mjs';

/**
 * Source adapter contract (independent of the destination stream's durability):
 *
 * source: the validated source configuration.
 * capabilities: {mode: 'poll'|'stream', replay: 'retained-file'|'none', checkpoint: boolean}.
 * read({checkpoint,maxRecords,signal}): Promise<{records,checkpoint?,health}> for polls.
 * stream({signal,report}): AsyncIterable<{records,health}> for one live session.
 * failure(error): source-specific health notice, including upstream backpressure.
 * close(): idempotently releases active resources; it does not discard or commit records.
 *
 * Only a checkpointed adapter may propose a new checkpoint. It never persists it:
 * the coordinator atomically commits records + checkpoint in the spool. Retained
 * files can be reread in smaller batches; a host observation or SSH session cannot.
 * Adapters do not own credentials, uploads, retry timers, or destination storage.
 */
export function createSourceAdapter(source) {
  switch (source.type) {
    case 'host': return createHostSource(source);
    case 'jsonl':
    case 'log': return createFileSource(source);
    case 'latest': return createLatestSource(source);
    case 'ssh': return createSshSource(source);
    case 'command': return createCommandSource(source);
    default: throw Error('Unknown collector source type.');
  }
}
