import { MeasurementError, need, same } from './observer-data.mjs';
import { hash } from './evidence.mjs';

export const installationItems = items => items.filter(i => i.type === 'commandExecution' &&
  (/\b(npm|pnpm|yarn)\b.*\b(install|ci|add)\b/u.test(i.command ?? '') ||
    /\bnpx\b|\bnpm\b[^\n]*\bexec\b|\b(?:pnpm|yarn)\b[^\n]*\bdlx\b/u.test(i.command ?? '') ||
    /^\s*(?:added|removed|changed) \d+ packages?(?:, and audited \d+ packages?)? in \S+/mu.test(i.output ?? '')));

// A bounded shell reader, not a shell interpreter. Quotes/escapes are retained as
// literal vs expandable fragments. Operators, substitutions and unknown commands
// terminate the supported prefix; captured code is never executed.
function words(source) {
  if (source.length > 65536) return null;
  const result = []; let pieces = [], start = -1, quote = null;
  const put = (text, expand) => { pieces.push({ text, expand }); };
  const finish = end => {
    if (start < 0) return;
    result.push({ pieces, text: pieces.map(p => p.text).join(''), raw: source.slice(start, end) });
    pieces = []; start = -1;
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quote === "'") { if (c === quote) quote = null; else put(c, false); continue; }
    if (quote === '"') {
      if (c === quote) { quote = null; continue; }
      if (c === '\\' && /[$`"\\\n]/u.test(source[i + 1] ?? '')) { put(source[++i], false); continue; }
      put(c, true); continue;
    }
    if (/\s/u.test(c)) { finish(i); continue; }
    if (c === '#' && start < 0) break;
    if (/[;&|<>()]/u.test(c)) return null;
    if (start < 0) start = i;
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === '\\') { if (++i >= source.length) return null; put(source[i], false); continue; }
    put(c, true);
    if (result.length > 1024) return null;
  }
  if (quote !== null) return null;
  finish(source.length); return result;
}
function script(command) {
  const outer = words(command);
  if (outer?.length === 3 && /^(?:\/[^\s]+\/)?(?:bash|sh)$/u.test(outer[0].text) &&
      ['-c', '-lc'].includes(outer[1].text)) return outer[2].text;
  return command;
}
function expand(word, variables) {
  // Expand from fragments rather than from the joined value: single quotes and
  // escaped dollars never acquire expansion semantics.
  const chunks = [];
  for (const piece of word.pieces) {
    const last = chunks.at(-1);
    if (last?.expand === piece.expand) last.text += piece.text;
    else chunks.push({ ...piece });
  }
  let value = '';
  for (const part of chunks) {
    if (!part.expand) { value += part.text; continue; }
    if (part.text.includes('`') || /\$(?![A-Za-z_]|\{[A-Za-z_]\w*\})/u.test(part.text)) return null;
    let missing = false;
    value += part.text.replace(/\$(?:([A-Za-z_]\w*)|\{([A-Za-z_]\w*)\})/gu, (_, plain, braces) => {
      const known = variables.get(plain ?? braces); if (known === undefined) missing = true; return known ?? '';
    });
    if (missing) return null;
  }
  return value;
}
function curlUrl(args) {
  if (args[0] !== 'curl') return null;
  let fail = false, url;
  const flags = new Set(['--silent', '--show-error', '--location', '--insecure']);
  const valued = new Set(['-o', '--output', '-m', '--max-time', '--connect-timeout', '-H', '--header', '-A', '--user-agent']);
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (['--fail', '--fail-with-body'].includes(arg)) { fail = true; continue; }
    if (/^-[fsSLk]+$/u.test(arg)) { fail ||= arg.includes('f'); continue; }
    if (flags.has(arg)) continue;
    if (valued.has(arg)) { if (++i >= args.length) return null; continue; }
    if (arg === '--url') { if (url !== undefined || ++i >= args.length) return null; url = args[i]; continue; }
    if (arg.startsWith('-') || url !== undefined) return null;
    url = arg;
  }
  return fail ? url : null;
}
function httpPrefix(item, origin) {
  const lines = script(item.command).split(/\r?\n/u).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  if (lines.length > 128) return { reads: [] };
  const variables = new Map(), reads = []; let guarded = false;
  for (let step = 0; step < lines.length; step++) {
    const tokens = words(lines[step]);
    if (!tokens?.length) return { reads, tail: step };
    const args = tokens.map(w => expand(w, variables));
    if (args.includes(null)) return { reads, tail: step };
    if (args[0] === 'set' && (args.length === 2 && /^-e[ux]*$/u.test(args[1]) ||
        args.length === 3 && /^-e[ux]*o$/u.test(args[1]) && args[2] === 'pipefail')) { guarded = true; continue; }
    if (args[0] === 'umask' && args.length === 2 && /^[0-7]{3,4}$/u.test(args[1])) continue;
    const assignments = args[0] === 'export' ? tokens.slice(1) : tokens;
    if (assignments.length && assignments.every(w => /^[A-Za-z_]\w*=/u.test(w.raw))) {
      if (args[0] !== 'export' && assignments.length !== 1) return { reads, tail: step };
      for (const assignment of assignments) {
        const value = expand(assignment, variables), split = value.indexOf('=');
        variables.set(value.slice(0, split), value.slice(split + 1));
      }
      continue;
    }
    const url = curlUrl(args);
    if (!url) return { reads, tail: step };
    // Earlier failures in an unguarded multiline script can be masked by later
    // success. A single literal curl may rely on its actual exit code instead.
    if (!guarded && (lines.length !== 1 || tokens.some(w => w.pieces.some(p => p.expand && p.text.includes('$'))))) continue;
    try {
      const parsed = new URL(url);
      if (parsed.origin === origin && !parsed.username && !parsed.password && !parsed.search && !parsed.hash)
        reads.push({ item, path: parsed.pathname, step, guarded });
    } catch { /* Unknown/dynamic destinations are not discovery evidence. */ }
  }
  return { reads };
}

/** Pure trace measurement. Static shell order proves reads before a later
 * installer in the SAME guarded command; it never fabricates HTTP timestamps.
 * Overlap with an install in ANOTHER command still fails closed. */
export function domainDiscovery(items, { origin }) {
  const installations = installationItems(items), candidates = [];
  const prefixes = new Map();
  for (const item of items) {
    if (item.type !== 'commandExecution' || item.exitCode !== 0 || typeof item.command !== 'string') continue;
    const prefix = httpPrefix(item, origin); prefixes.set(item, prefix); candidates.push(...prefix.reads);
  }
  const paths = ['/api/service', '/.well-known/tendriller.json', '/api/readiness', '/docs/BUILD_AN_APP.md'];
  const reads = paths.map(path => need(candidates.find(r => r.path === path), 'model-read-' + path));
  const ordering = [];
  for (const read of reads) {
    // Always validate the measured envelope, including a same-command proof.
    discoveryTiming([read.item], []);
    for (const install of installations) {
      if (install === read.item) {
        const tail = prefixes.get(install)?.tail;
        if (!read.guarded || !Number.isInteger(tail) || read.step >= tail)
          throw new MeasurementError('same-command-install-order-unmeasured');
        discoveryTiming([], [install]);
        if (Date.parse(install.startedAt) > Date.parse(install.completedAt)) throw new MeasurementError('discovery-command-time-order');
        ordering.push({ url: origin + read.path, kind: 'guarded-shell-prefix', readStep: read.step,
          opaqueContinuationStep: tail, commandHash: hash(read.item.command),
          startedAt: install.startedAt, completedAt: install.completedAt });
      } else discoveryTiming([read.item], [install]);
    }
  }
  const timing = discoveryTiming([], installations);
  return { mode: 'domain', source: 'Successful curl reads with literal destinations or statically resolved guarded shell prefixes',
    urls: reads.map(read => ({ url: origin + read.path, observedAt: read.item.completedAt, commandHash: hash(read.item.command), step: read.step })),
    installObserved: installations.length > 0, ...timing, sameCommandOrdering: ordering,
    timingScope: 'Timestamps bound whole commands; firstInstallCommandStartedAt is the enclosing command start, not actual npm start. Same-command order uses only the recognized errexit prefix, not inferred HTTP/installation timestamps' };
}
export function discoveryTiming(reads, installations) {
  const time = (value, metric) => {
    const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
    if (!Number.isFinite(parsed)) throw new MeasurementError(metric);
    return parsed;
  };
  const completed = reads.map(read => time(read.completedAt, 'discovery-completion-time-missing'));
  const starts = installations.map(item => time(item.startedAt, 'installation-start-time-missing'));
  if (starts.length && completed.some(at => at >= Math.min(...starts))) throw new MeasurementError('discovery-not-before-install-start', 'failed');
  return { firstInstallCommandStartedAt: starts.length ? new Date(Math.min(...starts)).toISOString() : null,
    installationCoverage: 'Recognized package-command patterns and npm-shaped output only; silent arbitrary subprocess installers are not audited' };
}

/** Account-linked discovery uses authenticated, origin-bound MCP results;
 * terminal HTTP reads remain a separate domain-only measurement. */
export function mcpDiscovery(items, { origin, build, catalog }) {
  const servers = need(catalog?.data, 'mcp-discovery-catalog');
  if (!Array.isArray(servers) || servers.length !== 1 || servers[0].name !== 'tendriller') throw new MeasurementError('mcp-discovery-server', 'failed');
  need(servers[0].tools?.tendril_guide, 'mcp-discovery-catalog-tendril_guide');
  const installations = installationItems(items);
  const selected = [need(items.find(i => i.type === 'mcpToolCall' && i.server === 'tendriller' &&
    i.tool === 'tendril_guide' && i.arguments?.topic === 'build' && !i.result?.isError), 'mcp-discovery-tendril_guide')];
  const reads = selected.map(event => {
    const blocks = event.result?.content?.filter(c => c.type === 'text');
    if (blocks?.length !== 1) throw new MeasurementError('mcp-discovery-content', 'failed');
    let body; try { body = JSON.parse(blocks[0].text); } catch { throw new MeasurementError('mcp-discovery-json', 'failed'); }
    same(body.serviceOrigin, origin, 'mcp-discovery-origin');
    same(body.readiness?.serviceOrigin, origin, 'mcp-discovery-readiness-origin');
    same(body.readiness?.mode, 'open', 'mcp-discovery-readiness-mode');
    same(body.readiness?.creation?.available, true, 'mcp-discovery-creation');
    for (const [key, expected] of Object.entries(build)) {
      same(body.build?.[key], expected, 'mcp-discovery-build-' + key);
      same(body.readiness?.build?.[key], expected, 'mcp-discovery-readiness-build-' + key);
    }
    if (event.tool === 'tendril_guide') {
      same(body.topic, 'build', 'mcp-discovery-guide-topic');
      same(body.url, origin + '/docs/BUILD_AN_APP.md', 'mcp-discovery-guide-url');
      if (typeof body.text !== 'string' || !body.text.trim()) throw new MeasurementError('mcp-discovery-guide-body');
    }
    return { tool: event.tool, observedAt: event.completedAt, returnedOrigin: body.serviceOrigin, resultSha256: hash(blocks[0].text) };
  });
  const timing = discoveryTiming(selected, installations);
  return { mode: 'mcp', source: 'Authenticated selected-origin build guide with returned readiness before install; get_profile is optional',
    selectedOrigin: origin, build, reads, installObserved: installations.length > 0, ...timing, catalogSha256: hash(JSON.stringify(servers[0].tools)) };
}
