// Config resolution.
//   1. --tendril <name>   -> <configDir>/<name>.json  ({api, token, page_url, id, name, server})
//   2. TENDRIL_NAME env   -> same
//   3. TENDRIL_API + TENDRIL_TOKEN env
// configDir = TENDRIL_CONFIG_DIR, else $XDG_CONFIG_HOME/tendril, else ~/.config/tendril.
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_SERVER = "http://localhost:8787";

export function configDir(env = process.env) {
  if (env.TENDRIL_CONFIG_DIR) return env.TENDRIL_CONFIG_DIR;
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  return join(base, "tendril");
}

export function serverBase(env = process.env, flags = {}) {
  return String(flags.server || env.TENDRIL_SERVER || DEFAULT_SERVER).replace(/\/+$/, "");
}

export function slug(name) {
  const s = String(name || "tendril").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s.slice(0, 48) || "tendril";
}

export function idFromApi(api) {
  const m = /\/api\/t\/([^/?#]+)/.exec(api || "");
  return m ? m[1] : null;
}

export function configPath(name, env = process.env) {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith(".")) throw new Error(`bad tendril name "${name}"`);
  return join(configDir(env), `${name}.json`);
}

export function resolveConfig(flags = {}, env = process.env) {
  const name = flags.tendril || env.TENDRIL_NAME;
  if (name) {
    const p = configPath(name, env);
    if (!existsSync(p)) throw new Error(`no config for "${name}" at ${p} (create one with: tendril new ${name})`);
    const c = JSON.parse(readFileSync(p, "utf8"));
    if (!c.api || !c.token) throw new Error(`${p} lacks api/token`);
    return { ...c, api: c.api.replace(/\/+$/, ""), id: c.id || idFromApi(c.api), configName: name, configFile: p };
  }
  if (env.TENDRIL_API && env.TENDRIL_TOKEN) {
    const api = env.TENDRIL_API.replace(/\/+$/, "");
    return { api, token: env.TENDRIL_TOKEN, id: idFromApi(api), configName: null, configFile: null };
  }
  throw new Error("no tendril selected: set TENDRIL_API and TENDRIL_TOKEN, or pass --tendril <name>");
}

// Writes the handle returned by POST /api/tendrils or /api/adopt. Returns {name, path}.
// If `name` is taken by a different tendril, appends the id.
export function saveConfig(handle, wanted, env = process.env, server) {
  const dir = configDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let name = slug(wanted || handle.name);
  let p = configPath(name, env);
  if (existsSync(p)) {
    try {
      const old = JSON.parse(readFileSync(p, "utf8"));
      if (old.id && old.id !== handle.id) { name = `${name}-${handle.id}`; p = configPath(name, env); }
    } catch { /* overwrite unreadable file */ }
  }
  const data = {
    id: handle.id, name: handle.name, page_url: handle.page_url, api: handle.api, token: handle.token,
    lifetime: handle.lifetime, server: server || null, saved_at: new Date().toISOString(),
  };
  writeFileSync(p, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  chmodSync(p, 0o600);
  return { name, path: p };
}

export function removeConfig(cfg) {
  if (cfg.configFile && existsSync(cfg.configFile)) unlinkSync(cfg.configFile);
}

// Cursor files are keyed by tendril id and shared with scripts/tendril-wait.sh.
export function cursorPath(cfg, flags = {}, env = process.env) {
  if (flags["cursor-file"]) return flags["cursor-file"];
  if (env.TENDRIL_CURSOR_FILE) return env.TENDRIL_CURSOR_FILE;
  return join(configDir(env), "cursors", `${cfg.id || "default"}.cursor`);
}

export function readCursor(path) {
  try {
    const n = parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch { return 0; }
}

export function writeCursor(path, n) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${n}\n`);
}
