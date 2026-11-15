/** Word error rate: insertions, deletions and substitutions over reference words. */
export function wordErrorRate(reference, actual) {
  const words = value => String(value).toLowerCase().replace(/[^a-z0-9\s']/g, " ").trim().split(/\s+/).filter(Boolean);
  const expected = words(reference), observed = words(actual);
  let previous = Array.from({ length: observed.length + 1 }, (_, index) => index);
  for (let i = 0; i < expected.length; i++) {
    const row = [i + 1];
    for (let j = 0; j < observed.length; j++) row.push(Math.min(row[j] + 1, previous[j + 1] + 1, previous[j] + (expected[i] === observed[j] ? 0 : 1)));
    previous = row;
  }
  return expected.length ? previous.at(-1) / expected.length : observed.length ? Infinity : 0;
}
