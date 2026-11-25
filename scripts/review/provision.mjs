import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Explicitly provision the OPTIONAL native participant from the already-initialized browser owner.
 * The browser never receives the native private key, and the native process never creates a root,
 * membership or data key: it proves its own signing key for the account-bound challenge, then imports
 * a package wrapped to exactly that recipient. Every step uses public records only.
 */
export async function provisionNative({ page, run, project, timeoutMs = 60000 }) {
  const { publicKey } = JSON.parse(run(['init-device']));
  if (!/^[a-f0-9]{64}$/.test(publicKey ?? '')) throw Error('NATIVE_DEVICE_KEY_INVALID');
  const status = (pattern) => page.locator('[data-provisioning="status"]').filter({ hasText: pattern }).waitFor({ timeout: timeoutMs });
  const out = page.locator('#transfer-out'), incoming = page.locator('#transfer-in');
  await page.locator('#provisioning summary').click();
  await page.getByLabel('Public signing key from that retained device').fill(publicKey);
  await page.getByRole('button', { name: 'Create account-bound challenge for this key' }).click();
  await status(/public account-bound challenge/);
  const challengePath = join(project, 'native-challenge.json');
  writeFileSync(challengePath, await out.inputValue(), { mode: 0o600 });
  await incoming.fill(run(['sign-enrollment', challengePath]).trim());
  await page.getByRole('button', { name: 'Record external signed enrollment proof from incoming field' }).click();
  await status(/External key proof recorded/);
  await incoming.fill(run(['provisioning-request']).trim());
  await page.getByRole('button', { name: 'Review recipient fingerprint' }).click();
  await status(/Review recipient fingerprint: [a-f0-9]{64}/);
  await page.getByRole('button', { name: 'Grant reviewed rights and wrap keys' }).click();
  await status(/Recipient-bound encrypted key package created/);
  const packagePath = join(project, 'native-provisioning.json');
  writeFileSync(packagePath, await out.inputValue(), { mode: 0o600 });
  const imported = JSON.parse(run(['import-provisioning', packagePath]));
  if (imported.imported !== true) throw Error('NATIVE_PROVISIONING_NOT_IMPORTED');
  return { publicKey, package: readFileSync(packagePath).length > 0 };
}
