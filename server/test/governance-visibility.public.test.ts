import { describe, expect, it } from 'vitest';
import { create, inDO, req } from './helpers';
import { renderDashboardContent } from '../src/accounts/keys';

describe('Zero-OAuth public visibility and security UX', () => {
  it('exposes visibility in _tendril/info, renders public-access security notices on _tendril/manage, and keeps admin routes 403 for anonymous openPublic callers', async () => {
    const h = await create();

    // Default private page reports open_readers: false, open_writers: false
    const privateInfo = await (await req(h.page_url + '_tendril/info')).json() as {
      visibility?: { open_readers: boolean; open_writers: boolean };
    };
    expect(privateInfo.visibility).toEqual({ open_readers: false, open_writers: false });

    // Simulate synced openMembers (read-only) control state on the blind host
    await inDO(h.id, async t => {
      t.db.set('v2_open_readers', true);
      t.db.set('v2_open_writers', false);
    });

    // Anonymous visitor can read _tendril/info without OAuth
    const anonInfoRes = await req(h.page_url + '_tendril/info', { anonymous: true });
    expect(anonInfoRes.status).toBe(200);
    const anonInfo = await anonInfoRes.json() as { visibility?: { open_readers: boolean; open_writers: boolean } };
    expect(anonInfo.visibility).toEqual({ open_readers: true, open_writers: false });

    // Sensitive owner/management/MCP/connections/groups routes remain 403 for anonymous visitors
    for (const sub of ['_tendril/manage', '_tendril/mcp/grants', '_tendril/connections', '_tendril/groups']) {
      const denied = await req(h.page_url + sub, { anonymous: true });
      expect(denied.status).toBe(403);
    }

    // Owner _tendril/manage surfaces Public · Read-only card + embed snippet + privacy notice
    const roManageHtml = await (await req(h.page_url + '_tendril/manage')).text();
    expect(roManageHtml).toContain('Public · Read-only');
    expect(roManageHtml).toContain('Privacy notice:');
    expect(roManageHtml).toContain('Embed snippet');

    // Flip to open_writers: true and verify strong security warning appears
    await inDO(h.id, async t => {
      t.db.set('v2_open_writers', true);
    });
    const rwManageHtml = await (await req(h.page_url + '_tendril/manage')).text();
    expect(rwManageHtml).toContain('Public · Open contributions');
    expect(rwManageHtml).toContain('Security notice:');
  });

  it('renders clear visibility badges on dashboard cards for public read-only and open-write pages', () => {
    const rendered = renderDashboardContent({
      origin: 'https://tendriller.dev',
      who: 'owner@example.com',
      email: 'owner@example.com',
      planName: 'Free',
      planId: 'free',
      unlimitedHost: false,
      inGracePeriod: false,
      limits: { pages: 10, residents: 3, agents: 3 },
      tendrils: [
        { id: 'aaaaaaaaaaaa', lifetime: 'ad_hoc', state: 'active', created_at: Date.now() },
        { id: 'bbbbbbbbbbbb', lifetime: 'ad_hoc', state: 'active', created_at: Date.now() },
      ],
      summaries: [
        {
          name: 'Public Status', page_url: 'https://aaaaaaaaaaaa.pages.tendriller.dev/s/k/',
          version: 1, held: false, bytes: 1024, agents: 1, guests_waiting: 0,
          open_readers: true, open_writers: false, last_activity: null,
        },
        {
          name: 'Community Board', page_url: 'https://bbbbbbbbbbbb.pages.tendriller.dev/s/k/',
          version: 1, held: false, bytes: 1024, agents: 1, guests_waiting: 0,
          open_readers: true, open_writers: true, last_activity: null,
        },
      ],
      agents: [],
      grants: new Map(),
    });
    expect(rendered.body).toContain('Public · Read-only');
    expect(rendered.body).toContain('Public · Open write');
  });
});
