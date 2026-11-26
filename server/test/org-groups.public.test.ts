import { expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import {
  createSigningIdentity,
  encodeRecord,
  epochKeyCommitment,
  signAppDescriptor,
  signEnrollmentRequest,
  signMembership,
  signRecord,
} from '@chronolog/authority';
import { generateWrapKeyPair } from '../src/mcp-crypto';
import { authorityRecord } from '../../contract/authority.mjs';
import { create, inDO, req } from './helpers';
import { sha256Hex } from '../src/ids';
import { GROUP_POLICY_DOMAIN, recordGoogleWorkspaceDomain, syncGitHubOrgGroups } from '../src/groups/org-groups';
import { applyPlanToAccount } from '../src/billing/entitlements';

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  return Array.from(sig, b => b.toString(16).padStart(2, '0')).join('');
}

async function initPageAuthority(h: Awaited<ReturnType<typeof create>>) {
  const ownerId = await createSigningIdentity();
  const ownerWrap = await generateWrapKeyPair();
  const appMetaRes = await req(`${h.page_url}_tendril/application`);
  const appMeta = await appMetaRes.json() as {
    selection: { id: string };
    hostAttestationKey: string;
    admissionAccounts: string[];
  };
  const digest = 'aa'.repeat(32);
  await req(`${h.page_url}_tendril/application`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ executionManifestDigest: digest, executionProfile: 'events-v1', publisherKeys: [ownerId.publicKey] }),
  });
  const epochKey = crypto.getRandomValues(new Uint8Array(32));
  const descriptor = await signAppDescriptor({
    applicationId: appMeta.selection.id,
    rootPrincipal: ownerId.publicKey,
    authorityPublicKey: ownerId.publicKey,
    executionManifestDigest: digest,
    finalityPolicy: { kind: 'none' },
  }, ownerId);
  const membership = await signMembership({
    applicationId: appMeta.selection.id,
    revision: 0,
    previous: null,
    authorTimeAfterMs: -1n,
    epoch: 0,
    epochKeyDigest: await epochKeyCommitment(appMeta.selection.id, 0, epochKey),
    members: [{
      publicKey: ownerId.publicKey,
      wrapKey: ownerWrap.publicKeyHex,
      reader: true,
      writer: true,
      administrator: true,
      publisher: true,
      finalizer: false,
    }],
    admission: {
      mode: 'attested',
      hostKey: appMeta.hostAttestationKey,
      accounts: appMeta.admissionAccounts,
      grant: { reader: true, writer: true, administrator: true },
    },
    admitted: [],
    invites: [],
  }, ownerId);
  const initRes = await req(`${h.page_url}_tendril/peers/enrollment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'initialize', bundle: authorityRecord(encodeRecord({ descriptor, memberships: [membership] })) }),
  });
  expect(initRes.status).toBe(200);
  return { ownerId, ownerWrap, applicationId: appMeta.selection.id, hostKey: appMeta.hostAttestationKey };
}

async function createUserWithGitHub(ghUserId: number, login: string, email: string) {
  const accountId = crypto.randomUUID();
  const now = Date.now();
  const rawSession = `svc-${crypto.randomUUID()}`;
  await env.ACCOUNTS!.batch([
    env.ACCOUNTS!.prepare('INSERT INTO accounts (id, created_at, email) VALUES (?, ?, ?)').bind(accountId, now, email),
    env.ACCOUNTS!.prepare("INSERT INTO identities (provider, subject, account_id, login, email, created_at) VALUES ('github', ?, ?, ?, ?, ?)")
      .bind(String(ghUserId), accountId, login, email, now),
    env.ACCOUNTS!.prepare("INSERT INTO identity_emails (provider, subject, email) VALUES ('github', ?, ?)").bind(String(ghUserId), email),
    env.ACCOUNTS!.prepare('INSERT INTO sessions (hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .bind(await sha256Hex(rawSession), accountId, now, now + 86_400_000),
  ]);
  return { accountId, cookie: `__Host-tendriller=${rawSession}` };
}

it('records Google Workspace hd domains (excluding consumer gmail.com) and syncs GitHub orgs/teams', async () => {
  const acc = crypto.randomUUID();
  const now = Date.now();
  await env.ACCOUNTS!.batch([
    env.ACCOUNTS!.prepare('INSERT INTO accounts (id, created_at, email) VALUES (?, ?, ?)').bind(acc, now, 'alice@acme.com'),
    env.ACCOUNTS!.prepare("INSERT INTO identities (provider, subject, account_id, login, email, created_at) VALUES ('google', 'g-sub-1', ?, 'alice', 'alice@acme.com', ?)").bind(acc, now),
    env.ACCOUNTS!.prepare("INSERT INTO identities (provider, subject, account_id, login, email, created_at) VALUES ('github', '9001', ?, 'alicegh', 'alice@acme.com', ?)").bind(acc, now),
  ]);

  await recordGoogleWorkspaceDomain(env, 'g-sub-1', acc, 'gmail.com');
  expect((await env.ACCOUNTS!.prepare('SELECT group_id FROM identity_groups WHERE account_id = ?').bind(acc).all()).results).toEqual([]);

  await recordGoogleWorkspaceDomain(env, 'g-sub-1', acc, 'Acme.COM');
  const gRows = await env.ACCOUNTS!.prepare('SELECT group_id FROM identity_groups WHERE account_id = ?').bind(acc).all<{ group_id: string }>();
  expect(gRows.results.map(r => r.group_id)).toEqual(['google-domain:acme.com']);

  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes('/user/orgs')) return Response.json([{ login: 'Acme' }]);
    if (url.includes('/user/teams') && !url.includes('page=2')) {
      return new Response(JSON.stringify([{ slug: 'eng', name: 'Engineering', organization: { login: 'Acme' } }]), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          Link: '<https://api.github.com/user/teams?per_page=100&page=2>; rel="next"',
        },
      });
    }
    if (url.includes('/user/teams') && url.includes('page=2')) {
      return Response.json([{ slug: 'platform', name: 'Platform', organization: { login: 'Acme' } }]);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  try {
    const synced = await syncGitHubOrgGroups(env, '9001', acc, 'gho_token');
    expect(synced.groups.sort()).toEqual(['github-org:acme', 'github-team:acme/eng', 'github-team:acme/platform']);
    expect(synced.departed).toEqual([]);
  } finally {
    fetchMock.mockRestore();
  }
});

it('admin-signed group policy admits verified org members seamlessly on the page URL and offboards them seamlessly on GitHub org webhook', async () => {
  const h = await create({ name: 'Acme Eng Board' });
  const { ownerId, applicationId } = await initPageAuthority(h);

  // Reject a policy signed by a non-administrator key
  const rogue = await createSigningIdentity();
  const forged = await signRecord(GROUP_POLICY_DOMAIN, {
    pageId: h.id,
    applicationId,
    revision: 0,
    rules: [{ ruleId: 'r_eng', group: 'github-team:acme/eng', role: 'writer' }],
    updatedAt: Date.now(),
  }, rogue);
  expect((await req(`${h.page_url}_tendril/groups/policy`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ policy: forged }),
  })).status).toBe(403);

  // Owner administrator signs the real group policy: Free tier is gated (402), Team tier succeeds (200)
  const signedPolicy = await signRecord(GROUP_POLICY_DOMAIN, {
    pageId: h.id,
    applicationId,
    revision: 0,
    rules: [{ ruleId: 'r_eng', group: 'github-team:acme/eng', role: 'writer', label: 'Acme Engineering' }],
    updatedAt: Date.now(),
  }, ownerId);
  expect((await req(`${h.page_url}_tendril/groups/policy`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ policy: signedPolicy }),
  })).status).toBe(402);

  await applyPlanToAccount(env, h.account!, 'team');
  const putRes = await req(`${h.page_url}_tendril/groups/policy`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ policy: signedPolicy }),
  });
  expect(putRes.status).toBe(200);

  // Alice signs in with GitHub and is verified in github-team:acme/eng
  const alice = await createUserWithGitHub(4242, 'alice-eng', 'alice@acme.test');
  await env.ACCOUNTS!.prepare(`INSERT INTO identity_groups (provider, subject, account_id, group_id, display_name, verified_at, expires_at)
    VALUES ('github', '4242', ?, 'github-team:acme/eng', 'Acme/Engineering', ?, ?)`).bind(alice.accountId, Date.now(), Date.now() + 30 * 60_000).run();

  // Alice opens the NORMAL page URL (/auth/page?tendril=...&key=...) with NO individual email invite!
  const key = new URL(h.page_url).pathname.split('/')[2]!;
  const authRes = await req(`/auth/page?tendril=${h.id}&key=${key}`, {
    anonymous: true, headers: { Cookie: alice.cookie }, redirect: 'manual',
  });
  expect(authRes.status).toBe(303);
  const redeemRes = await req(authRes.headers.get('Location')!, { anonymous: true, redirect: 'manual' });
  expect(redeemRes.status).toBe(303);
  const alicePageCookie = redeemRes.headers.get('Set-Cookie')!.split(';')[0]!;

  // Alice can open the page HTML and gets viewerRole:"guest"
  const aliceOrigin = new URL(h.page_url).origin;
  const aliceHtml = await (await req(h.page_url, { anonymous: true, headers: { Cookie: alicePageCookie } })).text();
  expect(aliceHtml).toContain('"viewerRole":"guest"');

  // Alice enrolls her device -> host signs companion tendriller-group-attestation-v1
  const aliceDev = await createSigningIdentity();
  const aliceWrap = await generateWrapKeyPair();
  const chalRes = await req(`${h.page_url}_tendril/peers/enrollment`, {
    method: 'POST', anonymous: true,
    headers: { Cookie: alicePageCookie, Origin: aliceOrigin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'challenge', publicKey: aliceDev.publicKey }),
  });
  expect(chalRes.status).toBe(200);
  const { challenge } = await chalRes.json() as { challenge: string };
  const proof = await signEnrollmentRequest({ applicationId, publicKey: aliceDev.publicKey, wrapKey: aliceWrap.publicKeyHex, challenge }, aliceDev);
  const enrollRes = await req(`${h.page_url}_tendril/peers/enrollment`, {
    method: 'POST', anonymous: true,
    headers: { Cookie: alicePageCookie, Origin: aliceOrigin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'enroll', proof: authorityRecord(encodeRecord(proof)) }),
  });
  expect(enrollRes.status).toBe(200);

  // Check _tendril/groups exposes the companion signed group attestation for Alice's device
  const grpState = await (await req(`${h.page_url}_tendril/groups`)).json() as {
    group_attestations: Array<{ payload: { publicKey: string; group: string; ruleId: string } }>;
  };
  expect(grpState.group_attestations.some(a => a.payload.publicKey === aliceDev.publicKey && a.payload.group === 'github-team:acme/eng')).toBe(true);

  // Now Alice is removed from Acme/eng via GitHub webhook -> instant host gate!
  (env as any).GITHUB_ORG_WEBHOOK_SECRET = 'gh-org-webhook-test-secret';
  const whPayload = JSON.stringify({
    action: 'removed',
    organization: { login: 'Acme' },
    team: { slug: 'eng' },
    membership: { user: { id: 4242 } },
  });
  const sig = `sha256=${await hmacHex('gh-org-webhook-test-secret', whPayload)}`;
  const whRes = await req('/api/webhooks/github-org', {
    method: 'POST', anonymous: true,
    headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'membership', 'X-Hub-Signature-256': sig },
    body: whPayload,
  });
  expect(whRes.status).toBe(200);
  const whJson = await whRes.json() as { handled: boolean; pages_notified: number };
  expect(whJson).toMatchObject({ handled: true, pages_notified: 1 });

  // Alice's page session is immediately invalidated (redirect to sign-in / 401)
  const denied = await req(h.page_url, { anonymous: true, headers: { Cookie: alicePageCookie }, redirect: 'manual' });
  expect(denied.status).toBe(302);

  // Confirm owner session was NOT touched (guardrail)
  const ownerOk = await req(`${h.page_url}_tendril/groups`);
  expect(ownerOk.status).toBe(200);
});
