/** MCP adapts explicit host administration to the same participant transport. */
import type { Tendril } from './tendril';
import { CONTRACT_VERSION, validateSchema } from '../../contract/index.mjs';
import { handleAgent } from './agent';
import { HttpError, isPlainObject, json, readJson } from './http';
import { PEER_CONTROL_TOOLS } from './peer-mcp';
import { authenticateAgentToken, currentPrincipal } from './access';
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
class RpcError extends Error { constructor(public code: number, message: string, public data?: unknown) { super(message); } }
const INSTRUCTIONS = 'This host is a filtered Chronolog participant for signed code publication, membership, discovery and explicit recovery. ' +
  'Open one public Chronolog application session for commands, queries, operations and ephemeral signals. ' +
  'Use applied() for a generation-scoped result and shared() for retained coverage. Explicit recovery can abandon a suffix. ' +
  'The host has no ordinary application command endpoint or event queue. Verify signed authority and publication ancestry in your session. ' +
  'Preserve the original operation identity and signed bytes on uncertain replies; code rollback is a newly signed release.';
export interface ToolRequest {
  method: string;
  rest: string;
  query?: Record<string, string>;
  body?: unknown;
  rawBody?: BodyInit;
  headers?: Record<string, string>;
}

export type InvokeToolRequest = (request: ToolRequest) => Promise<Response>;

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  call(args: Record<string, any>, invoke: InvokeToolRequest): ToolRequest | Response | Promise<ToolRequest | Response>;
}

const TOOLS: Tool[] = [...PEER_CONTROL_TOOLS, {
  name: 'tendril_info', description: 'Read page identity, current signed publication storage version and host lifecycle metadata.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  call: () => ({ method: 'GET', rest: '' }),
}];
/** Routes `A/mcp` and `A/mcp/<token>` (a capability URL for hosts that cannot send headers). */
export async function handleMcp(t: Tendril, req: Request, rest: string): Promise<Response> {
  const pathToken = rest.startsWith("mcp/") ? rest.slice(4) : "";
  const header = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("Authorization") ?? "")?.[1] ?? "";
  const token = pathToken || header;
  if (!token) throw new HttpError(401, "unauthorized", "Connect with Authorization: Bearer <token> or the URL <api>/mcp/<token>");
  const principal = await authenticateAgentToken(t, token);
  if (!currentPrincipal(t, principal)) throw new HttpError(401, 'unauthorized');
  t.recordAccess();
  if (req.method !== "POST")
    return json({ error: { code: "method_not_allowed", message: "This MCP server takes JSON-RPC over POST and offers no event stream" } }, 405, { Allow: "POST" });

  const msg = await readJson<any>(req, 36 * 1024 * 1024);
  if (Array.isArray(msg) || !isPlainObject(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string")
    return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } }, 400);
  if (msg.id === undefined || msg.id === null) return new Response(null, { status: 202 });
  try {
    const result = await dispatch(t, token, msg.method, isPlainObject(msg.params) ? msg.params : {}, req.signal, req.headers.get("CF-Connecting-IP"));
    return json({ jsonrpc: "2.0", id: msg.id, result });
  } catch (err) {
    const e = err instanceof RpcError ? err : new RpcError(-32603, err instanceof Error ? err.message : String(err));
    return json({ jsonrpc: "2.0", id: msg.id, error: { code: e.code, message: e.message, ...(e.data !== undefined ? { data: e.data } : {}) } });
  }
}

async function dispatch(t: Tendril, token: string, method: string, params: Record<string, any>, signal: AbortSignal, clientIp: string | null): Promise<unknown> {
  switch (method) {
    case 'initialize': return {
      protocolVersion: typeof params.protocolVersion === 'string' && PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
      capabilities: { tools: {} }, serverInfo: { name: 'tendriller', version: String(CONTRACT_VERSION) }, instructions: INSTRUCTIONS,
    };
    case 'ping': return {};
    case 'tools/list': return { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
    case 'tools/call': return callTool(t, token, params, signal, clientIp);
    default: throw new RpcError(-32601, `Method not found: ${method}`);
  }
}
async function callTool(t: Tendril, token: string, params: Record<string, any>, signal: AbortSignal, clientIp: string | null): Promise<unknown> {
  const tool = TOOLS.find((x) => x.name === params.name);
  if (!tool) throw new RpcError(-32602, `Unknown tool: ${String(params.name)}`);
  const args = isPlainObject(params.arguments) ? params.arguments : {};
  const issues = validateSchema(tool.inputSchema, args);
  if (issues.length) throw new RpcError(-32602, "Invalid tool arguments", { issues });
  const invoke: InvokeToolRequest = spec => {
    const query = { ...spec.query };
    const url = new URL(`https://tendril.internal/agent?${new URLSearchParams(query)}`);
    const headers = new Headers(spec.headers);
    // Internal adapters cannot replace the caller's credential, route or origin.
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("x-tendril-rest", encodeURIComponent(spec.rest));
    if (clientIp) headers.set("CF-Connecting-IP", clientIp);
    const init: RequestInit = { method: spec.method, headers, signal };
    if (spec.rawBody !== undefined) init.body = spec.rawBody;
    else if (spec.body !== undefined) {
      headers.set("Content-Type", "application/json");
      init.body = JSON.stringify(spec.body);
    }
    return handleAgent(t, new Request(url, init), url);
  };
  let res: Response;
  try {
    const spec = await tool.call(args, invoke);
    res = spec instanceof Response ? spec : await invoke(spec);
  } catch (err) {
    const message = err instanceof HttpError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: message }], isError: true };
  }
  const text = res.status === 204 ? "{}" : await res.text();
  let value: unknown = text;
  try {
    value = JSON.parse(text);
  } catch {
    /* plain text result */
  }
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
    ...(isPlainObject(value) ? { structuredContent: value } : {}),
    ...(res.ok ? {} : { isError: true }),
  };
}
