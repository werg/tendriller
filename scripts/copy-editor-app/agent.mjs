import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createLiveView } from '@chronolog/peer-session';
import { openNativePage } from '../../shared/native-page.mjs';
import { definition, deriveCopyState } from './domain.mjs';

export { definition };

/**
 * Native participant for the Tendriller Copy Editor page.
 * Watches the shared Chronolog session for signed `copy.submit` batches replicated
 * from any enrolled browser and appends them to the local inbox file so a waiting
 * repo agent (`node scripts/copy-editor.mjs --wait`) wakes up automatically.
 */
async function attachInboxBridge({ session }) {
  const inboxPath = process.env.TENDRILLER_COPY_INBOX
    ? resolve(process.env.TENDRILLER_COPY_INBOX)
    : resolve(process.cwd(), '../copy-editor/inbox.jsonl');
  mkdirSync(dirname(inboxPath), { recursive: true });

  const seen = new Set();
  if (existsSync(inboxPath)) {
    for (const line of readFileSync(inboxPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const row = JSON.parse(line); if (row.id) seen.add(row.id); } catch {}
    }
  }

  const live = createLiveView(session, deriveCopyState, { onError() {} });
  live.subscribe((snapshot) => {
    for (const batch of snapshot.value.batches) {
      if (seen.has(batch.batchId)) continue;
      seen.add(batch.batchId);
      const entry = {
        id: batch.batchId,
        ts: new Date(Number(batch.authorTimestampMs) || Date.now()).toISOString(),
        page: batch.page,
        note: batch.note,
        edits: batch.edits,
        author: batch.author,
        operationId: batch.operationId,
        proposalId: batch.proposalId,
        source: 'chronolog',
      };
      appendFileSync(inboxPath, JSON.stringify(entry) + '\n', 'utf8');
    }
  });
  session.signal?.addEventListener('abort', () => { live.close(); }, { once: true });
  return {};
}

export const openPage = (context) => openNativePage(context, { definition, assistant: attachInboxBridge });
