// Delta debugging (Zeller's ddmin) over an action log. `test(subset)` resolves
// true when the subset still reproduces the original failure signature. Real
// chaos trials are expensive, so results are cached and a trial budget applies.

function split(items, n) {
  const chunks = [];
  let start = 0;
  for (let i = 0; i < n; i++) {
    const end = start + Math.floor((items.length - start) / (n - i));
    chunks.push(items.slice(start, end));
    start = end;
  }
  return chunks.filter(chunk => chunk.length);
}

/**
 * @param {unknown[]} items Ordered entries (kept in original relative order).
 * @param {(subset: unknown[]) => Promise<boolean>} test
 * @param {{ budget?: number, key?: (item: unknown) => string, onTrial?: Function }} options
 * @returns {Promise<{ minimal: unknown[], trials: number, exhausted: boolean, history: object[] }>}
 */
export async function ddmin(items, test, { budget = Infinity, key = item => JSON.stringify(item), onTrial } = {}) {
  const cache = new Map();
  const history = [];
  let trials = 0, exhausted = false;
  const fails = async subset => {
    const id = subset.map(key).join('\u0000');
    if (cache.has(id)) return cache.get(id);
    if (trials >= budget) { exhausted = true; return false; }
    trials++;
    const failed = Boolean(await test(subset));
    cache.set(id, failed);
    history.push({ trial: trials, size: subset.length, failed });
    await onTrial?.({ trial: trials, size: subset.length, failed, subset });
    return failed;
  };
  let current = [...items], n = 2;
  while (current.length >= 2 && !exhausted) {
    const chunks = split(current, Math.min(n, current.length));
    let reduced = false;
    for (const chunk of chunks) {
      if (await fails(chunk)) { current = chunk; n = 2; reduced = true; break; }
      if (exhausted) break;
    }
    if (!reduced && !exhausted && chunks.length > 2) {
      for (let i = 0; i < chunks.length; i++) {
        const complement = chunks.filter((_, j) => j !== i).flat();
        if (await fails(complement)) { current = complement; n = Math.max(n - 1, 2); reduced = true; break; }
        if (exhausted) break;
      }
    }
    if (!reduced) {
      if (n >= current.length) break;
      n = Math.min(n * 2, current.length);
    }
  }
  // Final one-at-a-time pass: ddmin guarantees 1-minimality only when it
  // reached single-item granularity; make that explicit and cheap to read.
  for (let i = 0; i < current.length && current.length > 1 && !exhausted; ) {
    const without = current.filter((_, j) => j !== i);
    if (await fails(without)) current = without; else i++;
  }
  return { minimal: current, trials, exhausted, history };
}
