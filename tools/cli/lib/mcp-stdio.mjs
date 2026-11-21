// Local Stdio MCP Server (W5) for Grok Bot local MCP, Cursor, and local coding agents.
// Implements JSON-RPC 2.0 over newline-delimited stdin/stdout backed directly by the opened session.
import { createInterface } from 'node:readline';

const PROTOCOL_VERSION = '2025-11-25';

const TOOLS = [
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
        operationId: { type: 'string', minLength: 1, maxLength: 256 },
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
              operationId: { type: 'string', minLength: 1, maxLength: 256 },
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
      properties: { operationId: { type: 'string', minLength: 1, maxLength: 256 } },
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
];

function lifecycleOf(operationId, state) {
  if (!state) return { operationId, lifecycle: 'unknown', state: null };
  if (state.status === 'applied') {
    return { operationId, lifecycle: state.outcome === 'rejected' ? 'rejected' : 'applied', state };
  }
  if (state.status === 'saved') return { operationId, lifecycle: 'recorded', state };
  return { operationId, lifecycle: 'rejected', state };
}

export async function handleStdioMcpMessage(owned, message, { signal } = {}) {
  const { session } = owned;
  const id = message?.id;
  const ok = result => ({ jsonrpc: '2.0', id, result });
  const err = (code, msg) => ({ jsonrpc: '2.0', id, error: { code, message: msg } });
  const toolOk = value => ok({ structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] });
  const toolErr = (code, msg) => ok({ isError: true, structuredContent: { code, message: msg }, content: [{ type: 'text', text: JSON.stringify({ code, message: msg }) }] });

  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return err(-32600, 'Invalid JSON-RPC request');
  }
  if (message.method === 'notifications/initialized' || id === undefined) return null;

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
      const args = message.params?.arguments ?? {};
      if (name === 'app_discover') {
        return toolOk({
          applicationId: session.applicationId,
          deviceId: session.deviceId,
          mode: owned.mode ?? 'own',
          status: session.status,
          descriptor: session.describe(),
        });
      }
      if (name === 'state_query') {
        return toolOk(await session.query(args.query, args.input ?? null));
      }
      if (name === 'operation_inspect') {
        const state = await session.operations.get(args.operationId);
        return toolOk(lifecycleOf(args.operationId, state));
      }
      if (name === 'command_submit') {
        const op = await session.command(args.command, args.input, { operationId: args.operationId });
        if (args.wait === 'recorded') {
          return toolOk(lifecycleOf(args.operationId, await op.get()));
        }
        try {
          const applied = await op.applied({ signal });
          return toolOk({ operationId: args.operationId, lifecycle: applied.outcome === 'rejected' ? 'rejected' : 'applied', applied });
        } catch (waitError) {
          const state = await session.operations.get(args.operationId).catch(() => null);
          return toolOk({ operationId: args.operationId, lifecycle: 'unknown', state, error: waitError?.message ?? String(waitError) });
        }
      }
      if (name === 'command_submit_batch') {
        const items = Array.isArray(args.commands) ? args.commands : [];
        if (items.length > 32) return toolErr('batch_limit_exceeded', 'At most 32 commands per batch.');
        const results = [];
        for (const item of items) {
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
            results.push({ operationId: item.operationId, command: item.command, lifecycle: 'rejected', error: { code: error?.code ?? 'command_failed', message: error?.message ?? String(error) } });
            if (args.stopOnError === true) break;
          }
        }
        return toolOk({ results });
      }
      return toolErr('unknown_tool', `Unknown local MCP tool: ${name}`);
    }
    return err(-32601, `Unknown method: ${message.method}`);
  } catch (error) {
    return err(-32000, error?.message ?? String(error));
  }
}

export async function serveStdioMcp(owned, { input = process.stdin, output = process.stdout, signal } = {}) {
  const rl = createInterface({ input, crlfDelay: Infinity });
  const close = () => { rl.close(); };
  signal?.addEventListener('abort', close, { once: true });
  try {
    for await (const line of rl) {
      if (signal?.aborted) break;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed;
      try { parsed = JSON.parse(trimmed); }
      catch {
        output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
        continue;
      }
      const response = await handleStdioMcpMessage(owned, parsed, { signal });
      if (response !== null) output.write(JSON.stringify(response) + '\n');
    }
  } finally {
    signal?.removeEventListener('abort', close);
    rl.close();
  }
}
