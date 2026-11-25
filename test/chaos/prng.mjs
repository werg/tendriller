// Deterministic, seedable PRNG for chaos runs. sfc32 seeded through splitmix32:
// small, fast, statistically adequate for test scheduling, and identical on every
// platform (only 32-bit integer arithmetic). Never use Math.random in a chaos plan.

const MAX_SEED = 0xffff_ffff;

export function parseSeed(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value).trim();
  const seed = /^0x[0-9a-f]+$/i.test(text) ? Number.parseInt(text, 16) : Number(text);
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > MAX_SEED) throw Error(`Seed must be an integer in [0, ${MAX_SEED}]: ${value}`);
  return seed;
}

/** A fresh seed for an unseeded run. The run prints and records it. */
export function randomSeed() {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

function splitmix32(state) {
  return () => {
    state = (state + 0x9e3779b9) | 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
}

function hashLabel(label) {
  // FNV-1a over UTF-16 code units: stable sub-stream names.
  let hash = 0x811c9dc5;
  for (let i = 0; i < label.length; i++) hash = Math.imul(hash ^ label.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}

export function createRng(seed) {
  if (parseSeed(seed) !== seed) throw Error('createRng requires a parsed 32-bit seed');
  const init = splitmix32(seed);
  let a = init(), b = init(), c = init(), d = init();
  let draws = 0;
  const nextU32 = () => {
    draws++;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return t >>> 0;
  };
  for (let i = 0; i < 12; i++) nextU32();
  draws = 0;
  const rng = {
    seed,
    get draws() { return draws; },
    u32: nextU32,
    /** Uniform float in [0, 1). */
    next: () => nextU32() / 0x1_0000_0000,
    /** Uniform integer in [min, max] (inclusive). */
    int(min, max) {
      if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min) throw Error(`Invalid integer range [${min}, ${max}]`);
      const span = max - min + 1;
      if (span > 0x1_0000_0000) throw Error('Integer range too large');
      // Rejection sampling avoids modulo bias.
      const limit = 0x1_0000_0000 - (0x1_0000_0000 % span);
      let value;
      do value = nextU32(); while (value >= limit);
      return min + (value % span);
    },
    chance(probability) { return rng.next() < probability; },
    pick(items) {
      if (!items.length) throw Error('Cannot pick from an empty list');
      return items[rng.int(0, items.length - 1)];
    },
    /** Pick one item with probability proportional to weight(item) (> 0). */
    weighted(items, weight = item => item.weight) {
      const weights = items.map(item => {
        const value = weight(item);
        if (!(Number.isFinite(value) && value >= 0)) throw Error('Weights must be finite and non-negative');
        return value;
      });
      const total = weights.reduce((sum, value) => sum + value, 0);
      if (!(total > 0)) throw Error('Cannot pick: no positive weight');
      let target = rng.next() * total;
      for (let i = 0; i < items.length; i++) {
        if (weights[i] === 0) continue;
        target -= weights[i];
        if (target < 0) return items[i];
      }
      return items.findLast((_, i) => weights[i] > 0);
    },
    /** An independent, reproducible sub-stream (e.g. per subsystem). */
    fork(label) { return createRng((nextU32() ^ hashLabel(String(label))) >>> 0); },
  };
  return rng;
}
