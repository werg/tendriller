import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, toPath, parseJsonArg } from "../lib/args.mjs";
import { pack, listFiles, isText, guessType, shouldSkip } from "../lib/pack.mjs";
import {
  resolveConfig, saveConfig, configDir, cursorPath, readCursor, writeCursor, idFromApi, slug, serverBase,
} from "../lib/config.mjs";
import { injectRuntime } from "../lib/preview.mjs";
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
  assert.throws(() => parseArgs(["-z"]), /unknown flag/);
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
  assert.equal(serverBase({}), "http://localhost:8787");
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
});

test("preview: runtime injected right after <head>", () => {
  const out = injectRuntime('<html><head lang="x"><title>t</title></head></html>');
  assert.match(out, /^<html><head lang="x"><script>window.__TENDRIL__=/);
  assert.match(out, /<script src="\/_tendril\/tendril.js"><\/script><title>/);
  assert.match(injectRuntime("<p>no head</p>"), /^<script>window.__TENDRIL__/);
});

test("qr renders when qrcode-generator resolves", () => {
  const q = terminalQr("http://localhost:8787/t/abc/s/key/");
  if (q === null) return; // optional dependency absent
  assert.ok(q.split("\n").length > 10);
});
