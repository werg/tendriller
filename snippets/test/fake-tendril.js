// A stand-in for the runtime's window.tendril (docs/PROTOCOL.md section 11) that records calls.
// Injected with page.addInitScript before any snippet loads. Tests read window.__calls.
(() => {
  const calls = (window.__calls = { upload: [], send: [], state: [] });
  let n = 0;
  const state = {};
  const listeners = new Set();
  const toPath = (p) => (Array.isArray(p) ? p : String(p).split("."));
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const emit = (ops, by) => listeners.forEach((f) => f(state, ops, by));
  const parent = (path, create) => {
    let o = state;
    for (const k of path.slice(0, -1)) {
      if (o[k] == null || typeof o[k] !== "object") { if (!create) return null; o[k] = {}; }
      o = o[k];
    }
    return o;
  };
  const apply = (ops, by) => {
    for (const op of ops) {
      if (op.op === "set") parent(op.path, true)[op.path[op.path.length - 1]] = clone(op.value);
      else { const o = parent(op.path, false); if (o) delete o[op.path[op.path.length - 1]]; }
    }
    emit(ops, by);
  };
  window.__TENDRIL__ = window.__TENDRIL__ || { id: "test", base: "/", version: 1, ws: "/_tendril/ws", features: { transcribe: false, voice: false, push: false, vapid: null } };
  window.tendril = {
    device: { id: "d_testdevice000000", role: "owner", name: "test", pending: false },
    version: 1,
    connected: true,
    async upload(blob, opts) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const id = "b_test" + String(++n).padStart(15, "0");
      calls.upload.push({ id, type: blob.type, size: blob.size, name: opts && opts.name, head: Array.from(bytes.slice(0, 8)), objectUrl: URL.createObjectURL(blob) });
      return { id, url: "_tendril/blob/" + id };
    },
    async send(data, opts) {
      calls.send.push({ data: clone(data), wake: opts && opts.wake !== undefined ? opts.wake : true });
      return { seq: calls.send.length, queued: false };
    },
    state: {
      get(p) {
        if (p == null) return state;
        let o = state;
        for (const k of toPath(p)) { if (o == null) return undefined; o = o[k]; }
        return o;
      },
      set(p, value) { calls.state.push({ op: "set", path: toPath(p), value: clone(value) }); apply([{ op: "set", path: toPath(p), value }], "device:me"); },
      delete(p) { calls.state.push({ op: "delete", path: toPath(p) }); apply([{ op: "delete", path: toPath(p) }], "device:me"); },
      patch(mp) {
        const ops = [];
        const walk = (obj, path) => {
          for (const [k, v] of Object.entries(obj)) {
            if (v === null) ops.push({ op: "delete", path: [...path, k] });
            else if (typeof v === "object" && !Array.isArray(v)) walk(v, [...path, k]);
            else ops.push({ op: "set", path: [...path, k], value: v });
          }
        };
        walk(mp, []);
        calls.state.push(...ops);
        apply(ops, "device:me");
      },
      mine() { return (state._device || {})[window.tendril.device.id]; },
      on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    },
    on() { return () => {}; },
    // Test hook: simulate the agent changing state from the server side.
    __agentState(ops) { apply(ops, "agent:main"); },
  };
})();
