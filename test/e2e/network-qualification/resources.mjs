/** Explicit per-container caps; normal local use must leave room for other work. */
export function networkLabResources({ memoryMiB = '1024', cpus = '1' } = {}) {
  const memory = Number(memoryMiB), cpuCount = Number(cpus);
  if (!Number.isSafeInteger(memory) || memory < 512 || memory > 4096)
    throw new Error('Network lab memory must be an integer between 512 and 4096 MiB');
  if (!Number.isFinite(cpuCount) || cpuCount < 0.25 || cpuCount > 2)
    throw new Error('Network lab CPUs must be between 0.25 and 2');
  const bytes = memory * 1024 ** 2;
  return { cpus: cpuCount, memoryBytes: bytes, memorySwapBytes: bytes,
    dockerArgs: [`--cpus=${cpuCount}`, `--memory=${bytes}`, `--memory-swap=${bytes}`] };
}
