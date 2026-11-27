/**
 * Optional author-time `$finality` lifecycle UI (status, schedule opt-in, and checkpoint closure).
 * Default is `finality: none`; opting in requires explicit consent because delayed offline work
 * first delivered behind a sealed frontier may be excluded.
 */
export function mountFinality({ root, session }) {
  const section = document.createElement('section');
  const title = document.createElement('h2');
  const explanation = document.createElement('p');
  const scheduleSummary = document.createElement('p');
  title.textContent = 'Optional author-time finality ($finality)';
  explanation.textContent = 'No finality is the default for offline-first pages. Closing a frontier can exclude genuinely offline work first received behind it. Finality never assigns operation order, guarantees peer retention, or makes external effects exactly once.';
  scheduleSummary.dataset.finality = 'schedule';

  // Opt-in schedule toggle for administrators when finality is currently `none`
  const scheduleBox = document.createElement('div');
  const enableConsentLabel = document.createElement('label');
  const enableConsent = document.createElement('input');
  enableConsent.type = 'checkbox';
  enableConsentLabel.append(enableConsent, document.createTextNode(' I understand enabling signed-frontier finality allows closing past timestamps, which can exclude unseen offline edits.'));
  const enableBtn = document.createElement('button');
  enableBtn.type = 'button';
  enableBtn.textContent = 'Schedule signed-frontier finality for this device';
  enableBtn.disabled = true;
  enableBtn.dataset.finality = 'schedule-enable';
  enableConsent.addEventListener('change', () => { enableBtn.disabled = !enableConsent.checked; });
  scheduleBox.append(enableConsentLabel, enableBtn);

  // Explicit checkpoint closure form
  const label = document.createElement('label');
  const input = document.createElement('input');
  input.inputMode = 'numeric';
  input.value = String(Date.now() - 60_000);
  input.setAttribute('aria-label', 'Requested author-time closure in milliseconds');
  label.textContent = 'Requested closure (signed author time, milliseconds)';
  label.append(input);
  const consentLabel = document.createElement('label');
  const consent = document.createElement('input');
  consent.type = 'checkbox';
  consentLabel.append(consent, document.createTextNode(' I understand delayed offline work behind this frontier may be excluded.'));
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Ask this browser to close the frontier';
  button.disabled = true;
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.textContent = 'Provider availability is not yet demonstrated. This action is separate from Save.';

  input.dataset.finality = 'through';
  consent.dataset.finality = 'consent';
  button.dataset.finality = 'close';
  status.dataset.finality = 'status';
  consent.addEventListener('change', () => { button.disabled = !consent.checked; });

  function renderSchedule() {
    const finStatus = session?.finality?.status?.() ?? { hasActiveFinality: false, closedThroughMs: null, checkpoints: [] };
    const topicState = session?.topic?.('$finality') ?? { schedule: [{ effectiveAfterMs: -1, policy: { kind: 'none' } }] };
    const latest = Array.isArray(topicState.schedule) && topicState.schedule.length
      ? topicState.schedule[topicState.schedule.length - 1]
      : { policy: { kind: 'none' } };
    const kind = latest?.policy?.kind ?? 'none';
    const closedText = finStatus.closedThroughMs === null ? 'none' : String(finStatus.closedThroughMs);
    scheduleSummary.textContent = `Current policy: ${kind} · closed frontier: ${closedText} · checkpoints: ${finStatus.checkpoints?.length ?? 0}`;
    const selfKey = session?.device?.identity?.publicKey ?? session?.identity?.publicKey ?? null;
    const isAdmin = selfKey ? Boolean(session?.isAdministrator?.(selfKey)) : false;
    scheduleBox.hidden = !isAdmin || kind !== 'none';
  }

  enableBtn.addEventListener('click', async () => {
    if (!enableConsent.checked) return;
    const selfKey = session?.device?.identity?.publicKey ?? session?.identity?.publicKey;
    if (!selfKey) return;
    enableBtn.disabled = true;
    try {
      const effectiveAfterMs = Date.now() + 5_000;
      const op = await session.submit({
        visibility: 'public',
        operationId: `finality-optin-${crypto.randomUUID().slice(0, 8)}`,
        updates: [{
          topic: '$finality',
          input: {
            action: 'schedulePolicy',
            effectiveAfterMs,
            policy: { kind: 'signed-frontier', signer: selfKey },
          },
        }],
      });
      const mat = await op.materialized();
      status.textContent = mat.outcome === 'accepted'
        ? `Scheduled signed-frontier finality for this device starting after ${effectiveAfterMs}.`
        : `Could not schedule finality: ${mat.rejectionCode ?? 'rejected'}.`;
      renderSchedule();
    } catch (error) {
      status.textContent = `Could not schedule finality: ${error.message ?? String(error)}`;
    } finally {
      enableConsent.checked = false;
      enableBtn.disabled = true;
    }
  });

  button.addEventListener('click', async () => {
    if (!consent.checked) return;
    try {
      if (!/^(?:0|[1-9][0-9]{0,18})$/.test(input.value)) throw Error('Enter an exact nonnegative int64 author timestamp');
      button.disabled = true;
      const checkpoint = await session.finality.createCheckpoint({ throughMs: BigInt(input.value) });
      status.textContent = `Verified local finality checkpoint closed through ${checkpoint.payload.closedThroughMs} (stateRoot ${checkpoint.payload.stateRoot.slice(0, 12)}...). Inspect each operation’s finalized/excluded facts; retention is separate.`;
      renderSchedule();
    } catch (error) {
      status.textContent = `No closure was established: ${error.message}. Local authoring remains available. A no-finality policy explicitly does not support finalization; validator quorums need separately collected votes.`;
    } finally {
      consent.checked = false;
      button.disabled = true;
    }
  });

  section.append(title, explanation, scheduleSummary, scheduleBox, label, consentLabel, button, status);
  root.append(section);
  renderSchedule();
  const off = typeof session?.onChange === 'function' ? session.onChange(() => renderSchedule()) : () => {};
  return Object.freeze({ element: section, refresh: renderSchedule, destroy() { off(); section.remove(); } });
}
