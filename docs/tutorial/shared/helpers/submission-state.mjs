// UI eligibility only. Drafts and signed attempts remain in the view/session stores.
// Saving needs only this device's coherent local data: Chronolog keeps the signed
// attempt in the local journal and delivers it when a peer (the agent program) is
// reachable. Retry and reapply reconcile with that peer, so they need a connection.
// Wire every action control to onChange, including the final working release;
// data snapshots alone cannot observe completion. See APP_PATTERNS.md's
// "Keep every action control reactive" example. Release once in finally,
// after coherent refresh, and retain pending/recovery state on failure.
export function createSubmissionState(onChange = () => {}) {
  let state = { attached: false, connected: false, ready: false, coherent: false,
    generation: null, working: false, pending: null, selected: '', observed: null };
  function snapshot() {
    const local = state.attached && state.ready && state.coherent;
    const available = local && state.connected;
    const selectedPending = state.pending?.id === state.selected;
    // A pending attempt observed as saved is durable in the local journal; only an
    // uncertain one (no saved state seen yet) blocks the next submission.
    const pendingSaved = Boolean(state.pending) && state.observed?.operationId === state.pending.id && state.observed.status === 'saved';
    const reapply = selectedPending && ['abandoned', 'needsReapply'].includes(state.observed?.status);
    return Object.freeze({ ...state, local, available, pendingSaved,
      canSubmit: local && !state.working && (!state.pending || pendingSaved),
      canInspect: state.attached && !state.working && Boolean(state.selected),
      canRetry: available && !state.working && selectedPending && !reapply && state.observed?.status !== 'applied',
      canReapply: available && !state.working && reapply,
      message: !state.attached ? 'Draft only. Open this device’s local data before saving.'
        : !local ? 'Waiting for a successful current read of this device’s data. Your draft is retained.'
        : state.working ? 'Working. Your draft and original operation are retained.'
        : state.pending && !pendingSaved ? `Retained operation ${state.pending.id}. Inspect its outcome before starting another submission.`
        : !state.connected ? 'Saving on this device. Saved work is applied and shared when the agent program or another peer is reachable.'
        : state.pending ? `Operation ${state.pending.id} is saved on this device and waiting to be applied. You can save more.`
        : 'Ready to save. Draft text stays on this device until submitted.',
    });
  }
  function update(patch) { state = { ...state, ...patch }; onChange(snapshot()); }
  return {
    get snapshot() { return snapshot(); }, update,
    application(status) {
      // 'waiting' is a ready local replica whose coordinator (the agent program) is not connected.
      const ready = ['ready', 'waiting'].includes(status.phase) && status.database === 'ready';
      update({ ready, generation: status.generation,
        ...(!ready || state.generation !== status.generation ? { coherent: false } : {}) });
    },
    participation(status) {
      update({ connected: ['connected', 'following', 'coordinating'].includes(status.phase) && !status.error && !status.recovery });
    },
    read(snapshot) {
      update({ coherent: state.ready && snapshot.revision.generation === state.generation });
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
