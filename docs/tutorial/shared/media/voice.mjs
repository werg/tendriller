// Optional core voice, with authored controls and an editable transcript draft.
// This helper never writes application state or executes a command.
const cancelled = () => new DOMException('Voice input cancelled.', 'AbortError');
function fromGesture(event) {
  if (event?.isTrusted !== true) throw Error('Start voice from a deliberate button or keyboard action.');
}
function abortable(task, signal) {
  return new Promise((resolve, reject) => {
    const finish = (callback, value) => { signal.removeEventListener('abort', abort); callback(value); };
    const abort = () => finish(reject, signal.reason ?? cancelled());
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(task).then(value => finish(resolve, value), error => finish(reject, error));
    if (signal.aborted) abort();
  });
}

/**
 * loadVoice defaults to the publication-pinned optional runtime. Bundled pages
 * may instead pass () => import('@tendriller/runtime/voice'). Neither path uses
 * the types-only @tendriller/core/voice entry.
 * onDraft receives a candidate; let the person edit/review it before a command.
 */
export function createVoiceController({ runtime, consent, consentMode = consent ? 'session' : 'auto', onDraft, onStatus = () => {},
  loadVoice = () => import(runtime.assetUrl('voice.mjs')) }) {
  if (typeof onDraft !== 'function') throw Error('Supply a transcript draft callback.');
  if (consentMode !== 'auto' && typeof consent !== 'function') throw Error('Supply a voice consent callback or use consentMode: "auto".');
  let voice = null, loading = null, owner = null, attempt = null, phase = 'idle', error = null, disposed = false;
  let detail = null;
  const snapshot = () => ({ phase, error, detail: detail && { ...detail }, listening: voice?.listening ?? false,
    microphoneActive: voice?.microphoneActive ?? false,
    speaking: voice?.speaking ?? false, muted: voice?.muted ?? true });
  const notify = () => onStatus(snapshot());
  const usable = () => {
    if (disposed) throw Error('Voice controls are closed.');
    if (document.visibilityState !== 'visible') throw Error('Open this page before starting voice input.');
  };
  const cancel = () => {
    if (disposed) return;
    attempt = null; owner?.abort(cancelled()); owner = null;
    voice?.stop(); phase = 'idle'; error = null; detail = null; notify();
  };
  const visible = () => { if (document.visibilityState !== 'visible') cancel(); };
  const offStop = runtime.on('sensors_stopped', cancel);
  document.addEventListener('visibilitychange', visible); window.addEventListener('pagehide', cancel);
  const getVoice = async signal => {
    signal.throwIfAborted();
    if (!voice) {
      loading ??= Promise.resolve().then(loadVoice).catch(failure => { loading = null; throw failure; });
      const module = await abortable(loading, signal);
      signal.throwIfAborted();
      if (!voice) voice = module.createVoice(runtime, {
        consentMode,
        consent,
        transcript(text) {
          // Core invalidates old capture results. Keep application context
          // separate as well: finishing capture never reads a mutable form.
          const current = attempt;
          if (disposed || !current || current.signal.aborted || document.visibilityState !== 'visible') return;
          attempt = null; phase = 'draft'; error = null; notify();
          if (disposed || current.signal.aborted || document.visibilityState !== 'visible') return;
          onDraft({ text, context: structuredClone(current.context), attemptId: current.id });
        },
        status(status) {
          if (disposed) return;
          detail = { ...status };
          if (status.kind === 'capture' && status.state === 'error' && attempt) { phase = 'error'; error = status.message; attempt = null; }
          notify();
        },
      });
    }
    return voice;
  };
  const begin = event => {
    usable(); fromGesture(event); cancel();
    owner = new AbortController(); return owner;
  };
  const failed = (failure, current) => {
    if (!disposed && owner === current && !current.signal.aborted) {
      attempt = null; phase = 'error'; error = failure.message; notify();
    }
    throw failure;
  };
  notify();
  return {
    snapshot,
    async prepare(event) {
      const current = begin(event); phase = 'preparing'; notify();
      try {
        const adapter = await getVoice(current.signal);
        await abortable(adapter.prepareCapture(), current.signal); current.signal.throwIfAborted();
        phase = 'idle'; notify();
      } catch (failure) { failed(failure, current); }
    },
    async start(event, { context, language } = {}) {
      if (context === undefined) throw Error('Capture the task context before starting asynchronous voice input.');
      const captured = structuredClone(context), current = begin(event);
      attempt = { id: crypto.randomUUID(), context: captured, signal: current.signal };
      phase = 'preparing'; notify();
      try {
        const adapter = await getVoice(current.signal);
        current.signal.throwIfAborted();
        // The optional tag is captured with this attempt before loading/consent.
        // The adapter owns validation, persistence and saved/device defaults.
        if (language !== undefined) adapter.language(language);
        current.signal.throwIfAborted();
        await abortable(adapter.startCapture(), current.signal); current.signal.throwIfAborted();
        if (attempt) { phase = adapter.listening ? 'recording' : 'error'; if (!adapter.listening) error = 'Recording did not start. You can type instead.'; notify(); }
      } catch (failure) { failed(failure, current); }
    },
    finish() {
      usable();
      if (!attempt || phase !== 'recording') return;
      phase = 'transcribing'; voice.finishCapture(); notify();
    },
    cancel,
    revokeConsent() { cancel(); voice?.revokeConsent(); },
    stopAll() { cancel(); return runtime.sensors.stopAll(); },
    async enableOutput(event, engine = 'browser') {
      const current = begin(event);
      try {
        const adapter = await getVoice(current.signal);
        const enabled = await abortable(adapter.enableOutput(engine), current.signal); current.signal.throwIfAborted(); notify(); return enabled;
      } catch (failure) { failed(failure, current); }
    },
    speak(text) { usable(); voice?.speak(text); },
    mute() { voice?.mute(); notify(); },
    dispose() {
      if (disposed) return;
      cancel(); disposed = true; voice?.dispose(); phase = 'closed';
      offStop(); document.removeEventListener('visibilitychange', visible); window.removeEventListener('pagehide', cancel);
      notify();
    },
  };
}
