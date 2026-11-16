import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const compiled = await build({
  entryPoints: [new URL("../src/capabilities.ts", import.meta.url).pathname],
  bundle: true, format: "iife", globalName: "Capabilities", platform: "browser", write: false,
});
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function environment() {
  const window = new EventTarget(), timers = new Map(), queries = [], changed = [];
  let blockQueries = false, nextTimer = 0;
  window.isSecureContext = true;
  const status = state => ({ state, addEventListener() {}, removeEventListener() {} });
  const navigator = {
    geolocation: {}, userAgent: "fixture", maxTouchPoints: 0,
    permissions: { query() {
      if (!blockQueries) return Promise.resolve(status("prompt"));
      return new Promise(resolve => queries.push(resolve));
    } },
  };
  const context = {
    window, navigator, document: {}, screen: {}, Date,
    setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  runInNewContext(compiled.outputFiles[0].text, context);
  const observer = context.Capabilities.observeCapabilities(() => [], report => changed.push(report));
  return {
    queries, changed, stop: observer.dispose, status,
    refresh() {
      blockQueries = true;
      window.dispatchEvent(new Event("online"));
      const [id, callback] = [...timers].at(-1) ?? [];
      assert.ok(callback, "expected a scheduled capabilities refresh");
      timers.delete(id);
      callback();
    },
  };
}

test("a slower older permission response cannot overwrite a newer report", async () => {
  const env = environment();
  env.refresh(); await flush();
  env.refresh(); await flush();
  assert.equal(env.queries.length, 2);
  env.queries[1](env.status("denied")); await flush();
  assert.equal(env.changed.length, 1);
  assert.equal(env.changed[0].capabilities.location.permission, "denied");
  env.queries[0](env.status("granted")); await flush();
  assert.equal(env.changed.length, 1, "outdated permission result must not be presented");
  env.stop();
});

test("a detached observer does not publish a pending permission result", async () => {
  const env = environment();
  env.refresh(); await flush();
  assert.equal(env.queries.length, 1);
  env.stop();
  env.queries[0](env.status("granted")); await flush();
  assert.equal(env.changed.length, 0);
});
