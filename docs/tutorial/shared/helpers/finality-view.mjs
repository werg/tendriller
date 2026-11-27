/** An explicit optional provider action. Configuring a policy alone never reports availability/finality. */
export function mountFinality({ root, session }) {
  const section = document.createElement('section'), title = document.createElement('h2'), explanation = document.createElement('p');
  title.textContent = 'Optional author-time finality';
  explanation.textContent = 'Closing a frontier can exclude genuinely offline work first received behind it. It does not assign operation order, guarantee peer retention, or make external effects exactly once. No finality is the default.';
  const label = document.createElement('label'), input = document.createElement('input'); input.inputMode = 'numeric'; input.value = String(Date.now() - 60_000); input.setAttribute('aria-label', 'Requested author-time closure in milliseconds'); label.textContent = 'Requested closure (signed author time, milliseconds)'; label.append(input);
  const consentLabel = document.createElement('label'), consent = document.createElement('input'); consent.type = 'checkbox'; consentLabel.append(consent, document.createTextNode(' I understand delayed offline work behind this frontier may be excluded.'));
  const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Ask this browser to close the frontier'; button.disabled = true;
  const status = document.createElement('p'); status.setAttribute('role', 'status'); status.textContent = 'Provider availability is not yet demonstrated. This action is separate from Save.';
  input.dataset.finality = 'through'; consent.dataset.finality = 'consent'; button.dataset.finality = 'close'; status.dataset.finality = 'status';
  const consentState = () => { button.disabled = !consent.checked; };
  consent.addEventListener('change', consentState);
  button.addEventListener('click', async () => {
    if (!consent.checked) return;
    try {
      if (!/^(?:0|[1-9][0-9]{0,18})$/.test(input.value)) throw Error('Enter an exact nonnegative int64 author timestamp');
      button.disabled = true;
      const checkpoint = await session.finality.createCheckpoint({ throughMs: BigInt(input.value) });
      status.textContent = `Verified local finality checkpoint closed through ${checkpoint.payload.closedThroughMs} (stateRoot ${checkpoint.payload.stateRoot.slice(0, 12)}...). Inspect each operation’s finalized/excluded facts; retention is separate.`;
    } catch (error) { status.textContent = `No closure was established: ${error.message}. Local authoring remains available. A no-finality policy explicitly does not support finalization; validator quorums need separately collected votes.`; }
    finally { consent.checked = false; button.disabled = true; }
  });
  section.append(title, explanation, label, consentLabel, button, status); root.append(section);
}
