// Operational commands use the application's public owned session. This module
// has no transport, signer, delivery queue, event checkpoint or data store.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pack } from './pack.mjs';

export async function withSession(modulePath, run, { signal } = {}) {
  if (!modulePath) throw Error('Supply --session with a module exporting openSession({ signal })');
  signal?.throwIfAborted();
  const bootstrap = await import(pathToFileURL(resolve(modulePath)).href);
  if (typeof bootstrap.openSession !== 'function') throw Error('The session module must export openSession({ signal })');
  const owned = await bootstrap.openSession({ signal });
  if (!owned?.session || typeof owned.session.close !== 'function') throw Error('openSession must return { session, control? }');
  const abort = () => { void Promise.resolve(owned.session.close()).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    return await run(owned);
  } finally { signal?.removeEventListener('abort', abort); await owned.session.close(); }
}

const required = (value, description) => {
  if (typeof value !== 'string' || !value.length) throw Error(`Supply ${description}`);
  return value;
};
export function jsonInput(value, description = 'JSON input') {
  if (value === undefined) throw Error(`Supply ${description}`);
  try { return JSON.parse(value); } catch { throw Error(`Invalid ${description}`); }
}
const identity = options => ({ operationId: required(options.operation, '--operation with a stable operation identity'),
  ...(options['based-on'] === undefined ? {} : { basedOn: jsonInput(options['based-on'], 'captured revision JSON') }) });
const controlOf = owned => {
  if (!owned.control) throw Error('This action requires the session-owned control participant returned by openSession');
  return owned.control;
};

/** Call one public command. Operation identities and exact retry semantics stay in Chronolog. */
export async function runSessionCommand(owned, command, args, options = {}, { signal } = {}) {
  const { session } = owned;
  signal?.throwIfAborted();
  if (command === 'describe') return session.describe();
  if (command === 'status') return session.status;
  if (command === 'query') return session.query(required(args[0], 'a query name'), jsonInput(args[1] ?? '{}'));
  if (command === 'operation') return session.operations.inspect(required(args[0], 'an operation identity'));
  if (command === 'command' || command === 'reapply') {
    const metadata = identity(options);
    const operation = command === 'command'
      ? await session.command(required(args[0], 'a command name'), jsonInput(args[1]), metadata)
      : await session.reapply(required(args[0], 'the abandoned operation identity'), required(args[1], 'a command name'), jsonInput(args[2]), metadata);
    if (options.saved) return operation.get();
    try {
      const applied = await operation.applied({ signal });
      return options.shared ? { applied, retained: await operation.shared({ signal }) } : applied;
    } catch (error) {
      // A cancelled waiter does not cancel or replace its saved signed attempt.
      error.operation = await session.operations.get(metadata.operationId).catch(() => null);
      throw error;
    }
  }
  if (command === 'retry') {
    const operationId = required(args[0], 'the original operation identity');
    await session.retry(operationId);
    return options.saved ? session.operations.get(operationId) : session.operations.wait(operationId, { signal });
  }
  if (command === 'events') {
    const view = await session.readView();
    try { return await view.readEvents({ ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      ...(options.topics === undefined ? {} : { topics: jsonInput(options.topics, 'topic array JSON') }),
      ...(options.limit === undefined ? {} : { limit: Number(options.limit) }) }); }
    finally { await view.release(); }
  }
  if (command === 'recovery') {
    if (args[0] === 'inspect') return session.recovery.inspect();
    const control = controlOf(owned), transitionId = required(options.transition, '--transition with a stable transition identity');
    if (args[0] === 'takeover') return session.recovery.takeover(control, { transitionId });
    if (args[0] === 'handover') return session.recovery.handover(control, { transitionId, coordinator: required(args[1], 'the successor device identity') });
    throw Error('Use recovery inspect, takeover, or handover <coordinator>');
  }
  if (command === 'definition') return controlOf(owned).definition();
  if (command === 'publication') return controlOf(owned).publication();
  if (command === 'publish') {
    const control = controlOf(owned), source = pack(required(args[0], 'the complete authored directory'), { entry: options.entry });
    const publication = await control.preparePublication({ operationId: required(options.operation, '--operation with a stable publication identity'),
      entry: source.entry, files: source.files.map(file => ({ path: file.path, type: file.type, size: file.size, hash: file.sha256 })) });
    const assets = [...new Map(source.files.map(file => [file.sha256, { hash: file.sha256, bytes: file.bytes.toString('base64') }])).values()];
    return control.publish(publication, assets);
  }
  if (command === 'signal') {
    await session.signals.send(required(args[0], 'a live topic'), jsonInput(args[1]),
      options.ttl === undefined ? {} : { ttlMs: Number(options.ttl) });
    return { sent: true, durable: false };
  }
  throw Error(`Unknown application command: ${command}`);
}

/** Pulling the next change is backpressure. The caller owns its processed cursor. */
export async function watchSession(owned, emit, { signal } = {}) {
  for await (const change of owned.session.changes({ signal })) await emit(change);
}
