// Local stdio MCP server for coding agents. JSON-RPC 2.0 over newline-delimited
// stdin/stdout, serving every workspace page; each tool names its `page`.
import { once } from 'node:events';

const PROTOCOL_VERSION = '2025-11-25';

const PAGE = { type: 'string', minLength: 1, maxLength: 64, description: 'Workspace page slug or page id (see pages_list).' };
const TOOL_SPECS = [
  {
    name: 'pages_list',
    description: 'List the workspace pages this agent serves, with their slugs, ids and whether the agent program runs them.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'app_discover',
    description: 'Inspect the connected Tendriller application descriptor, allowed commands/queries, and current session status.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'command_submit',
    description: 'Submit one idempotent application command with a stable operationId.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', minLength: 1 },
        input: {},
        operationId: { type: 'string', minLength: 1, maxLength: 512 },
        wait: { type: 'string', enum: ['applied', 'recorded'], default: 'applied' },
      },
      required: ['command', 'input', 'operationId'],
      additionalProperties: false,
    },
  },
  {
    name: 'command_submit_batch',
    description: 'Submit an ordered batch of up to 32 idempotent commands.',
    inputSchema: {
      type: 'object',
      properties: {
        commands: {
          type: 'array',
          maxItems: 32,
          items: {
            type: 'object',
            properties: {
              command: { type: 'string', minLength: 1 },
              input: {},
              operationId: { type: 'string', minLength: 1, maxLength: 512 },
            },
            required: ['command', 'input', 'operationId'],
            additionalProperties: false,
          },
        },
        wait: { type: 'string', enum: ['applied', 'recorded'], default: 'applied' },
        stopOnError: { type: 'boolean', default: false },
      },
      required: ['commands'],
      additionalProperties: false,
    },
  },
  {
    name: 'operation_inspect',
    description: 'Inspect an operation by its original operationId and return its honest lifecycle state.',
    inputSchema: {
      type: 'object',
      properties: { operationId: { type: 'string', minLength: 1, maxLength: 512 } },
      required: ['operationId'],
      additionalProperties: false,
    },
  },
  {
    name: 'state_query',
    description: 'Run a declared coherent read query on the local application session.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', minLength: 1 }, input: {} },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'signal_send',
    description: 'Send a bounded live JSON signal (e.g. dashboard feed update, presence, typing, or observation request) without writing to the durable journal.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', minLength: 1, maxLength: 128 },
        payload: {},
        ttlMs: { type: 'integer', minimum: 100, maximum: 60000 },
      },
      required: ['topic', 'payload'],
      additionalProperties: false,
    },
  },
  {
    name: 'notify_user',
    description: 'Send an opt-in Web Push notification to subscribed devices for this Tendriller page (even when the page is closed).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 120 },
        body: { type: 'string', maxLength: 500 },
        path: { type: 'string', maxLength: 256 },
        tag: { type: 'string', maxLength: 64 },
        badge: { type: 'integer', minimum: 0, maximum: 999 },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
];
// Every page-scoped tool takes `page`; the agent program attaches to that page only.
export const TOOLS = TOOL_SPECS.map(tool => tool.name === 'pages_list' ? tool : { ...tool, inputSchema: { ...tool.inputSchema,
  properties: { page: PAGE, ...tool.inputSchema.properties }, required: ['page', ...(tool.inputSchema.required ?? [])] } });

function lifecycleOf(operationId, state) {
  if (!state) return { operationId, lifecycle: 'unknown', state: null };
  if (state.status === 'applied') {
    return { operationId, lifecycle: state.outcome === 'rejected' ? 'rejected' : 'applied', state };
  }
  if (state.status === 'saved') return { operationId, lifecycle: 'recorded', state };
  if (['abandoned', 'needsReapply'].includes(state.status)) return { operationId, lifecycle: 'needs-review', state };
  return { operationId, lifecycle: 'unknown', state };
}

const invalid = message => Object.assign(new Error(message), { code: 'invalid_arguments' });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function validateArguments(name, args) {
  const spec = TOOLS.find(tool => tool.name === name)?.inputSchema;
  if (!spec) throw Object.assign(new Error(`Unknown local MCP tool: ${name}`), { code: 'unknown_tool' });
  if (!plain(args) || Object.keys(args).some(key => !Object.hasOwn(spec.properties, key)) ||
      (spec.required ?? []).some(key => !Object.hasOwn(args, key))) throw invalid('Invalid tool arguments');
  const command = item => {
    if (!plain(item) || typeof item.command !== 'string' || !item.command.trim() || item.command.length > 128 ||
        typeof item.operationId !== 'string' || !item.operationId.trim() || item.operationId.length > 512 ||
        /[\u0000-\u001f\u007f]/u.test(item.operationId) || !Object.hasOwn(item, 'input'))
      throw invalid('Every command needs a name, input and stable operationId');
  };
  if (name !== 'pages_list' && (typeof args.page !== 'string' || !args.page.trim() || args.page.length > 64)) throw invalid('Supply the page slug or id');
  if (name === 'command_submit') command({ ...args, page: undefined });
  if (name === 'command_submit_batch') {
    if (!Array.isArray(args.commands) || args.commands.length > 32) throw invalid('Supply 0..32 commands');
    for (const item of args.commands) {
      command(item);
      if (Object.keys(item).some(key => !['command', 'input', 'operationId'].includes(key))) throw invalid('Unknown command field');
    }
  }
  if (name === 'operation_inspect' && (typeof args.operationId !== 'string' || !args.operationId.trim() || args.operationId.length > 512))
    throw invalid('Supply the original operationId');
  if (name === 'state_query' && (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 128)) throw invalid('Supply a query name');
  if (name === 'signal_send') {
    if (typeof args.topic !== 'string' || !args.topic.trim() || args.topic.length > 128) throw invalid('Supply a signal topic');
    if (args.ttlMs !== undefined && (!Number.isSafeInteger(args.ttlMs) || args.ttlMs < 100 || args.ttlMs > 60_000)) throw invalid('ttlMs must be 100..60000');
  }
  if (name === 'notify_user') {
    if (typeof args.title !== 'string' || !args.title.trim() || args.title.trim().length > 120) throw invalid('Supply a notification title (1..120 chars)');
    if (args.body !== undefined && (typeof args.body !== 'string' || args.body.length > 500)) throw invalid('body must be a string up to 500 chars');
    if (args.path !== undefined && (typeof args.path !== 'string' || args.path.length > 256)) throw invalid('path must be a relative string up to 256 chars');
    if (args.tag !== undefined && (typeof args.tag !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(args.tag))) throw invalid('tag must be 1..64 alphanumeric/._- chars');
    if (args.badge !== undefined && (!Number.isSafeInteger(args.badge) || args.badge < 0 || args.badge > 999)) throw invalid('badge must be 0..999');
  }
  if (args.wait !== undefined && !['recorded', 'applied'].includes(args.wait)) throw invalid('wait must be recorded or applied');
  if (args.stopOnError !== undefined && typeof args.stopOnError !== 'boolean') throw invalid('stopOnError must be boolean');
}
async function uncertain(session, operationId, error) {
  const state = await session.operations.get(operationId).catch(() => null);
  return { operationId, lifecycle: 'unknown', state, error: { code: error?.code ?? 'operation_uncertain', message: error?.message ?? String(error) },
    nextAction: 'Inspect this operationId. Retry only the original ID and input; an interrupted response does not establish rejection.' };
}

/** `pages` = { list(), open(page, { signal }) -> { session, notify? } }; attachments are cached by the caller. */
export async function handleStdioMcpMessage(pages, message, { signal } = {}) {
  const id = message?.id ?? null;
  const ok = result => ({ jsonrpc: '2.0', id, result });
  const err = (code, msg) => ({ jsonrpc: '2.0', id, error: { code, message: msg } });
  const toolOk = value => ok({ structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] });
  const toolErr = (code, msg) => ok({ isError: true, structuredContent: { code, message: msg }, content: [{ type: 'text', text: JSON.stringify({ code, message: msg }) }] });

  if (!plain(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' ||
      (message.id !== undefined && message.id !== null && typeof message.id !== 'string' && !(typeof message.id === 'number' && Number.isFinite(message.id)))) {
    return err(-32600, 'Invalid JSON-RPC request');
  }
  if (message.id === undefined) return null;
  const lifetime = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]);
  signal = lifetime;

  try {
    if (message.method === 'initialize') {
      return ok({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'tendriller-local-stdio', version: '1.0.0' },
      });
    }
    if (message.method === 'ping') return ok({});
    if (message.method === 'tools/list') return ok({ tools: TOOLS });
    if (message.method === 'tools/call') {
      const name = message.params?.name;
      if (!plain(message.params) || typeof message.params.name !== 'string') return err(-32602, 'Invalid tool call');
      const args = message.params.arguments ?? {};
      try { validateArguments(name, args); } catch (error) { return toolErr(error.code, error.message); }
      signal.throwIfAborted();
      if (name === 'pages_list') return toolOk({ pages: await pages.list() });
      const owned = await pages.open(args.page, { signal });
      const { session } = owned;
      if (name === 'app_discover') {
        return toolOk({
          page: args.page,
          applicationId: session.applicationId,
          deviceId: session.deviceId,
          mode: 'attach',
          status: session.status,
          descriptor: session.describe(),
        });
      }
      if (name === 'state_query') {
        return toolOk(await session.query(args.query, args.input ?? null));
      }
      if (name === 'signal_send') {
        await session.signals.send(args.topic, args.payload, args.ttlMs === undefined ? {} : { ttlMs: args.ttlMs });
        return toolOk({ sent: true, topic: args.topic, durable: false });
      }
      if (name === 'notify_user') {
        const payload = {
          title: args.title.trim(),
          ...(args.body !== undefined ? { body: args.body } : {}),
          ...(args.path !== undefined ? { path: args.path } : {}),
          ...(args.tag !== undefined ? { tag: args.tag } : {}),
          ...(args.badge !== undefined ? { badge: args.badge } : {}),
        };
        return toolOk(await owned.notify(payload, { signal }));
      }
      if (name === 'operation_inspect') {
        const state = await session.operations.get(args.operationId);
        return toolOk(lifecycleOf(args.operationId, state));
      }
      if (name === 'command_submit') {
        try {
          const op = await session.command(args.command, args.input, { operationId: args.operationId });
          if (args.wait === 'recorded') return toolOk(lifecycleOf(args.operationId, await op.get()));
          const applied = await op.applied({ signal });
          return toolOk({ operationId: args.operationId, lifecycle: applied.outcome === 'rejected' ? 'rejected' : 'applied', applied });
        } catch (error) {
          return toolOk(await uncertain(session, args.operationId, error));
        }
      }
      if (name === 'command_submit_batch') {
        const items = args.commands;
        if (items.length > 32) return toolErr('batch_limit_exceeded', 'At most 32 commands per batch.');
        const results = [];
        for (const item of items) {
          if (signal.aborted) break;
          try {
            const op = await session.command(item.command, item.input, { operationId: item.operationId });
            if (args.wait === 'recorded') {
              results.push({ ...lifecycleOf(item.operationId, await op.get()), command: item.command });
            } else {
              const applied = await op.applied({ signal });
              results.push({ operationId: item.operationId, command: item.command, lifecycle: applied.outcome === 'rejected' ? 'rejected' : 'applied', applied });
              if (args.stopOnError === true && applied.outcome === 'rejected') break;
            }
          } catch (error) {
            results.push({ ...await uncertain(session, item.operationId, error), command: item.command });
            if (args.stopOnError === true) break;
          }
        }
        return toolOk({ results, complete: results.length === items.length, nextIndex: results.length });
      }
      return toolErr('unknown_tool', `Unknown local MCP tool: ${name}`);
    }
    return err(-32601, `Unknown method: ${message.method}`);
  } catch (error) {
    return message.method === 'tools/call' ? toolErr(error?.code ?? 'tool_failed', error?.message ?? String(error)) : err(-32000, error?.message ?? String(error));
  }
}

// Read bounded frames rather than letting readline retain an unbounded line.
export async function serveStdioMcp(pages, { input = process.stdin, output = process.stdout, signal } = {}) {
  const active = new Map(), pending = new Set();
  const disconnected = new AbortController();
  const lifetime = AbortSignal.any([disconnected.signal, ...(signal ? [signal] : [])]);
  let frame = Buffer.alloc(0);
  const write = async response => {
    if (response !== null && !output.write(JSON.stringify(response) + '\n'))
      await once(output, 'drain', { signal: lifetime });
  };
  const reply = async line => {
    let message;
    try { message = JSON.parse(line); }
    catch { return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    if (message?.method === 'notifications/cancelled' && message.id === undefined) {
      active.get(JSON.stringify(message.params?.requestId))?.abort(new Error('MCP caller cancelled the request'));
      return;
    }
    const key = JSON.stringify(message?.id), cancellation = new AbortController();
    if (message?.id !== undefined && (active.has(key) || active.size >= 16)) {
      return write({ jsonrpc: '2.0', id: message.id, error: { code: -32600, message: 'Duplicate or excessive outstanding request' } });
    }
    if (message?.id !== undefined) active.set(key, cancellation);
    try { await write(await handleStdioMcpMessage(pages, message,
      { signal: AbortSignal.any([lifetime, cancellation.signal]) })); }
    finally { if (active.get(key) === cancellation) active.delete(key); }
  };
  const abort = () => input.destroy?.();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    for await (const chunk of input) {
      if (lifetime.aborted) break;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      // Bound retained frame and total input chunk before copying.
      if (frame.length + bytes.length > 1024 * 1024) throw invalid('MCP input frame exceeds 1 MiB');
      frame = Buffer.concat([frame, bytes]);
      let newline;
      while ((newline = frame.indexOf(10)) !== -1) {
        const line = frame.subarray(0, newline).toString('utf8').trim();
        frame = frame.subarray(newline + 1);
        if (!line) continue;
        const task = reply(line);
        pending.add(task);
        void task.then(() => pending.delete(task), () => pending.delete(task));
      }
    }
  } finally {
    disconnected.abort(new Error('MCP input closed'));
    signal?.removeEventListener('abort', abort);
    await Promise.allSettled(pending);
  }
}
