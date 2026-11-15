import { test, expect } from '@playwright/test';
import { load, calls } from './helpers';

const interfaceSpec = { title: 'A useful question', blocks: [{ id: 'status', type: 'status', text: 'First step' }, { id: 'note', type: 'text', label: 'Your observation' }, { id: 'sketch', type: 'drawing', label: 'Your sketch' }] };
async function mount(page) {
  await load(page, 'ui');
  await page.evaluate(spec => { const w = window as any; w.tendril.state.set('interface', spec); w.ui = w.tendrilSnippets.ui.mount('#app'); }, interfaceSpec);
}

async function mountControlledCamera(page, session = false) {
  await load(page);
  await page.evaluate(() => {
    const w = window as any; w.cameraFixture = { sessions: [] };
    w.tendrilSnippets = { camera: { async open(host: HTMLElement) {
      const video = document.createElement('video'); host.append(video);
      const session: any = { ready: 2, width: 320, height: 180, active: true, captures: 0, closes: 0 };
      Object.defineProperties(video, { readyState: { get: () => session.ready }, videoWidth: { get: () => session.width }, videoHeight: { get: () => session.height } });
      session.showFrame = () => { session.ready = 2; session.width = 320; session.height = 180; video.dispatchEvent(new Event('loadeddata')); };
      w.cameraFixture.sessions.push(session);
      return {
        video,
        async capture() {
          session.captures++; if (session.ready < 2) throw Error('Captured before the new frame was ready');
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 2;
          const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
          return { blob, width: 2, height: 2 };
        },
        async switch() {
          session.ready = 0; session.width = session.height = 0; session.active = false;
          await new Promise<void>(resolve => { session.finishSwitch = () => { session.active = true; session.ready = 1; session.width = 320; session.height = 180; resolve(); }; });
        },
        close() { session.active = false; session.closes++; video.remove(); },
      };
    } } };
  });
  await page.addScriptTag({ url: '/input-kit.js' });
  await page.evaluate(withSession => { const w = window as any; w.workflowSession = { scope: 'guide', id: 'old-session' }; w.tendrilSnippets.inputs.mount('#app', { modalities: ['photo'], ...(withSession ? { session: () => w.workflowSession } : {}) }); }, session);
}

test('adaptive blocks preserve text, focus and drawing when the agent changes a status', async ({ page }) => {
  await mount(page);
  await page.getByLabel('Your observation').fill('A half-written field note');
  await page.evaluate(() => {
    const w = window as any; w.original = document.querySelector('textarea');
    const canvas = document.querySelector('canvas')!; canvas.getContext('2d')!.fillRect(10, 10, 20, 20);
    w.tendril.state.set('interface.blocks.0.text', 'New status, same question');
  });
  await expect(page.getByLabel('Your observation')).toHaveValue('A half-written field note');
  await expect(page.getByLabel('Your observation')).toBeFocused();
  expect(await page.evaluate(() => ({ same: (window as any).original === document.querySelector('textarea'), pixel: document.querySelector('canvas')!.getContext('2d')!.getImageData(15, 15, 1, 1).data[3] }))).toEqual({ same: true, pixel: 255 });
  await expect(page.getByText('New status, same question')).toBeVisible();
});

test('disruptive layout waits; removed drafts survive an explicit update and return', async ({ page }) => {
  await mount(page); await page.getByLabel('Your observation').fill('Keep this draft');
  await page.evaluate(() => (window as any).tendril.state.set('interface.blocks', [{ id: 'status', type: 'status', text: 'Next step' }]));
  await expect(page.getByLabel('Your observation')).toHaveValue('Keep this draft');
  await page.getByRole('button', { name: 'Apply update', exact: true }).click();
  await expect(page.getByLabel('Your observation')).toHaveCount(0);
  await page.evaluate(spec => (window as any).tendril.state.set('interface', spec), interfaceSpec);
  await expect(page.getByLabel('Your observation')).toHaveValue('Keep this draft');
});

test('a publish waits for the user and restores draft text after remount', async ({ page }) => {
  await mount(page); await page.getByLabel('Your observation').fill('Saved before publish');
  expect(await page.evaluate(() => {
    const w = window as any; const event = new CustomEvent('tendril:before-reload', { cancelable: true, detail: { version: 2, apply: () => { w.applied = true; } } });
    window.dispatchEvent(event); return event.defaultPrevented;
  })).toBe(true);
  await page.getByRole('button', { name: 'Apply update', exact: true }).click();
  expect(await page.evaluate(() => (window as any).applied)).toBe(true);
  await page.evaluate(() => { const w = window as any; w.ui.destroy(); w.ui = w.tendrilSnippets.ui.mount('#app'); });
  await expect(page.getByLabel('Your observation')).toHaveValue('Saved before publish');
});

test('rejected adaptive input keeps its text and reports the rejection', async ({ page }) => {
  await mount(page); await page.getByLabel('Your observation').fill('Please retain me');
  await page.evaluate(() => { (window as any).tendril.send = async () => ({ status: 'rejected', queued: false, error: { message: 'Page quota reached' } }); });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByLabel('Your observation')).toHaveValue('Please retain me');
  await expect(page.getByText('Page quota reached')).toBeVisible();
});

test('an accepted input does not erase words typed while the send was pending', async ({ page }) => {
  await mount(page); await page.getByLabel('Your observation').fill('First observation');
  await page.evaluate(() => { (window as any).tendril.send = () => new Promise(resolve => { (window as any).finishSend = resolve; }); });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByLabel('Your observation').fill('First observation and another detail');
  await page.evaluate(() => (window as any).finishSend({ status: 'accepted', seq: 1, queued: false }));
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  await expect(page.getByLabel('Your observation')).toHaveValue('First observation and another detail');
});

test('photo capture waits for aim and review, then sends its question and point once', async ({ page }) => {
  await load(page, 'input-kit');
  await page.evaluate(() => (window as any).tendrilSnippets.inputs.mount('#app', { modalities: ['photo'] }));
  await page.getByRole('button', { name: 'Take photo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Capture photo', exact: true })).toBeVisible();
  expect((await calls(page)).upload).toHaveLength(0);
  await page.getByRole('button', { name: 'Capture photo', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Review your photo before sending' })).toBeVisible();
  expect((await calls(page)).send).toHaveLength(0);
  await page.getByRole('button', { name: 'Mark centre' }).click();
  await page.getByRole('textbox', { name: 'Question or note (optional)' }).fill('Which screw should I turn?');
  await page.getByRole('button', { name: 'Send photo', exact: true }).click();
  await expect.poll(async () => (await calls(page)).send.length).toBe(1);
  expect((await calls(page)).send[0].data).toMatchObject({ type: 'input', modality: 'photo', question: 'Which screw should I turn?', point: { x: .5, y: .5 }, blob: expect.any(String) });
  await page.evaluate(() => (window as any).tendril.__emit('say', { in_reply_to: 1, text: 'The screw at the marked point.' }));
  await expect(page.getByText('Agent: The screw at the marked point.')).toBeVisible();
});

test('retake, switch camera and discard never upload a photo', async ({ page }) => {
  await load(page, 'input-kit'); await page.evaluate(() => (window as any).tendrilSnippets.inputs.mount('#app', { modalities: ['photo'] }));
  await page.getByRole('button', { name: 'Take photo', exact: true }).click();
  await page.getByRole('button', { name: 'Switch camera' }).click();
  await page.getByRole('button', { name: 'Capture photo', exact: true }).click();
  await page.getByRole('button', { name: 'Retake photo' }).click();
  await page.getByRole('button', { name: 'Capture photo', exact: true }).click();
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  expect((await calls(page)).upload).toHaveLength(0); expect((await calls(page)).send).toHaveLength(0);
});

test('the shutter waits for switch completion and a current frame, not just metadata', async ({ page }) => {
  await mountControlledCamera(page); await page.getByRole('button', { name: 'Take photo', exact: true }).click();
  const shutter = page.getByRole('button', { name: 'Capture photo', exact: true });
  const switcher = page.getByRole('button', { name: 'Switch camera', exact: true });
  await expect(shutter).toBeEnabled(); await switcher.click();
  await expect(shutter).toBeDisabled(); await expect(switcher).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Cancel camera', exact: true })).toBeEnabled();
  await shutter.evaluate((button: HTMLButtonElement) => button.click());
  expect(await page.evaluate(() => (window as any).cameraFixture.sessions[0].captures)).toBe(0);
  await page.evaluate(() => (window as any).cameraFixture.sessions[0].finishSwitch());
  await expect(shutter).toBeDisabled();
  await page.evaluate(() => (window as any).cameraFixture.sessions[0].showFrame());
  await expect(shutter).toBeEnabled(); await shutter.click();
  await expect(page.getByRole('button', { name: 'Retake photo', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).cameraFixture.sessions[0].captures)).toBe(1);
  expect((await calls(page)).upload).toHaveLength(0);
});

test('cancelled switches and frame waits cannot reopen a camera or replace a newer capture session', async ({ page }) => {
  await mountControlledCamera(page);
  await page.getByRole('button', { name: 'Take photo', exact: true }).click();
  await page.getByRole('button', { name: 'Switch camera', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel camera', exact: true }).click();
  await page.getByRole('button', { name: 'Take photo', exact: true }).click();
  await page.evaluate(() => (window as any).cameraFixture.sessions[0].finishSwitch());
  await expect.poll(() => page.evaluate(() => (window as any).cameraFixture.sessions.map((s: any) => s.active))).toEqual([false, true]);
  await page.getByRole('button', { name: 'Switch camera', exact: true }).click();
  await page.evaluate(() => (window as any).cameraFixture.sessions[1].finishSwitch());
  await expect(page.getByRole('button', { name: 'Capture photo', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel camera', exact: true }).click();
  await page.evaluate(() => (window as any).cameraFixture.sessions[1].showFrame());
  await expect(page.getByRole('button', { name: 'Capture photo', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Take photo', exact: true }).click();
  await page.getByRole('button', { name: 'Capture photo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retake photo', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).cameraFixture.sessions.map((s: any) => s.captures))).toEqual([0, 0, 1]);
  expect((await calls(page)).upload).toHaveLength(0);
});

test('a storage failure with a capture id retains the local photo and question for retry', async ({ page }) => {
  await load(page, 'input-kit');
  await page.evaluate(() => {
    const w = window as any; w.originalUploadEvent = w.tendril.uploadEvent;
    w.tendril.uploadEvent = async () => ({ status: 'rejected', queued: false, error: 'storage_unavailable', capture_id: 'c_storage', message: 'This browser could not save the capture. Keep this page open and try again.' });
    w.tendrilSnippets.inputs.mount('#app', { modalities: ['photo'] });
  });
  await page.getByRole('button', { name: 'Take photo', exact: true }).click(); await page.getByRole('button', { name: 'Capture photo', exact: true }).click();
  await page.getByRole('textbox', { name: 'Question or note (optional)' }).fill('Keep this question with my photo');
  await page.getByRole('button', { name: 'Send photo', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Review your photo before sending' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Question or note (optional)' })).toHaveValue('Keep this question with my photo');
  await expect(page.getByRole('button', { name: 'Send photo', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Retry capture', exact: true })).toHaveCount(0);
  await page.evaluate(() => { const w = window as any; w.tendril.uploadEvent = w.originalUploadEvent; });
  await page.getByRole('button', { name: 'Send photo', exact: true }).click();
  await expect.poll(async () => (await calls(page)).send.length).toBe(1);
  expect((await calls(page)).send[0].data.question).toBe('Keep this question with my photo');
});

test('voice note supports recording duration, playback review, discard and explicit send', async ({ page }) => {
  await load(page, 'input-kit'); await page.evaluate(() => (window as any).tendrilSnippets.inputs.mount('#app', { modalities: ['audio'] }));
  await page.getByRole('button', { name: 'Record voice note' }).click();
  await expect(page.getByRole('timer')).toContainText('Recording');
  await page.waitForTimeout(350);
  await page.getByRole('button', { name: 'Stop and review' }).click();
  await expect(page.locator('audio[controls]')).toBeVisible();
  expect((await calls(page)).send).toHaveLength(0);
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  expect((await calls(page)).upload).toHaveLength(0);
  await page.getByRole('button', { name: 'Record voice note' }).click(); await page.waitForTimeout(350);
  await page.getByRole('button', { name: 'Stop and review' }).click();
  await page.getByRole('button', { name: 'Send voice note', exact: true }).click();
  await expect.poll(async () => (await calls(page)).send.length).toBe(1);
  expect((await calls(page)).send[0].data).toMatchObject({ modality: 'audio', duration_ms: expect.any(Number) });
});

test('reviewed capture retains the workflow session from capture time', async ({ page }) => {
  await mountControlledCamera(page, true);
  await page.getByRole('button', { name: 'Add photo', exact: true }).click();
  await page.getByRole('button', { name: 'Capture photo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Send photo', exact: true })).toBeVisible();
  await page.evaluate(() => { (window as any).workflowSession = { scope: 'guide', id: 'new-session' }; });
  await page.getByRole('button', { name: 'Send photo', exact: true }).click();
  expect((await calls(page)).send[0].data.session).toEqual({ scope: 'guide', id: 'old-session' });
});
