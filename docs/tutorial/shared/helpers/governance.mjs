// Governance & security-posture helper for Chronolog v2 pages.
// Surfaces clear, honest UX whenever a page deviates from the default private
// OAuth + E2EE model (e.g. zero-OAuth openMembers public read/write, multisigMembers,
// or custom $permissions ES Module reducers).

const BANNER_STYLE = `.tg-banner{display:flex;gap:.75rem;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;padding:.75rem 1rem;margin:.75rem 0;border-radius:10px;border:1px solid #d2dce6;background:#f4f8fc;color:#142230;font-size:.88rem;line-height:1.45}
.tg-banner[data-tone=warn]{border-color:#e5c387;background:#fff8eb;color:#3d2807}
.tg-banner[data-tone=info]{border-color:#c6d9e8;background:#f0f7fc;color:#102a43}
.tg-banner strong{font-weight:650}
.tg-banner-badge{display:inline-flex;align-items:center;padding:.15rem .5rem;border-radius:999px;font-size:.75rem;font-weight:650;background:rgba(0,0,0,.08)}
.tg-banner p{margin:.2rem 0 0}
@media(prefers-color-scheme:dark){.tg-banner{border-color:#293948;background:#131e28;color:#e6eef5}.tg-banner[data-tone=warn]{border-color:#5c451d;background:#261d0d;color:#f7dfa9}.tg-banner-badge{background:rgba(255,255,255,.12)}}`;

/**
 * Inspect the live Chronolog v2 `$reducers` + `$permissions` topics and return a
 * plain, user-readable description of this page's cryptographic governance model.
 */
export function describeGovernance(session, { hostedMcpCount = 0 } = {}) {
  const permBinding = session?.topic?.('$reducers')?.topics?.$permissions ?? null;
  const perms = session?.permissions?.() ?? {};
  const privateLog = session?.genesis?.privateLog !== false;
  const selfKey = session?.device?.identity?.publicKey ?? session?.identity?.publicKey ?? null;

  const mode = perms.mode || (permBinding && permBinding.module !== 'chronolog/permissions' ? 'custom' : 'attested');
  const openRead = Boolean(perms.openReaders);
  const openWrite = Boolean(perms.openWriters);
  const blockedAuthors = Array.isArray(perms.blockedAuthors) ? perms.blockedAuthors : [];
  const isAdmin = selfKey ? Boolean(session?.isAdministrator?.(selfKey)) : false;
  const canWrite = selfKey ? Boolean(session?.isWriter?.(selfKey)) : openWrite;
  const canRead = selfKey ? Boolean(session?.isReader?.(selfKey)) : openRead;
  const hostedActive = Number(hostedMcpCount) > 0;

  if (mode === 'open') {
    const modNote = blockedAuthors.length > 0 ? ` (${blockedAuthors.length} blocked key${blockedAuthors.length === 1 ? '' : 's'})` : '';
    return Object.freeze({
      mode,
      privateLog,
      openRead,
      openWrite,
      canRead,
      canWrite,
      isAdmin,
      blockedAuthors,
      hostedMcpActive: hostedActive,
      deviatesFromDefaultPrivacy: true,
      tone: openWrite ? 'warn' : 'info',
      badge: openWrite ? 'Public · Open contributions' : 'Public · Read-only',
      title: openWrite ? `Public unencrypted page — anyone can contribute${modNote}` : 'Public unencrypted page — anyone can view',
      securityNote: openWrite
        ? 'This page uses an unencrypted public Chronolog log with open writes. Anyone with the link can read and submit signed entries without signing in — do not enter private secrets. Admins can block abusive keys anytime.'
        : 'This page uses an unencrypted public Chronolog log so anyone with the link can view and sync peer-to-peer without signing in. Only authorized writers can publish edits.',
    });
  }

  if (mode === 'multisig') {
    const ms = perms.multisig ?? {};
    const threshold = Number.isSafeInteger(ms.threshold) ? ms.threshold : 1;
    const signers = Array.isArray(ms.signers) ? ms.signers : [];
    const proposals = ms.proposals && typeof ms.proposals === 'object' ? Object.keys(ms.proposals).length : 0;
    return Object.freeze({
      mode,
      privateLog,
      openRead: false,
      openWrite: false,
      canRead,
      canWrite,
      isAdmin,
      blockedAuthors: [],
      hostedMcpActive: hostedActive,
      threshold,
      signerCount: signers.length,
      pendingProposals: proposals,
      deviatesFromDefaultPrivacy: true,
      tone: 'info',
      badge: `Multisig ${threshold}-of-${signers.length}`,
      title: `Multisig governance (${threshold} of ${signers.length} signers required)`,
      securityNote: `Membership and admin changes require ${threshold} independent signer approvals instead of single-owner OAuth auto-admission.${proposals > 0 ? ` ${proposals} proposal(s) awaiting approval.` : ''}`,
    });
  }

  if (mode === 'custom') {
    return Object.freeze({
      mode,
      privateLog,
      openRead: false,
      openWrite: false,
      canRead,
      canWrite,
      isAdmin,
      blockedAuthors: [],
      hostedMcpActive: hostedActive,
      reducerModule: permBinding?.module ?? 'custom',
      deviatesFromDefaultPrivacy: true,
      tone: 'info',
      badge: 'Custom governance',
      title: `Custom $permissions reducer (${permBinding?.module ?? 'custom'})`,
      securityNote: privateLog
        ? 'Access rules are governed by a custom hash-pinned ES Module reducer on this encrypted log.'
        : 'Access rules are governed by a custom hash-pinned ES Module reducer on an unencrypted public log.',
    });
  }

  if (privateLog && hostedActive) {
    return Object.freeze({
      mode: 'attested',
      privateLog: true,
      openRead: false,
      openWrite: false,
      canRead,
      canWrite,
      isAdmin,
      blockedAuthors: [],
      hostedMcpActive: true,
      deviatesFromDefaultPrivacy: true,
      tone: 'info',
      badge: `Hosted MCP active (${hostedMcpCount})`,
      title: 'Private E2EE page with Hosted MCP assistant enabled',
      securityNote: 'Data stays encrypted at rest, and your opted-in Hosted MCP assistant unseals keys strictly in RAM during OAuth /mcp requests. Revoke anytime in Page settings → Connections.',
    });
  }

  return Object.freeze({
    mode: 'attested',
    privateLog,
    openRead: false,
    openWrite: false,
    canRead,
    canWrite,
    isAdmin,
    blockedAuthors: [],
    hostedMcpActive: false,
    deviatesFromDefaultPrivacy: !privateLog,
    tone: privateLog ? 'default' : 'warn',
    badge: privateLog ? 'Private · E2EE' : 'Unencrypted · Member-gated',
    title: privateLog ? 'Private end-to-end encrypted page' : 'Unencrypted member-gated page',
    securityNote: privateLog
      ? 'Encrypted end-to-end for admitted members only; Tendriller cannot read your data.'
      : 'Membership is attested, but privateLog is disabled so application operations are stored in plaintext.',
  });
}

/**
 * Mount a calm, accessible security-posture banner that stays hidden on standard
 * private OAuth E2EE pages and automatically informs users whenever the page uses
 * public/open-write, multisig, unencrypted, custom governance, or opt-in Hosted MCP.
 */
export function mountGovernanceBanner({ root, session, runtime = globalThis.window?.tendril, getHostedMcpCount, showDefault = false }) {
  if (!root || !session) return { update() {}, destroy() {} };
  if (typeof document !== 'undefined' && !document.getElementById('tg-banner-style')) {
    document.head?.append(Object.assign(document.createElement('style'), { id: 'tg-banner-style', textContent: BANNER_STYLE }));
  }
  const el = document.createElement('aside');
  el.className = 'tg-banner';
  el.setAttribute('role', 'note');
  el.setAttribute('aria-label', 'Page access and security model');
  const left = document.createElement('div');
  const title = document.createElement('strong');
  const note = document.createElement('p');
  left.append(title, note);
  const badge = document.createElement('span');
  badge.className = 'tg-banner-badge';
  el.append(left, badge);
  root.prepend(el);

  const countHosted = () => {
    if (typeof getHostedMcpCount === 'function') return Number(getHostedMcpCount()) || 0;
    const list = runtime?.agents?.list?.() ?? runtime?.agents?.roster?.agents ?? [];
    if (!Array.isArray(list)) return 0;
    return list.filter(a => a && (a.kind === 'hosted_mcp' || a.hosted === true || a.transport === 'hosted_mcp')).length;
  };

  const update = () => {
    const info = describeGovernance(session, { hostedMcpCount: countHosted() });
    const visible = showDefault || info.deviatesFromDefaultPrivacy;
    el.hidden = !visible;
    el.dataset.mode = info.mode;
    el.dataset.tone = info.tone;
    title.textContent = info.title;
    note.textContent = info.securityNote;
    badge.textContent = info.badge;
    return info;
  };

  update();
  const off = typeof session.onChange === 'function' ? session.onChange(() => update()) : () => {};
  const offAgents = typeof runtime?.agents?.onChange === 'function' ? runtime.agents.onChange(() => update()) : () => {};
  return Object.freeze({
    element: el,
    update,
    destroy() { off(); offAgents(); el.remove(); },
  });
}

/** Block an abusive/spam author publicKey on an `openMembers` page (administrator only). */
export async function blockAuthor(session, publicKey, { reason, operationId } = {}) {
  return session.submit({
    visibility: 'public',
    ...(operationId ? { operationId } : {}),
    updates: [{
      topic: '$permissions',
      input: {
        action: 'blockAuthor',
        publicKey,
        ...(typeof reason === 'string' && reason.trim() ? { reason: reason.trim().slice(0, 160) } : {}),
      },
    }],
  });
}

/** Unblock a previously blocked author publicKey on an `openMembers` page (administrator only). */
export async function unblockAuthor(session, publicKey, { operationId } = {}) {
  return session.submit({
    visibility: 'public',
    ...(operationId ? { operationId } : {}),
    updates: [{ topic: '$permissions', input: { action: 'unblockAuthor', publicKey } }],
  });
}

/** Toggle openRead / openWrite on an `openMembers` page (administrator only). */
export async function setOpenAccess(session, { openRead, openWrite, operationId } = {}) {
  return session.submit({
    visibility: 'public',
    ...(operationId ? { operationId } : {}),
    updates: [{
      topic: '$permissions',
      input: {
        action: 'setOpen',
        ...(openRead === undefined ? {} : { openRead: Boolean(openRead) }),
        ...(openWrite === undefined ? {} : { openWrite: Boolean(openWrite) }),
      },
    }],
  });
}

/** Propose a `multisigMembers` governance change (`setMember` | `removeMember` | `setThreshold`). */
export async function proposeMultisig(session, proposal, { operationId } = {}) {
  return session.submit({
    visibility: 'public',
    ...(operationId ? { operationId } : {}),
    updates: [{ topic: '$permissions', input: { action: 'propose', ...proposal } }],
  });
}

/** Approve an existing `multisigMembers` proposal by ID. */
export async function approveMultisig(session, proposalId, { operationId } = {}) {
  return session.submit({
    visibility: 'public',
    ...(operationId ? { operationId } : {}),
    updates: [{ topic: '$permissions', input: { action: 'approve', proposalId } }],
  });
}

/** Cancel a pending `multisigMembers` proposal by ID. */
export async function cancelMultisig(session, proposalId, { operationId } = {}) {
  return session.submit({
    visibility: 'public',
    ...(operationId ? { operationId } : {}),
    updates: [{ topic: '$permissions', input: { action: 'cancel', proposalId } }],
  });
}
