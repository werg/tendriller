import { describe, expect, it } from 'vitest';
import { renderDashboardContent } from '../src/accounts/keys';

describe('Dashboard page creation UI', () => {
  it('omits agent-less starter creation form while keeping agent build prompt and Remix action', () => {
    const rendered = renderDashboardContent({
      origin: 'https://tendriller.example',
      who: 'alice@example.com',
      email: 'alice@example.com',
      planName: 'Free',
      planId: 'free',
      unlimitedHost: false,
      inGracePeriod: false,
      limits: { pages: 20, residents: 5, agents: 5 },
      mcpUsage: null,
      tendrils: [{ id: 'aaaaaaaaaaaa', lifetime: 'ad_hoc', state: 'active', created_at: Date.now() }],
      summaries: [{
        name: 'Research Notes',
        version: 2,
        bytes: 4096,
        agents: 0,
        page_url: 'https://aaaaaaaaaaaa.tendriller.example/',
        guests_waiting: 0,
        last_activity: null,
        held: false,
        icon: null,
        theme_color: null,
        open_readers: false,
        open_writers: false,
      }],
      agents: [],
      grants: new Map(),
      agentRevoked: false,
      deleted: false,
    });
    expect(rendered.body).not.toContain('action="/dashboard/pages/new"');
    expect(rendered.body).not.toContain('Browser-first (no agent required)');
    expect(rendered.body).not.toContain('instant-create-title');
    expect(rendered.body).toContain('id="build-prompt"');
    expect(rendered.body).toContain('action="/dashboard/t/aaaaaaaaaaaa/remix"');
  });
});
