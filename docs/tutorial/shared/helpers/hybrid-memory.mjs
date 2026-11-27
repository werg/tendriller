// Deterministic local-first AI memory & hybrid search helper for Chronolog (`chronolog-db`).
// Combines SQLite-CAS FTS5 full-text search + sqlite-vec (`vec0`) vector similarity +
// Postgres-style write RLS (`chronolog/rls`) with Reciprocal Rank Fusion (RRF).
// Works 100% offline with zero external API keys (via deterministic feature-hashing vectors)
// while accepting high-dimensional embeddings from agents or local WebGPU models.

export const DEFAULT_EMBED_DIMS = 64;

function fnv1a32(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Deterministic, zero-dependency L2-normalized text embedding using signed feature hashing
 * over normalized word tokens and character trigrams. Identical across browser, Node, and Workers.
 */
export function embedTextLocal(text, dims = DEFAULT_EMBED_DIMS) {
  const d = Number.isSafeInteger(dims) && dims >= 4 && dims <= 4096 ? dims : DEFAULT_EMBED_DIMS;
  const vec = new Float64Array(d);
  const cleaned = String(text ?? '').toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    vec[0] = 1;
    return Array.from(vec);
  }
  const tokens = cleaned.split(' ').filter(Boolean);
  const addFeature = (feat, weight) => {
    const h = fnv1a32(feat);
    const idx = h % d;
    const sign = (h & 0x80000000) ? -1 : 1;
    vec[idx] += sign * weight;
  };
  for (const tok of tokens) {
    addFeature(`w:${tok}`, 2.0);
    if (tok.length >= 3) {
      for (let i = 0; i <= tok.length - 3; i++) {
        addFeature(`g:${tok.slice(i, i + 3)}`, 0.75);
      }
    }
  }
  let normSq = 0;
  for (let i = 0; i < d; i++) normSq += vec[i] * vec[i];
  const norm = normSq > 0 ? Math.sqrt(normSq) : 1;
  const out = new Array(d);
  for (let i = 0; i < d; i++) {
    out[i] = Math.round((vec[i] / norm) * 1_000_000) / 1_000_000;
  }
  return out;
}

/** Normalize and validate an external or local numeric embedding vector. */
export function normalizeEmbedding(vector, dims = DEFAULT_EMBED_DIMS) {
  if (!Array.isArray(vector) || vector.length !== dims) {
    throw Object.assign(new Error(`Expected embedding array of length ${dims}`), { code: 'INVALID_EMBEDDING' });
  }
  let normSq = 0;
  const nums = vector.map(v => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw Object.assign(new Error('Embedding contains non-finite value'), { code: 'INVALID_EMBEDDING' });
    normSq += n * n;
    return n;
  });
  const norm = normSq > 0 ? Math.sqrt(normSq) : 1;
  return nums.map(n => Math.round((n / norm) * 1_000_000) / 1_000_000);
}

/** Escape a user query string into a safe FTS5 prefix-OR expression that never throws syntax errors. */
export function buildSafeFtsQuery(query) {
  const tokens = String(query ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 12);
  if (!tokens.length) return '';
  return tokens.map(t => `"${t}"*`).join(' OR ');
}

/**
 * Self-contained Chronolog QuickJS-NG ES Module reducer for local-first AI memory & hybrid search.
 * Enforces Postgres-style write RLS (`chronolog/rls`) on `memories` in `mode: 'user'`, then
 * atomically maintains derived `memories_fts` (FTS5) and `memories_vec` (`vec0`) indexes so no
 * unauthorized writer can tamper with or desynchronize search indexes.
 */
export function createHybridMemoryReducerSource({ dims = DEFAULT_EMBED_DIMS, allowSharedEdits = false } = {}) {
  const d = Number.isSafeInteger(dims) && dims >= 4 && dims <= 4096 ? dims : DEFAULT_EMBED_DIMS;
  return `
import { withDb, rowsToObjects } from 'chronolog/sqlite-helpers';
import { applyRls } from 'chronolog/rls';

const DIMS = ${d};
const ALLOW_SHARED = ${allowSharedEdits ? 'true' : 'false'};

function hasCap(ctx, cap, actor) {
  const checked = ctx.query('$permissions', { check: cap, actor });
  return checked === true;
}

function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function embedLocal(text) {
  const vec = new Float64Array(DIMS);
  const cleaned = String(text || '').toLowerCase().replace(/[^a-z0-9\\s]+/g, ' ').replace(/\\s+/g, ' ').trim();
  if (!cleaned) { vec[0] = 1; return Array.from(vec); }
  const tokens = cleaned.split(' ').filter(Boolean);
  const add = (f, w) => { const h = fnv1a32(f); vec[h % DIMS] += ((h & 0x80000000) ? -1 : 1) * w; };
  for (const tok of tokens) {
    add('w:' + tok, 2.0);
    if (tok.length >= 3) {
      for (let i = 0; i <= tok.length - 3; i++) add('g:' + tok.slice(i, i + 3), 0.75);
    }
  }
  let sq = 0;
  for (let i = 0; i < DIMS; i++) sq += vec[i] * vec[i];
  const n = sq > 0 ? Math.sqrt(sq) : 1;
  const out = new Array(DIMS);
  for (let i = 0; i < DIMS; i++) out[i] = Math.round((vec[i] / n) * 1000000) / 1000000;
  return out;
}

function normVec(v) {
  if (!Array.isArray(v) || v.length !== DIMS) throw new Error('invalid_embedding');
  let sq = 0;
  const nums = v.map(x => {
    const n = Number(x);
    if (!Number.isFinite(n)) throw new Error('invalid_embedding');
    sq += n * n;
    return n;
  });
  const norm = sq > 0 ? Math.sqrt(sq) : 1;
  return nums.map(n => Math.round((n / norm) * 1000000) / 1000000);
}

function safeFts(q) {
  const toks = String(q || '').toLowerCase().replace(/[^a-z0-9_]+/g, ' ').trim().split(/\\s+/).filter(Boolean).slice(0, 12);
  return toks.length ? toks.map(t => '"' + t + '"*').join(' OR ') : '';
}

function cleanTags(tags) {
  if (!Array.isArray(tags)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of tags) {
    const t = String(raw || '').trim().toLowerCase();
    if (t && t.length <= 48 && !seen.has(t)) { seen.add(t); out.push(t); if (out.length >= 24) break; }
  }
  return out;
}

function errCode(err) {
  const msg = String(err && err.message ? err.message : err);
  const rls = /rls_denied:[A-Za-z0-9_]+:(?:insert|update|delete)/.exec(msg);
  if (rls) return rls[0];
  if (/invalid_embedding/.test(msg)) return 'memory:invalid_embedding';
  return 'memory:error';
}

function parseRow(r) {
  let tags = [];
  try { tags = JSON.parse(String(r[4] || '[]')); } catch {}
  return {
    id: String(r[0]),
    rowSeq: Number(r[1]),
    title: String(r[2]),
    body: String(r[3]),
    tags: Array.isArray(tags) ? tags : [],
    source: String(r[5] || 'note'),
    embedModel: String(r[6] || ''),
    author: String(r[7] || ''),
    createdAt: String(r[8] || ''),
    updatedAt: String(r[9] || ''),
  };
}

export default {
  reduce(state, tx, ctx) {
    const cur = state && typeof state === 'object' ? state : { dbRoot: null, initialized: false, dims: DIMS };
    const input = tx.payload;
    if (!input || typeof input !== 'object') return { ok: false, code: 'invalid_input' };
    const isAdmin = hasCap(ctx, 'administrator', tx.author);
    const isWriter = isAdmin || hasCap(ctx, 'writer', tx.author);

    if (input.action === 'initialize') {
      if (!isAdmin && !isWriter) return { ok: false, code: 'writer_required' };
      if (cur.initialized) return { ok: false, code: 'already_initialized' };
      try {
        const dbRoot = withDb(cur.dbRoot, db => {
          db.exec(\`
            CREATE TABLE IF NOT EXISTS memories (
              id TEXT PRIMARY KEY NOT NULL,
              row_seq INTEGER UNIQUE NOT NULL,
              title TEXT NOT NULL,
              body TEXT NOT NULL,
              tags_json TEXT NOT NULL DEFAULT '[]',
              source TEXT NOT NULL DEFAULT 'note',
              embed_model TEXT NOT NULL DEFAULT 'local-hash-\${DIMS}',
              author TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(id, title, body, tags);
            CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(embedding float[\${DIMS}]);
            CREATE TABLE IF NOT EXISTS memory_grants (
              grantee TEXT PRIMARY KEY NOT NULL,
              granted_by TEXT NOT NULL
            );
          \`, [], { mode: 'admin' });
          applyRls(db, {
            memories: {
              insert: 'NEW.author = actor()',
              update: ALLOW_SHARED ? '1 = 1' : 'OLD.author = actor() OR EXISTS (SELECT 1 FROM memory_grants WHERE grantee = actor())',
              delete: ALLOW_SHARED ? '1 = 1' : 'OLD.author = actor() OR EXISTS (SELECT 1 FROM memory_grants WHERE grantee = actor())',
            },
          });
          return db.commit();
        });
        return {
          ok: true,
          state: { dbRoot, initialized: true, dims: DIMS },
          events: [{ topic: 'memory.initialized', payload: { dims: DIMS } }],
        };
      } catch (err) {
        return { ok: false, code: errCode(err), detail: String(err && err.message ? err.message : err) };
      }
    }

    if (!cur.initialized) return { ok: false, code: 'not_initialized' };

    if (input.action === 'grantMemoryWrites') {
      if (!isAdmin) return { ok: false, code: 'admin_required' };
      if (typeof input.publicKey !== 'string' || !/^[0-9a-f]{64}$/.test(input.publicKey)) return { ok: false, code: 'invalid_key' };
      try {
        const dbRoot = withDb(cur.dbRoot, db => {
          db.exec('INSERT OR REPLACE INTO memory_grants(grantee, granted_by) VALUES (?, actor())', [input.publicKey], { mode: 'admin' });
          return db.commit();
        });
        return { ok: true, state: { ...cur, dbRoot }, events: [{ topic: 'memory.grant_added', payload: { publicKey: input.publicKey } }] };
      } catch (err) {
        return { ok: false, code: errCode(err), detail: String(err && err.message ? err.message : err) };
      }
    }

    if (!isWriter) return { ok: false, code: 'writer_required' };

    if (input.action === 'upsertMemory') {
      const id = typeof input.id === 'string' ? input.id.trim() : '';
      const title = typeof input.title === 'string' ? input.title.trim() : '';
      const body = typeof input.body === 'string' ? input.body : '';
      if (!id || !title || !body) return { ok: false, code: 'invalid_input' };
      const tags = cleanTags(input.tags);
      const source = typeof input.source === 'string' && input.source.trim() ? input.source.trim().slice(0, 64) : 'note';
      try {
        const vec = input.embedding ? normVec(input.embedding) : embedLocal(title + '\\n' + body + '\\n' + tags.join(' '));
        const model = typeof input.embedModel === 'string' && input.embedModel.trim()
          ? input.embedModel.trim().slice(0, 64)
          : (input.embedding ? 'external-' + DIMS : 'local-hash-' + DIMS);
        const dbRoot = withDb(cur.dbRoot, db => {
          // Enforce write RLS on memories in mode:'user'
          db.exec(
            \`INSERT INTO memories (id, row_seq, title, body, tags_json, source, embed_model, author, created_at, updated_at)
             VALUES (
               ?,
               COALESCE((SELECT row_seq FROM memories WHERE id = ?), COALESCE((SELECT MAX(row_seq) FROM memories), 0) + 1),
               ?, ?, ?, ?, ?, actor(), datetime('now'), datetime('now')
             )
             ON CONFLICT(id) DO UPDATE SET
               title = excluded.title,
               body = excluded.body,
               tags_json = excluded.tags_json,
               source = excluded.source,
               embed_model = excluded.embed_model,
               updated_at = datetime('now')\`,
            [id, id, title, body, JSON.stringify(tags), source, model],
            { mode: 'user' },
          );
          const seqRes = db.query('SELECT row_seq FROM memories WHERE id = ?', [id]);
          const rowSeq = Number(seqRes.rows[0][0]);
          // Synchronize derived FTS5 + sqlite-vec indexes atomically
          db.exec('DELETE FROM memories_fts WHERE id = ?', [id], { mode: 'admin' });
          db.exec('INSERT INTO memories_fts (id, title, body, tags) VALUES (?, ?, ?, ?)', [id, title, body, tags.join(' ')], { mode: 'admin' });
          db.exec('DELETE FROM memories_vec WHERE rowid = ?', [rowSeq], { mode: 'admin' });
          db.exec('INSERT INTO memories_vec (rowid, embedding) VALUES (?, ?)', [rowSeq, JSON.stringify(vec)], { mode: 'admin' });
          return db.commit();
        });
        return {
          ok: true,
          state: { ...cur, dbRoot },
          events: [{ topic: 'memory.upserted', payload: { id, title } }],
        };
      } catch (err) {
        return { ok: false, code: errCode(err), detail: String(err && err.message ? err.message : err) };
      }
    }

    if (input.action === 'upsertEmbedding') {
      const id = typeof input.id === 'string' ? input.id.trim() : '';
      if (!id || !input.embedding) return { ok: false, code: 'invalid_input' };
      try {
        const vec = normVec(input.embedding);
        const model = typeof input.embedModel === 'string' && input.embedModel.trim() ? input.embedModel.trim().slice(0, 64) : 'external-' + DIMS;
        const dbRoot = withDb(cur.dbRoot, db => {
          // RLS-checked UPDATE on memories ensures only authorized writers/grantees can enrich
          db.exec("UPDATE memories SET embed_model = ?, updated_at = datetime('now') WHERE id = ?", [model, id], { mode: 'user' });
          const seqRes = db.query('SELECT row_seq FROM memories WHERE id = ?', [id]);
          if (!seqRes.rows.length) return null;
          const rowSeq = Number(seqRes.rows[0][0]);
          db.exec('DELETE FROM memories_vec WHERE rowid = ?', [rowSeq], { mode: 'admin' });
          db.exec('INSERT INTO memories_vec (rowid, embedding) VALUES (?, ?)', [rowSeq, JSON.stringify(vec)], { mode: 'admin' });
          return db.commit();
        });
        if (!dbRoot) return { ok: false, code: 'not_found' };
        return {
          ok: true,
          state: { ...cur, dbRoot },
          events: [{ topic: 'memory.embedded', payload: { id, embedModel: model } }],
        };
      } catch (err) {
        return { ok: false, code: errCode(err), detail: String(err && err.message ? err.message : err) };
      }
    }

    if (input.action === 'deleteMemory') {
      const id = typeof input.id === 'string' ? input.id.trim() : '';
      if (!id) return { ok: false, code: 'invalid_input' };
      try {
        const dbRoot = withDb(cur.dbRoot, db => {
          const seqRes = db.query('SELECT row_seq FROM memories WHERE id = ?', [id]);
          if (!seqRes.rows.length) return null;
          const rowSeq = Number(seqRes.rows[0][0]);
          // RLS-checked DELETE on memories first
          db.exec('DELETE FROM memories WHERE id = ?', [id], { mode: 'user' });
          db.exec('DELETE FROM memories_fts WHERE id = ?', [id], { mode: 'admin' });
          db.exec('DELETE FROM memories_vec WHERE rowid = ?', [rowSeq], { mode: 'admin' });
          return db.commit();
        });
        if (!dbRoot) return { ok: false, code: 'not_found' };
        return {
          ok: true,
          state: { ...cur, dbRoot },
          events: [{ topic: 'memory.deleted', payload: { id } }],
        };
      } catch (err) {
        return { ok: false, code: errCode(err), detail: String(err && err.message ? err.message : err) };
      }
    }

    return { ok: false, code: 'unknown_action' };
  },

  query(state, input) {
    const cur = state && typeof state === 'object' ? state : { dbRoot: null, initialized: false, dims: DIMS };
    const req = input && typeof input === 'object' ? input : {};
    if (req.kind === 'schema' || req.query === 'schema') {
      if (!cur.initialized || !cur.dbRoot) return { dbRoot: cur.dbRoot, initialized: false, dims: DIMS, tables: [] };
      return withDb(cur.dbRoot, db => {
        const res = db.query("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_rls_%' ORDER BY name", []);
        return { dbRoot: cur.dbRoot, initialized: true, dims: DIMS, tables: res.rows.map(r => ({ name: r[0], type: r[1] })) };
      });
    }
    if (typeof req.sql === 'string') {
      if (!cur.initialized || !cur.dbRoot) return { columns: [], rows: [] };
      return withDb(cur.dbRoot, db => {
        const res = db.query(req.sql, Array.isArray(req.params) ? req.params : []);
        return req.format === 'objects' ? { columns: res.columns, rows: rowsToObjects(res) } : res;
      });
    }
    if (!cur.initialized || !cur.dbRoot) {
      return { initialized: false, mode: req.mode || 'hybrid', query: String(req.query || ''), total: 0, tags: [], items: [] };
    }
    return withDb(cur.dbRoot, db => {
      const allRes = db.query('SELECT id, row_seq, title, body, tags_json, source, embed_model, author, created_at, updated_at FROM memories ORDER BY updated_at DESC, id ASC', []);
      const allItems = allRes.rows.map(parseRow);
      const byId = new Map(allItems.map(item => [item.id, item]));
      const bySeq = new Map(allItems.map(item => [item.rowSeq, item]));
      const tagCounts = new Map();
      for (const item of allItems) for (const t of item.tags) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
      const tags = Array.from(tagCounts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, count]) => ({ name, count }));
      const mode = req.mode === 'keyword' || req.mode === 'semantic' ? req.mode : 'hybrid';
      const cleanTag = String(req.tag || '').trim().toLowerCase();
      const limit = Math.max(1, Math.min(100, Number(req.limit) || 20));
      const trimmed = String(req.query || '').trim();
      if (!trimmed && !req.queryEmbedding) {
        const filtered = cleanTag ? allItems.filter(it => it.tags.includes(cleanTag)) : allItems;
        return {
          initialized: true,
          mode,
          query: '',
          total: allItems.length,
          tags,
          items: filtered.slice(0, limit).map(it => ({ ...it, score: null, lexicalRank: null, vectorDistance: null })),
        };
      }
      const ftsRank = new Map();
      const vecRank = new Map();
      const vecDist = new Map();
      const k = 60;
      const candLimit = Math.min(100, Math.max(limit * 3, 25));
      if ((mode === 'keyword' || mode === 'hybrid') && trimmed) {
        const ftsQ = safeFts(trimmed);
        if (ftsQ) {
          const r = db.query('SELECT id, bm25(memories_fts) AS rank FROM memories_fts WHERE memories_fts MATCH ? ORDER BY rank LIMIT ?', [ftsQ, candLimit]);
          r.rows.forEach((row, idx) => ftsRank.set(String(row[0]), idx + 1));
        }
      }
      if (mode === 'semantic' || mode === 'hybrid') {
        const vec = req.queryEmbedding ? normVec(req.queryEmbedding) : embedLocal(trimmed);
        const r = db.query('SELECT rowid, distance FROM memories_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance', [JSON.stringify(vec), candLimit]);
        r.rows.forEach((row, idx) => {
          const hit = bySeq.get(Number(row[0]));
          if (hit) { vecRank.set(hit.id, idx + 1); vecDist.set(hit.id, Number(row[1])); }
        });
      }
      const ids = new Set([...ftsRank.keys(), ...vecRank.keys()]);
      const scored = [];
      for (const id of ids) {
        const it = byId.get(id);
        if (!it || (cleanTag && !it.tags.includes(cleanTag))) continue;
        const lr = ftsRank.get(id) ?? null;
        const vr = vecRank.get(id) ?? null;
        const vd = vecDist.get(id) ?? null;
        const score = mode === 'keyword' ? (lr !== null ? 1 / (k + lr) : 0)
          : mode === 'semantic' ? (vr !== null ? 1 / (k + vr) : 0)
          : (lr !== null ? 1 / (k + lr) : 0) + (vr !== null ? 1 / (k + vr) : 0);
        scored.push({
          ...it,
          score: Math.round(score * 1000000) / 1000000,
          lexicalRank: lr,
          vectorDistance: vd === null ? null : Math.round(vd * 1000000) / 1000000,
        });
      }
      scored.sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id));
      return { initialized: true, mode, query: trimmed, total: allItems.length, tags, items: scored.slice(0, limit) };
    });
  },

  describe() {
    return {
      commands: [
        { name: 'initialize', description: 'Create memories, FTS5, sqlite-vec tables and write RLS triggers.' },
        { name: 'upsertMemory', description: 'Upsert a memory note with automatic FTS5 + sqlite-vec indexing under write RLS.' },
        { name: 'upsertEmbedding', description: 'Upgrade a memory semantic vector embedding.' },
        { name: 'deleteMemory', description: 'Delete a permitted memory and its search index entries.' },
        { name: 'grantMemoryWrites', description: 'Grant another peer update/delete rights on memories (admin only).' },
      ],
      queries: [
        { name: 'search', description: 'Run hybrid (FTS5 + sqlite-vec RRF), keyword, or semantic search.' },
        { name: 'schema', description: 'Inspect dbRoot and SQLite-CAS tables.' },
        { name: 'sql', description: 'Execute a read-only SQL query against the knowledge database.' },
      ],
    };
  },
};
`.trimStart();
}

export const HYBRID_MEMORY_REDUCER_SOURCE = createHybridMemoryReducerSource({ dims: DEFAULT_EMBED_DIMS });
