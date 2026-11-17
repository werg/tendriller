import { expect, it } from 'vitest';
import { readBody } from '../src/http';

it('rejects and cancels a stalled body without accepting its partial bytes', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('partial')); },
    cancel() { cancelled = true; },
  });
  const request = new Request('https://example.test/', { method: 'POST', body });
  await expect(readBody(request, 1024, 10)).rejects.toMatchObject({ status: 408, code: 'request_timeout' });
  expect(cancelled).toBe(true);
  expect(body.locked).toBe(false);
});

it('does not let an uncooperative stream cancel block a byte-limit rejection', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(33)); },
    cancel() { return new Promise<void>(() => {}); },
  });
  await expect(readBody(new Request('https://example.test/', { method: 'POST', body }), 32, 100))
    .rejects.toMatchObject({ status: 413, code: 'too_large' });
  expect(body.locked).toBe(false);
});

it('uses a total deadline even while partial chunks continue to arrive', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) { await new Promise(resolve => setTimeout(resolve, 4)); if (!cancelled) controller.enqueue(new Uint8Array([1])); },
    cancel() { cancelled = true; },
  });
  await expect(readBody(new Request('https://example.test/', { method: 'POST', body }), 1024, 15))
    .rejects.toMatchObject({ code: 'request_timeout' });
  expect(cancelled).toBe(true);
});

it('bounds empty fragments independently of bytes and the event-loop deadline', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array()); },
    cancel() { cancelled = true; },
  });
  await expect(readBody(new Request('https://example.test/', { method: 'POST', body }), 1024))
    .rejects.toMatchObject({ status: 413, code: 'too_fragmented' });
  expect(cancelled).toBe(true);
  expect(body.locked).toBe(false);
});

it('preserves complete bodies and handles cancellation before reading', async () => {
  expect(new TextDecoder().decode(await readBody(new Request('https://example.test/', { method: 'POST', body: 'complete' }), 32)))
    .toBe('complete');
  const abort = new AbortController();
  const request = new Request('https://example.test/', { method: 'POST', body: 'complete', signal: abort.signal });
  abort.abort(new Error('client left'));
  await expect(readBody(request, 32)).rejects.toThrow('client left');
});
