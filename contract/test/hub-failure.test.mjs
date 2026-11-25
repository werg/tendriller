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
