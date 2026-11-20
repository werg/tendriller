// Node-only private project state. This module is never bundled into the page.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createClient, requireServiceOrigin } from '@tendriller/core';

export const privateDirectory = new URL('./.tendriller/', import.meta.url);
export const devicePath = fileURLToPath(new URL('device.sqlite', privateDirectory));

export async function readPrivate(name, optional = false) {
  try { return JSON.parse(await readFile(new URL(name, privateDirectory), 'utf8')); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
}

// Provisioning records are write-once. In particular, a retry never replaces a
// signer, epoch key, pinned descriptor or already signed transition request.
export async function savePrivate(name, value) {
  await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
  const text = JSON.stringify(value, null, 2) + '\n';
  try { await writeFile(new URL(name, privateDirectory), text, { flag: 'wx', mode: 0o600, flush: true }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await readFile(new URL(name, privateDirectory), 'utf8');
    if (existing !== text) throw Error(`Refusing to replace saved setup record ${name}; inspect the original setup.`);
  }
  return value;
}

// Reviewed host delegation changes only the HTTP credential. The original
// setup handle, signed descriptor, device and operation journals stay intact.
export async function hostIdentity(service) {
  try {
    const origin = requireServiceOrigin(service);
    const [original, receipt, intent, descriptor, ownerPageText] = await Promise.all([
      readPrivate('handle.json', true), readPrivate('account-setup-result.json', true),
      readPrivate('account-setup.json', true), readPrivate('descriptor.json', true),
      readFile(new URL('owner-page-url.txt', privateDirectory), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; }),
    ]);
    let ownerPage;
    if (ownerPageText !== null) {
      try { ownerPage = new URL(ownerPageText.trim()); } catch {}
      if (!ownerPage || ownerPage.protocol !== 'https:' || ownerPage.username || ownerPage.password || ownerPage.search || ownerPage.hash ||
        !/^\/s\/[a-z2-7]{26}\/$/.test(ownerPage.pathname) || !/^([a-z2-7]{12})(?:\.|--p-)/.test(ownerPage.hostname))
        throw Error('The retained owner page URL is invalid. Copy the original existing page link from this service’s signed-in setup recovery dashboard.');
    }
    const ownerPageId = ownerPage && /^([a-z2-7]{12})(?:\.|--p-)/.exec(ownerPage.hostname)[1];
    const pageId = original?.id ?? receipt?.pageId ?? ownerPageId;
    const applicationId = original?.application?.id ?? intent?.applicationId ?? descriptor?.payload?.applicationId;
    if (!/^[a-z2-7]{12}$/.test(pageId ?? '') || !/^[a-f0-9]{64}$/.test(applicationId ?? ''))
      throw Error('Restore the original handle, save its public setup inspection, or retain its dashboard page link in .tendriller/owner-page-url.txt alongside the original signed descriptor. Do not prepare a new application.');
    if (original && original.api !== `${origin}/api/t/${pageId}` ||
      intent && (intent.serviceOrigin !== origin || intent.applicationId !== applicationId) ||
      descriptor && descriptor.payload?.applicationId !== applicationId ||
      ownerPage && (ownerPageId !== pageId || original?.page_url && original.page_url !== ownerPage.href ||
        receipt?.page?.page_url && receipt.page.page_url !== ownerPage.href) ||
      receipt && (receipt.serviceOrigin !== origin || receipt.pageId !== pageId || receipt.applicationId !== applicationId ||
        intent && (receipt.operationId !== intent.operationId || receipt.requestDigest !== intent.requestDigest || receipt.credentialCommitment !== intent.credentialCommitment)))
      throw Error('The retained service, page, application or setup operation differs. Preserve the records and inspect the original application before continuing.');
    return { serviceOrigin: origin, pageId, applicationId, pageUrl: original?.page_url ?? receipt?.page?.page_url ?? ownerPage?.href };
  } catch (error) {
    throw Object.assign(Error(error instanceof SyntaxError ? 'A private identity record is malformed. Restore its verified checkpoint before continuing.' : error.message), { code: 'host_identity_required' });
  }
}

export function requireHostHandle(handle, identity) {
  let page;
  try { page = new URL(handle?.page_url); } catch {}
  if (handle?.id !== identity.pageId || handle?.application?.id !== identity.applicationId ||
    handle?.api !== `${identity.serviceOrigin}/api/t/${identity.pageId}` || !/^tk_[a-z2-7]{32}$/.test(handle?.token ?? '') ||
    !page || page.protocol !== 'https:' || page.username || page.password || page.search || page.hash ||
    !page.hostname.startsWith(identity.pageId + '.') && !page.hostname.startsWith(identity.pageId + '--p-') ||
    !/^\/s\/[a-z2-7]{26}\/$/.test(page.pathname) || identity.pageUrl && handle.page_url !== identity.pageUrl)
    throw Object.assign(Error('The delegated handle does not match the retained service, page and application. Preserve the private response for inspection; no application identity was replaced.'), { code: 'host_handle_mismatch' });
  return handle;
}

export async function readHostHandle(optional = false) {
  try {
    const selected = await readPrivate('host-credential.json', true);
    if (!selected) return await readPrivate('handle.json', optional);
    if (selected.schemaVersion !== 1 || typeof selected.attemptId !== 'string') throw Error('Invalid reviewed credential selection.');
    return requireHostHandle(selected.handle, await hostIdentity(selected.serviceOrigin));
  } catch (error) {
    if (error instanceof SyntaxError) throw Object.assign(Error('A private host credential record is malformed. Preserve it and restore its verified checkpoint.'), { code: 'host_state_invalid' });
    throw error;
  }
}

export async function project({ signal } = {}) {
  const handle = await readHostHandle();
  return { handle, host: createClient(handle, { applicationId: handle.application.id,
    fetch: (url, options = {}) => fetch(url, { ...options,
      signal: AbortSignal.any([AbortSignal.timeout(30_000), ...[signal, options.signal].filter(Boolean)]) }),
  }) };
}
