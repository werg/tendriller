#!/usr/bin/env node
// Antigravity SessionStart hook for Tendriller workspaces.
// Fast local check (~5ms, zero network): inspects tendriller.json and
// .tendriller/consumers/antigravity/*/bridge-status.json to alert the resumed
// session if the CLI Language Server changed or unanswered page requests wait.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function readStdin() {
  return new Promise(resolvePromise => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolvePromise(data));
    process.stdin.on('error', () => resolvePromise(''));
  });
}

function isPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (err) { return err?.code !== 'ESRCH'; }
}

function findTendrillerRoots(payload) {
  const candidates = new Set();
  if (typeof payload?.cwd === 'string' && payload.cwd) candidates.add(resolve(payload.cwd));
  if (Array.isArray(payload?.workspacePaths)) {
    for (const p of payload.workspacePaths) {
      if (typeof p === 'string' && p) candidates.add(resolve(p));
    }
  }
  return [...candidates].filter(dir => existsSync(join(dir, 'tendriller.json')));
}

function inspectBridgeStatuses(root) {
  const base = join(root, '.tendriller', 'consumers', 'antigravity');
  if (!existsSync(base)) return [];
  const results = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const statusPath = join(base, entry.name, 'bridge-status.json');
    if (!existsSync(statusPath)) continue;
    try {
      const parsed = JSON.parse(readFileSync(statusPath, 'utf8'));
      results.push({ ...parsed, alive: isPidAlive(parsed.pid), statusPath });
    } catch { /* ignore unreadable status */ }
  }
  return results;
}

async function main() {
  const raw = await readStdin();
  let payload = {};
  try { payload = raw.trim() ? JSON.parse(raw) : {}; } catch { /* ignore */ }

  const roots = findTendrillerRoots(payload);
  if (!roots.length) {
    process.stdout.write('{}\n');
    return;
  }

  const currentConvId = String(payload.conversationId ?? process.env.ANTIGRAVITY_CONVERSATION_ID ?? '').toLowerCase();
  const currentLs = String(process.env.ANTIGRAVITY_LS_ADDRESS ?? '').trim();
  const notes = [];

  for (const root of roots) {
    const attachExists = existsSync(join(root, '.tendriller', 'agent', 'attach.json'));
    const statuses = inspectBridgeStatuses(root);
    const matching = statuses.find(s => s.conversationId && s.conversationId.toLowerCase() === currentConvId);
    const pendingTotal = statuses.reduce((acc, s) => acc + (Number.isSafeInteger(s.pendingCount) ? s.pendingCount : 0), 0);

    if (matching) {
      const lsMismatch = Boolean(currentLs && matching.lsAddress && matching.lsAddress !== currentLs);
      if (!matching.alive || matching.state !== 'running' || lsMismatch) {
        const pages = Array.isArray(matching.pages) && matching.pages.length ? matching.pages.join(',') : '<pages>';
        notes.push(
          `Tendriller workspace (${root}): previous Antigravity bridge for this conversation is ${lsMismatch ? 'bound to an earlier CLI Language Server' : 'not running'} (pending unanswered requests: ${pendingTotal}). ` +
          `Restart it in this session with \`node consumers/antigravity-bridge.mjs --workspace ${JSON.stringify(root)} --pages ${pages} --conversation "$ANTIGRAVITY_CONVERSATION_ID" --mode agentapi\`, or run \`--doctor\` to verify sandbox network rules.`,
        );
      } else if (pendingTotal > 0) {
        notes.push(`Tendriller workspace (${root}): ${pendingTotal} unanswered page request(s) are pending in the active bridge.`);
      }
    } else if (pendingTotal > 0) {
      notes.push(`Tendriller workspace (${root}): ${pendingTotal} unanswered page request(s) recorded by a previous Antigravity bridge. Inspect with \`tendril status\` and \`tendril --page <slug> query agentFeed null\`.`);
    } else if (!attachExists) {
      notes.push(`Tendriller workspace detected at ${root} (native participant not currently attached). Run \`npm run agent\` if browsers need admission or live agent responses.`);
    }
  }

  if (!notes.length) {
    process.stdout.write('{}\n');
    return;
  }
  process.stdout.write(JSON.stringify({
    injectSteps: [
      {
        systemMessage: {
          systemMessage: notes.join('\n'),
        },
      },
    ],
  }) + '\n');
}

main().catch(() => { process.stdout.write('{}\n'); });
