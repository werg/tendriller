import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createConnection } from "node:net";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { startServer } from "../lib/preview.mjs";

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "tendril-preview-shutdown-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Shutdown fixture</title>");
  const server = await startServer(dir);
  const port = server.address().port;
  const clients = new Set();
  const closed = new Map();
  const track = client => {
    clients.add(client);
    client.on("error", () => {}); // forced teardown may reset an incomplete request
    closed.set(client, new Promise(resolve => client.once("close", resolve)));
    return client;
  };
  t.after(async () => {
    // Also release peers after a failed assertion, so the regression itself cannot leak sockets.
    for (const client of clients) client instanceof WebSocket ? client.terminate() : client.destroy();
    await server.stopPreview();
    rmSync(dir, { recursive: true, force: true });
  });
  const tcp = async () => {
    const accepted = once(server, "connection");
    const client = track(createConnection({ host: "127.0.0.1", port }));
    client.resume();
    await Promise.all([once(client, "connect"), accepted]);
    return client;
  };
  const socket = () => track(new WebSocket(`ws://127.0.0.1:${port}/_tendril/ws`));
  return { server, tcp, socket, closed };
}

test("preview shutdown closes preconnects, partial HTTP, active uploads and upgraded sockets", { timeout: 5000 }, async t => {
  const { server, tcp, socket, closed } = await fixture(t);
  const preconnect = await tcp(); // Chromium may open this without sending any HTTP request.
  const headers = await tcp();
  headers.write("GET / HTTP/1.1\r\nHost: preview\r\n");

  const upload = await tcp();
  const request = once(server, "request");
  upload.write("POST /_tendril/blob HTTP/1.1\r\nHost: preview\r\nContent-Type: image/png\r\nContent-Length: 1000\r\n\r\npartial");
  await request; // The real upload handler is waiting for the rest of the body.

  // A raw upgraded peer never responds to a WebSocket close handshake.
  const upgraded = await tcp();
  const handshake = once(upgraded, "data");
  upgraded.write("GET /_tendril/ws HTTP/1.1\r\nHost: preview\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n");
  assert.match(String((await handshake)[0]), /^HTTP\/1\.1 101 /);
  const live = socket();
  await once(live, "open");

  await server.stopPreview();
  await Promise.all([preconnect, headers, upload, upgraded, live].map(client => closed.get(client)));
  assert.equal(server.listening, false);
  assert.equal(server.preview.online, false);
  assert.equal(await new Promise((resolve, reject) => server.getConnections((error, count) => error ? reject(error) : resolve(count))), 0);
  assert.equal(server.preview.blobs.size, 0, "an aborted upload must not become a stored capture");
});

test("preview shutdown stops admission immediately and shares one close promise during reconnect", { timeout: 5000 }, async t => {
  const { server, socket, closed } = await fixture(t);
  const live = socket();
  await once(live, "open");
  let reconnectOpened = false;
  const reconnected = closed.get(live).then(async () => {
    const retry = socket();
    retry.once("open", () => { reconnectOpened = true; });
    await closed.get(retry);
  });

  const stopping = server.stopPreview();
  assert.equal(server.listening, false, "the listener must close before waiting for existing clients");
  assert.strictEqual(server.stopPreview(), stopping);
  server.preview.setOnline(true);
  assert.equal(server.preview.online, false, "a fixture cannot reopen an adapter that is closing");
  const adapterClosed = server.preview.close();
  assert.strictEqual(server.preview.close(), adapterClosed);
  await Promise.all([stopping, adapterClosed, reconnected]);
  assert.equal(reconnectOpened, false);
  assert.strictEqual(server.stopPreview(), stopping);
  assert.strictEqual(server.preview.close(), adapterClosed);
});
