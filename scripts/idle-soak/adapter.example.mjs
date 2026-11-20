// Copy outside the repository and tailor to YOUR isolated synthetic notes app. Enrollment is pre-completed.
// Fresh #count rendering follows liveView.refresh's actual coherent query. The editable fieldset is NOT readiness.
async function coherentRead(page, config) {
  if (!Number.isSafeInteger(config.expectedNoteCount) || config.expectedNoteCount < 0) throw Error('EXPECTED_SYNTHETIC_NOTE_COUNT_REQUIRED');
  await page.locator('#submit:enabled').waitFor({ timeout: 15000 });
  const updated = page.locator('#count').evaluate(element => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { observer.disconnect(); reject(Error('READ_RENDER_TIMEOUT')); }, 15000);
    const observer = new MutationObserver(() => { clearTimeout(timer); observer.disconnect(); resolve(element.textContent); });
    observer.observe(element, { childList: true, characterData: true, subtree: true });
  }));
  // Register the DOM observer before the explicit boundary query; never poll host state while idle.
  const [text] = await Promise.all([updated, page.locator('#refresh:enabled').click({ timeout: 10000 })]);
  if (!new RegExp('^' + config.expectedNoteCount + ' retained notes? in this selected history$').test(text)) throw Error('COHERENT_SYNTHETIC_READ_MISMATCH');
}
export async function ready({ page, config }) {
  await page.locator('#connect:enabled').click({ timeout: 15000 });
  await coherentRead(page, config);
}
export async function settle({ page, config }) { if (page) await coherentRead(page, config); }
export async function reconnect({ page, config, signal }) {
  signal.throwIfAborted();
  await page.locator('#close:enabled').click({ timeout: 10000 });
  await page.locator('#connect:enabled').click({ timeout: 10000 });
  await coherentRead(page, config);
  return true;
}
// Set true ONLY after instrumenting complete dispatch paths. Unknown counts remain null in evidence.
export async function audit() { return { modelTurns: false, wakeups: false }; }
// Optional external dispatch instrumentation: observe({record,signal}), event-driven, no health timers.
// record({source:'adapter',kind:'modelTurns',count:1}) at actual model dispatch, never at tool execution.
