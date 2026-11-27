import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { create, inDO } from './helpers';
import { createVersion, storeContent } from '../src/files';
import { sha256Hex } from '../src/ids';
import { createPageFromBlueprint, remixExistingPage } from '../src/owner-pages';

describe('One-click Remix / Fork isolation', () => {
  it('copies ONLY immutable public publication files with rewritten configuration.json and zero private state, and enforces owner/public boundaries', async () => {
    const h = await create();
    const ownerAccount = await inDO(h.id, t => t.db.get<string>('owner_account', ''));
    expect(ownerAccount).toBeTruthy();

    // Publish v1 files + store sensitive private DO data that must NEVER be copied on remix
    const htmlBytes = new TextEncoder().encode('<!doctype html><h1>Hello Remix</h1>');
    const cfgBytes = new TextEncoder().encode(JSON.stringify({ applicationId: h.application.id, page_url: h.page_url }));
    const htmlHash = await sha256Hex(htmlBytes);
    const cfgHash = await sha256Hex(cfgBytes);

    await inDO(h.id, async t => {
      await storeContent(t, htmlBytes.slice().buffer, 'text/html');
      await storeContent(t, cfgBytes.slice().buffer, 'application/json');
      await createVersion(t, new Map([
        ['index.html', { path: 'index.html', hash: htmlHash, type: 'text/html', size: htmlBytes.byteLength }],
        ['configuration.json', { path: 'configuration.json', hash: cfgHash, type: 'application/json', size: cfgBytes.byteLength }],
      ]), null, 'test', { entry: 'index.html', beforeCommit: async () => {}, commit() {} });
      t.db.run('INSERT OR REPLACE INTO mcp_store(k, v) VALUES (?, ?)', 'envelope/secret', new Uint8Array([1, 2, 3]).buffer);
      await t.createLink('guest', 'Secret guest', null);
    });

    // Non-owner CANNOT remix a private page
    await expect(
      remixExistingPage(env, 'acct_stranger_123', h.id),
    ).rejects.toMatchObject({ status: 403 });

    // Owner remixes cleanly via helper (same path as POST /dashboard/t/:id/remix)
    const remixed = await remixExistingPage(env, ownerAccount, h.id, { name: 'My Fork' });
    expect(remixed.id).not.toBe(h.id);
    expect(remixed.application.id).not.toBe(h.application.id);
    expect(remixed.version).toBe(1);
    expect(remixed.name).toBe('My Fork');

    // Verify zero private state leaked into the remixed DO
    const leakCheck = await inDO(remixed.id, t => ({
      mcpRows: t.db.all('SELECT k FROM mcp_store').length,
      links: t.db.all('SELECT id FROM links').length,
      grants: t.db.all('SELECT agent_id FROM agent_grants').length,
      publicOps: t.db.all('SELECT op_id FROM v2_public_ops').length,
      cfgFile: t.db.one<{ hash: string }>('SELECT hash FROM version_files WHERE version = 1 AND path = ?', 'configuration.json'),
    }));
    expect(leakCheck.mcpRows).toBe(0);
    expect(leakCheck.links).toBe(1); // Only its own l_main
    expect(leakCheck.grants).toBe(0); // Zero agent grants copied
    expect(leakCheck.publicOps).toBe(0);
    expect(leakCheck.cfgFile?.hash).toBeTruthy();

    // Verify configuration.json was rewritten to target the NEW applicationId & page_url
    const cfgObj = await env.FILES.get(`t/${remixed.id}/files/${leakCheck.cfgFile!.hash}`);
    expect(cfgObj).toBeTruthy();
    const parsedCfg = JSON.parse(await cfgObj!.text()) as { applicationId: string; page_url: string };
    expect(parsedCfg.applicationId).toBe(remixed.application.id);
    expect(parsedCfg.page_url).toBe(remixed.page_url);

    // Enabling open_readers allows another signed-in user to remix the public page cleanly
    await inDO(h.id, t => { t.db.set('v2_open_readers', true); });
    await env.ACCOUNTS.prepare('INSERT OR IGNORE INTO accounts (id, email, created_at) VALUES (?, ?, ?)').bind('acct_stranger_123', 'stranger@example.com', Date.now()).run();
    const publicRemix = await remixExistingPage(env, 'acct_stranger_123', h.id);
    expect(publicRemix.id).not.toBe(h.id);
    expect(publicRemix.version).toBe(1);

    // Launching from a portable PageBlueprint clones UI from sourcePageId with embedded blueprint & zero private data
    const fromBp = await createPageFromBlueprint(env, ownerAccount, {
      sourcePageId: h.id,
      blueprint: {
        format: 'tendriller-page-blueprint/v1',
        title: 'Portable SQL Tracker',
        reducers: { imports: {}, topics: { db: { module: 'chronolog/sql' } } },
        casModules: [],
        schemas: [{ topic: 'db', statements: ['CREATE TABLE items (id TEXT PRIMARY KEY)'], policies: {}, allowUserDdl: true }],
      },
      visibility: 'private',
    });
    expect(fromBp.name).toBe('Portable SQL Tracker');
    expect(fromBp.version).toBe(1);
    const bpCfgHash = await inDO(fromBp.id, t => t.db.one<{ hash: string }>('SELECT hash FROM version_files WHERE version = 1 AND path = ?', 'configuration.json'));
    const bpCfg = JSON.parse(await (await env.FILES.get(`t/${fromBp.id}/files/${bpCfgHash!.hash}`))!.text());
    expect(bpCfg.applicationId).toBe(fromBp.application.id);
    expect(bpCfg.blueprint?.format).toBe('tendriller-page-blueprint/v1');
    expect(bpCfg.blueprint?.schemas?.length).toBe(1);

    // Invalid blueprint rejects cleanly with 400
    await expect(
      createPageFromBlueprint(env, ownerAccount, { blueprint: { format: 'wrong' } }),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_blueprint' });
  });
});
