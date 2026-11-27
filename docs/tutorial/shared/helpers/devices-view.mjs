// Devices and access: one reactive view over the owner's admission state. It renders
// the newcomer's waiting state, every admitted device and agent from signed page
// state with an Administrator badge, "New device signed in" notices, pending sign-ins
// with Approve, Remove device, the strict-mode switch, the rights the owner's own
// signed-in devices join with (administrator by default) and invites. All actions run in the owner (its signer and
// keys); this page only calls them and re-renders the next coherent state.
const short = key => `${key.slice(0, 8)}…${key.slice(-4)}`;
const roleOf = member => member.administrator ? 'Administrator' : member.writer ? 'Can edit' : 'Can read';
const grantRole = grant => grant?.administrator ? 'admin' : grant?.writer ? 'writer' : 'reader';
const WAITING = {
  'waiting-admission': 'Waiting for one of your devices or your agent to come online to let this browser in. Keep this page open; it retries automatically.',
  'waiting-approval': 'Signed in. An administrator must approve this browser on one of their devices (this page uses strict mode). It retries automatically.',
  'waiting-keys': 'Admitted. Waiting for a device or agent that holds the page keys to send them to this browser.',
  removed: 'This browser was removed from the page. Its earlier local data stays here, but new changes are no longer shared with it.',
};
const REASONS = { strict_mode: 'Needs approval (strict mode)', account_not_authorized: 'Another account — approve only if you know them',
  invite_invalid: 'Invite revoked, expired or for another email', invite_already_redeemed: 'Invite already used — possible double redemption', previously_removed: 'Was removed earlier — approve to readmit',
  attestation_signature_invalid: 'Host attestation signature did not match this page’s pinned host key',
  application_id_mismatch: 'Host attestation was issued for a different chain',
  attestation_expired: 'Host attestation expired before admission',
  host_key_missing: 'Page permissions do not pin a host attestation key',
  attestation_malformed: 'Host attestation record could not be decoded' };
const element = (tag, { dataset, ariaLabel, ...props } = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const [key, value] of Object.entries(dataset ?? {})) node.dataset[key] = value;
  if (ariaLabel) node.setAttribute('aria-label', ariaLabel);
  node.append(...children.filter(child => child !== null && child !== undefined)); return node;
};
/** A self-styled badge so every starter shows administrators without extra CSS. */
const adminBadge = () => { const node = element('span', { className: 'admin-badge', textContent: 'Admin', title: 'Administrator: can approve and remove devices and change access settings' });
  node.style.cssText = 'display:inline-block;padding:0 .4em;border:1px solid currentColor;border-radius:.6em;font-size:.8em;font-weight:600'; return node; };
const button = (text, onClick, props = {}) => { const node = element('button', { type: 'button', className: 'secondary', textContent: text, ...props }); node.addEventListener('click', onClick); return node; };

/** Mount into `root` (an empty section). Returns { close }. */
export function mountDevices({ root, session, pageUrl = location.href, storage }) {
  const ids = { mode: `${root.id || 'devices'}-strict`, kind: `${root.id || 'devices'}-invite-kind`, owner: `${root.id || 'devices'}-owner-grant` };
  const banner = element('p', { role: 'status', className: 'admission-banner' });
  const status = element('p', { role: 'status', className: 'muted' });
  const notices = element('ul', { className: 'admission-notices', ariaLabel: 'Device notices' });
  // The full key lets an administrator approve this device from another device or the CLI.
  const selfKey = element('input', { id: 'public-key', readOnly: true, spellcheck: false });
  const selfKeyLabel = element('label', { htmlFor: 'public-key', textContent: 'This device’s key' });
  const members = element('ul', { className: 'admission-members' }), pending = element('ul', { className: 'admission-pending' });
  const pendingSection = element('div', {}, element('h3', { textContent: 'Waiting to join' }), pending);
  const mode = element('input', { type: 'checkbox', id: ids.mode });
  const modeLabel = element('label', { htmlFor: ids.mode }, mode, ' Require approval for every new device (strict mode)');
  // The signed admission policy names the rights the owner's own signed-in devices receive.
  const ownerGrant = element('select', { id: ids.owner }, element('option', { value: 'admin', textContent: 'Administrator' }), element('option', { value: 'writer', textContent: 'Can edit' }), element('option', { value: 'reader', textContent: 'Can read' }));
  const ownerGrantRow = element('p', {}, element('label', { htmlFor: ids.owner, textContent: 'Your own signed-in devices join as ' }), ownerGrant,
    element('span', { className: 'muted', textContent: ' Administrators can remove any device; every admission is listed here.' }));
  const summary = element('p', { className: 'muted admission-summary' });
  const inviteForm = element('form', { className: 'admission-invite' });
  const kind = element('select', { id: ids.kind }, element('option', { value: 'email', textContent: 'One person, by email' }), element('option', { value: 'open', textContent: 'Single-use link' }), element('option', { value: 'public', textContent: 'Public link (several people)' }));
  const email = element('input', { type: 'email', placeholder: 'friend@example.com', autocomplete: 'off', ariaLabel: 'Invitee email' });
  const role = element('select', { ariaLabel: 'Invite role' }, element('option', { value: 'reader', textContent: 'Can read' }), element('option', { value: 'writer', textContent: 'Can edit' }), element('option', { value: 'admin', textContent: 'Administrator' }));
  const max = element('input', { type: 'number', min: '1', max: '100000', placeholder: 'No limit', ariaLabel: 'Maximum people for a public link' });
  const days = element('input', { type: 'number', min: '1', max: '90', value: '7', ariaLabel: 'Invite expires after days' });
  const created = element('p', { role: 'status' }), invites = element('ul', { className: 'admission-invites' });
  inviteForm.append(element('label', { htmlFor: ids.kind, textContent: 'Invite someone' }), kind, email, element('label', { textContent: 'Role' }), role,
    element('label', { textContent: 'Public link limit' }), max, element('label', { textContent: 'Expires after (days)' }), days, element('button', { type: 'submit', textContent: 'Create invite' }), created);
  const adminTools = element('div', {}, element('h3', { textContent: 'Access settings' }), modeLabel, ownerGrantRow, inviteForm, element('h3', { textContent: 'Invites' }), invites);
  root.replaceChildren(element('h2', { id: `${root.id || 'devices'}-heading`, textContent: 'Devices and access' }), banner, notices, selfKeyLabel, selfKey,
    element('h3', { textContent: 'Devices and agents with access' }), summary, members, pendingSection, adminTools, status);
  let state, closed = false;
  const seen = new Set((() => { try { return JSON.parse(storage?.getItem('admission:seen') ?? '[]'); } catch { return []; } })());
  const call = async (name, ...args) => {
    status.textContent = 'Working…';
    try { const result = await session.extensions.call(name, args); status.textContent = ''; return result; }
    catch (error) { status.textContent = `Could not complete that: ${error.message ?? error}`; throw error; }
  };
  /** Keyed list rendering: nodes keep identity (and focus) by stable public key. */
  function renderList(list, items, keyOf, build) {
    const existing = new Map([...list.children].map(node => [node.dataset.key, node])), wanted = new Set(items.map(keyOf));
    for (const [key, node] of existing) if (!wanted.has(key)) node.remove();
    for (const item of items) {
      const key = keyOf(item), next = build(item); next.dataset.key = key;
      const current = existing.get(key), focused = current?.contains(document.activeElement) ? document.activeElement?.dataset.action : null;
      if (current) current.replaceWith(next); list.append(next);
      if (focused) next.querySelector(`[data-action="${focused}"]`)?.focus();
    }
  }
  function render(value) {
    if (closed || !value) return; state = value; if (selfKey.value !== value.publicKey) selfKey.value = value.publicKey;
    banner.textContent = WAITING[value.phase] ?? ''; banner.hidden = !WAITING[value.phase];
    if (value.error && value.phase !== 'admitted') banner.textContent += ` (Last attempt: ${value.error}.)`;
    renderList(notices, value.notices.filter(item => !seen.has(item.id) && item.kind !== 'removed' || item.kind === 'removed' && item.self), item => item.id, item => element('li', {},
      item.kind === 'new-device' ? `New ${item.subject === 'agent' ? 'agent' : 'device'} signed in: ${item.label ?? 'device'} (${short(item.publicKey)}).`
        : item.kind === 'pending' ? `${item.label ?? 'A device'} (${short(item.publicKey)}) is waiting: ${REASONS[item.reason] ?? item.reason}.`
          : item.kind === 'rejected' ? `Rejected sign-in from ${item.label ?? 'a device'}${item.publicKey ? ` (${short(item.publicKey)})` : ''}: ${REASONS[item.reason] ?? item.reason}.`
            : item.kind === 'error' ? `Admission sync error: ${item.error ?? 'unknown error'}.`
              : 'This device was removed.',
      button('Dismiss', () => { seen.add(item.id); try { storage?.setItem('admission:seen', JSON.stringify([...seen].slice(-50))); } catch {} render(state); }, { dataset: { action: 'dismiss' } })));
    const admins = value.members.filter(member => member.administrator).length;
    summary.textContent = `${value.members.length} with access · ${admins} administrator${admins === 1 ? '' : 's'}${value.administrator ? ' (including this one)' : ''}`;
    renderList(members, value.members, member => member.publicKey, member => element('li', { dataset: { role: member.administrator ? 'administrator' : member.writer ? 'writer' : 'reader' } },
      element('strong', { textContent: member.self ? `${member.label} (this ${value.subject === 'agent' ? 'agent' : 'device'})` : member.label }), ' ',
      member.administrator ? adminBadge() : null, member.administrator ? ' ' : null,
      element('span', { className: 'muted', textContent: `${roleOf(member)} · ${member.subject === 'agent' ? 'agent' : member.via === 'invited' ? 'invited' : member.subject} · key ${short(member.publicKey)}${member.accountId ? ` · account ${member.accountId}` : ''}` }),
      value.administrator && !member.self ? button(`Remove ${member.subject === 'agent' ? 'agent' : 'device'}`, () => {
        if (confirm(`Remove ${member.label} (${short(member.publicKey)})? It loses access to new changes and the page key is rotated.`)) void call('admission.remove', member.publicKey).catch(() => {});
      }, { dataset: { action: 'remove' } }) : null));
    pendingSection.hidden = value.pending.length === 0;
    renderList(pending, value.pending, item => item.publicKey, item => element('li', {},
      element('strong', { textContent: item.label }), ' ', element('span', { className: 'muted', textContent: `${item.email ?? item.accountId} · key ${short(item.publicKey)} · ${REASONS[item.reason] ?? item.reason}` }),
      value.administrator ? button('Approve this device', () => void call('admission.approve', item.publicKey).catch(() => {}), { className: '', dataset: { action: 'approve' } }) : element('span', { className: 'muted', textContent: ' An administrator can approve it.' })));
    adminTools.hidden = !value.administrator;
    mode.checked = value.mode === 'strict'; mode.disabled = !value.administrator;
    if (document.activeElement !== ownerGrant) ownerGrant.value = grantRole(value.ownerGrant); ownerGrant.disabled = !value.administrator;
    renderList(invites, value.invites, item => item.inviteId, item => element('li', {},
      `${item.binding.kind === 'email' ? `For ${item.binding.email}` : item.binding.kind === 'open' ? 'Single-use link' : `Public link${item.capacity ? ` (up to ${item.capacity})` : ''}`} · ${item.role === 'admin' ? 'administrator' : item.role === 'writer' ? 'can edit' : 'can read'} · used ${item.redemptions}${item.capacity ? `/${item.capacity}` : ''} · ${item.revoked ? 'revoked' : item.expired ? 'expired' : `expires ${new Date(Number(item.expiresAt)).toLocaleDateString()}`}`,
      !item.revoked && !item.expired ? button('Revoke', () => void call('admission.revokeInvite', item.inviteId).catch(() => {}), { dataset: { action: 'revoke' } }) : null));
  }
  mode.addEventListener('change', () => void call('admission.mode', mode.checked ? 'strict' : 'attested').catch(() => { mode.checked = state?.mode === 'strict'; }));
  ownerGrant.addEventListener('change', () => void call('admission.ownerGrant', ownerGrant.value).catch(() => { ownerGrant.value = grantRole(state?.ownerGrant); }));
  const syncKind = () => { email.hidden = kind.value !== 'email'; max.hidden = kind.value !== 'public'; if (kind.value === 'public' && role.value !== 'reader') role.value = 'reader'; };
  kind.addEventListener('change', syncKind); syncKind();
  inviteForm.addEventListener('submit', event => {
    event.preventDefault();
    const binding = kind.value === 'email' ? { kind: 'email', email: email.value } : kind.value === 'open' ? { kind: 'open' } : { kind: 'public', max: max.value ? Number(max.value) : null };
    void call('admission.invite', { binding, role: role.value, expiresInMs: Number(days.value || 7) * 86_400_000 }).then(invite => {
      const link = new URL(pageUrl); link.hash = invite.fragment;
      const field = element('input', { readOnly: true, value: link.href, ariaLabel: 'Invite link' });
      created.replaceChildren('Share this link only with the invitee. It carries the invite secret; this page will not show it again. ', field,
        button('Copy link', () => void navigator.clipboard?.writeText(link.href).then(() => { created.append(' Copied.'); }).catch(() => field.select())));
      field.focus(); field.select(); email.value = '';
    }).catch(() => {});
  });
  const stop = session.extensions.subscribe(message => { if (message?.topic === 'admission') render(message.state); });
  void session.extensions.call('admission.state', []).then(render).catch(error => { status.textContent = `Device list unavailable: ${error.message}`; });
  // An invite link's secret lives in the fragment; present it once to this page's host, then drop it from the address bar.
  const fragment = location.hash.slice(1);
  if (/^invite=[0-9a-f]{32}\.[0-9a-f]{64}$/u.test(fragment)) {
    history.replaceState(history.state, '', location.pathname + location.search);
    banner.hidden = false; banner.textContent = 'Presenting your invite…';
    void call('admission.redeem', fragment).then(render).catch(() => {});
  }
  return Object.freeze({ get state() { return state; }, close() { closed = true; stop(); } });
}
