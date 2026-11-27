/** UI eligibility follows local signing/storage prerequisites, never peers, views or finality. */
export function createSubmissionState(onChange = () => {}) {
  let state = { attached: false, keyReady: false, storageReady: false, working: false, pending: null, selected: '', observed: null, admissionPhase: null, readOnly: false };
  const snapshot = () => {
    const waitingKeys = state.admissionPhase === 'waiting-keys';
    const available = state.attached && state.keyReady && state.storageReady && !waitingKeys && state.admissionPhase !== 'removed';
    const keyMessage = state.admissionPhase === 'removed' ? 'This browser was removed from the page. Earlier local data stays here; new edits are disabled.'
      : state.admissionPhase === 'waiting-approval' ? 'This browser is waiting for approval in strict mode. See Devices and access.'
      : waitingKeys ? 'This browser is admitted and waiting for the latest page key. See Devices and access.'
      : state.readOnly ? 'This browser has read-only access to this page.'
      : 'This device is waiting to be admitted to the page. See Devices and access; admitted devices can continue writing.';
    return Object.freeze({ ...state, available, canSubmit: available && !state.working,
      canInspect: state.attached && !state.working && Boolean(state.selected),
      canRetry: available && !state.working && Boolean(state.selected) && Boolean(state.observed?.stored || state.pending?.operationId === state.selected) && !state.observed?.excluded,
      message: !state.attached ? 'Opening this device’s retained local session. Your draft remains editable.'
        : (!state.keyReady || waitingKeys || state.admissionPhase === 'removed') ? keyMessage
        : !state.storageReady ? 'Local storage is unavailable. Your draft has not been submitted.'
        : state.working ? 'Storing the exact signed intent on this device.'
        : 'Save is available, including offline. Materialized outcomes can change when earlier work arrives.',
    });
  };
  const update = patch => { state = { ...state, ...patch }; onChange(snapshot()); };
  return { get snapshot() { return snapshot(); }, update,
    application(status) { update({ keyReady: status.canAuthor === true && status.phase !== 'awaiting-keys', storageReady: status.phase !== 'closed' }); },
    admission(admissionState) {
      const phase = admissionState?.phase ?? null;
      const self = admissionState?.members?.find(member => member.self);
      update({ admissionPhase: phase, readOnly: phase === 'admitted' && self?.writer === false });
    },
    begin(kind = 'submit') {
      if (!snapshot()[kind === 'retry' ? 'canRetry' : 'canSubmit']) throw Error(snapshot().message);
      update({ working: true }); return () => update({ working: false });
    },
    failure(error, original) { return `${error.message ?? error} ${original ? `Inspect or retry the retained operation ${original.operationId} with its original input and ID.` : 'No durable acknowledgment was received; keep your draft and inspect the original operation before retrying.'}`; },
  };
}
