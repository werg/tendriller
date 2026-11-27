#!/usr/bin/env node
// Antigravity Stop hook for Tendriller workspaces.
// Catches unanswered Tendriller requests that arrived right on the turn-ending
// boundary while respecting `continuationActive` (never loops) and user cancellations.
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

async function main() {
  const raw = await readStdin();
  let payload = {};
  try { payload = raw.trim() ? JSON.parse(raw) : {}; } catch { /* ignore */ }

  // Never override user cancellation, errors, or already-active Stop continuations.
  if (payload.continuationActive === true || payload.terminationReason !== 'NO_TOOL_CALL' || payload.fullyIdle === false) {
    process.stdout.write('{}\n');
    return;
  }

  const convId = String(payload.conversationId ?? process.env.ANTIGRAVITY_CONVERSATION_ID ?? '').toLowerCase();
  if (!convId) {
    process.stdout.write('{}\n');
    return;
  }

  const dirs = new Set();
  if (typeof payload.cwd === 'string' && payload.cwd) dirs.add(resolve(payload.cwd));
  if (Array.isArray(payload.workspacePaths)) {
    for (const p of payload.workspacePaths) {
      if (typeof p === 'string' && p) dirs.add(resolve(p));
    }
  }

  const pendingPages = [];
  for (const root of dirs) {
    const base = join(root, '.tendriller', 'consumers', 'antigravity');
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const statusPath = join(base, entry.name, 'bridge-status.json');
      if (!existsSync(statusPath)) continue;
      try {
        const st = JSON.parse(readFileSync(statusPath, 'utf8'));
        if (String(st.conversationId ?? '').toLowerCase() !== convId) continue;
        if (st.state === 'running' && Number.isSafeInteger(st.pendingCount) && st.pendingCount > 0) {
          const pages = Object.entries(st.pendingByPage ?? {})
            .filter(([, count]) => Number(count) > 0)
            .map(([slug, count]) => `${slug} (${count})`);
          pendingPages.push(`${root}: ${pages.join(', ') || `${st.pendingCount} pending`}`);
        }
      } catch { /* ignore */ }
    }
  }

  if (!pendingPages.length) {
    process.stdout.write('{}\n');
    return;
  }

  process.stdout.write(JSON.stringify({
    decision: 'continue',
    reason: `Unanswered Tendriller page request(s) arrived before turn completion (${pendingPages.join('; ')}). Check agentFeed and save durable agentReceipt/agentMessage replies before stopping.`,
  }) + '\n');
}

main().catch(() => { process.stdout.write('{}\n'); });
