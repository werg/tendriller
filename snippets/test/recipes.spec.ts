import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { load, calls } from './helpers';

async function recipe(page, name: string, role = 'owner', initial: object = {}) {
  await load(page);
  const html = readFileSync(new URL(`../../recipes/${name}/index.html`, import.meta.url), 'utf8');
  const setup = `<script>tendril.device.role=${JSON.stringify(role)};for(const [key,value] of Object.entries(${JSON.stringify(initial)}))tendril.state.set(key,value);</script>`;
  await page.route('**/recipe.html', route => route.fulfill({ contentType: 'text/html', body: html.replace(/<script(?=[ >])/, setup+'<script') }));
  await page.goto('/recipe.html');
}

test('hands-free guide saves checkpoints and resumes the same step after reload', async ({ page }) => {
  await recipe(page, 'hands-free-guide');
  await expect(page.locator('#step-title')).toHaveText('Set out what you need');
  await expect(page.locator('#back')).toBeDisabled();
  await page.locator('#done').click();
  await expect(page.locator('#step-title')).toHaveText('Show where you are');
  expect((await calls(page)).send[0].data).toMatchObject({ type: 'checkpoint', step_id: 'prepare', completed: true });
  await page.locator('#back').click(); await expect(page.locator('#done')).toHaveText('Next step');
  await page.locator('#done').click(); await expect(page.locator('#step-title')).toHaveText('Show where you are');
  expect((await calls(page)).send).toHaveLength(1);
  const progress = await page.evaluate(() => (window as any).tendril.state.get('guide_progress'));
  await recipe(page, 'hands-free-guide', 'owner', { guide_progress: progress });
  await expect(page.locator('#step-title')).toHaveText('Show where you are');
  await expect(page.locator('#count')).toHaveText('1 of 3 steps complete');
  await page.locator('#read').click();
  expect((await calls(page)).speech[0]).toContain('Show where you are');
});

test('guests can follow a guide without changing shared checkpoints', async ({ page }) => {
  await recipe(page, 'hands-free-guide', 'guest');
  await expect(page.locator('#done')).toBeDisabled(); await expect(page.locator('#steps button').first()).toBeDisabled();
  await expect(page.locator('#read')).toBeEnabled();
  expect((await calls(page)).send).toHaveLength(0);
});

test('facilitated participant saves privately and edits with the returned revision', async ({ page }) => {
  let response: any = null; const requests: any[] = [];
  await page.route('**/_tendril/responses', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { participant: 'guest-1', responses: response ? [response] : [] } });
    const data = route.request().postDataJSON(); requests.push(data);
    if (response && data.expected_revision !== response.revision) return route.fulfill({ status: 409, json: { error: { message: 'Response changed' } } });
    response = { id: 'response-1', participant: 'guest-1', ...data, revision: (response?.revision || 0) + 1 };
    return route.fulfill({ json: { response } });
  });
  await recipe(page, 'facilitated-session', 'guest');
  await page.locator('#answer').fill('Please keep meeting-free mornings'); await page.locator('#send').click();
  await expect(page.locator('#status')).toContainText('Private response saved');
  expect(requests[0]).toMatchObject({ prompt_id: 'opening', answer: 'Please keep meeting-free mornings' });
  expect((await calls(page)).state.some((call: any) => JSON.stringify(call).includes('meeting-free'))).toBe(false);
  expect((await calls(page)).send).toHaveLength(0);
  await page.locator('#answer').fill('Keep two meeting-free mornings'); await page.locator('#send').click();
  await expect(page.locator('#saved')).toHaveText('Saved revision 2'); expect(requests[1].expected_revision).toBe(1);
  await expect(page.locator('#facilitator')).toBeHidden();
});

test('shared display reads public prompt and summary without requesting private responses', async ({ page }) => {
  let privateRequests = 0; page.on('request', request => { if (request.url().includes('/_tendril/responses')) privateRequests++; });
  await recipe(page, 'facilitated-session', 'display', { facilitation: { stage: 'discuss', prompt: { id: 'round-1', text: 'What did we learn?' }, summary: 'The group wants clearer next steps.' } });
  await expect(page.locator('#prompt')).toHaveText('What did we learn?'); await expect(page.locator('#summary')).toHaveText('The group wants clearer next steps.');
  await expect(page.locator('#participate')).toBeHidden(); await expect(page.locator('#facilitator')).toBeHidden(); expect(privateRequests).toBe(0);
});

test('a private response conflict can refresh the saved revision without erasing the local draft', async ({ page }) => {
  let response: any = { id: 'r1', participant: 'guest-1', prompt_id: 'opening', answer: 'Original answer', revision: 1 };
  const requests: any[] = [];
  await page.route('**/_tendril/responses', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { participant: 'guest-1', responses: [response] } });
    const data = route.request().postDataJSON(); requests.push(data);
    if (data.expected_revision !== response.revision) return route.fulfill({ status: 409, json: { error: { message: 'Response changed on another device' } } });
    response = { ...response, ...data, revision: response.revision + 1 }; return route.fulfill({ json: response });
  });
  await recipe(page, 'facilitated-session', 'guest'); await expect(page.locator('#answer')).toHaveValue('Original answer');
  await page.locator('#answer').fill('My considered local draft');
  response = { ...response, answer: 'A newer answer from another device', revision: 2 };
  await page.locator('#send').click(); await expect(page.locator('#status')).toContainText('Response changed');
  await page.locator('#refresh').click(); await expect(page.locator('#saved-response')).toHaveText('A newer answer from another device');
  await expect(page.locator('#answer')).toHaveValue('My considered local draft');
  await page.locator('#send').click(); await expect(page.locator('#saved')).toHaveText('Saved revision 3');
  expect(requests.at(-1).expected_revision).toBe(2);
  expect((await calls(page)).send).toHaveLength(0);
});

test('facilitator publishes only the edited summary to shared state', async ({ page }) => {
  await page.route('**/_tendril/responses', route => route.fulfill({ json: { participant: 'owner-1', responses: [] } }));
  await page.route('**/_tendril/responses/all', route => route.fulfill({ json: { responses: [{ id: 'r1', prompt_id: 'opening', answer: 'Private detail from participant', revision: 1 }] } }));
  await recipe(page, 'facilitated-session', 'owner');
  await page.locator('#review').click(); await expect(page.locator('#responses')).toContainText('Private detail from participant');
  await page.locator('#summary-draft').fill('We want more time for focused work.'); await page.locator('#summary-form button').click();
  await expect(page.locator('#summary')).toHaveText('We want more time for focused work.');
  const state = await page.evaluate(() => (window as any).tendril.state.get());
  expect(JSON.stringify(state)).not.toContain('Private detail from participant'); expect(state.facilitation.stage).toBe('discuss');
});
