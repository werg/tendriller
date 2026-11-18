import { expect, it } from 'vitest';
import { DeadlineAlarm } from '../src/alarm';

function fixture(initial: number | null = null) {
  let time = initial, reads = 0, writes = 0, deletes = 0, fail = false;
  const storage = {
    async getAlarm() { reads++; return time; },
    async setAlarm(at: number | Date) {
      writes++;
      if (fail) { fail = false; throw new Error('Alarm storage unavailable'); }
      time = Number(at);
    },
    async deleteAlarm() { deletes++; time = null; },
  };
  return { scheduler: new DeadlineAlarm(storage), storage,
    stats: () => ({ time, reads, writes, deletes }), failNextWrite() { fail = true; } };
}

it('coalesces a concurrent message burst into one persisted alarm and advances urgent work', async () => {
  const f = fixture();
  await Promise.all(Array.from({ length: 100 }, (_, i) => f.scheduler.ensure(10_000 + i)));
  expect(f.stats()).toEqual({ time: 10_000, reads: 1, writes: 1, deletes: 0 });
  await Promise.all([f.scheduler.ensure(20_000), f.scheduler.ensure(5_000), f.scheduler.ensure(8_000)]);
  expect(f.stats()).toEqual({ time: 5_000, reads: 1, writes: 2, deletes: 0 });
});

it('recovers a retained deadline after eviction without postponing it or rewriting it', async () => {
  const f = fixture(1_000);
  await f.scheduler.ensure(2_000);
  const restarted = new DeadlineAlarm(f.storage);
  await restarted.ensure(3_000);
  expect(f.stats()).toEqual({ time: 1_000, reads: 2, writes: 0, deletes: 0 });
  await restarted.ensure(500);
  expect(f.stats().time).toBe(500);
  expect(f.stats().writes).toBe(1);
});

it('schedules the next deadline after an alarm is consumed, including queued work', async () => {
  const f = fixture();
  await Promise.all([f.scheduler.ensure(1_000), f.scheduler.fired(), f.scheduler.ensure(2_000)]);
  expect(f.stats()).toEqual({ time: 2_000, reads: 1, writes: 2, deletes: 0 });
  await f.scheduler.clear();
  expect(f.stats().time).toBeNull();
  await f.scheduler.ensure(3_000);
  expect(f.stats()).toEqual({ time: 3_000, reads: 1, writes: 3, deletes: 1 });
});

it('retries a failed alarm write instead of remembering an unpersisted deadline', async () => {
  const f = fixture();
  f.failNextWrite();
  await expect(f.scheduler.ensure(1_000)).rejects.toThrow('Alarm storage unavailable');
  await f.scheduler.ensure(2_000);
  expect(f.stats()).toEqual({ time: 2_000, reads: 1, writes: 2, deletes: 0 });
});

it('observes the pending platform retry after failure instead of replacing its backoff', async () => {
  // A failed invocation retains its original alarm time while awaiting retry.
  const f = fixture(1_000);
  await f.scheduler.fired();
  await f.scheduler.failed();
  await f.scheduler.ensure(2_000);
  expect(f.stats()).toEqual({ time: 1_000, reads: 1, writes: 0, deletes: 0 });
  await f.scheduler.fired();
  await f.scheduler.ensure(3_000);
  expect(f.stats()).toEqual({ time: 3_000, reads: 1, writes: 1, deletes: 0 });
});
