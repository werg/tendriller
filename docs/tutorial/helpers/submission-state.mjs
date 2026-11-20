// UI eligibility only. Drafts and signed attempts remain in the view/session stores.
export function createSubmissionState(onChange = () => {}) {
  let state = { attached: false, connected: false, ready: false, coherent: false,
    generation: null, working: false, pending: null, selected: '', observed: null };
  function snapshot() {
    const available = state.attached && state.connected && state.ready && state.coherent;
    const selectedPending = state.pending?.id === state.selected;
    const reapply = selectedPending && ['abandoned', 'needsReapply'].includes(state.observed?.status);
    return Object.freeze({ ...state, available,
      canSubmit: available && !state.working && !state.pending,
      canInspect: state.attached && !state.working && Boolean(state.selected),
      canRetry: available && !state.working && selectedPending && !reapply && state.observed?.status !== 'applied',
      canReapply: available && !state.working && reapply,
      message: !state.attached ? 'Draft only. Connect this device before saving.'
        : !available ? 'Waiting for connection and a successful current notes read. Your draft is retained.'
        : state.working ? 'Working. Your draft and original operation are retained.'
        : state.pending ? `Retained operation ${state.pending.id}. Inspect its outcome before starting another submission.`
        : 'Ready to save. Draft text stays on this device until submitted.',
    });
  }
  function update(patch) { state = { ...state, ...patch }; onChange(snapshot()); }
  return {
    get snapshot() { return snapshot(); }, update,
    application(status) {
      const ready = status.phase === 'ready' && status.database === 'ready';
      update({ ready, generation: status.generation,
        ...(!ready || state.generation !== status.generation ? { coherent: false } : {}) });
    },
    participation(status) {
      const connected = ['connected', 'following', 'coordinating'].includes(status.phase) && !status.error && !status.recovery;
      update({ connected, ...(!connected ? { coherent: false } : {}) });
    },
    read(snapshot) {
      update({ coherent: state.connected && state.ready && snapshot.revision.generation === state.generation });
    },
    begin(kind = 'submit') {
      if (!snapshot()[kind === 'retry' ? 'canRetry' : kind === 'reapply' ? 'canReapply' : 'canSubmit'])
        throw Error(snapshot().message);
      update({ working: true });
      return () => update({ working: false });
    },
    failure(error, original) {
      return `${error.message ?? String(error)} ${original
        ? `Retained operation ${original.id}. Inspect or retry this original operation; keep its input and ID.`
        : 'No new operation was submitted. Your draft is retained; restore readiness and save when ready.'}`;
    },
  };
}
