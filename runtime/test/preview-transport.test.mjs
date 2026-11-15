import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const source = await build({ entryPoints: [new URL("../src/preview.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "node", write: false });
const { createFixtureTransport } = await import(`data:text/javascript;base64,${Buffer.from(source.outputFiles[0].text).toString("base64")}`);
const tick = () => new Promise(resolve => queueMicrotask(resolve));

test("the public fixture boundary exchanges protocol frames and isolates replies", async () => {
  const fixture = createFixtureTransport();
  const sockets = [fixture.socket(), fixture.socket()];
  const messages = [[], []];
  sockets.forEach((socket, index) => { socket.onmessage = event => messages[index].push(JSON.parse(event.data)); });
  const sent = [];
  fixture.onSend((frame, reply) => { sent.push(frame); reply({ t: "ack", cid: frame.cid }); });
  await tick();
  sockets[0].send(JSON.stringify({ t: "send", cid: "original", expected_generations: {}, data: { session: "opaque" } }));
  await tick();
  assert.equal(sent[0].data.session, "opaque");
  assert.deepEqual(messages, [[{ t: "ack", cid: "original" }], []]);
  fixture.emit("location", { latitude: 42 });
  assert.deepEqual(messages[1], [{ t: "fixture_event", event: "location", data: { latitude: 42 } }]);
  fixture.disconnect();
  assert.equal(sockets.every(socket => socket.readyState === 3), true);
});
