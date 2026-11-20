/** Bounded retry for observational reads only. Never wrap a fresh command or signed mutation. */
export async function readWithAdmissionRetry(read, { deadlineMs = 15000, pauseMs = 300 } = {}) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try { return await read(); }
    catch (error) {
      if (error.status !== 429 || Date.now() >= deadline) throw error;
      await new Promise(done => setTimeout(done, pauseMs));
    }
  }
}
