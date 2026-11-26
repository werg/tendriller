/**
 * Validate `releases/entries/*.json` and compile:
 *   1. `server/src/release-changelog.json` (bundled into the Worker for zero-secret deploy-synced broadcasts & `/api/changelog`)
 *   2. `docs/CHANGELOG.md` (human- and agent-readable Markdown served at `/changelog.md`, `/docs/CHANGELOG.md`, and `tendril_guide(topic: "changelog")`)
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateBroadcastInput } from '../contract/broadcasts.mjs';

export const CHANGELOG_CATEGORIES = Object.freeze(['feature', 'deprecation', 'breaking', 'security']);
export const DEPLOY_BROADCAST_AUDIENCES = Object.freeze(['agents', 'mcp']);

const SLUG_RE = /^(\d{4}-\d{2}-\d{2})-[a-z0-9][a-z0-9-]{2,64}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
const DAY_MS = 86_400_000;

export const SUNSETTING_POLICY = Object.freeze({
  experimentalDays: '7-14',
  stableDays: 30,
  securityHours: '24-72 (or immediate if actively exploited)',
  deployBroadcastAudiences: [...DEPLOY_BROADCAST_AUDIENCES],
  humanNotices: 'Manual one-off operator broadcasts only (/admin or scripts/broadcast.mjs); automated release entries never target human UI banners.',
});

/** Deterministically derive a valid `bc_<26 base32>` broadcast ID from a release entry slug. */
export function releaseBroadcastId(slug) {
  const hash = createHash('sha256').update(`tendriller.release.broadcast.v1:${slug}`).digest();
  let bits = 0;
  let value = 0;
  let out = '';
  for (let i = 0; i < hash.length && out.length < 26; i++) {
    value = (value << 8) | hash[i];
    bits += 8;
    while (bits >= 5 && out.length < 26) {
      bits -= 5;
      out += B32[(value >>> bits) & 31];
    }
  }
  return `bc_${out}`;
}

function parseIsoDateMs(value, field) {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) {
    throw new Error(`${field} must be YYYY-MM-DD (got ${JSON.stringify(value)})`);
  }
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) throw new Error(`${field} is not a valid calendar date: ${value}`);
  return ms;
}

const CATEGORY_DEFAULTS = Object.freeze({
  feature: { kind: 'announcement', severity: 'info', expiresAfterDays: 30, dismissible: true },
  deprecation: { kind: 'deprecation', severity: 'recommended', expiresAfterDays: 44, dismissible: true },
  breaking: { kind: 'upgrade', severity: 'urgent', expiresAfterDays: 90, dismissible: true },
  security: { kind: 'security', severity: 'urgent', expiresAfterDays: 90, dismissible: false },
});

/** Load and strictly validate every entry under `releases/entries/*.json`. */
export function loadReleaseEntries(root) {
  const dir = join(root, 'releases/entries');
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter(name => name.endsWith('.json')).sort();
  const seenSlugs = new Set();
  const rawEntries = [];

  for (const file of files) {
    const full = join(dir, file);
    let raw;
    try {
      raw = JSON.parse(readFileSync(full, 'utf8'));
    } catch (error) {
      throw new Error(`Invalid JSON in releases/entries/${file}: ${error.message}`);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`releases/entries/${file} must contain a JSON object`);
    }
    const slug = raw.slug;
    if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
      throw new Error(`releases/entries/${file}: slug must match YYYY-MM-DD-kebab-slug`);
    }
    if (`${slug}.json` !== file) {
      throw new Error(`releases/entries/${file}: filename must match slug (${slug}.json)`);
    }
    if (seenSlugs.has(slug)) {
      throw new Error(`Duplicate release changelog slug: ${slug}`);
    }
    seenSlugs.add(slug);

    const slugDate = SLUG_RE.exec(slug)[1];
    const date = raw.date ?? slugDate;
    const dateMs = parseIsoDateMs(date, `${file}: date`);
    if (date !== slugDate) {
      throw new Error(`releases/entries/${file}: date (${date}) must match slug date prefix (${slugDate})`);
    }

    const category = raw.category;
    if (!CHANGELOG_CATEGORIES.includes(category)) {
      throw new Error(`releases/entries/${file}: category must be one of ${CHANGELOG_CATEGORIES.join(', ')}`);
    }
    if (typeof raw.core_version !== 'string' || !/^[A-Za-z0-9.+_-]{1,64}$/.test(raw.core_version.trim())) {
      throw new Error(`releases/entries/${file}: core_version is required (e.g. "0.3.0-rc.17")`);
    }
    if (typeof raw.title !== 'string' || !raw.title.trim()) {
      throw new Error(`releases/entries/${file}: title is required`);
    }
    if (typeof raw.summary !== 'string' || !raw.summary.trim()) {
      throw new Error(`releases/entries/${file}: summary is required`);
    }
    const body = typeof raw.body === 'string' ? raw.body.trim() : '';

    let sunsetAt = null;
    let sunsetMs = null;
    if (raw.sunset_at !== undefined && raw.sunset_at !== null) {
      sunsetMs = parseIsoDateMs(raw.sunset_at, `${file}: sunset_at`);
      if (sunsetMs <= dateMs) {
        throw new Error(`releases/entries/${file}: sunset_at (${raw.sunset_at}) must be after date (${date})`);
      }
      sunsetAt = raw.sunset_at;
    }
    if (category === 'deprecation' && !sunsetAt) {
      throw new Error(`releases/entries/${file}: deprecation entries MUST set sunset_at (YYYY-MM-DD)`);
    }

    let docsUrl = null;
    if (raw.docs_url !== undefined && raw.docs_url !== null && raw.docs_url !== '') {
      if (typeof raw.docs_url !== 'string' || (!raw.docs_url.startsWith('/') && !raw.docs_url.startsWith('https://'))) {
        throw new Error(`releases/entries/${file}: docs_url must start with "/" or "https://"`);
      }
      docsUrl = raw.docs_url;
    }

    const broadcastEnabled = Boolean(raw.broadcast);
    const defaults = CATEGORY_DEFAULTS[category];
    const supersedes = typeof raw.supersedes === 'string' && raw.supersedes.trim() ? raw.supersedes.trim() : null;

    let broadcastSpec = null;
    if (broadcastEnabled) {
      const audiences = Array.isArray(raw.audiences) && raw.audiences.length ? raw.audiences : [...DEPLOY_BROADCAST_AUDIENCES];
      for (const audience of audiences) {
        if (!DEPLOY_BROADCAST_AUDIENCES.includes(audience)) {
          throw new Error(
            `releases/entries/${file}: deploy-triggered broadcasts may only target ${DEPLOY_BROADCAST_AUDIENCES.join(', ')} (got "${audience}"). ` +
            'Human UI banners (dashboard/page_owners/page_all) must be published manually via /admin or scripts/broadcast.mjs.',
          );
        }
      }

      let expiresAt = null;
      if (raw.expires_at !== undefined && raw.expires_at !== null) {
        expiresAt = typeof raw.expires_at === 'number' ? raw.expires_at : parseIsoDateMs(raw.expires_at, `${file}: expires_at`);
      } else if (category === 'deprecation' && sunsetMs !== null) {
        expiresAt = sunsetMs + 14 * DAY_MS;
      } else {
        const days = raw.expires_after_days === undefined ? defaults.expiresAfterDays : raw.expires_after_days;
        if (days !== null) {
          if (!Number.isSafeInteger(days) || days < 1 || days > 365) {
            throw new Error(`releases/entries/${file}: expires_after_days must be an integer 1..365 or null`);
          }
          expiresAt = dateMs + days * DAY_MS;
        }
      }

      const candidate = {
        kind: raw.kind ?? defaults.kind,
        severity: raw.severity ?? defaults.severity,
        audiences,
        title: raw.title.trim(),
        summary: raw.summary.trim(),
        body,
        docs_url: docsUrl ? (docsUrl.startsWith('/') ? `https://tendriller.dev${docsUrl}` : docsUrl) : `https://tendriller.dev/changelog.md#${slug}`,
        action: raw.action ?? null,
        match: raw.match ?? null,
        dismissible: raw.dismissible === undefined ? defaults.dismissible : Boolean(raw.dismissible),
        expires_at: expiresAt,
        superseded_by: null,
      };
      // Strictly validate against the shared public broadcast contract.
      const validated = validateBroadcastInput(candidate);
      broadcastSpec = {
        id: releaseBroadcastId(slug),
        kind: validated.kind,
        severity: validated.severity,
        audiences: validated.audiences,
        title: validated.title,
        summary: validated.summary,
        body: validated.body,
        docs_path: docsUrl ?? `/changelog.md#${slug}`,
        action: validated.action,
        match: validated.match,
        dismissible: validated.dismissible,
        expires_at: validated.expires_at,
        supersedes_id: supersedes ? releaseBroadcastId(supersedes) : null,
      };
    }

    rawEntries.push({
      slug,
      date,
      category,
      core_version: raw.core_version.trim(),
      title: raw.title.trim(),
      summary: raw.summary.trim(),
      body,
      docs_path: docsUrl ?? `/changelog.md#${slug}`,
      sunset_at: sunsetAt,
      supersedes,
      broadcast: broadcastSpec,
    });
  }

  for (const entry of rawEntries) {
    if (entry.supersedes && !seenSlugs.has(entry.supersedes)) {
      throw new Error(`releases/entries/${entry.slug}.json: supersedes references unknown slug "${entry.supersedes}"`);
    }
  }

  // Sort newest-first (date desc, then slug desc for deterministic tie-breaking).
  rawEntries.sort((a, b) => b.date.localeCompare(a.date) || b.slug.localeCompare(a.slug));
  return rawEntries;
}

const CATEGORY_LABEL = Object.freeze({
  security: 'Security',
  breaking: 'Breaking',
  deprecation: 'Deprecation',
  feature: 'Feature',
});

/** Render `docs/CHANGELOG.md` deterministically from validated release entries. */
export function renderChangelogMarkdown(entries) {
  const lines = [
    '# Tendriller Changelog & Sunsetting Policy',
    '',
    '<!-- Generated from releases/entries/*.json by scripts/release-changelog.mjs. Do not edit manually. -->',
    '',
    'This changelog lists **notable changes** that matter to agents and app builders: major new capabilities (`feature`), API deprecations (`deprecation`), breaking upgrades (`breaking`), and security advisories requiring client action (`security`). Routine bugfixes and internal refactors are intentionally omitted.',
    '',
    '- Machine-readable JSON feed: [/api/changelog](https://tendriller.dev/api/changelog) (supports `?since=YYYY-MM-DD`, `?since_core=VERSION`, `?category=...`)',
    '- Signed live agent broadcasts: [/api/broadcasts](https://tendriller.dev/api/broadcasts) (`tendril broadcasts` / MCP `get_broadcasts`)',
    '',
    '## Sunsetting policy',
    '',
    'Tendriller uses short, predictable sunsetting windows instead of accumulating permanent legacy compatibility layers:',
    '',
    '- **Experimental / preview APIs:** **7–14 days** notice (`deprecation` entry + signed agent broadcast with `sunset_at`), then removed.',
    '- **Stable public SDK, host & tutorial APIs:** **30 days** notice (`deprecation` entry + signed agent broadcast with `sunset_at`, migration guidance, and version-matched targeting), then removed cleanly with a `breaking` entry that supersedes the deprecation.',
    '- **Security fixes requiring client action:** Immediate `security` broadcast (`urgent` or `critical`) alongside a patched release; vulnerable legacy paths are disabled after **24–72 hours** (or immediately if actively exploited).',
    '- **Zero noise for humans:** Deploy-driven broadcasts only target `agents` and `mcp`. Human dashboard/page banners are reserved for manual one-off operator notices (maintenance windows, active incidents, or critical agentless-page interventions).',
    '',
    '## Returning to a fallow workspace',
    '',
    'If you open an app workspace that has not been touched recently (or whose installed `@tendriller/core` lags the host):',
    '',
    '1. Run `tendril status` — it checks `versions.core` and your last broadcast sync timestamp and surfaces a `catchup` advisory when stale.',
    '2. Run `tendril changelog --since YYYY-MM-DD` (or `tendril changelog --since-core VERSION`, or fetch `/changelog.md` / `tendril_guide(topic: "changelog")`).',
    '3. Address any `security`, `breaking`, or `deprecation` entries first (upgrading the pinned `firstApp.release` kit and republishing if required), then review new `feature` entries before building custom workarounds.',
    '',
    '## Entries',
    '',
  ];

  if (entries.length === 0) {
    lines.push('_No notable release entries recorded yet._', '');
  } else {
    for (const entry of entries) {
      lines.push(`<a id="${entry.slug}"></a>`, '');
      lines.push(`### ${entry.date} · [${CATEGORY_LABEL[entry.category]}] ${entry.title}`, '');
      const meta = [`Core \`${entry.core_version}\``, `Slug \`${entry.slug}\``];
      if (entry.sunset_at) meta.push(`**Sunset:** \`${entry.sunset_at}\``);
      if (entry.supersedes) meta.push(`Supersedes \`${entry.supersedes}\``);
      if (entry.broadcast) meta.push(`Agent broadcast \`${entry.broadcast.kind}/${entry.broadcast.severity}\``);
      else meta.push('Changelog only');
      lines.push(meta.join(' · '), '');
      lines.push(entry.summary, '');
      if (entry.body) lines.push(entry.body, '');
      if (entry.docs_path && !entry.docs_path.startsWith('/changelog.md#')) {
        const href = entry.docs_path.startsWith('/') ? `https://tendriller.dev${entry.docs_path}` : entry.docs_path;
        lines.push(`Reference: [${entry.docs_path}](${href})`, '');
      }
    }
  }

  return lines.join('\n');
}

/** Compile and write `server/src/release-changelog.json` and `docs/CHANGELOG.md`. */
export function buildReleaseChangelog(root) {
  const entries = loadReleaseEntries(root);
  const compiled = {
    schema_version: 1,
    sunsetting_policy: SUNSETTING_POLICY,
    entries,
  };
  const jsonPath = join(root, 'server/src/release-changelog.json');
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, JSON.stringify(compiled, null, 2) + '\n');

  const mdPath = join(root, 'docs/CHANGELOG.md');
  const markdown = renderChangelogMarkdown(entries);
  const existing = existsSync(mdPath) ? readFileSync(mdPath, 'utf8') : null;
  if (existing !== markdown) writeFileSync(mdPath, markdown);

  return { compiled, markdown };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const { compiled } = buildReleaseChangelog(root);
  console.log(`Compiled ${compiled.entries.length} release changelog entries.`);
}
