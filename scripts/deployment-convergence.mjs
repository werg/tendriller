/** Bounded post-deploy propagation only; never a runtime health/agent polling loop. */
export async function deploymentConvergence(readAndVerify, { attempts = 15, delayMs = 2000,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { return await readAndVerify(); }
    catch (error) { last = error; }
    if (attempt + 1 < attempts) await wait(delayMs);
  }
  throw last ?? Error('Deployment identity did not converge');
}
