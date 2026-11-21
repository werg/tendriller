// Stateless request-driven ServerlessHostAdapter (W10) for Cloudflare Workers,
// Durable Objects, Deno Deploy, or transactional KV runtimes without local POSIX sockets.
// Keeps zero @chronolog/* static dependency so @tendriller/core stays lightweight.

function fail(code, message, status = 500) {
  return Object.assign(new Error(message), { code, status });
}

/**
 * Wrap any transactional key-value backend (`get`, `put`, `list`, optional `compareAndSwap`)
 * as a Chronolog-compatible BytesStore with snapshot enumeration.
 */
export function createTransactionalBytesStore(backend) {
  if (!backend || typeof backend.get !== 'function' || typeof backend.put !== 'function') {
    throw fail('SERVERLESS_STORAGE_INVALID', 'Supply a storage backend implementing get(key) and put(key, bytes).', 500);
  }
  return Object.freeze({
    async get(key) {
      const value = await backend.get(key);
      return value == null ? null : Uint8Array.from(value);
    },
    async put(key, bytes) {
      await backend.put(key, Uint8Array.from(bytes));
    },
    async entries() {
      if (typeof backend.list !== 'function') {
        throw fail('CHECKPOINT_ENUMERATION_UNSUPPORTED', 'Storage backend must implement list() for checkpoint export.');
      }
      const keys = [...await backend.list()].sort();
      const out = [];
      for (const key of keys) {
        const value = await backend.get(key);
        if (value != null) out.push({ key, value: Uint8Array.from(value) });
      }
      return out;
    },
  });
}

/**
 * Request-driven ServerlessHostAdapter: serializes per-app execution through a supplied
 * transactional lock (`withLock`), opens/hydrates the Chronolog session via `openSession`,
 * executes HTTP command/batch/inspect/query requests, flushes state, and closes cleanly per request.
 */
export function createServerlessHostAdapter({
  applicationId,
  storage,
  withLock,
  openSession,
  authorize,
}) {
  if (typeof applicationId !== 'string' || !/^[a-f0-9]{64}$/u.test(applicationId)) {
    throw fail('SERVERLESS_APP_ID_INVALID', 'Supply the 64-character lowercase hex applicationId.');
  }
  if (typeof openSession !== 'function') {
    throw fail('SERVERLESS_OPEN_SESSION_REQUIRED', 'Supply openSession({ store, signal }) returning { session, flush?, close? }.');
  }
  const store = createTransactionalBytesStore(storage);
  let activeTail = Promise.resolve();
  const serialize = work => {
    if (typeof withLock === 'function') return withLock(applicationId, work);
    const next = activeTail.then(work, work);
    activeTail = next.then(() => undefined, () => undefined);
    return next;
  };

  async function withActiveSession(signal, run) {
    return serialize(async () => {
      signal?.throwIfAborted();
      const owned = await openSession({ store, signal });
      if (!owned?.session) throw fail('SERVERLESS_SESSION_INVALID', 'openSession must return { session }.');
      try {
        signal?.throwIfAborted();
        return await run(owned);
      } finally {
        // A rejected wait can follow a durable saved command. Flush that original
        // intent on every exit, so a lost/aborted response remains inspectable.
        try { if (typeof owned.flush === 'function') await owned.flush(); }
        finally {
          if (typeof owned.close === 'function') await owned.close();
          else if (typeof owned.session.close === 'function') await owned.session.close();
        }
      }
    });
  }

  async function handleRequest(request) {
    const url = new URL(request.url);
    const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
    try {
      if (typeof authorize === 'function') {
        const allowed = await authorize(request);
        if (!allowed) throw fail('unauthorized', 'Unauthorized serverless host request.', 401);
      }
      const commandInput = item => {
        if (!item || typeof item.command !== 'string' || !item.command.length || typeof item.operationId !== 'string' || !item.operationId.length || item.operationId.length > 256)
          throw fail('invalid_command', 'Supply a command and the original explicit operationId.', 400);
        return item;
      };
      const prefix = `/v1/apps/${applicationId}`;
      if (!url.pathname.startsWith(prefix)) throw fail('not_found', 'Unknown serverless route.', 404);
      const rest = url.pathname.slice(prefix.length);

      if (rest === '/health' && request.method === 'GET') {
        return jsonResponse({ ok: true, applicationId, mode: 'serverless-request-driven' });
      }
      if (rest === '/query' && (request.method === 'POST' || request.method === 'GET')) {
        const payload = request.method === 'POST'
          ? await request.json()
          : { query: url.searchParams.get('query'), input: JSON.parse(url.searchParams.get('input') ?? 'null') };
        const value = await withActiveSession(request.signal, ({ session }) => session.query(payload.query, payload.input ?? null));
        return jsonResponse(value);
      }
      if (rest === '/commands' && request.method === 'POST') {
        const body = commandInput(await request.json());
        const result = await withActiveSession(request.signal, async ({ session }) => {
          const op = await session.command(body.command, body.input, {
            operationId: body.operationId,
            ...(body.basedOn === undefined ? {} : { basedOn: body.basedOn }),
          });
          if (body.wait === 'recorded') {
            const state = await op.get();
            return { operationId: body.operationId, lifecycle: 'recorded', state };
          }
          const applied = await op.applied({ signal: request.signal });
          return { operationId: body.operationId, lifecycle: applied.outcome === 'rejected' ? 'rejected' : 'applied', applied };
        });
        return jsonResponse(result);
      }
      if (rest === '/commands/batch' && request.method === 'POST') {
        const body = await request.json();
        if (!Array.isArray(body?.commands) || body.commands.length > 64) throw fail('invalid_batch', 'Supply 0..64 commands.', 400);
        body.commands.forEach(commandInput);
        const results = await withActiveSession(request.signal, async ({ session }) => {
          const out = [];
          for (const item of body.commands) {
            const op = await session.command(item.command, item.input, {
              operationId: item.operationId,
              ...(item.basedOn === undefined ? {} : { basedOn: item.basedOn }),
            });
            const applied = await op.applied({ signal: request.signal });
            out.push({ operationId: item.operationId, command: item.command, lifecycle: applied.outcome === 'rejected' ? 'rejected' : 'applied', applied });
          }
          return out;
        });
        return jsonResponse({ results });
      }
      if (rest.startsWith('/operations/') && request.method === 'GET') {
        const opId = decodeURIComponent(rest.slice('/operations/'.length));
        const state = await withActiveSession(request.signal, ({ session }) => session.operations.get(opId));
        return jsonResponse({
          operationId: opId,
          lifecycle: !state ? 'unknown' : state.status === 'applied' ? (state.outcome === 'rejected' ? 'rejected' : 'applied') : state.status === 'saved' ? 'recorded' : 'rejected',
          state,
        });
      }
      throw fail('not_found', 'Unknown serverless route.', 404);
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      return jsonResponse({ error: { code: error?.code ?? 'serverless_error', message: error?.message ?? 'Serverless execution failed.' } }, status);
    }
  }

  return Object.freeze({ applicationId, store, withActiveSession, handleRequest });
}
