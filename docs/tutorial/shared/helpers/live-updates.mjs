/**
 * Implementer-layer helpers for Tendriller live publication updates.
 *
 * Pair Tendriller's top-level DOM guards (`window.tendril.publication`) with explicit
 * application awareness of debounced saves, custom/non-DOM editors, and in-flight
 * Chronolog writes so live updates never discard unsaved work.
 */

function resolvePublication(publication) {
  return publication ?? globalThis.tendril?.publication ?? null;
}

/**
 * Coordinates `publication.hold(reason)` and `publication.onBeforeReload(...)` for
 * any custom editor, debounced auto-save, `createViewStore` draft, or canvas state.
 *
 * - Call `sync()` whenever local dirty/focus state changes.
 * - Wrap async saves/submits with `holdWhile(() => ...)` so reloads never cut them short.
 * - Registers `onBeforeReload` to flush pending debounced work before an automatic reload
 *   and vetoes the reload if unsaved state still remains.
 */
export function createDraftGuard({
  publication,
  isDirty = () => false,
  flush,
  reason = 'Unsaved local draft',
} = {}) {
  const pub = resolvePublication(publication);
  let releaseDirtyHold = null;
  let closed = false;
  let activeAsyncCount = 0;
  let releaseAsyncHold = null;

  const updateAsyncHold = () => {
    if (closed || !pub || typeof pub.hold !== 'function') return;
    if (activeAsyncCount > 0 && !releaseAsyncHold) {
      releaseAsyncHold = pub.hold(reason);
    } else if (activeAsyncCount === 0 && releaseAsyncHold) {
      const fn = releaseAsyncHold;
      releaseAsyncHold = null;
      fn();
    }
  };

  const sync = () => {
    if (closed || !pub || typeof pub.hold !== 'function') return false;
    const dirty = Boolean(isDirty());
    if (dirty && !releaseDirtyHold) {
      releaseDirtyHold = pub.hold(reason);
    } else if (!dirty && releaseDirtyHold) {
      const fn = releaseDirtyHold;
      releaseDirtyHold = null;
      fn();
    }
    return dirty;
  };

  const offBeforeReload = pub && typeof pub.onBeforeReload === 'function'
    ? pub.onBeforeReload(async (update) => {
        if (closed) return;
        if (typeof flush === 'function') {
          await flush(update);
        }
        const stillDirty = Boolean(isDirty()) || activeAsyncCount > 0;
        if (stillDirty) {
          sync();
          return false;
        }
      })
    : () => {};

  const holdWhile = async (fn) => {
    if (closed) return fn();
    activeAsyncCount += 1;
    updateAsyncHold();
    try {
      return await fn();
    } finally {
      activeAsyncCount = Math.max(0, activeAsyncCount - 1);
      updateAsyncHold();
      sync();
    }
  };

  const close = () => {
    if (closed) return;
    closed = true;
    offBeforeReload();
    if (releaseDirtyHold) { const fn = releaseDirtyHold; releaseDirtyHold = null; fn(); }
    if (releaseAsyncHold) { const fn = releaseAsyncHold; releaseAsyncHold = null; fn(); }
  };

  sync();
  return Object.freeze({
    sync,
    holdWhile,
    get held() { return Boolean(releaseDirtyHold || releaseAsyncHold); },
    close,
  });
}

/**
 * Holds automatic live reloads while any local Chronolog command/submit is still
 * materializing or storing locally.
 *
 * Use `runCommand(name, input, options)` or `track(operationPromise)` around writes;
 * live reloads resume the instant all tracked writes settle.
 */
export function holdWhilePendingOperations(session, {
  publication,
  reason = 'Saving local Chronolog operations',
} = {}) {
  const pub = resolvePublication(publication);
  let pending = 0;
  let release = null;
  let closed = false;

  const updateHold = () => {
    if (closed || !pub || typeof pub.hold !== 'function') return;
    if (pending > 0 && !release) {
      release = pub.hold(reason);
    } else if (pending === 0 && release) {
      const fn = release;
      release = null;
      fn();
    }
  };

  const track = async (work) => {
    pending += 1;
    updateHold();
    try {
      const op = await work;
      if (op && typeof op.materialized === 'function') {
        await op.materialized().catch(() => {});
      }
      return op;
    } finally {
      pending = Math.max(0, pending - 1);
      updateHold();
    }
  };

  const runCommand = (name, input, options) => {
    if (!session || typeof session.command !== 'function') {
      return Promise.reject(new TypeError('Session does not expose command()'));
    }
    return track(session.command(name, input, options));
  };

  const runSubmit = (payload, options) => {
    if (!session || typeof session.submit !== 'function') {
      return Promise.reject(new TypeError('Session does not expose submit()'));
    }
    return track(session.submit(payload, options));
  };

  const close = () => {
    if (closed) return;
    closed = true;
    pending = 0;
    if (release) { const fn = release; release = null; fn(); }
  };

  return Object.freeze({
    track,
    runCommand,
    runSubmit,
    get pendingCount() { return pending; },
    close,
  });
}

/**
 * Mounts a small non-blocking banner inside `container` whenever a live update is
 * deferred by an active edit or application hold, letting the user reload on demand
 * (and automatically hiding on hot-swap or rollback).
 */
export function mountUpdateBanner(container, {
  publication,
  onBeforeManualUpdate,
  label = 'Update ready',
  buttonLabel = 'Reload now',
} = {}) {
  const pub = resolvePublication(publication);
  if (!container || !pub || typeof pub.onUpdate !== 'function') {
    return Object.freeze({ close() {} });
  }
  const el = container.ownerDocument.createElement('div');
  el.className = 'tendril-update-banner';
  el.hidden = true;
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');

  const text = container.ownerDocument.createElement('span');
  text.textContent = label;
  const btn = container.ownerDocument.createElement('button');
  btn.type = 'button';
  btn.textContent = buttonLabel;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      if (typeof onBeforeManualUpdate === 'function') await onBeforeManualUpdate();
    } catch {}
    pub.update();
  });
  el.append(text, btn);
  container.append(el);

  const off = pub.onUpdate((update) => {
    if (update?.kind === 'reload' && update.version != null) {
      text.textContent = `${label} (v${update.version})`;
      el.hidden = false;
      btn.disabled = false;
    } else {
      el.hidden = true;
    }
  });

  return Object.freeze({
    element: el,
    close() {
      off();
      el.remove();
    },
  });
}
