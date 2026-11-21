const PROTOCOL = '2026-01-26';

/** Minimal MCP Apps client for the application inbox card; sends no user message on mount. */
export function createWidgetBridge({ window: win, timeoutMs = 10000, onClose = () => {} } = {}) {
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
  win.addEventListener('message', receive);
  function close() {
    if (closed) return;
    closed = true; mode = 'unavailable';
    win.removeEventListener('message', receive);
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error('WIDGET_CLOSED')); }
    pending.clear(); listeners.input.clear(); listeners.result.clear();
    onClose();
  }
  return {
    async connect() {
      if (closed) throw Error('WIDGET_CLOSED');
      if (win.parent !== win) {
        const result = await request('ui/initialize', {
          protocolVersion: PROTOCOL,
          appInfo: { name: 'Tendriller application inbox', version: '1.0.0' },
          appCapabilities: { availableDisplayModes: ['inline'] },
        });
        if (closed) throw Error('WIDGET_CLOSED');
        if (result?.protocolVersion !== PROTOCOL) throw Error('WIDGET_PROTOCOL_UNSUPPORTED');
        capabilities = result.hostCapabilities ?? {};
        mode = 'mcp-apps';
        post({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} });
        return { mode, capabilities };
      }
      return { mode, capabilities: {} };
    },
    get mode() { return mode; },
    get canMessage() { return mode === 'mcp-apps' && Boolean(capabilities.message?.text); },
    onInput(listener) { listeners.input.add(listener); return () => listeners.input.delete(listener); },
    onResult(listener) { listeners.result.add(listener); return () => listeners.result.delete(listener); },
    async sendMessage(prompt) {
      if (typeof prompt !== 'string' || !prompt.length || prompt.length > 4000) throw Error('WIDGET_MESSAGE_INVALID');
      if (mode === 'mcp-apps' && capabilities.message?.text) return request('ui/message', { role: 'user', content: [{ type: 'text', text: prompt }] });
      throw Error('WIDGET_MESSAGE_UNAVAILABLE');
    },
    close,
  };
}
