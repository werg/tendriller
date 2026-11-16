import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, statSync, readFileSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, toPath, parseJsonArg, intFlag } from "../lib/args.mjs";
import { pack, listFiles, isText, guessType, shouldSkip } from "../lib/pack.mjs";
import { syncAssets, verifyAssets } from "../lib/assets.mjs";
import {
  resolveConfig, saveConfig, configDir, cursorPath, checkpointPath, readCursor, writeCursor, idFromApi, slug, serverBase,
} from "../lib/config.mjs";
import { injectRuntime } from "../../preview/lib/preview.mjs";
import { terminalQr } from "../lib/qr.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "tendril-cli-"));

test("parseArgs: positional, value flags, boolean flags, = form, --", () => {
  const r = parseArgs(["new", "Kitchen", "--resident", "--pairing", "required", "--pretty"]);
  assert.equal(r.cmd, "new");
  assert.deepEqual(r.args, ["Kitchen"]);
  assert.deepEqual(r.flags, { resident: true, pairing: "required", pretty: true });
  const e = parseArgs(["eval", "-f", "x.js", "--device=all"]);
  assert.deepEqual(e.flags, { file: "x.js", device: "all" });
  const d = parseArgs(["eval", "--", "--not-a-flag"]);
  assert.deepEqual(d.args, ["--not-a-flag"]);
  assert.deepEqual(parseArgs(["events", "--follow=false"]).flags, { follow: false });
  assert.throws(() => parseArgs(["events", "--wait"]), /needs a value/);
  assert.throws(() => parseArgs(["events", "--wait", "--peek"]), /needs a value/);
  assert.throws(() => parseArgs(["eval", "-f", "--pretty"]), /needs a value/);
  assert.throws(() => parseArgs(["-z"]), /unknown flag/);
  assert.equal(intFlag("3", "limit", 100), 3);
  for (const value of ["", "NaN", "0.5", "9007199254740992"])
    assert.throws(() => intFlag(value, "limit", 100), /safe integer/);
});

test("toPath and parseJsonArg", () => {
  assert.deepEqual(toPath("list.a1.done"), ["list", "a1", "done"]);
  assert.deepEqual(toPath(["a", 1]), ["a", "1"]);
  assert.deepEqual(toPath(""), []);
  assert.deepEqual(parseJsonArg('{"a":1}'), { a: 1 });
  assert.equal(parseJsonArg("true"), true);
  assert.equal(parseJsonArg("hello world"), "hello world");
});

test("pack: directory skips dotfiles and node_modules, encodes binary as base64", () => {
  const d = tmp();
  writeFileSync(join(d, "index.html"), "<h1>héllo</h1>");
  writeFileSync(join(d, ".env"), "SECRET=1");
  mkdirSync(join(d, ".git")); writeFileSync(join(d, ".git", "HEAD"), "x");
  mkdirSync(join(d, "node_modules")); writeFileSync(join(d, "node_modules", "a.js"), "x");
  mkdirSync(join(d, "img")); writeFileSync(join(d, "img", "dot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]));
  writeFileSync(join(d, "app.js"), "tendril.send(1)");
  assert.deepEqual(listFiles(d), ["app.js", "img/dot.png", "index.html"]);
  const body = pack(d, { message: "m" });
  assert.equal(body.replace, true);
  assert.equal(body.message, "m");
  assert.equal(body.files["index.html"], "<h1>héllo</h1>");
  assert.equal(body.files["app.js"], "tendril.send(1)");
  assert.deepEqual(body.files["img/dot.png"], { base64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]).toString("base64"), type: "image/png" });
  assert.equal(pack(d, { merge: true }).replace, false);
});

test("pack: directory without index.html is refused unless merging", () => {
  const d = tmp();
  writeFileSync(join(d, "style.css"), "body{}");
  assert.throws(() => pack(d), /no index.html/);
  assert.deepEqual(pack(d, { merge: true }).files, { "style.css": "body{}" });
});

test("pack vendors declared components before publication and refuses modified copies", () => {
  const dir = tmp();
  writeFileSync(join(dir, "index.html"), '<script src="assets/components/chart.js"></script><script src="assets/components/stream-view.js"></script>');
  writeFileSync(join(dir, "tendril.json"), JSON.stringify({components:["chart","stream-view"]}));
  const first = pack(dir);
  const lock = JSON.parse(readFileSync(join(dir, "tendril.assets.json"), "utf8"));
  assert.ok(lock.files.some(file => file.path === "assets/components/chart.js"));
  assert.ok(lock.files.some(file => file.path === "assets/components/stream-view.js"));
  for (const file of lock.files) assert.ok(first.files[file.path], file.path);
  writeFileSync(join(dir, "tendril.assets.json"), JSON.stringify({...lock, core: []}));
  assert.throws(() => verifyAssets(dir), /does not match/);
  assert.doesNotThrow(() => pack(dir));
  writeFileSync(join(dir, "assets/components/chart.js"), "// local edits");
  assert.throws(() => pack(dir), /Modified or unmanaged component/);
  assert.ok(syncAssets(dir, {force:true}).written >= 1);
  assert.doesNotThrow(() => pack(dir));
  writeFileSync(join(dir,"tendril.json"),JSON.stringify({components:["chart"]}));
  assert.equal(pack(dir).files["assets/components/stream-view.js"],undefined);
});
test("asset sync refuses a symbolic link out of the page directory", () => {
  const dir = tmp(), outside = tmp();
  writeFileSync(join(dir, "tendril.json"), JSON.stringify({components:["chart"]}));
  symlinkSync(outside, join(dir, "assets"), "dir");
  assert.throws(() => syncAssets(dir), /symlink/);
  assert.equal(existsSync(join(outside, "components", "chart.js")), false);
});
test("asset sync rejects nested and dangling lock symlinks", () => {
  const dir = tmp(), outside = tmp();
  writeFileSync(join(dir, "index.html"), "<h1>safe</h1>");
  writeFileSync(join(dir, "tendril.json"), JSON.stringify({components:["chart"]}));
  mkdirSync(join(dir, "assets"));
  symlinkSync(outside, join(dir, "assets", "components"), "dir");
  assert.throws(() => pack(dir), /symlink/);
  assert.equal(existsSync(join(outside, "chart.js")), false);

  const other = tmp();
  writeFileSync(join(other, "tendril.json"), JSON.stringify({components:["chart"]}));
  symlinkSync(join(other, "missing-lock.json"), join(other, "tendril.assets.json"));
  assert.throws(() => pack(other), /Asset lock must not be a symlink/);
});
test("pack: single html file becomes index.html; --as overrides", () => {
  const d = tmp();
  const f = join(d, "page.html");
  writeFileSync(f, "<p>x</p>");
  assert.deepEqual(pack(f).files, { "index.html": "<p>x</p>" });
  assert.equal(pack(f).replace, undefined);
  assert.deepEqual(Object.keys(pack(f, { as: "other.html" }).files), ["other.html"]);
});

test("pack helpers", () => {
  assert.equal(isText(Buffer.from("abc")), true);
  assert.equal(isText(Buffer.from([0xff, 0xfe, 0x00])), false);
  assert.equal(guessType("a/b.SVG"), "image/svg+xml");
  assert.equal(guessType("x.unknown"), "application/octet-stream");
  assert.equal(shouldSkip("_tendril/x.js"), true);
  assert.equal(shouldSkip("a/.hidden/b"), true);
  assert.equal(shouldSkip("a/b.js"), false);
});

test("config: env vars, named config files (mode 600), precedence", () => {
  const dir = tmp();
  const env = { TENDRIL_CONFIG_DIR: dir, HOME: dir };
  assert.throws(() => resolveConfig({}, env), /no tendril selected/);
  const e = resolveConfig({}, { ...env, TENDRIL_API: "http://h/api/t/abc234abc234/", TENDRIL_TOKEN: "tk_x" });
  assert.equal(e.api, "http://h/api/t/abc234abc234");
  assert.equal(e.id, "abc234abc234");
  const handle = { id: "abc234abc234", name: "Kitchen Tablet", page_url: "http://h/t/abc/s/k/", api: "http://h/api/t/abc234abc234", token: "tk_y", lifetime: "resident" };
  const saved = saveConfig(handle, undefined, env, "http://h");
  assert.equal(saved.name, "kitchen-tablet");
  assert.equal(statSync(saved.path).mode & 0o777, 0o600);
  const c = resolveConfig({ tendril: "kitchen-tablet" }, env);
  assert.equal(c.token, "tk_y");
  assert.equal(c.configName, "kitchen-tablet");
  // --tendril wins over env
  assert.equal(resolveConfig({ tendril: "kitchen-tablet" }, { ...env, TENDRIL_API: "http://o/api/t/zz", TENDRIL_TOKEN: "tk_o" }).token, "tk_y");
  // TENDRIL_NAME works too
  assert.equal(resolveConfig({}, { ...env, TENDRIL_NAME: "kitchen-tablet" }).id, "abc234abc234");
  // same name, different tendril -> suffixed; same tendril -> overwritten
  const other = saveConfig({ ...handle, id: "zzzzzzzzzzzz" }, "Kitchen Tablet", env);
  assert.equal(other.name, "kitchen-tablet-zzzzzzzzzzzz");
  assert.equal(saveConfig({ ...handle, token: "tk_new" }, "kitchen-tablet", env).name, "kitchen-tablet");
  assert.equal(JSON.parse(readFileSync(saved.path, "utf8")).token, "tk_new");
  assert.throws(() => resolveConfig({ tendril: "missing" }, env), /no config/);
  assert.throws(() => resolveConfig({ tendril: "../etc" }, env), /bad tendril name/);
});

test("config: dirs, server base, cursor files", () => {
  assert.equal(configDir({ HOME: "/home/u" }), "/home/u/.config/tendril");
  assert.equal(configDir({ HOME: "/home/u", XDG_CONFIG_HOME: "/x" }), "/x/tendril");
  assert.equal(serverBase({}), "https://tendriller.dev");
  assert.equal(serverBase({ TENDRIL_SERVER: "https://t.example/" }), "https://t.example");
  assert.equal(serverBase({ TENDRIL_SERVER: "https://a" }, { server: "https://b" }), "https://b");
  assert.equal(idFromApi("https://x/api/t/abcd/"), "abcd");
  assert.equal(slug("  Road Trip!! "), "road-trip");
  const dir = tmp();
  const p = cursorPath({ id: "abc" }, {}, { TENDRIL_CONFIG_DIR: dir });
  assert.equal(p, join(dir, "cursors", "abc.cursor"));
  assert.equal(readCursor(p), 0);
  writeCursor(p, 42);
  assert.equal(readCursor(p), 42);
  assert.equal(cursorPath({ id: "abc" }, { "cursor-file": "/c" }, {}), "/c");
  const cfg = { id: "abc", api: "https://example.test/api/t/abc", configFile: "/configs/page.json" };
  assert.equal(checkpointPath(cfg, {}, {}), "/configs/page.json.events.json");
  assert.equal(checkpointPath(cfg, { "checkpoint-file": "/custom" }, {}), "/custom");
  assert.equal(checkpointPath(cfg, {}, { TENDRIL_CHECKPOINT_FILE: "/env" }), "/env");
  const withoutFile = { ...cfg, configFile: null };
  assert.notEqual(checkpointPath(withoutFile, {}, { HOME: dir }), checkpointPath({ ...withoutFile, api: "https://other.test/api/t/abc" }, {}, { HOME: dir }));
});

test("preview: runtime injected right after <head>", () => {
  const out = injectRuntime('<html><head lang="x"><title>t</title></head></html>');
  assert.match(out, /^<html><head lang="x"><base href="[^"]+"><script>window.__TENDRIL__=/);
  assert.match(out, /<script src="\/_tendril\/runtime\/[a-f0-9]+\/tendril.js"><\/script><script>/);
  assert.match(out, /fixture_event|_preview\/events/); // public fixture transport boundary
  assert.match(injectRuntime("<p>no head</p>"), /^<base href="[^"]+"><script>window.__TENDRIL__/);
});

test("qr renders when qrcode-generator resolves", () => {
  const q = terminalQr("http://localhost:8787/t/abc/s/key/");
  if (q === null) return; // optional dependency absent
  assert.ok(q.split("\n").length > 10);
});
