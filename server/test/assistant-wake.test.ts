import { expect, it, vi } from 'vitest';
import { AssistantWake, type AssistantWork } from '../src/assistant-wake';

function fixture() {
  let state: AssistantWork | null = null;
  let now = 1_000;
  const persistence = {
    read: () => state,
    write: vi.fn((value: AssistantWork | null) => { state = value; }),
  };
  const reopen = () => new AssistantWake(persistence, () => now);
  const time = (at: number) => { now = at; };
  return { persistence, reopen, time };
}

it('does no work while idle, coalesces notices and opens retained work after restart', async () => {
  const f = fixture(), wake = f.reopen();
  const drain = vi.fn(async () => ({ more: false, nextDue: null }));
  expect(wake.deadline()).toBeNull();
  await wake.run(drain);
  expect(drain).not.toHaveBeenCalled();
  for (let i = 0; i < 100; i++) expect(wake.notify()).toBe(1_050);
  expect(f.persistence.write).toHaveBeenCalledTimes(1);

  const restarted = f.reopen();
  f.time(1_050);
  await restarted.run(drain);
  expect(drain).toHaveBeenCalledExactlyOnceWith(true);
  expect(restarted.deadline()).toBeNull();
});

it('does not acknowledge a wake that arrived while the captured history was draining', async () => {
  const f = fixture(), wake = f.reopen();
  wake.notify();
  f.time(1_050);
  await wake.run(async () => {
    wake.notify();
    wake.notify();
    return { more: false, nextDue: null };
  });
  expect(f.persistence.write).toHaveBeenCalledTimes(3);
  expect(wake.deadline()).toBe(1_150);
  f.time(1_150);
  await f.reopen().run(async observe => {
    expect(observe).toBe(true);
    return { more: false, nextDue: 4_000 };
  });
  f.time(4_000);
  const restarted = f.reopen();
  await restarted.run(async observe => {
    expect(observe).toBe(false);
    return { more: false, nextDue: null };
  });
  expect(restarted.deadline()).toBeNull();
});

it('backs off failed scans without forgetting their observation work', async () => {
  const f = fixture(), wake = f.reopen();
  wake.notify();
  f.time(1_050);
  await expect(wake.run(async () => { throw Error('peer unavailable'); })).rejects.toThrow('peer unavailable');
  expect(wake.deadline()).toBe(3_050);
  expect(wake.notify()).toBe(3_050);
  f.time(3_050);
  await f.reopen().run(async observe => {
    expect(observe).toBe(true);
    return { more: false, nextDue: null };
  });
});
