/* Tendriller snippet: stream-view.js — explicit browser checkpoints and batched rendering.
 *
 * <script src="_tendril/snippets/stream-view.js"></script>
 * const view = tendrilSnippets.streamView;
 * const checkpoint = view.checkpoint('metrics', { key: 'chart-v1' });
 * const saved = checkpoint.load(); // null only when absent; failures throw
 * // Restore BOTH saved.state and saved.cursor before subscribing with after.
 * checkpoint.save({ cursor: 42, state: { records: [] } });
 * checkpoint.clear();
 * const paint = view.batch(() => render(model));
 * paint.schedule(); // coalesces calls until the next animation frame
 * paint.flush();    // run a pending render now, e.g. on pagehide
 * paint.cancel();   // cancel pending work when removing the view
 *
 * checkpoint(stream, {key, pageId?, storage?, maxBytes=1048576}) -> {load,save,clear}
 * key identifies the application view AND its state schema version. pageId
 * defaults to the injected Tendriller page id; supply it explicitly elsewhere.
 * One atomic localStorage item holds the scope, cursor and JSON state together.
 * State must be JSON data (finite numbers, strings, booleans, null, arrays and
 * plain objects); missing state, unsupported values and oversized entries fail.
 * Errors have codes invalid_checkpoint, checkpoint_too_large or storage_unavailable.
 * A failed save leaves the previous checkpoint intact. No automatic subscribe,
 * replay, reset, acknowledgement or synchronization across tabs is performed.
 * Restore only after authorizing the current reader; browser storage is not an
 * access-control boundary. Reset state and cursor together on corrupt/incompatible
 * data. A cursor without its materialized state cannot rebuild a view on reload.
 * batch never queues records: update the model synchronously for EVERY callback,
 * then schedule rendering/persistence. It does not await async callbacks.
 */
(() => {
  const ns = (window.tendrilSnippets = window.tendrilSnippets || {});
  const fail = (code, message) => Object.assign(new Error(message), { code });
  const invalid = message => fail('invalid_checkpoint', message);
  const plain = value => value && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const cursor = value => Number.isSafeInteger(value) && value >= 0;

  function jsonData(value, seen = new Set(), depth = 0) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (depth > 50 || !value || typeof value !== 'object' || (!Array.isArray(value) && !plain(value)) || seen.has(value))
      throw invalid('Checkpoint state must contain only acyclic JSON data with finite numbers.');
    if (Object.getOwnPropertySymbols(value).length) throw invalid('Checkpoint state cannot contain symbol keys.');
    seen.add(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      if (Array.isArray(value) && key === 'length') continue;
      const field = Object.getOwnPropertyDescriptor(value, key);
      if (!field || !has(field, 'value')) throw invalid('Checkpoint state cannot contain accessors.');
      if (!field.enumerable) throw invalid('Checkpoint state cannot contain non-enumerable properties.');
      if (Array.isArray(value) && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))
        throw invalid('Checkpoint arrays cannot contain additional named properties.');
      jsonData(field.value, seen, depth + 1);
    }
    if (Array.isArray(value)) for (let i = 0; i < value.length; i++) if (!has(value, i)) throw invalid('Checkpoint arrays cannot contain missing entries.');
    seen.delete(value);
  }

  function checkpoint(stream, { key, pageId = window.__TENDRIL__?.id, storage, maxBytes = 1024 * 1024 } = {}) {
    if (typeof stream !== 'string' || !/^[a-z][a-z0-9._-]{0,63}$/.test(stream)) throw invalid('A checkpoint requires a valid stream name.');
    if (typeof key !== 'string' || !key || key.length > 200) throw invalid('Provide a view key including its state schema version, for example chart-v1.');
    if (typeof pageId !== 'string' || !pageId || pageId.length > 200) throw invalid('Provide pageId when the Tendriller runtime is absent.');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 128 || maxBytes > 4 * 1024 * 1024)
      throw invalid('maxBytes must be an integer from 128 to 4194304.');
    const scope = { page: pageId, stream, key }, storageKey = `tendril:stream-view:${JSON.stringify([pageId, stream, key])}`;
    const stored = (method, ...args) => {
      try { return (storage === undefined ? window.localStorage : storage)[method](storageKey, ...args); }
      catch { throw fail('storage_unavailable', 'The browser could not read or save this checkpoint. Keep the view open or replay its history.'); }
    };
    const bounded = text => {
      if (new TextEncoder().encode(text).byteLength > maxBytes)
        throw fail('checkpoint_too_large', 'Checkpoint exceeds maxBytes; retain a smaller materialized view.');
    };
    const validate = value => {
      if (!plain(value) || value.version !== 1 || value.page !== pageId || value.stream !== stream || value.key !== key
        || !cursor(value.cursor) || !has(value, 'state')) throw invalid('Checkpoint scope, version, cursor or state is invalid.');
      jsonData(value.state);
    };
    return {
      load() {
        const raw = stored('getItem');
        if (raw === null) return null;
        if (typeof raw !== 'string') throw invalid('Checkpoint storage returned a non-text value.');
        bounded(raw);
        let value;
        try { value = JSON.parse(raw); } catch { throw invalid('The saved checkpoint is not valid JSON.'); }
        validate(value);
        return { cursor: value.cursor, state: value.state };
      },
      save(value) {
        if (!plain(value) || !cursor(value.cursor) || !has(value, 'state')) throw invalid('Save both a nonnegative integer cursor and its materialized state.');
        const envelope = { version: 1, ...scope, cursor: value.cursor, state: value.state };
        validate(envelope);
        const raw = JSON.stringify(envelope); bounded(raw);
        // setItem either replaces the whole value or throws, leaving the prior
        // snapshot and cursor together; never write them as separate keys.
        stored('setItem', raw);
      },
      clear() { stored('removeItem'); },
    };
  }

  function batch(render) {
    if (typeof render !== 'function') throw new TypeError('batch requires a synchronous render function');
    let frame = null;
    const run = () => { frame = null; render(); };
    return {
      schedule() { if (frame === null) frame = window.requestAnimationFrame(run); },
      flush() { if (frame !== null) { window.cancelAnimationFrame(frame); run(); } },
      cancel() { if (frame !== null) window.cancelAnimationFrame(frame); frame = null; },
    };
  }
  ns.streamView = { supported: () => typeof window.requestAnimationFrame === 'function', checkpoint, batch };
})();
