import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const DAY = 86_400_000;
const NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const KINDS = new Set(['read', 'query', 'command', 'event', 'event-details']);

export class ConsentError extends Error {
  constructor(code, message, status = 403) {
    super(message);
    this.name = 'ConsentError';
    this.code = code;
    this.status = status;
  }
}

function subject(principal) {
  if (typeof principal?.id !== 'string' || !principal.id.trim() || principal.id.length > 512 || (principal.issuer !== undefined && typeof principal.issuer !== 'string')) {
    throw new ConsentError('authentication_required', 'An authenticated account identity is required', 401);
  }
  return JSON.stringify([principal.issuer ?? '', principal.id]);
}

function identifier(value, name) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) throw new ConsentError('invalid_consent', `A bounded ${name} is required`, 400);
  return value;
}

function names(value, label) {
  if (!Array.isArray(value) || value.length > 100 || value.some(name => typeof name !== 'string' || !NAME.test(name))) throw new ConsentError('invalid_consent', `${label} must contain exact declared names, without wildcards`, 400);
  return [...new Set(value)].sort();
}

const connectionId = (owner, applicationId) => `con_${createHash('sha256').update(JSON.stringify([owner, applicationId])).digest('hex')}`;

function publicConnection(connection, now) {
  const { owner, ...result } = connection;
  return { ...structuredClone(result), status: connection.revokedAt !== null ? 'revoked' : connection.expiresAt !== null && connection.expiresAt <= now ? 'expired' : 'active' };
}

/** Consent is delivery/access bookkeeping, never Chronolog authority or state. */
export function createConsentService({ store, authorizeOwner, clock = Date.now } = {}) {
  if (typeof store?.read !== 'function' || typeof store?.transaction !== 'function') throw new TypeError('Consent requires a durable read/transaction store');
  if (authorizeOwner !== undefined && typeof authorizeOwner !== 'function') throw new TypeError('authorizeOwner must be a function');
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');

  async function grant(principal, input) {
    const owner = subject(principal);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ConsentError('invalid_consent', 'Expected explicit connection consent', 400);
    const allowedFields = new Set(['id', 'applicationId', 'queries', 'commands', 'events', 'readEvents', 'expiresAt']);
    if (Object.keys(input).some(key => !allowedFields.has(key))) throw new ConsentError('invalid_consent', 'Unknown connection consent field', 400);
    const applicationId = identifier(input.applicationId, 'application ID');
    const id = connectionId(owner, applicationId);
    if (input.id !== undefined && input.id !== id) throw new ConsentError('invalid_consent', 'Connection ID does not match this account and application', 400);
    const queries = names(input.queries ?? [], 'Queries');
    const commands = names(input.commands ?? [], 'Commands');
    const events = names(input.events ?? [], 'Events');
    const readEvents = input.readEvents ?? false;
    if (typeof readEvents !== 'boolean' || (readEvents && events.length === 0)) throw new ConsentError('invalid_consent', 'Event details require an explicit selection of event types', 400);
    if (!queries.length && !commands.length && !events.length) throw new ConsentError('invalid_consent', 'Select at least one query, command or event', 400);
    const now = clock();
    const expiresAt = input.expiresAt === undefined ? now + 30 * DAY : input.expiresAt;
    if (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + 365 * DAY)) throw new ConsentError('invalid_consent', 'Connection expiry must be within one year or explicitly null', 400);
    const snapshot = await store.read();
    const expectedVersion = snapshot.chatgptConnections?.[id]?.version ?? 0;
    // Only the deployment's account/page authorization lookup can establish
    // ownership. OAuth scopes, publisher flags or model arguments cannot do so.
    if (!authorizeOwner || await authorizeOwner(principal, applicationId) !== true) throw new ConsentError('owner_authorization_required', 'The authenticated account must own this application before granting bridge consent');
    const approvedAt = clock();
    if (expiresAt !== null && expiresAt <= approvedAt) throw new ConsentError('invalid_consent', 'Connection consent expired while ownership was being verified', 400);
    return store.transaction(state => {
      state.chatgptConnections ??= {};
      const prior = state.chatgptConnections[id];
      if ((prior?.version ?? 0) !== expectedVersion) throw new ConsentError('connection_changed', 'Connection changed while ownership was being verified; review the current permissions before retrying', 409);
      const connection = {
        id, owner, principalId: principal.id, issuer: principal.issuer ?? null,
        applicationId, queries, commands, events, readEvents, expiresAt,
        createdAt: prior?.createdAt ?? approvedAt, updatedAt: approvedAt, revokedAt: null,
        version: (prior?.version ?? 0) + 1,
      };
      state.chatgptConnections[id] = connection;
      return publicConnection(connection, approvedAt);
    });
  }

  async function revoke(principal, { id } = {}) {
    const owner = subject(principal);
    identifier(id, 'connection ID');
    const now = clock();
    return store.transaction(state => {
      const connection = Object.hasOwn(state.chatgptConnections ?? {}, id) ? state.chatgptConnections[id] : undefined;
      if (!connection || connection.owner !== owner) throw new ConsentError('connection_not_found', 'Connection was not found for this account', 404);
      if (connection.revokedAt === null) {
        connection.revokedAt = now;
        connection.updatedAt = now;
        connection.version++;
      }
      return publicConnection(connection, now);
    });
  }

  async function list(principal) {
    const owner = subject(principal);
    const state = await store.read();
    return Object.values(state.chatgptConnections ?? {}).filter(connection => connection.owner === owner)
      .map(connection => publicConnection(connection, clock())).sort((a, b) => a.applicationId.localeCompare(b.applicationId));
  }

  async function assertAccess(principal, { applicationId, kind, name } = {}) {
    const owner = subject(principal);
    identifier(applicationId, 'application ID');
    if (!KINDS.has(kind)) throw new ConsentError('invalid_consent', 'Unknown connection permission kind', 400);
    if (kind !== 'read' && (typeof name !== 'string' || !NAME.test(name))) throw new ConsentError('invalid_consent', 'An exact declared operation or event name is required', 400);
    const state = await store.read();
    const connection = state.chatgptConnections?.[connectionId(owner, applicationId)];
    if (!connection || connection.owner !== owner || connection.revokedAt !== null || (connection.expiresAt !== null && connection.expiresAt <= clock())) throw new ConsentError('connection_consent_required', 'No active connection consent exists for this account and application');
    const allowed = kind === 'read'
      || kind === 'query' && connection.queries.includes(name)
      || kind === 'command' && connection.commands.includes(name)
      || kind === 'event' && connection.events.includes(name)
      || kind === 'event-details' && connection.readEvents && connection.events.includes(name);
    if (!allowed) throw new ConsentError('connection_permission_denied', 'This connection does not permit the requested operation or event');
    return publicConnection(connection, clock());
  }

  async function renderConnectionsHtml(principal, options = {}) {
    return renderManagement(await list(principal), options);
  }

  return Object.freeze({ grant, revoke, list, assertAccess, renderConnectionsHtml });
}

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

function catalogEntries(applications) {
  if (!Array.isArray(applications) || applications.length > 50) throw new ConsentError('invalid_catalog', 'Management requires a bounded authorized application catalog', 500);
  const seen = new Set();
  return applications.map(app => {
    const applicationId = identifier(app.applicationId, 'application ID');
    if (seen.has(applicationId)) throw new ConsentError('invalid_catalog', 'Duplicate application in management catalog', 500);
    seen.add(applicationId);
    return {
      applicationId, label: typeof app.label === 'string' ? app.label.slice(0,200) : applicationId,
      queries: names(app.queries ?? [], 'Queries'), commands: names(app.commands ?? [], 'Commands'),
      events: names(app.events ?? [], 'Events'), allowEventDetails: app.allowEventDetails === true,
    };
  });
}

function renderManagement(connections, { csrfToken, action = '/connections', applications = [] } = {}) {
  if (!action.startsWith('/') || action.startsWith('//') || /[\\?#]/.test(action)) throw new TypeError('Management action must be a local path');
  const catalog = catalogEntries(applications);
  const enabled = typeof csrfToken === 'string' && csrfToken.length > 0;
  const hidden = (name, value) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
  const field = (name, values) => values.length ? `<fieldset><legend>${escapeHtml(name)}</legend>${values.map(value => `<label><input type="checkbox" name="${name}" value="${escapeHtml(value)}"> ${escapeHtml(value)}</label>`).join('')}</fieldset>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Tendriller connections</title><style>body{font:16px system-ui;max-width:55rem;margin:2rem auto;padding:0 1rem;color:#172a23;background:#f5f8f5}section,article{border:1px solid #cedbd2;background:white;border-radius:12px;padding:1rem;margin:1rem 0}h1,h2{line-height:1.2}label{display:block;margin:.5rem 0}button{font:inherit;background:#245b42;color:white;border:0;border-radius:6px;padding:.65rem 1rem;cursor:pointer}fieldset{border:1px solid #cedbd2;margin:1rem 0}code{overflow-wrap:anywhere}dt{font-weight:600;margin-top:.6rem}dd{margin:.2rem 0;overflow-wrap:anywhere}.status{font-weight:600}p{line-height:1.5}</style></head><body><h1>Connect ChatGPT</h1><p>Choose the exact application data and commands this connection may use. A separately enrolled Chronolog bridge must also have permission. Event details can expose selected application content outside the peer group. Publication and device enrollment require their own authorization.</p><h2>Your connections</h2>${connections.length ? connections.map(connection => `<article><h3>${escapeHtml(connection.applicationId)}</h3><p class="status">${escapeHtml(connection.status)}</p><dl><dt>Queries</dt><dd>${escapeHtml(connection.queries.join(', ') || 'None')}</dd><dt>Commands</dt><dd>${escapeHtml(connection.commands.join(', ') || 'None')}</dd><dt>Events sent</dt><dd>${escapeHtml(connection.events.join(', ') || 'None')}</dd><dt>Detailed event content</dt><dd>${connection.readEvents ? 'Allowed for selected event types' : 'Not allowed'}</dd><dt>Expires</dt><dd>${connection.expiresAt === null ? 'No expiration' : escapeHtml(new Date(connection.expiresAt).toISOString())}</dd></dl>${enabled && connection.status === 'active' ? `<form method="post" action="${escapeHtml(action)}">${hidden('csrf', csrfToken)}${hidden('action', 'revoke')}${hidden('id', connection.id)}<button type="submit">Disconnect</button></form>` : ''}</article>`).join('') : '<p>No applications are connected.</p>'}${enabled ? `<h2>Grant or replace consent</h2><p>Saving replaces this account’s existing selections for the application. Nothing is selected automatically.</p>${catalog.map(app => `<section><h3>${escapeHtml(app.label)}</h3><p><code>${escapeHtml(app.applicationId)}</code></p><form method="post" action="${escapeHtml(action)}">${hidden('csrf', csrfToken)}${hidden('action', 'grant')}${hidden('applicationId', app.applicationId)}${field('queries', app.queries)}${field('commands', app.commands)}${field('events', app.events)}${app.allowEventDetails && app.events.length ? '<label><input type="checkbox" name="readEvents" value="yes"> Allow fetching detailed content for selected event types</label>' : ''}<label>Consent duration <select name="days"><option value="1">1 day</option><option value="7">7 days</option><option value="30" selected>30 days</option><option value="90">90 days</option></select></label><button type="submit">Save these permissions</button></form></section>`).join('')}` : '<p>Connection changes require the authenticated management endpoint.</p>'}</body></html>`;
}

async function formBody(request) {
  if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded') throw new ConsentError('invalid_request', 'Expected an HTML form submission', 415);
  const reader = request.body?.getReader();
  if (!reader) throw new ConsentError('invalid_request', 'Missing form body', 400);
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16_384) throw new ConsentError('invalid_request', 'Form submission is too large', 413);
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  const multiple = new Set(['queries', 'commands', 'events']);
  const allowed = new Set(['csrf', 'action', 'id', 'applicationId', 'queries', 'commands', 'events', 'readEvents', 'days']);
  for (const key of params.keys()) if (!allowed.has(key) || !multiple.has(key) && params.getAll(key).length !== 1) throw new ConsentError('invalid_request', 'Unknown or repeated form field', 400);
  return params;
}

/** Optional browser management surface. authenticate must verify the deployed
 * account session; applicationsForPrincipal must derive its list server-side. */
export function createConsentManagementHandler({ service, authenticate, origin, csrfKey, applicationsForPrincipal, clock = Date.now, path = '/connections' } = {}) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) throw new TypeError('Management origin must be an exact HTTPS origin');
  if (typeof authenticate !== 'function' || typeof applicationsForPrincipal !== 'function' || typeof service?.grant !== 'function') throw new TypeError('Management requires authenticated account and authorized application adapters');
  const key = Buffer.from(csrfKey ?? []);
  if (key.length < 32) throw new TypeError('Management CSRF key requires at least 32 random bytes');
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[\\?#]/.test(path)) throw new TypeError('Management path must be local');
  const signature = value => createHmac('sha256', key).update(value).digest('base64url');
  const csrf = principal => {
    const body = Buffer.from(JSON.stringify({ owner: subject(principal), expiresAt: clock() + 300_000, nonce: randomBytes(24).toString('base64url'), origin, path })).toString('base64url');
    return `${body}.${signature(body)}`;
  };
  function checkCsrf(value, principal) {
    if (typeof value !== 'string' || value.length > 4096) return false;
    const parts = value.split('.');
    if (parts.length !== 2) return false;
    const expected = Buffer.from(signature(parts[0]));
    const actual = Buffer.from(parts[1]);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
    try {
      const body = JSON.parse(Buffer.from(parts[0], 'base64url'));
      return body.owner === subject(principal) && body.origin === origin && body.path === path && body.expiresAt > clock() && body.expiresAt <= clock() + 300_000;
    } catch { return false; }
  }
  const responseHeaders = {
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  };
  return async request => {
    try {
      const requestUrl = new URL(request.url);
      if (requestUrl.origin !== origin || requestUrl.pathname !== path) return new Response('Not found', { status: 404, headers: responseHeaders });
      if (!['GET', 'POST'].includes(request.method)) return new Response('Method not allowed', { status: 405, headers: { ...responseHeaders, allow: 'GET, POST' } });
      const principal = await authenticate(request);
      subject(principal);
      if (request.method === 'GET') {
        const applications = catalogEntries(await applicationsForPrincipal(principal));
        const html = await service.renderConnectionsHtml(principal, { csrfToken: csrf(principal), action: path, applications });
        return new Response(html, { headers: { ...responseHeaders, 'content-type': 'text/html; charset=utf-8' } });
      }
      if (request.headers.get('origin') !== origin) throw new ConsentError('csrf_rejected', 'A same-origin management submission is required');
      const form = await formBody(request);
      if (!checkCsrf(form.get('csrf'), principal)) throw new ConsentError('csrf_rejected', 'The management form expired or belongs to another account');
      if (form.get('action') === 'revoke') {
        await service.revoke(principal, { id: form.get('id') });
      } else if (form.get('action') === 'grant') {
        const applications = catalogEntries(await applicationsForPrincipal(principal));
        const app = applications.find(item => item.applicationId === form.get('applicationId'));
        if (!app) throw new ConsentError('application_not_found', 'This account cannot connect that application', 404);
        const selection = Object.fromEntries(['queries', 'commands', 'events'].map(name => [name, names(form.getAll(name), name)]));
        for (const name of Object.keys(selection)) if (selection[name].some(value => !app[name].includes(value))) throw new ConsentError('connection_permission_denied', 'The requested permission is not available for this application');
        const readEvents = form.get('readEvents') === 'yes';
        if (form.has('readEvents') && form.get('readEvents') !== 'yes' || readEvents && !app.allowEventDetails) throw new ConsentError('connection_permission_denied', 'Detailed event content is not available for this application');
        const days = Number(form.get('days'));
        if (![1,7,30,90].includes(days)) throw new ConsentError('invalid_request', 'Choose a supported consent duration', 400);
        await service.grant(principal, { applicationId: app.applicationId, ...selection, readEvents, expiresAt: clock() + days * DAY });
      } else throw new ConsentError('invalid_request', 'Choose a connection management action', 400);
      return new Response(null, { status: 303, headers: { ...responseHeaders, location: path } });
    } catch (error) {
      const known = error instanceof ConsentError || ['OAuthError'].includes(error.name);
      return Response.json({ error: known ? error.code : 'management_unavailable', message: known ? error.message : 'Connection management is unavailable' }, {
        status: known ? error.status : 503,
        headers: { ...responseHeaders, ...(known && error.challenge ? { 'www-authenticate': error.challenge } : {}) },
      });
    }
  };
}
