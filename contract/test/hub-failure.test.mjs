import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentHub } from '../hub.mjs';

const TOKEN = 'ta_' + 'a'.repeat(32);

test('a socket whose close() re-fires error synchronously is handled once and reconnects', async () => {
  // Node 22.15's undici WebSocket dispatches 'error' again from close() on a failed
  // connection. Handling each error by closing again recursed until the stack overflowed.
  const sockets = [];
  class FailingSocket extends EventTarget {
    constructor() { super(); this.closes = 0; sockets.push(this); queueMicrotask(() => this.dispatchEvent(new Event('error'))); }
    close() { this.closes++; if (this.closes < 1000) this.dispatchEvent(new Event('error')); }
    send() {}
  }
  const states = [];
  const hub = createAgentHub({ service: 'https://service.test', token: TOKEN, WebSocket: FailingSocket,
    probe: async () => false, retryMs: 5, maxRetryMs: 5 });
  hub.onStatus(value => states.push(value.state));
  hub.connect();
  await new Promise(resolve => setTimeout(resolve, 60));
  hub.close();
  assert.ok(sockets.length >= 2, 'the hub keeps reconnecting after a failed socket');
  for (const socket of sockets) assert.ok(socket.closes <= 2, `close() was called ${socket.closes} times on one socket`);
  assert.ok(states.includes('reconnecting'));
});

test('calling hub.socket() or hub.events() during reconnect backoff does not bypass retryTimer', async () => {
  const sockets = [];
  let allowOpen = false;
  class ControlledSocket extends EventTarget {
    constructor() {
      super();
      this.readyState = 0;
      this.sent = [];
      sockets.push(this);
      queueMicrotask(() => {
        if (allowOpen) {
          this.readyState = 1;
          this.dispatchEvent(new Event('open'));
        } else {
          this.readyState = 3;
          this.dispatchEvent(new Event('error'));
        }
      });
    }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; }
  }
  const hub = createAgentHub({
    service: 'https://service.test',
    token: TOKEN,
    WebSocket: ControlledSocket,
    probe: async () => false,
    retryMs: 80,
    maxRetryMs: 500,
  });
  hub.connect();
  // Let the initial socket fail and enter backoff (80ms).
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(sockets.length, 1);
  assert.equal(hub.state, 'reconnecting');

  // Opening virtual streams or registering listeners during backoff MUST NOT cancel retryTimer.
  const stream = hub.socket('aaaaaaaaaaaa', 'setup/watch', ['tendriller.setup.v1']);
  const offEvents = hub.events(() => {});
  const offBroadcasts = hub.broadcasts(() => {});
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(sockets.length, 1, 'watcher activity during backoff must not trigger immediate reconnects');

  // Once backoff expires and the server recovers, the queued stream opens automatically.
  allowOpen = true;
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(sockets.length, 2);
  assert.equal(hub.state, 'connected');
  assert.ok(sockets[1].sent.some(frame => frame.t === 'open' && frame.page === 'aaaaaaaaaaaa' && frame.path === 'setup/watch'));

  offEvents();
  offBroadcasts();
  stream.close();
  hub.close();
});
