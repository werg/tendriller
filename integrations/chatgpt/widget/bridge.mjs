const PROTOCOL = '2026-01-26';

/** Minimal MCP Apps client for this resource; it sends no user message on mount. */
export function createWidgetBridge({ window: win, timeoutMs = 10000 } = {}) {
  if (!win) throw Error('WIDGET_WINDOW_REQUIRED');
  let nextId = 0, mode = 'unavailable', hostOrigin, capabilities = {}, closed = false;
  const pending = new Map(), listeners = { input: new Set(), result: new Set() };
  const emit = (kind, value) => { for (const listener of listeners[kind]) listener(value); };
  const post = message => win.parent.postMessage(message, hostOrigin && hostOrigin !== 'null' ? hostOrigin : '*');
  function request(method, params) {
    if (closed) return Promise.reject(Error('WIDGET_CLOSED'));
    const id = `tendriller-${++nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(Error('WIDGET_HOST_TIMEOUT')); }, timeoutMs);
      pending.set(id, { resolve, reject, timer, method });
      post({ jsonrpc: '2.0', id, method, params });
    });
  }
  function receive(event) {
    if (closed || event.source !== win.parent || hostOrigin && event.origin !== hostOrigin) return;
    const message = event.data;
    if (!message || message.jsonrpc !== '2.0' || typeof message !== 'object') return;
    const waiting = pending.get(message.id);
    if (waiting && !message.method) {
      if (!Object.hasOwn(message, 'result') && !Object.hasOwn(message, 'error')) return;
      if (waiting.method === 'ui/initialize') hostOrigin = event.origin;
      pending.delete(message.id); clearTimeout(waiting.timer);
      if (message.error) waiting.reject(Object.assign(Error(message.error.message || 'WIDGET_HOST_DENIED'), { code: message.error.code }));
      else waiting.resolve(message.result);
    } else if (mode === 'mcp-apps' && message.id === undefined) {
      if (message.method === 'ui/notifications/tool-input') emit('input', message.params?.arguments ?? {});
      if (message.method === 'ui/notifications/tool-result') emit('result', message.params ?? {});
    } else if (mode === 'mcp-apps' && message.method === 'ui/resource-teardown' && message.id !== undefined) {
      post({ jsonrpc: '2.0', id: message.id, result: {} }); close();
    } else if (mode === 'mcp-apps' && message.method === 'ping' && message.id !== undefined) {
      post({ jsonrpc: '2.0', id: message.id, result: {} });
    }
  }
  function legacyGlobals(event) {
    if (mode !== 'legacy') return;
    const globals = event.detail?.globals;
    if (globals?.toolInput) emit('input', globals.toolInput);
    if (globals?.toolOutput) emit('result', { structuredContent: globals.toolOutput });
  }
  win.addEventListener('message', receive);
  win.addEventListener('openai:set_globals', legacyGlobals);
  function close() {
    closed = true; mode = 'unavailable';
    win.removeEventListener('message', receive); win.removeEventListener('openai:set_globals', legacyGlobals);
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error('WIDGET_CLOSED')); }
    pending.clear(); listeners.input.clear(); listeners.result.clear();
  }
  return {
    async connect() {
      if (closed) throw Error('WIDGET_CLOSED');
      if (win.parent !== win) {
        try {
          const result = await request('ui/initialize', { protocolVersion: PROTOCOL,
            appInfo: { name: 'Tendriller assistance', version: '1.0.0' }, appCapabilities: { availableDisplayModes: ['inline'] } });
          if (closed) throw Error('WIDGET_CLOSED');
          if (result?.protocolVersion !== PROTOCOL) throw Error('WIDGET_PROTOCOL_UNSUPPORTED');
          capabilities = result.hostCapabilities ?? {}; mode = 'mcp-apps';
          post({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} });
          return { mode, capabilities };
        } catch (error) {
          if (closed) throw error;
          // Only handshake compatibility can fall back. A denied or uncertain
          // user message is never sent a second time through another API.
        }
      }
      if (typeof win.openai?.sendFollowUpMessage === 'function' || typeof win.openai?.callTool === 'function') {
        mode = 'legacy';
        if (win.openai.toolInput) emit('input', win.openai.toolInput);
        if (win.openai.toolOutput) emit('result', { structuredContent: win.openai.toolOutput });
      }
      return { mode, capabilities: {} };
    },
    get mode() { return mode; },
    get canMessage() { return mode === 'mcp-apps' ? Boolean(capabilities.message?.text) : mode === 'legacy' && typeof win.openai?.sendFollowUpMessage === 'function'; },
    get canCallTool() { return mode === 'mcp-apps' ? Boolean(capabilities.serverTools) : mode === 'legacy' && typeof win.openai?.callTool === 'function'; },
    onInput(listener) { listeners.input.add(listener); return () => listeners.input.delete(listener); },
    onResult(listener) { listeners.result.add(listener); return () => listeners.result.delete(listener); },
    async sendMessage(prompt) {
      if (typeof prompt !== 'string' || !prompt.length || prompt.length > 4000) throw Error('WIDGET_MESSAGE_INVALID');
      if (mode === 'mcp-apps' && capabilities.message?.text) return request('ui/message', { role: 'user', content: [{ type: 'text', text: prompt }] });
      if (mode === 'legacy' && typeof win.openai?.sendFollowUpMessage === 'function') return win.openai.sendFollowUpMessage({ prompt });
      throw Error('WIDGET_MESSAGE_UNAVAILABLE');
    },
    async callTool(name, args) {
      // This card has one refresh operation. Never let tool results choose an
      // arbitrary tool, model-visible action, URL or command to execute.
      if (name !== 'get_assistance_status') throw Error('WIDGET_TOOL_NOT_ALLOWED');
      if (mode === 'mcp-apps' && capabilities.serverTools) return request('tools/call', { name, arguments: args });
      if (mode === 'legacy' && typeof win.openai?.callTool === 'function') return win.openai.callTool(name, args);
      throw Error('WIDGET_TOOLS_UNAVAILABLE');
    },
    close,
  };
}

export function requestReference(value) {
  if (typeof value?.applicationId !== 'string' || !/^[a-f0-9]{64}$/.test(value.applicationId) ||
      typeof value.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.requestId)) return null;
  return { applicationId: value.applicationId, requestId: value.requestId };
}

export function followupPrompt(value) {
  const reference = requestReference(value);
  if (!reference) throw Error('WIDGET_REQUEST_REFERENCE_INVALID');
  return `Please read the current Tendriller assistance request using get_assistance_status with ${JSON.stringify(reference)}. Check its current step, expiry and conflicts, then help and return your answer through reply_to_assistance. Ask me before any inventory change or purchase.`;
}
