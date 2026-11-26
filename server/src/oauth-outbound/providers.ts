/**
 * Declarative outbound OAuth 2.1 provider registry, typed action templates,
 * and SSRF host validation for Issue #136 (Tier A agent-held & Tier B host-brokered).
 */
import type { Env } from '../env';
import { HttpError } from '../http';
import { unsealHostConfigSecret } from './crypto';

export type OutboundTier = 'agent-held' | 'host-brokered';
export type OutboundCustody = 'personal' | 'page';
export type ProviderCategory = 'work-dev' | 'productivity-cloud' | 'personal-media' | 'custom';

export interface ProviderActionTemplate {
  readonly id: string;
  readonly description: string;
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Full HTTPS URL template with `{param}` placeholders substituted safely via encodeURIComponent. */
  readonly url: string;
  /** Required OAuth scopes (advisory/enforcement metadata). */
  readonly scopes: readonly string[];
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

export interface OutboundProviderSpec {
  readonly id: string;
  readonly name: string;
  readonly category: ProviderCategory;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly revokeUrl?: string;
  readonly pkce: boolean;
  readonly supportsAgentHeld: boolean;
  readonly supportsHostBrokered: boolean;
  readonly allowedApiHosts: readonly string[];
  readonly defaultScopes: readonly string[];
  readonly extraAuthParams?: Readonly<Record<string, string>>;
  readonly tokenAcceptJson?: boolean;
  /** How confidential client credentials are sent on token exchange/refresh (`body` default, `basic` for Notion/Airtable/Fitbit/Figma). */
  readonly tokenAuthMethod?: 'body' | 'basic';
  /** Request body encoding on token exchange/refresh (`form` default, `json` for Notion). */
  readonly tokenContentType?: 'form' | 'json';
  /** Scope list delimiter on the authorize URL (` ` default, `,` for Strava). */
  readonly scopeDelimiter?: ' ' | ',';
  /** Optional profile lookup URL for external_subject / external_label display. */
  readonly profileUrl?: string;
  readonly actions: readonly ProviderActionTemplate[];
}

export interface CustomProviderRecord {
  id: string;
  account_id: string;
  slug: string;
  name: string;
  authorize_url: string;
  token_url: string;
  revoke_url: string | null;
  client_id: string;
  client_secret: string | null;
  default_scopes: string;
  allowed_hosts: string;
  pkce: number;
  created_at: number;
}

export interface ResolvedProvider {
  spec: OutboundProviderSpec;
  clientId: string;
  clientSecret: string | null;
  isCustom: boolean;
  /** True when built-in `github`/`google` fell back to the login OAuth app (`GITHUB_CLIENT_ID`/`GOOGLE_CLIENT_ID`), reusing `/auth/callback/:provider`. */
  usesLoginClient?: boolean;
}

export const BUILTIN_PROVIDERS: readonly OutboundProviderSpec[] = Object.freeze<OutboundProviderSpec[]>([
  // ── Work & Dev ─────────────────────────────────────────────────────────────
  {
    id: 'github',
    name: 'GitHub',
    category: 'work-dev',
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    pkce: true,
    supportsAgentHeld: true,
    supportsHostBrokered: true,
    allowedApiHosts: ['api.github.com'],
    defaultScopes: ['read:user', 'repo'],
    tokenAcceptJson: true,
    profileUrl: 'https://api.github.com/user',
    actions: [
      { id: 'github.repos:list', description: 'List accessible repositories', method: 'GET', url: 'https://api.github.com/user/repos', scopes: ['repo'] },
      { id: 'github.issues:list', description: 'List issues in a repository', method: 'GET', url: 'https://api.github.com/repos/{owner}/{repo}/issues', scopes: ['repo'] },
      { id: 'github.issues:create', description: 'Create an issue in a repository', method: 'POST', url: 'https://api.github.com/repos/{owner}/{repo}/issues', scopes: ['repo'] },
      { id: 'github.pulls:list', description: 'List pull requests in a repository', method: 'GET', url: 'https://api.github.com/repos/{owner}/{repo}/pulls', scopes: ['repo'] },
      { id: 'github.gists:list', description: 'List gists', method: 'GET', url: 'https://api.github.com/gists', scopes: ['gist'] },
      { id: 'github.actions:runs', description: 'List workflow runs', method: 'GET', url: 'https://api.github.com/repos/{owner}/{repo}/actions/runs', scopes: ['repo'] },
    ],
  },
  {
    id: 'linear',
    name: 'Linear',
    category: 'work-dev',
    authorizeUrl: 'https://linear.app/oauth/authorize',
    tokenUrl: 'https://api.linear.app/oauth/token',
    revokeUrl: 'https://api.linear.app/oauth/revoke',
    pkce: true,
    supportsAgentHeld: true,
    supportsHostBrokered: true,
    allowedApiHosts: ['api.linear.app'],
    defaultScopes: ['read', 'write'],
    actions: [
      { id: 'linear.graphql:query', description: 'Run a Linear GraphQL query/mutation', method: 'POST', url: 'https://api.linear.app/graphql', scopes: ['read'] },
    ],
  },
  {
    id: 'notion',
    name: 'Notion',
    category: 'work-dev',
    authorizeUrl: 'https://api.notion.com/v1/oauth/authorize',
    tokenUrl: 'https://api.notion.com/v1/oauth/token',
    pkce: false,
    supportsAgentHeld: true,
    supportsHostBrokered: true,
    allowedApiHosts: ['api.notion.com'],
    defaultScopes: [],
    extraAuthParams: { owner: 'user' },
    tokenAuthMethod: 'basic',
    tokenContentType: 'json',
    actions: [
      { id: 'notion.search', description: 'Search Notion pages and databases', method: 'POST', url: 'https://api.notion.com/v1/search', scopes: [], extraHeaders: { 'Notion-Version': '2022-06-28' } },
      { id: 'notion.pages:get', description: 'Read a Notion page', method: 'GET', url: 'https://api.notion.com/v1/pages/{page_id}', scopes: [], extraHeaders: { 'Notion-Version': '2022-06-28' } },
      { id: 'notion.databases:query', description: 'Query a Notion database', method: 'POST', url: 'https://api.notion.com/v1/databases/{database_id}/query', scopes: [], extraHeaders: { 'Notion-Version': '2022-06-28' } },
    ],
  },
  {
    id: 'slack',
    name: 'Slack',
    category: 'work-dev',
    authorizeUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    revokeUrl: 'https://slack.com/api/auth.revoke',
    pkce: false,
    supportsAgentHeld: true,
    supportsHostBrokered: true,
    allowedApiHosts: ['slack.com'],
    defaultScopes: ['channels:read', 'chat:write'],
    actions: [
      { id: 'slack.channels:list', description: 'List Slack channels', method: 'GET', url: 'https://slack.com/api/conversations.list', scopes: ['channels:read'] },
      { id: 'slack.messages:history', description: 'Read messages in a Slack channel', method: 'GET', url: 'https://slack.com/api/conversations.history', scopes: ['channels:history'] },
      { id: 'slack.messages:post', description: 'Post a message to a Slack channel', method: 'POST', url: 'https://slack.com/api/chat.postMessage', scopes: ['chat:write'] },
    ],
  },
  {
    id: 'figma',
    name: 'Figma',
    category: 'work-dev',
    authorizeUrl: 'https://www.figma.com/oauth',
    tokenUrl: 'https://api.figma.com/v1/oauth/token',
    pkce: true,
    supportsAgentHeld: true,
    supportsHostBrokered: true,
    allowedApiHosts: ['api.figma.com'],
    defaultScopes: ['files:read'],
    tokenAuthMethod: 'basic',
    actions: [
      { id: 'figma.files:get', description: 'Read a Figma file', method: 'GET', url: 'https://api.figma.com/v1/files/{file_key}', scopes: ['files:read'] },
      { id: 'figma.comments:list', description: 'List comments on a Figma file', method: 'GET', url: 'https://api.figma.com/v1/files/{file_key}/comments', scopes: ['files:read'] },
    ],
  },
  {
    id: 'airtable',
    name: 'Airtable',
    category: 'work-dev',
    authorizeUrl: 'https://airtable.com/oauth2/v1/authorize',
    tokenUrl: 'https://airtable.com/oauth2/v1/token',
    pkce: true,
    supportsAgentHeld: true,
    supportsHostBrokered: true,
    allowedApiHosts: ['api.airtable.com'],
    defaultScopes: ['data.records:read', 'schema.bases:read'],
    tokenAuthMethod: 'basic',
    actions: [
      { id: 'airtable.bases:list', description: 'List Airtable bases', method: 'GET', url: 'https://api.airtable.com/v0/meta/bases', scopes: ['schema.bases:read'] },
      { id: 'airtable.records:list', description: 'List records in a table', method: 'GET', url: 'https://api.airtable.com/v0/{base_id}/{table}', scopes: ['data.records:read'] },
      { id: 'airtable.records:create', description: 'Create records in a table', method: 'POST', url: 'https://api.airtable.com/v0/{base_id}/{table}', scopes: ['data.records:write'] },
    ],
  },
  {
    id: 'discord',
    name: 'Discord',
    category: 'work-dev',
    authorizeUrl: 'https://discord.com/oauth2/authorize',
    tokenUrl: 'https://discord.com/api/oauth2/token',
    revokeUrl: 'https://discord.com/api/oauth2/token/revoke',
    pkce: true,
    supportsAgentHeld: true,
    supportsHostBrokered: true,
    allowedApiHosts: ['discord.com'],
    defaultScopes: ['identify', 'guilds'],
    profileUrl: 'https://discord.com/api/users/@me',
    actions: [
      { id: 'discord.guilds:list', description: 'List Discord servers', method: 'GET', url: 'https://discord.com/api/v10/users/@me/guilds', scopes: ['guilds'] },
      { id: 'discord.messages:post', description: 'Post a message to a Discord channel', method: 'POST', url: 'https://discord.com/api/v10/channels/{channel_id}/messages', scopes: ['messages.write'] },
    ],
  },

  // ── Productivity & Cloud ───────────────────────────────────────────────────
  {
    id: 'google',
    name: 'Google',
    category: 'productivity-cloud',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    revokeUrl: 'https://oauth2.googleapis.com/revoke',
    pkce: true,
    supportsAgentHeld: true,
    supportsHostBrokered: true,
    allowedApiHosts: [
      'www.googleapis.com',
      'gmail.googleapis.com',
      'tasks.googleapis.com',
      'docs.googleapis.com',
      'sheets.googleapis.com',
      'people.googleapis.com',
      'youtube.googleapis.com',
    ],
    defaultScopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    extraAuthParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
    profileUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    actions: [
      { id: 'google.calendar.events:list', description: 'List Google Calendar events', method: 'GET', url: 'https://www.googleapis.com/calendar/v3/calendars/{calendar_id}/events', scopes: ['https://www.googleapis.com/auth/calendar.readonly'] },
      { id: 'google.calendar.events:create', description: 'Create a Google Calendar event', method: 'POST', url: 'https://www.googleapis.com/calendar/v3/calendars/{calendar_id}/events', scopes: ['https://www.googleapis.com/auth/calendar.events'] },
      { id: 'google.tasks:list', description: 'List Google Tasks', method: 'GET', url: 'https://tasks.googleapis.com/tasks/v1/lists/{tasklist_id}/tasks', scopes: ['https://www.googleapis.com/auth/tasks.readonly'] },
      { id: 'google.tasks:create', description: 'Create a Google Task', method: 'POST', url: 'https://tasks.googleapis.com/tasks/v1/lists/{tasklist_id}/tasks', scopes: ['https://www.googleapis.com/auth/tasks'] },
      { id: 'google.gmail.messages:list', description: 'List Gmail messages', method: 'GET', url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages', scopes: ['https://www.googleapis.com/auth/gmail.readonly'] },
      { id: 'google.drive.files:list', description: 'List Google Drive files', method: 'GET', url: 'https://www.googleapis.com/drive/v3/files', scopes: ['https://www.googleapis.com/auth/drive.readonly'] },
      { id: 'google.sheets.values:get', description: 'Read a Google Sheets range', method: 'GET', url: 'https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{range}', scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] },
    ],
  },
  {
    id: 'microsoft',
    name: 'Microsoft 365',
    category: 'productivity-cloud',
    authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    pkce: true,
    supportsAgentHeld: true,
    supportsHostBrokered: true,
    allowedApiHosts: ['graph.microsoft.com'],
    defaultScopes: ['offline_access', 'User.Read', 'Calendars.Read'],
    profileUrl: 'https://graph.microsoft.com/v1.0/me',
    actions: [
      { id: 'microsoft.calendar.events:list', description: 'List Outlook Calendar events', method: 'GET', url: 'https://graph.microsoft.com/v1.0/me/events', scopes: ['Calendars.Read'] },
      { id: 'microsoft.mail.messages:list', description: 'List Outlook messages', method: 'GET', url: 'https://graph.microsoft.com/v1.0/me/messages', scopes: ['Mail.Read'] },
      { id: 'microsoft.onedrive.items:list', description: 'List OneDrive root items', method: 'GET', url: 'https://graph.microsoft.com/v1.0/me/drive/root/children', scopes: ['Files.Read'] },
      { id: 'microsoft.todo.lists:list', description: 'List Microsoft To Do lists', method: 'GET', url: 'https://graph.microsoft.com/v1.0/me/todo/lists', scopes: ['Tasks.Read'] },
    ],
  },
  {
    id: 'dropbox',
    name: 'Dropbox',
    category: 'productivity-cloud',
    authorizeUrl: 'https://www.dropbox.com/oauth2/authorize',
    tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
    revokeUrl: 'https://api.dropboxapi.com/2/auth/token/revoke',
    pkce: true,
    supportsAgentHeld: true,
    supportsHostBrokered: true,
    allowedApiHosts: ['api.dropboxapi.com', 'content.dropboxapi.com'],
    defaultScopes: ['files.metadata.read'],
    extraAuthParams: { token_access_type: 'offline' },
    actions: [
      { id: 'dropbox.files:list', description: 'List Dropbox folder contents', method: 'POST', url: 'https://api.dropboxapi.com/2/files/list_folder', scopes: ['files.metadata.read'] },
    ],
  },
  {
    id: 'todoist',
    name: 'Todoist',
    category: 'productivity-cloud',
    authorizeUrl: 'https://todoist.com/oauth/authorize',
    tokenUrl: 'https://todoist.com/oauth/access_token',
    pkce: false,
    supportsAgentHeld: true,
    supportsHostBrokered: true,
    allowedApiHosts: ['api.todoist.com'],
    defaultScopes: ['data:read_write'],
    actions: [
      { id: 'todoist.tasks:list', description: 'List active Todoist tasks', method: 'GET', url: 'https://api.todoist.com/rest/v2/tasks', scopes: ['data:read'] },
      { id: 'todoist.tasks:create', description: 'Create a Todoist task', method: 'POST', url: 'https://api.todoist.com/rest/v2/tasks', scopes: ['data:read_write'] },
      { id: 'todoist.projects:list', description: 'List Todoist projects', method: 'GET', url: 'https://api.todoist.com/rest/v2/projects', scopes: ['data:read'] },
    ],
  },

  // ── Personal, Health & Media ───────────────────────────────────────────────
  {
    id: 'spotify',
    name: 'Spotify',
    category: 'personal-media',
    authorizeUrl: 'https://accounts.spotify.com/authorize',
    tokenUrl: 'https://accounts.spotify.com/api/token',
    pkce: true,
    supportsAgentHeld: true,
    supportsHostBrokered: true,
    allowedApiHosts: ['api.spotify.com'],
    defaultScopes: ['user-read-playback-state', 'playlist-read-private'],
    profileUrl: 'https://api.spotify.com/v1/me',
    actions: [
      { id: 'spotify.playback:read', description: 'Read current Spotify playback state', method: 'GET', url: 'https://api.spotify.com/v1/me/player', scopes: ['user-read-playback-state'] },
      { id: 'spotify.playlists:list', description: 'List user Spotify playlists', method: 'GET', url: 'https://api.spotify.com/v1/me/playlists', scopes: ['playlist-read-private'] },
    ],
  },
  {
    id: 'strava',
    name: 'Strava',
    category: 'personal-media',
    authorizeUrl: 'https://www.strava.com/oauth/authorize',
    tokenUrl: 'https://www.strava.com/oauth/token',
    revokeUrl: 'https://www.strava.com/oauth/deauthorize',
    pkce: false,
    supportsAgentHeld: true,
    supportsHostBrokered: true,
    allowedApiHosts: ['www.strava.com'],
    defaultScopes: ['activity:read_all'],
    scopeDelimiter: ',',
    actions: [
      { id: 'strava.activities:list', description: 'List Strava athlete activities', method: 'GET', url: 'https://www.strava.com/api/v3/athlete/activities', scopes: ['activity:read_all'] },
    ],
  },
  {
    id: 'fitbit',
    name: 'Fitbit',
    category: 'personal-media',
    authorizeUrl: 'https://www.fitbit.com/oauth2/authorize',
    tokenUrl: 'https://api.fitbit.com/oauth2/token',
    revokeUrl: 'https://api.fitbit.com/oauth2/revoke',
    pkce: true,
    supportsAgentHeld: true,
    supportsHostBrokered: true,
    allowedApiHosts: ['api.fitbit.com'],
    defaultScopes: ['activity', 'sleep', 'heartrate'],
    tokenAuthMethod: 'basic',
    actions: [
      { id: 'fitbit.activity:read', description: 'Read daily Fitbit activity summary', method: 'GET', url: 'https://api.fitbit.com/1/user/-/activities/date/{date}.json', scopes: ['activity'] },
      { id: 'fitbit.sleep:read', description: 'Read Fitbit sleep logs for a date', method: 'GET', url: 'https://api.fitbit.com/1.2/user/-/sleep/date/{date}.json', scopes: ['sleep'] },
    ],
  },
  {
    id: 'oura',
    name: 'Oura',
    category: 'personal-media',
    authorizeUrl: 'https://cloud.ouraring.com/oauth/authorize',
    tokenUrl: 'https://api.ouraring.com/oauth/token',
    revokeUrl: 'https://api.ouraring.com/oauth/revoke',
    pkce: false,
    supportsAgentHeld: true,
    supportsHostBrokered: true,
    allowedApiHosts: ['api.ouraring.com'],
    defaultScopes: ['daily', 'sleep', 'workout'],
    actions: [
      { id: 'oura.readiness:read', description: 'Read daily Oura readiness scores', method: 'GET', url: 'https://api.ouraring.com/v2/usercollection/daily_readiness', scopes: ['daily'] },
      { id: 'oura.sleep:read', description: 'Read daily Oura sleep scores', method: 'GET', url: 'https://api.ouraring.com/v2/usercollection/daily_sleep', scopes: ['sleep'] },
    ],
  },
]);

const BUILTIN_MAP = new Map(BUILTIN_PROVIDERS.map(p => [p.id, p]));
export const CUSTOM_SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;
export const PROVIDER_ID_RE = /^(?:[a-z0-9][a-z0-9_-]{1,31}|custom:[a-z0-9][a-z0-9_-]{1,31})$/;

/** Reject non-HTTPS, credentials-in-URL, loopback, link-local, RFC1918, and metadata hosts. */
export function assertSafeExternalUrl(raw: string, label = 'URL'): URL {
  let parsed: URL;
  try { parsed = new URL(raw); }
  catch { throw new HttpError(400, 'invalid_url', `${label} must be a valid HTTPS URL`); }
  if (parsed.protocol !== 'https:') throw new HttpError(400, 'invalid_url', `${label} must use https://`);
  if (parsed.username || parsed.password) throw new HttpError(400, 'invalid_url', `${label} must not embed credentials`);
  assertSafeExternalHost(parsed.hostname, label);
  return parsed;
}

export function assertSafeExternalHost(hostname: string, label = 'host'): string {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host.length > 253 || !/^[a-z0-9.-]+$/.test(host) || !host.includes('.')) {
    throw new HttpError(400, 'invalid_host', `${label} must be a public DNS hostname`);
  }
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === 'metadata.google.internal' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^0\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host)
  ) {
    throw new HttpError(400, 'forbidden_host', `${label} cannot target private, local, or IP-literal hosts`);
  }
  return host;
}

type ConfiguredClientMap = Record<string, { client_id?: string; client_secret?: string }>;

function parseClientMap(env: Env): ConfiguredClientMap {
  const raw = (env as unknown as Record<string, string | undefined>).OUTBOUND_OAUTH_CLIENTS_JSON;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as ConfiguredClientMap : {};
  } catch {
    return {};
  }
}

export function builtinClientCredentials(env: Env, providerId: string): { clientId: string; clientSecret: string | null; usesLoginClient?: boolean } | null {
  const map = parseClientMap(env);
  const fromMap = map[providerId];
  if (fromMap && typeof fromMap.client_id === 'string' && fromMap.client_id.trim()) {
    return { clientId: fromMap.client_id.trim(), clientSecret: typeof fromMap.client_secret === 'string' && fromMap.client_secret ? fromMap.client_secret : null, usesLoginClient: false };
  }
  // Reuse host GitHub/Google OAuth credentials if outbound-specific ones aren't set separately.
  if (providerId === 'github' && env.GITHUB_CLIENT_ID) {
    return { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET ?? null, usesLoginClient: true };
  }
  if (providerId === 'google' && env.GOOGLE_CLIENT_ID) {
    return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET ?? null, usesLoginClient: true };
  }
  return null;
}

export function listBuiltinProviderViews(env: Env) {
  return BUILTIN_PROVIDERS.map(p => ({
    id: p.id,
    name: p.name,
    category: p.category,
    configured: builtinClientCredentials(env, p.id) !== null,
    pkce: p.pkce,
    supports_agent_held: p.supportsAgentHeld,
    supports_host_brokered: p.supportsHostBrokered,
    default_scopes: p.defaultScopes,
    allowed_api_hosts: p.allowedApiHosts,
    actions: p.actions.map(a => ({ id: a.id, description: a.description, method: a.method, scopes: a.scopes })),
  }));
}

export async function resolveProvider(env: Env, accountId: string, providerId: string): Promise<ResolvedProvider> {
  if (!PROVIDER_ID_RE.test(providerId)) {
    throw new HttpError(400, 'invalid_provider', 'Unknown or invalid OAuth provider id');
  }
  if (providerId.startsWith('custom:')) {
    const slug = providerId.slice('custom:'.length);
    const row = await env.ACCOUNTS.prepare('SELECT * FROM oauth_custom_providers WHERE account_id = ? AND slug = ?')
      .bind(accountId, slug).first<CustomProviderRecord>();
    if (!row) throw new HttpError(404, 'provider_not_found', `Custom provider "${slug}" is not registered on this account`);
    const allowedHosts = (JSON.parse(row.allowed_hosts) as string[]).map(h => assertSafeExternalHost(h, 'allowed_hosts'));
    const defaultScopes = JSON.parse(row.default_scopes) as string[];
    const spec: OutboundProviderSpec = {
      id: providerId,
      name: row.name,
      category: 'custom',
      authorizeUrl: row.authorize_url,
      tokenUrl: row.token_url,
      ...(row.revoke_url ? { revokeUrl: row.revoke_url } : {}),
      pkce: row.pkce === 1,
      supportsAgentHeld: true,
      supportsHostBrokered: true,
      allowedApiHosts: allowedHosts,
      defaultScopes,
      actions: [],
    };
    const clientSecret = row.client_secret
      ? await unsealHostConfigSecret(env, row.client_secret, `custom-provider:${accountId}:${slug}`)
      : null;
    return { spec, clientId: row.client_id, clientSecret, isCustom: true };
  }
  const spec = BUILTIN_MAP.get(providerId);
  if (!spec) throw new HttpError(404, 'provider_not_found', `Unsupported provider "${providerId}"`);
  const creds = builtinClientCredentials(env, providerId);
  if (!creds) throw new HttpError(503, 'provider_unconfigured', `${spec.name} outbound OAuth is not configured on this host. Register a custom BYO provider or configure OUTBOUND_OAUTH_CLIENTS_JSON.`);
  return { spec, clientId: creds.clientId, clientSecret: creds.clientSecret, isCustom: false, usesLoginClient: Boolean(creds.usesLoginClient) };
}

/**
 * Resolve an outbound invoke request against either a named provider action template
 * or an explicitly granted `http:request` constrained to the provider's `allowedApiHosts`.
 */
export function buildOutboundRequest(
  spec: OutboundProviderSpec,
  grantedActions: readonly string[],
  input: {
    action: string;
    params?: Record<string, string>;
    query?: Record<string, string>;
    body?: unknown;
    method?: string;
    url?: string;
    headers?: Record<string, string>;
  },
): { method: string; url: string; headers: Record<string, string>; body?: string } {
  if (!grantedActions.includes(input.action) && !grantedActions.includes('*')) {
    throw new HttpError(403, 'action_not_granted', `Action "${input.action}" is not granted for this connection`);
  }
  let method: string;
  let targetUrl: URL;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'Tendriller-OAuth-Broker/1.0',
  };

  if (input.action === 'http:request') {
    const reqMethod = String(input.method ?? 'GET').toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(reqMethod)) {
      throw new HttpError(400, 'invalid_method', 'Unsupported HTTP method');
    }
    if (typeof input.url !== 'string' || !input.url) {
      throw new HttpError(400, 'invalid_url', 'http:request requires a target https URL');
    }
    targetUrl = assertSafeExternalUrl(input.url, 'Target URL');
    if (!spec.allowedApiHosts.includes(targetUrl.hostname.toLowerCase())) {
      throw new HttpError(403, 'host_not_allowed', `Host "${targetUrl.hostname}" is not allowed for provider "${spec.id}"`);
    }
    method = reqMethod;
  } else {
    const template = spec.actions.find(a => a.id === input.action);
    if (!template) throw new HttpError(404, 'unknown_action', `Unknown action "${input.action}" for provider "${spec.id}"`);
    const substituted = template.url.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key: string) => {
      const value = input.params?.[key];
      if (typeof value !== 'string' || !value.trim() || value.includes('..') || value.includes('/') && key !== 'range') {
        throw new HttpError(400, 'missing_param', `Missing or invalid path parameter "${key}"`);
      }
      return encodeURIComponent(value);
    });
    targetUrl = assertSafeExternalUrl(substituted, 'Action URL');
    if (!spec.allowedApiHosts.includes(targetUrl.hostname.toLowerCase())) {
      throw new HttpError(403, 'host_not_allowed', 'Resolved action host is outside provider allowlist');
    }
    method = template.method;
    if (template.extraHeaders) Object.assign(headers, template.extraHeaders);
  }

  if (input.query && typeof input.query === 'object') {
    for (const [k, v] of Object.entries(input.query)) {
      if (typeof v === 'string') targetUrl.searchParams.set(k, v);
    }
  }
  // Allow only safe custom headers (never Authorization/Host/Cookie).
  const SAFE_HEADER = /^(accept|content-type|notion-version|x-github-api-version|if-none-match|if-modified-since)$/i;
  if (input.headers && typeof input.headers === 'object') {
    for (const [k, v] of Object.entries(input.headers)) {
      if (SAFE_HEADER.test(k) && typeof v === 'string' && !/[\r\n]/.test(v)) headers[k] = v;
    }
  }

  let body: string | undefined;
  if (input.body !== undefined && method !== 'GET') {
    body = typeof input.body === 'string' ? input.body : JSON.stringify(input.body);
    if (!Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }
  }
  return { method, url: targetUrl.toString(), headers, ...(body !== undefined ? { body } : {}) };
}
