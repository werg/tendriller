import type { Tendril } from './tendril';
import { HttpError } from './http';
import { sha256Hex } from './ids';

function scanContent(body: ArrayBuffer): number {
  const text = new TextDecoder().decode(body.slice(0, 1024 * 1024));
  let score = 0;
  if (/<input\b[^>]*type\s*=\s*["']?password\b/i.test(text)) score += 5;
  if (/<form\b[^>]*action\s*=\s*["']?https?:\/\//i.test(text)) score += 4;
  if (/(?:github|google|microsoft|paypal|bank|openai)[\s\S]{0,100}(?:sign\s*in|log\s*in|password|verify\s+account)/i.test(text)) score += 4;
  if (/(?:coinhive|cryptonight|cryptominer|stratum\+tcp)/i.test(text)) score += 5;
  return score;
}

export function fileKey(t: Tendril, hash: string): string {
  return `t/${t.tid}/files/${hash}`;
}

/** Serialize external storage effects for one content hash, across writers and GC. */
async function contentOperation<T>(t: Tendril, hash: string, operation: () => Promise<T>): Promise<T> {
  const previous = t.contentOperations.get(hash) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  t.contentOperations.set(hash, current);
  try { return await current; }
  finally { if (t.contentOperations.get(hash) === current) t.contentOperations.delete(hash); }
}

/** Called in the transaction that creates a durable reference to content. */
export function assertStoredContent(t: Tendril, files: Iterable<{ readonly hash: string; readonly size: number }>): void {
  for (const file of files) {
    const stored = t.db.one<{ size: number; status: string }>('SELECT size,status FROM stored_files WHERE hash=?', file.hash);
    if (!stored || stored.status !== 'ready' || stored.size !== file.size)
      throw new HttpError(409, 'content_unavailable', 'File content changed during preparation; upload the publication again');
  }
}

/** Reserve deletion synchronously; references cannot be added while R2 is awaited. */
export async function deleteUnreferencedContent(t: Tendril, hash: string, olderThan?: number): Promise<void> {
  await contentOperation(t, hash, async () => {
    const file = t.transaction(() => {
      const stored = t.db.one<{ size: number; created_at: number }>('SELECT size,created_at FROM stored_files WHERE hash=?', hash);
      if (!stored || (olderThan !== undefined && stored.created_at >= olderThan)) return null;
      if (t.db.one('SELECT 1 AS present FROM version_files WHERE hash=? LIMIT 1', hash)) return null;
      if (t.db.one('SELECT 1 FROM page_release_assets WHERE hash=? LIMIT 1', hash)) return null;
      if (t.db.one('SELECT 1 FROM page_release_content WHERE hash=? AND created_at>=?', hash, t.now() - 86400_000)) return null;
      if (t.db.one('SELECT 1 AS present FROM blobs WHERE sha256=? LIMIT 1', hash)) return null;
      if (t.db.one('SELECT 1 AS present FROM file_refs f JOIN blobs b ON b.id=f.blob_id WHERE b.sha256=? LIMIT 1', hash)) return null;
      const staged = t.db.get<{ files: { hash: string }[] } | null>('staged_bundle', null);
      if (staged?.files.some(file => file.hash === hash)) return null;
      t.db.run("UPDATE stored_files SET status='deleting' WHERE hash=?", hash);
      return stored;
    });
    if (!file) return;
    // On failure the reservation remains. Another upload or a later GC pass can
    // recover it without allowing a publication to refer to uncertain bytes.
    await t.env.FILES.delete(fileKey(t, hash));
    t.db.run("DELETE FROM stored_files WHERE hash=? AND status='deleting'", hash);
    t.db.run('DELETE FROM page_release_content WHERE hash=?', hash);
    await t.releaseGlobalBytes(file.size);
  });
}

/** Stores the bytes content-addressed in R2 (skipped if already present). */
export async function storeContent(t: Tendril, body: ArrayBuffer, type: string,
  retain?: (hash: string) => void, beforeCommit?: () => Promise<void>): Promise<{ hash: string; size: number }> {
  const hash = await sha256Hex(body);
  await contentOperation(t, hash, async () => {
    const riskScore = scanContent(body);
    const reserved = t.reserveStoredFile(hash, body.byteLength, riskScore);
    let globalReserved = false;
    let uploaded = false;
    const key = fileKey(t, hash);
    try {
      if (reserved) {
        await t.reserveGlobalBytes(body.byteLength);
        globalReserved = true;
      }
      const head = await t.env.FILES.head(key);
      if (!head) { await t.env.FILES.put(key, body, { httpMetadata: { contentType: type } }); uploaded = true; }
      await beforeCommit?.();
      t.transaction(() => {
        t.db.run("UPDATE stored_files SET status='ready' WHERE hash=?", hash);
        retain?.(hash);
      });
    } catch (err) {
      if (reserved) {
        t.db.run("DELETE FROM stored_files WHERE hash = ?", hash);
        if (uploaded) { try { await t.env.FILES.delete(key); } catch { /* orphan sweep can retry */ } }
        if (globalReserved) await t.releaseGlobalBytes(body.byteLength);
      }
      throw err;
    }
  });
  return { hash, size: body.byteLength };
}

