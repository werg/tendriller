// Real-browser check of the built-in Page options → Application connections inspector:
// the link names its peer (agent @handle or the owner's other device), states the
// actual route and shows non-zero received application data in human units.
const RECEIVED = /Received (?!0 B)\d[\d.,]* (?:B|KB|MB|GB)/;

export async function expectConnectionInspector(page, { expect, name, transport, screenshot, label, timeout = 60_000 }) {
  const options = page.getByRole('button', { name: 'Page options', exact: true });
  await options.click();
  const region = page.getByRole('region', { name: 'Application connections' });
  const links = region.getByRole('list', { name: 'Connected devices' });
  const route = transport === 'relay' ? 'Via relay' : 'Direct connection';
  const link = links.getByRole('listitem').filter({ hasText: name });
  // Each Refresh is one explicit local sample; a just-replaced link may need a second one.
  await expect(async () => {
    await region.getByRole('button', { name: 'Refresh connection details' }).click();
    await expect(link).toContainText(route, { timeout: 2000 });
    await expect(link).toContainText(RECEIVED, { timeout: 2000 });
  }).toPass({ timeout });
  await expect(region.locator('[aria-live=polite]')).toContainText(/Connected to \d+ devices?\./);
  const text = await link.first().innerText();
  await region.scrollIntoViewIfNeeded();
  if (screenshot) await screenshot(page, label);
  await page.keyboard.press('Escape');
  await expect(options).toBeFocused();
  return text.replace(/\s+/g, ' ').trim();
}
