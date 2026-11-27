/**
 * Self-contained MCP App HTML resource (`ui://tendriller/inbox.html`) for
 * `io.modelcontextprotocol/ui` hosts (including Google Antigravity App `v2.34.0+`
 * `aux_pane` side panel and `global` full-page entrypoints).
 *
 * Talks strictly via the MCP Apps postMessage JSON-RPC bridge (`tools/call`,
 * `ui/message`, `ui/notifications/size-changed`) with zero external fetches
 * or `connectDomains`.
 */
import { escapeHtml } from './inject';

export const MCP_APP_INBOX_URI = 'ui://tendriller/inbox.html';
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';

export function renderTendrillerMcpAppHtml(serviceOrigin: string): string {
  const safeOrigin = escapeHtml(serviceOrigin);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tendriller Inbox</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #0f1411;
    --surface: #171f1a;
    --surface-2: #1e2822;
    --border: rgba(255,255,255,.12);
    --ink: #ecf3ee;
    --muted: #9eb0a5;
    --accent: #3ecf8e;
    --accent-soft: rgba(62,207,142,.15);
    --warn: #f5b942;
    --danger: #f06a6a;
    --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    --sans: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f6f8f6;
      --surface: #ffffff;
      --surface-2: #edf2ee;
      --border: rgba(15,25,18,.12);
      --ink: #132018;
      --muted: #526358;
      --accent: #147d4e;
      --accent-soft: rgba(20,125,78,.11);
      --warn: #a66900;
      --danger: #c0392b;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 14px;
    background: var(--bg);
    color: var(--ink);
    font: 13px/1.45 var(--sans);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 12px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--border);
  }
  .brand { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .brand h1 { margin: 0; font-size: 14px; font-weight: 700; letter-spacing: -.01em; }
  .brand .origin { font: 11px/1.2 var(--mono); color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  button {
    appearance: none;
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--ink);
    border-radius: 7px;
    padding: 5px 10px;
    font: 600 12px/1.2 var(--sans);
    cursor: pointer;
  }
  button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
  button.primary { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
  button:disabled { opacity: .5; cursor: default; }
  .status {
    margin-bottom: 10px;
    padding: 8px 10px;
    border-radius: 8px;
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--muted);
    font-size: 12px;
  }
  .status.err { border-color: var(--danger); color: var(--danger); }
  .grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 10px 12px;
  }
  .card h2 { margin: 0 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
  .apps { display: flex; flex-direction: column; gap: 6px; }
  .app-btn {
    width: 100%;
    text-align: left;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 10px;
    background: var(--surface-2);
  }
  .app-btn.active { border-color: var(--accent); background: var(--accent-soft); }
  .app-title { font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pill {
    font: 600 11px/1 var(--mono);
    padding: 3px 6px;
    border-radius: 999px;
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--muted);
    flex: none;
  }
  .msg-list { display: flex; flex-direction: column; gap: 8px; }
  .msg {
    padding: 8px 10px;
    border-radius: 8px;
    background: var(--surface-2);
    border: 1px solid var(--border);
  }
  .msg-head { display: flex; justify-content: space-between; gap: 8px; font: 11px/1.3 var(--mono); color: var(--muted); margin-bottom: 4px; }
  .msg-text { margin: 0 0 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .empty { color: var(--muted); margin: 4px 0; font-size: 12px; }
</style>
</head>
<body>
<header>
  <div class="brand">
    <h1>Tendriller Inbox</h1>
    <span class="origin" id="origin">${safeOrigin}</span>
  </div>
  <div class="row">
    <button type="button" id="refresh-btn">Refresh</button>
  </div>
</header>
<div class="status" id="status" role="status" aria-live="polite">Connecting to MCP host…</div>
<div class="grid">
  <section class="card" aria-labelledby="apps-h">
    <h2 id="apps-h">Connected Pages</h2>
    <div class="apps" id="apps"><p class="empty">Loading connected Tendriller apps…</p></div>
  </section>
  <section class="card" id="feed-card" style="display:none" aria-labelledby="feed-h">
    <h2 id="feed-h">Agent Feed</h2>
    <div class="msg-list" id="feed"></div>
  </section>
</div>
<script>
(() => {
  const statusEl = document.getElementById('status');
  const appsEl = document.getElementById('apps');
  const feedCard = document.getElementById('feed-card');
  const feedEl = document.getElementById('feed');
  const refreshBtn = document.getElementById('refresh-btn');

  let nextId = 1;
  const pending = new Map();
  let apps = [];
  let selectedAppId = null;
  let hostCapabilities = {};

  function setStatus(text, isErr = false) {
    statusEl.textContent = text;
    statusEl.className = isErr ? 'status err' : 'status';
  }

  function postRpc(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error('Host RPC timeout: ' + method));
        }
      }, 20000);
    });
  }

  function notifyHost(method, params) {
    window.parent.postMessage({ jsonrpc: '2.0', method, params }, '*');
  }

  function reportSize() {
    const height = Math.min(800, Math.max(220, document.documentElement.scrollHeight + 8));
    notifyHost('ui/notifications/size-changed', { height });
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || msg.jsonrpc !== '2.0') return;
    if (msg.id !== undefined && pending.has(msg.id)) {
      const entry = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message || 'MCP error'));
      else entry.resolve(msg.result);
      return;
    }
    if (msg.method === 'ui/notifications/tool-result' && msg.params) {
      const sc = msg.params.structuredContent;
      if (sc && Array.isArray(sc.applications)) {
        apps = sc.applications;
        if (sc.selectedApplicationId) selectedAppId = sc.selectedApplicationId;
        renderApps();
        if (sc.feed) renderFeed(sc.feed);
        setStatus('Loaded ' + apps.length + ' connected Tendriller page(s).');
      }
    }
  });

  async function callTool(name, args) {
    const res = await postRpc('tools/call', { name, arguments: args || {} });
    if (res && res.isError) {
      const text = res.content && res.content[0] && res.content[0].text ? res.content[0].text : 'Tool error';
      throw new Error(text);
    }
    if (res && res.structuredContent !== undefined) return res.structuredContent;
    const raw = res && res.content && res.content[0] && res.content[0].text;
    try { return raw ? JSON.parse(raw) : {}; } catch { return { raw }; }
  }

  async function sendToAgent(promptText, targetNew) {
    const params = {
      role: 'user',
      content: [{ type: 'text', text: promptText }],
      ...(targetNew ? { _meta: { 'com.google.antigravity/message': { target: 'new' } } } : {}),
    };
    try {
      await postRpc('ui/message', params);
      setStatus(targetNew ? 'Started a new Antigravity conversation for this request.' : 'Sent to the current Antigravity conversation.');
    } catch (err) {
      setStatus('Could not post follow-up message from this surface (' + err.message + ').', true);
    }
  }

  function renderApps() {
    appsEl.innerHTML = '';
    if (!apps.length) {
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = 'No Tendriller pages are opted into hosted MCP yet. Connect a page at /connections or ask Antigravity to build one.';
      appsEl.appendChild(p);
      feedCard.style.display = 'none';
      reportSize();
      return;
    }
    for (const app of apps) {
      const appId = app.applicationId || app.id || '';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'app-btn' + (appId === selectedAppId ? ' active' : '');
      const title = document.createElement('span');
      title.className = 'app-title';
      title.textContent = app.label || app.name || appId.slice(0, 12);
      const pill = document.createElement('span');
      pill.className = 'pill';
      pill.textContent = app.handle ? '@' + app.handle : appId.slice(0, 8);
      btn.append(title, pill);
      btn.addEventListener('click', () => { void loadFeed(appId); });
      appsEl.appendChild(btn);
    }
    reportSize();
  }

  function renderFeed(feed) {
    feedCard.style.display = 'block';
    feedEl.innerHTML = '';
    const messages = Array.isArray(feed?.messages) ? feed.messages : [];
    const recent = messages.slice(-12).reverse();
    if (!recent.length) {
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = 'No messages in agentFeed yet.';
      feedEl.appendChild(p);
      reportSize();
      return;
    }
    const canMessage = hostCapabilities.message !== false;
    for (const m of recent) {
      const box = document.createElement('div');
      box.className = 'msg';
      const head = document.createElement('div');
      head.className = 'msg-head';
      const who = document.createElement('span');
      who.textContent = (m.author || '').slice(0, 12) + ' · ' + (m.operationId || '').slice(0, 20);
      const when = document.createElement('span');
      when.textContent = m.atMs ? new Date(m.atMs).toLocaleTimeString() : '';
      head.append(who, when);

      const body = document.createElement('p');
      body.className = 'msg-text';
      body.textContent = String(m.text || '');

      box.append(head, body);
      if (canMessage && selectedAppId && m.author && m.operationId) {
        const ref = JSON.stringify({ applicationId: selectedAppId, messageAuthor: m.author, messageOperationId: m.operationId });
        const prompt = 'Inspect Tendriller application ' + selectedAppId + ' via agent_feed, match ' + ref + ', save an agentReceipt if unanswered, handle it under existing user authorization, and reply via agent_message with inReplyTo.';
        const actions = document.createElement('div');
        actions.className = 'row';
        const btnHere = document.createElement('button');
        btnHere.type = 'button';
        btnHere.className = 'primary';
        btnHere.textContent = 'Handle in this chat';
        btnHere.addEventListener('click', () => { void sendToAgent(prompt, false); });

        const btnNew = document.createElement('button');
        btnNew.type = 'button';
        btnNew.textContent = 'New conversation';
        btnNew.addEventListener('click', () => { void sendToAgent(prompt, true); });

        actions.append(btnHere, btnNew);
        box.appendChild(actions);
      }
      feedEl.appendChild(box);
    }
    reportSize();
  }

  async function loadFeed(appId) {
    selectedAppId = appId;
    renderApps();
    setStatus('Loading agent_feed for ' + appId.slice(0, 12) + '…');
    try {
      const feed = await callTool('agent_feed', { applicationId: appId });
      renderFeed(feed);
      setStatus('Showing latest messages for ' + appId.slice(0, 12) + '.');
    } catch (err) {
      setStatus('Could not load agent_feed: ' + err.message, true);
    }
  }

  async function refreshAll() {
    refreshBtn.disabled = true;
    setStatus('Refreshing connected Tendriller pages…');
    try {
      const listed = await callTool('list_tendrils', {});
      apps = Array.isArray(listed.applications) ? listed.applications : [];
      if (!selectedAppId && apps.length) selectedAppId = apps[0].applicationId || apps[0].id || null;
      renderApps();
      if (selectedAppId) await loadFeed(selectedAppId);
      else setStatus('Connected. No opted-in Tendriller apps yet.');
    } catch (err) {
      setStatus('Refresh failed: ' + err.message, true);
    } finally {
      refreshBtn.disabled = false;
    }
  }

  refreshBtn.addEventListener('click', () => { void refreshAll(); });

  (async () => {
    try {
      const init = await postRpc('ui/initialize', {
        appInfo: { name: 'tendriller-inbox', version: '1.0.0' },
        appCapabilities: {},
        protocolVersion: '2026-01-26',
      });
      hostCapabilities = init?.hostCapabilities || {};
      notifyHost('ui/notifications/initialized', {});
      await refreshAll();
    } catch (err) {
      setStatus('Standing by (' + err.message + '). Click Refresh to query connected pages.');
      reportSize();
    }
  })();
})();
</script>
</body>
</html>`;
}
