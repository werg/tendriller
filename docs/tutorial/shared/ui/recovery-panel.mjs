// Zero-jargon "Trusted Backup Contacts" UI panel for threshold social recovery.
import {
  approveContactRecovery,
  finishDeviceRecovery,
  inspectRecoveryState,
  startDeviceRecovery,
} from '../helpers/social-recovery.mjs';

/**
 * Mount a calm recovery panel showing trusted contacts, pending recovery requests (with 6-digit
 * match codes), and 1-click Approve / Complete Recovery actions.
 */
export async function mountRecoveryPanel(container, session, { onRecovered } = {}) {
  container.textContent = '';
  const state = await inspectRecoveryState(session);

  const heading = document.createElement('h3');
  heading.textContent = 'Trusted backup contacts';
  container.append(heading);

  const intro = document.createElement('p');
  if (!state.guardians) {
    intro.textContent = 'No backup contacts are set up yet. Add trusted friends, family, or a backup device so you can recover access if you lose your devices.';
    container.append(intro);
    return;
  }

  intro.textContent = `Any ${state.guardians.threshold} of your ${state.guardians.members.length} trusted contacts can help you recover access. Backup contacts cannot read your private data.`;
  container.append(intro);

  const list = document.createElement('ul');
  for (const g of state.guardians.members) {
    const li = document.createElement('li');
    li.textContent = g.label || `Contact ${g.publicKey.slice(0, 8)}`;
    list.append(li);
  }
  container.append(list);

  const pending = state.requests.filter(r => r.status === 'pending');
  const myPk = session.identity?.publicKey;
  const amGuardian = state.guardians.members.some(g => g.publicKey === myPk);

  if (pending.length > 0) {
    const reqHeading = document.createElement('h4');
    reqHeading.textContent = 'Pending recovery requests';
    container.append(reqHeading);

    for (const req of pending) {
      const row = document.createElement('div');
      row.className = 'tendril-recovery-request';
      const label = document.createElement('span');
      label.textContent = `${req.label} · Match code: ${req.verificationCode} (${req.approvals.length}/${state.guardians.threshold} approved)`;
      row.append(label);

      if (amGuardian && !req.approvals.includes(myPk)) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = 'Approve recovery';
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          await approveContactRecovery(session, req.requestId);
          await mountRecoveryPanel(container, session, { onRecovered });
        });
        row.append(' ', btn);
      }
      container.append(row);
    }
  }

  const completedForMe = state.requests.find(r => r.newPublicKey === myPk && r.status === 'completed');
  let isReader = false;
  if (typeof session.isReader === 'function') {
    isReader = Boolean(session.isReader(myPk));
  } else if (typeof session.permissions === 'function') {
    try {
      const perms = await session.permissions();
      isReader = Boolean(perms?.members?.some?.(m => m.publicKey === myPk && m.reader));
    } catch { /* fall back to status */ }
  } else {
    isReader = Boolean(session.status?.canAuthor);
  }
  if (completedForMe) {
    const finishBtn = document.createElement('button');
    finishBtn.type = 'button';
    finishBtn.textContent = 'Unlock my recovered space';
    finishBtn.addEventListener('click', async () => {
      finishBtn.disabled = true;
      const res = await finishDeviceRecovery(session);
      onRecovered?.(res);
    });
    container.append(finishBtn);
  } else if (!isReader) {
    const reqBtn = document.createElement('button');
    reqBtn.type = 'button';
    reqBtn.textContent = 'Request access recovery';
    reqBtn.addEventListener('click', async () => {
      reqBtn.disabled = true;
      const res = await startDeviceRecovery(session);
      const msg = document.createElement('p');
      msg.textContent = `Share this match code with ${state.guardians.threshold} trusted contacts: ${res.verificationCode}`;
      container.append(msg);
    });
    container.append(reqBtn);
  }
}
