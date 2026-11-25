/** UI eligibility follows local signing/storage prerequisites, never peers, views or finality. */
export function createSubmissionState(onChange = () => {}) {
  let state = { attached: false, keyReady: false, storageReady: false, working: false, pending: null, selected: '', observed: null };
  const snapshot = () => {
    const available = state.attached && state.keyReady && state.storageReady;
    return Object.freeze({ ...state, available, canSubmit: available && !state.working,
      canInspect: state.attached && !state.working && Boolean(state.selected),
      canRetry: available && !state.working && Boolean(state.selected) && Boolean(state.observed?.stored || state.pending?.operationId === state.selected) && !state.observed?.excluded,
      message: !state.attached ? 'Opening this device’s retained local session. Your draft remains editable.'
        : !state.keyReady ? 'This device needs explicit key provisioning. Existing devices can continue writing.'
        : !state.storageReady ? 'Local storage is unavailable. Your draft has not been submitted.'
        : state.working ? 'Storing the exact signed intent on this device.'
        : 'Save is available, including offline. Materialized outcomes can change when earlier work arrives.',
    });
  };
  const update = patch => { state = { ...state, ...patch }; onChange(snapshot()); };
  return { get snapshot() { return snapshot(); }, update,
    application(status) { update({ keyReady: status.canAuthor === true, storageReady: status.phase !== 'closed' }); },
    begin(kind = 'submit') {
      if (!snapshot()[kind === 'retry' ? 'canRetry' : 'canSubmit']) throw Error(snapshot().message);
      update({ working: true }); return () => update({ working: false });
    },
    failure(error, original) { return `${error.message ?? error} ${original ? `Inspect or retry the retained operation ${original.operationId} with its original input and ID.` : 'No durable acknowledgment was received; keep your draft and inspect the original operation before retrying.'}`; },
  };
}
