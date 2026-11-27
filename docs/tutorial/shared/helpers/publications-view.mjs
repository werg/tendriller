// Client-side `$publications` history inspector, P2P hash-recovery verifier, and signed rollback helper.

async function verifyReleaseFiles(session, files, { fetchHost } = {}) {
  try {
    const mod = await import('@tendriller/core/publication-blobs');
    return mod.recoverPublication(session, { id: 'verify', payload: { files } }, { fetchHost });
  } catch {
    let fromPeers = 0;
    const missing = [];
    for (const f of files ?? []) {
      const bytes = await session.content.get(f.hash, { expectedBytes: f.size });
      if (bytes && bytes.byteLength === f.size) fromPeers++;
      else missing.push(f);
    }
    return { complete: missing.length === 0, fromHost: 0, fromPeers, missing };
  }
}

/** Query the signed `$publications` history from the local Chronolog session. */
export async function listPublicationHistory(session) {
  const res = await session.query('$publications', { history: true });
  const list = Array.isArray(res?.value) ? res.value : [];
  return [...list].sort((a, b) => Number(b.revision ?? 0) - Number(a.revision ?? 0));
}

/** Submit a signed `$publications` rollback operation targeting a historical revision or opId. */
export async function rollbackPublication(session, target, { operationId } = {}) {
  const payload = typeof target === 'number' || /^\d+$/.test(String(target))
    ? { action: 'rollback', revision: Number(target) }
    : { action: 'rollback', opId: String(target) };
  return session.submit({
    visibility: 'public',
    ...(operationId ? { operationId } : {}),
    updates: [{ topic: '$publications', input: payload }],
  });
}

/**
 * Mount a reactive `$publications` version history panel with peer-backed SHA-256 recovery
 * checks and one-click signed rollback for authorized publishers/administrators.
 */
export function mountPublicationsHistory({ root, session, fetchHost } = {}) {
  if (!root || !session) return { refresh: async () => {}, destroy() {} };
  const section = document.createElement('section');
  const heading = document.createElement('h2');
  heading.textContent = 'Signed publication history';
  const note = document.createElement('p');
  note.textContent = 'The host keeps a short rolling R2 cache (3 versions); pruned historical releases stay verifiable in $publications and recoverable from connected Chronolog peers by SHA-256 hash.';
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const list = document.createElement('ol');
  section.append(heading, note, status, list);
  root.append(section);
  let destroyed = false;

  async function refresh() {
    if (destroyed) return;
    const history = await listPublicationHistory(session).catch(() => []);
    const current = (await session.query('$publications', {}))?.value?.current ?? null;
    const selfKey = session.device?.identity?.publicKey ?? session.identity?.publicKey ?? null;
    const canPublish = selfKey ? (session.isAdministrator?.(selfKey) || await session.checkPermission?.('publisher', selfKey).catch(() => false)) : false;

    if (!history.length) {
      status.textContent = 'No signed $publications releases recorded yet.';
      list.replaceChildren();
      return;
    }
    status.textContent = `${history.length} signed release${history.length === 1 ? '' : 's'} · current rev ${current?.revision ?? 0}`;
    const items = history.map(rel => {
      const li = document.createElement('li');
      const totalBytes = (rel.files ?? []).reduce((s, f) => s + Number(f.size ?? 0), 0);
      const isCurrent = current && rel.opId === current.opId;
      const summary = document.createElement('span');
      summary.textContent = `Rev ${rel.revision}${isCurrent ? ' (Current)' : ''}${rel.rollbackOf ? ` · rollback of rev ${rel.rollbackOf}` : ''} · ${(rel.files ?? []).length} files (${Math.ceil(totalBytes / 1024)} KiB) · ${new Date(Number(rel.timestampMs ?? 0)).toISOString().slice(0, 16).replace('T', ' ')} UTC `;
      li.append(summary);

      const verifyBtn = document.createElement('button');
      verifyBtn.type = 'button';
      verifyBtn.textContent = 'Check P2P recovery';
      verifyBtn.onclick = async () => {
        verifyBtn.disabled = true;
        status.textContent = `Verifying rev ${rel.revision} assets across host & peers…`;
        try {
          const rec = await verifyReleaseFiles(session, rel.files ?? [], { fetchHost });
          status.textContent = rec.complete
            ? `Rev ${rel.revision} complete (${rec.fromHost} from host, ${rec.fromPeers} recovered from P2P peers).`
            : `Rev ${rel.revision} incomplete: ${rec.missing.length} asset(s) missing locally and on connected peers.`;
        } catch (err) {
          status.textContent = `Verification failed: ${err?.message ?? String(err)}`;
        } finally { verifyBtn.disabled = false; }
      };
      li.append(verifyBtn);

      if (canPublish && !isCurrent) {
        const rbBtn = document.createElement('button');
        rbBtn.type = 'button';
        rbBtn.textContent = 'Roll back here';
        rbBtn.onclick = async () => {
          rbBtn.disabled = true;
          status.textContent = `Signing rollback to rev ${rel.revision}…`;
          try {
            const op = await rollbackPublication(session, rel.revision, { operationId: `rollback-${rel.revision}-${crypto.randomUUID().slice(0, 8)}` });
            const mat = await op.materialized();
            status.textContent = `Signed rollback to rev ${rel.revision}: ${mat.outcome}.`;
            await refresh();
          } catch (err) {
            status.textContent = `Rollback failed: ${err?.message ?? String(err)}`;
            rbBtn.disabled = false;
          }
        };
        li.append(rbBtn);
      }
      return li;
    });
    if (!destroyed) list.replaceChildren(...items);
  }

  void refresh();
  const off = typeof session.onChange === 'function' ? session.onChange(() => void refresh()) : () => {};
  return Object.freeze({
    element: section,
    refresh,
    destroy() { destroyed = true; off(); section.remove(); },
  });
}
