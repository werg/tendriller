/**
 * Pure QuickJS-NG WASM sandbox for executing a page's signed `domain.js` bundle
 * inside the Cloudflare Worker / Durable Object.
 *
 * - Static `.wasm` import via `newVariant` (zero dynamic WebAssembly.compile).
 * - Zero ambient I/O: no `fetch`, no `env`, no DO storage, no timers.
 * - Hard memory limit (16 MiB) and execution interrupt deadline (50 ms).
 * - Zero Asyncify: `view.query(...)` and `view.readEvents(...)` execute synchronously
 *   against the in-memory Chronolog/DoltLite view and return already-resolved Promises,
 *   then `runtime.executePendingJobs()` drains async `read(view)` functions cleanly.
 */
import { newQuickJSWASMModuleFromVariant, newVariant, shouldInterruptAfterDeadline, type QuickJSWASMModule } from 'quickjs-emscripten-core';
import baseVariant from '@jitl/quickjs-ng-wasmfile-release-sync';
import quickjsWasm from './vendor/quickjs/emscripten-module.wasm';
import { HttpError } from './http';

const DEFAULT_MEMORY_LIMIT = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 50;
const MAX_BUNDLE_BYTES = 256 * 1024;

let cachedQuickJs: Promise<QuickJSWASMModule> | null = null;

async function getQuickJs(): Promise<QuickJSWASMModule> {
  if (!cachedQuickJs) {
    const variant = newVariant(baseVariant, { wasmModule: quickjsWasm });
    cachedQuickJs = newQuickJSWASMModuleFromVariant(variant).catch(err => {
      cachedQuickJs = null;
      throw err;
    });
  }
  return cachedQuickJs;
}

/**
 * Minimal pure Chronolog DSL prelude injected into the QuickJS sandbox so published
 * `domain.js` bundles that construct `defineApplication`, `defineCommand`, `defineQuery`,
 * `program`, `emit`, `sqlStatement`, `platformOp`, `hexToBytes`, `bytesToHex` run identically
 * to `@chronolog/peer-session` with zero external imports.
 */
const SANDBOX_PRELUDE = `
const __chronologDsl = (() => {
  const bytesToHex = bytes => {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let out = '';
    for (let i = 0; i < view.length; i++) out += view[i].toString(16).padStart(2, '0');
    return out;
  };
  const hexToBytes = hex => {
    if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) {
      throw new Error('INVALID_HEX');
    }
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  };
  const emit = (topic, payload) => ({ kind: 'emit', topic, payload });
  const sqlStatement = (sql, params = []) => ({ kind: 'sql', sql, params });
  const platformOp = {
    grant: spec => ({ kind: 'platform', op: 'grant', spec }),
    revoke: spec => ({ kind: 'platform', op: 'revoke', spec }),
  };
  const program = (...steps) => ({ __chronologProgram: true, steps: steps.flat() });
  const defineCommand = spec => Object.freeze({ ...spec });
  const defineQuery = spec => Object.freeze({ ...spec });
  const defineApplication = spec => Object.freeze({ ...spec });
  return Object.freeze({
    defineApplication, defineCommand, defineQuery, program, emit, sqlStatement, platformOp, hexToBytes, bytesToHex,
  });
})();
globalThis.__chronologDsl = __chronologDsl;
`;

export interface SandboxProgramStep {
  kind: 'emit' | 'sql' | 'platform';
  topic?: string;
  payload?: unknown;
  sql?: string;
  params?: unknown[];
  op?: string;
  spec?: Record<string, unknown>;
}

export interface SandboxReadBridge {
  readEvents(options: { topics?: string[]; limit?: number; cursor?: string }): {
    events: unknown[];
    cursor?: string;
    hasMore: boolean;
  };
  query?(sql: string, params?: unknown[]): { columns: Array<{ name: string }>; rows: unknown[][] };
}

export interface DomainMetadata {
  id: string;
  version: string;
  commands: Array<{ name: string; description: string; input: unknown }>;
  queries: Array<{ name: string; description: string; input: unknown }>;
}

function checkBundleSize(source: string): void {
  if (typeof source !== 'string' || !source.trim()) {
    throw new HttpError(404, 'domain_bundle_missing', 'No signed domain bundle is published for this page.');
  }
  if (new TextEncoder().encode(source).byteLength > MAX_BUNDLE_BYTES) {
    throw new HttpError(413, 'domain_bundle_too_large', 'Published domain bundle exceeds the 256 KiB sandbox limit.');
  }
}

/**
 * Evaluate a signed `domain.js` bundle inside a fresh, isolated QuickJS runtime and run
 * `fn(vm, definitionHandle)` synchronously, draining microtasks within the timeout.
 */
async function withDomainSandbox<T>(
  bundleSource: string,
  options: { memoryLimit?: number; timeoutMs?: number; bridge?: SandboxReadBridge },
  run: (ctx: {
    evalJson: (expr: string) => unknown;
  }) => T,
): Promise<T> {
  checkBundleSize(bundleSource);
  const qjs = await getQuickJs();
  const runtime = qjs.newRuntime();
  runtime.setMemoryLimit(options.memoryLimit ?? DEFAULT_MEMORY_LIMIT);
  runtime.setMaxStackSize(512 * 1024);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS)));
  const vm = runtime.newContext();
  try {
    const prelude = vm.evalCode(SANDBOX_PRELUDE, 'prelude.js');
    if (prelude.error) {
      const dumped = vm.dump(prelude.error);
      prelude.error.dispose();
      throw new HttpError(500, 'sandbox_init_failed', String(dumped?.message ?? dumped));
    }
    prelude.value.dispose();

    if (options.bridge) {
      const bridge = options.bridge;
      const readEventsFn = vm.newFunction('__hostReadEvents', (argHandle) => {
        const arg = argHandle ? JSON.parse(vm.getString(argHandle)) : {};
        const res = bridge.readEvents(arg);
        return vm.newString(JSON.stringify(res));
      });
      vm.setProp(vm.global, '__hostReadEvents', readEventsFn);
      readEventsFn.dispose();

      if (bridge.query) {
        const queryFn = vm.newFunction('__hostQuery', (sqlHandle, paramsHandle) => {
          const sql = vm.getString(sqlHandle);
          const params = paramsHandle ? JSON.parse(vm.getString(paramsHandle)) : [];
          const res = bridge.query!(sql, params);
          return vm.newString(JSON.stringify(res));
        });
        vm.setProp(vm.global, '__hostQuery', queryFn);
        queryFn.dispose();
      }

      const viewSetup = vm.evalCode(`
        globalThis.__sandboxView = Object.freeze({
          readEvents(opts) {
            return JSON.parse(__hostReadEvents(JSON.stringify(opts ?? {})));
          },
          query(sql, params) {
            if (typeof __hostQuery !== 'function') throw new Error('SQL_QUERY_UNAVAILABLE');
            return JSON.parse(__hostQuery(String(sql), JSON.stringify(params ?? [])));
          },
        });
      `, 'view-bridge.js');
      if (viewSetup.error) {
        const dumped = vm.dump(viewSetup.error);
        viewSetup.error.dispose();
        throw new HttpError(500, 'sandbox_bridge_failed', String(dumped?.message ?? dumped));
      }
      viewSetup.value.dispose();
    }

    // Normalize ESM `domain.js` bundles (stripping `@chronolog/peer-session` imports and `export` keywords)
    // so both esbuild ESM output and IIFE/CommonJS bundles expose `definition` cleanly.
    const normalizedBundle = bundleSource
      .replace(/import\s*\{([^}]+)\}\s*from\s*['"]@chronolog\/peer-session['"];?/g, (_m, names) => {
        const mapped = String(names).replace(/\s+as\s+/g, ': ');
        return `const { ${mapped} } = __chronologDsl;`;
      })
      .replace(/export\s+default\s+/g, 'module.exports.default = ')
      .replace(/export\s+(?=(?:const|let|var|async\s+function|function|class)\b)/g, '')
      .replace(/export\s*\{([^}]*)\}\s*;?/g, (_m, names) => {
        const pairs = String(names).split(',').map(s => s.trim()).filter(Boolean).map(item => {
          const [orig, alias] = item.split(/\s+as\s+/);
          return `${(alias ?? orig)!.trim()}: ${orig!.trim()}`;
        });
        return `Object.assign(module.exports, { ${pairs.join(', ')} });`;
      });

    const wrapped = `
      const module = { exports: {} };
      const exports = module.exports;
      ${normalizedBundle}
      globalThis.__tendrilDefinition =
        globalThis.__tendrilDomain?.definition ??
        globalThis.__tendrilDomain ??
        module.exports?.definition ??
        module.exports?.default?.definition ??
        module.exports?.default ??
        (typeof definition !== 'undefined' ? definition : null);
      if (!globalThis.__tendrilDefinition || typeof globalThis.__tendrilDefinition !== 'object') {
        throw new Error('DOMAIN_DEFINITION_MISSING');
      }
    `;
    const loaded = vm.evalCode(wrapped, 'domain.js');
    if (loaded.error) {
      const dumped = vm.dump(loaded.error);
      loaded.error.dispose();
      throw new HttpError(400, 'domain_bundle_invalid', String(dumped?.message ?? dumped));
    }
    loaded.value.dispose();

    const evalJson = (expr: string): unknown => {
      const res = vm.evalCode(expr, 'invoke.js');
      if (res.error) {
        const dumped = vm.dump(res.error);
        res.error.dispose();
        const msg = typeof dumped === 'object' && dumped && 'message' in dumped ? String((dumped as any).message) : String(dumped);
        throw new HttpError(400, 'domain_execution_failed', msg);
      }
      const handle = res.value;
      // Drain microtasks in case the expression returned a Promise (e.g. async read(view)).
      for (;;) {
        const jobs = runtime.executePendingJobs(100);
        if (jobs.error) {
          const dumped = vm.dump(jobs.error);
          jobs.error.dispose();
          handle.dispose();
          const msg = typeof dumped === 'object' && dumped && 'message' in dumped ? String((dumped as any).message) : String(dumped);
          throw new HttpError(400, 'domain_execution_failed', msg);
        }
        if (jobs.value === 0) break;
      }
      const state = vm.getPromiseState(handle);
      if (state.type === 'fulfilled') {
        const jsonStr = vm.getString(state.value);
        if (state.value !== handle) state.value.dispose();
        handle.dispose();
        return JSON.parse(jsonStr);
      }
      if (state.type === 'rejected') {
        const dumped = vm.dump(state.error);
        if (state.error !== handle) state.error.dispose();
        handle.dispose();
        const msg = typeof dumped === 'object' && dumped && 'message' in dumped ? String((dumped as any).message) : String(dumped);
        throw new HttpError(400, 'domain_execution_failed', msg);
      }
      if (state.type === 'pending') {
        handle.dispose();
        throw new HttpError(400, 'domain_async_unsupported', 'Domain functions must resolve purely against the local snapshot without external I/O.');
      }
      const jsonStr = vm.getString(handle);
      handle.dispose();
      return JSON.parse(jsonStr);
    };

    return run({ evalJson });
  } finally {
    vm.dispose();
    runtime.dispose();
  }
}

export async function describeDomainBundle(bundleSource: string): Promise<DomainMetadata> {
  return withDomainSandbox(bundleSource, {}, ({ evalJson }) => evalJson(`
    (() => {
      const def = globalThis.__tendrilDefinition;
      const commands = Object.entries(def.commands ?? {}).map(([name, spec]) => ({
        name, description: String(spec.description ?? ''), input: spec.input ?? {},
      }));
      const queries = Object.entries(def.queries ?? {}).map(([name, spec]) => ({
        name, description: String(spec.description ?? ''), input: spec.input ?? {},
      }));
      return JSON.stringify({ id: String(def.id ?? ''), version: String(def.version ?? '1'), commands, queries });
    })()
  `) as DomainMetadata);
}

export async function runDomainCommand(
  bundleSource: string,
  commandName: string,
  input: unknown,
): Promise<SandboxProgramStep[]> {
  return withDomainSandbox(bundleSource, {}, ({ evalJson }) => evalJson(`
    (() => {
      const def = globalThis.__tendrilDefinition;
      const cmd = def.commands?.[${JSON.stringify(commandName)}];
      if (!cmd || typeof cmd.prepare !== 'function') throw new Error('COMMAND_NOT_FOUND');
      const out = cmd.prepare(${JSON.stringify(input)});
      const steps = Array.isArray(out?.steps) ? out.steps : [];
      // Normalize Uint8Array fields (e.g. grantee bytes) to hex for host serialization.
      const clean = steps.map(step => {
        if (step.kind === 'platform' && step.spec && step.spec.grantee instanceof Uint8Array) {
          return { ...step, spec: { ...step.spec, granteeHex: __chronologDsl.bytesToHex(step.spec.grantee), grantee: undefined } };
        }
        return step;
      });
      return JSON.stringify(clean);
    })()
  `) as SandboxProgramStep[]);
}

export async function runDomainQuery(
  bundleSource: string,
  queryName: string,
  input: unknown,
  bridge: SandboxReadBridge,
): Promise<unknown> {
  return withDomainSandbox(bundleSource, { bridge }, ({ evalJson }) => evalJson(`
    (async () => {
      const def = globalThis.__tendrilDefinition;
      const q = def.queries?.[${JSON.stringify(queryName)}];
      if (!q || typeof q.read !== 'function') throw new Error('QUERY_NOT_FOUND');
      const result = await q.read(globalThis.__sandboxView, ${JSON.stringify(input)});
      return JSON.stringify(result === undefined ? null : result);
    })()
  `));
}
