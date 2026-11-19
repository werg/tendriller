// Operational commands use the application's public session composition. This module
// has no transport, signer, delivery queue, event checkpoint or data store.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pack } from './pack.mjs';

export async function withSession(modulePath, run, { signal, mode, profile, runId } = {}) {
  if (!modulePath) throw Error('Supply --session with a module exporting attachSession({ signal }) or openSession({ signal }). A page handle does not open a Chronolog session. Run tendril guide --server YOUR_SERVICE_ORIGIN and follow /docs/BUILD_AN_APP.md to configure authority, enroll the device and compose the session.');
  if (mode !== undefined && !['attach', 'own', 'independent'].includes(mode)) throw Error('Use --mode attach, own, or independent');
  if (profile !== undefined && (typeof profile !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(profile))) throw Error('Use --profile with a retained profile name');
  if (mode === 'independent' && !profile) throw Error('--mode independent requires --profile naming a separately provisioned device');
  if (runId !== undefined && (typeof runId !== 'string' || !runId.length || runId.length > 128 || /[\u0000-\u001f]/u.test(runId))) throw Error('Use --run with a bounded run identity');
  signal?.throwIfAborted();
  const bootstrap = await import(pathToFileURL(resolve(modulePath)).href);
  const selected = mode ?? (typeof bootstrap.attachSession === 'function' ? 'attach' : 'own');
  const hook = selected === 'attach' ? bootstrap.attachSession : bootstrap.openSession;
  if (typeof hook !== 'function') throw Error(selected === 'attach'
    ? 'The session module must export attachSession({ signal, profile, context }). Attachment never falls back to opening a signer.'
    : 'The session module must export openSession({ signal, mode, profile }) and acquire exclusive ownership of the selected retained profile.');
  const owned = await hook({ signal, mode: selected, profile, ...(runId === undefined ? {} : { context: { runId } }) });
  const dispose = selected === 'attach'
    ? typeof owned?.detach === 'function' ? () => owned.detach() : typeof owned?.session?.detach === 'function' ? () => owned.session.detach() : undefined
    : typeof owned?.close === 'function' ? () => owned.close() : typeof owned?.session?.close === 'function' ? () => owned.session.close() : undefined;
  if (!owned?.session || !dispose) throw Error(selected === 'attach'
    ? 'attachSession must return { session, detach? } with a local detach method; detaching must not stop the owner.'
    : 'openSession must return { session, control?, close? }; close releases its exclusive profile ownership.');
  let closing;
  const close = () => closing ??= Promise.resolve().then(dispose);
  const abort = () => { void close().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    return await run({ ...owned, mode: selected });
  } finally { signal?.removeEventListener('abort', abort); await close(); }
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
  if (!owned.control) throw Error('This action requires the session-owned control participant returned by openSession. Connect it with session.connectControlParticipant({ exchange }) and return { session, control }; see /docs/BUILD_AN_APP.md. Signed publication also requires an explicit publisher grant, independent of page access.');
  return owned.control;
};

/** Call one public command. Operation identities and exact retry semantics stay in Chronolog. */
export async function runSessionCommand(owned, command, args, options = {}, { signal } = {}) {
  const { session } = owned;
  signal?.throwIfAborted();
  if (command === 'describe') return session.describe();
  if (command === 'status') return session.status;
  if (command === 'self') return { mode: owned.mode ?? 'own', applicationId: session.applicationId,
    historyId: session.historyId ?? null, deviceId: session.deviceId, endpoint: session.endpoint ?? null };
  if (command === 'endpoints') {
    if (typeof session.endpoints !== 'function') throw Error('Endpoint diagnostics require an attached application owner.');
    return session.endpoints();
  }
  if (command === 'doctor') return { identity: await runSessionCommand(owned, 'self', []),
    definition: session.describe(), status: session.status,
    capabilities: session.endpoint?.capabilities ?? null,
    ...(typeof session.endpoints === 'function' ? { endpoints: await session.endpoints() } : {}) };
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
    const transitionId = required(options.transition, '--transition with a stable transition identity');
    if (owned.mode === 'attach') {
      if (args[0] === 'takeover') return session.recovery.takeover({ transitionId, signal });
      if (args[0] === 'handover') return session.recovery.handover({ transitionId, coordinator: required(args[1], 'the successor device identity'), signal });
      throw Error('Use recovery inspect, takeover, or handover <coordinator>');
    }
    const control = controlOf(owned);
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
