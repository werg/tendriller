// Page-owned camera acquisition. Tendriller observes/cancels the native APIs;
// it does not acquire a camera, select a frame, or approve evidence for the page.
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const cancelled = () => new DOMException('Camera input cancelled.', 'AbortError');

function fromGesture(event) {
  if (event?.isTrusted !== true) throw Error('Start the camera from a deliberate button or keyboard action.');
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
function stopTracks(stream) { for (const track of stream?.getTracks() ?? []) track.stop(); }

/**
 * Bind start(event) to a trusted DOM action. capture() returns an unsubmitted
 * Blob; the caller supplies its previously captured task context to review.
 * useFile(file) supplies the same candidate path without opening a camera.
 */
export function createCameraController({ runtime, video, onStatus = () => {}, maxBytes = 8 * 1024 * 1024 }) {
  if (!runtime?.sensors || typeof runtime.on !== 'function') throw Error('Install the Tendriller runtime before camera controls.');
  if (!video || typeof video.play !== 'function') throw Error('Supply the authored preview video element.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 128 * 1024 * 1024) throw Error('Invalid evidence byte limit.');
  let phase = 'idle', error = null, stream = null, controller = null, generation = 0, disposed = false;
  let endedListeners = [];
  video.muted = true; video.playsInline = true;

  const snapshot = () => {
    const sensors = runtime.sensors.status();
    return { phase, error, sensors: { active: [...sensors.active], pending: [...sensors.pending] } };
  };
  const notify = () => onStatus(snapshot());
  const usable = () => {
    if (disposed) throw Error('Camera controls are closed.');
    if (document.visibilityState !== 'visible') throw Error('Open this page before starting camera input.');
  };
  const release = () => {
    const previous = stream; stream = null;
    for (const [track, listener] of endedListeners) track.removeEventListener?.('ended', listener);
    endedListeners = [];
    video.pause?.(); video.srcObject = null;
    stopTracks(previous);
  };
  const stop = () => {
    if (disposed) return;
    generation++; controller?.abort(cancelled()); controller = null;
    release(); phase = 'idle'; error = null; notify();
  };
  const visible = () => { if (document.visibilityState !== 'visible') stop(); };
  const offSensors = runtime.sensors.on(() => {
    if (stream && stream.getTracks().every(track => track.readyState === 'ended')) stop();
    else if (!disposed) notify();
  });
  const offStop = runtime.on('sensors_stopped', stop);
  document.addEventListener('visibilitychange', visible);
  window.addEventListener('pagehide', stop);
  notify();

  return {
    snapshot,
    async start(event) {
      usable(); fromGesture(event);
      if (!navigator.mediaDevices?.getUserMedia) throw Error('Camera access is unavailable. Choose an image file instead.');
      stop();
      const current = generation, owner = new AbortController(); controller = owner;
      phase = 'requesting'; notify();
      try {
        owner.signal.throwIfAborted();
        // Invoke the native acquisition in the gesture's call stack. Stop all
        // also covers this call through the installed runtime sensor tracker.
        const acquisition = navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'environment' } });
        const acquired = await abortable(Promise.resolve(acquisition).then(value => {
          // A page-local Cancel cannot dismiss the browser's permission UI.
          // Release a late grant even if the runtime was unable to wrap it.
          if (disposed || current !== generation || owner.signal.aborted) { stopTracks(value); throw cancelled(); }
          return value;
        }), owner.signal);
        if (disposed || current !== generation || owner.signal.aborted) { stopTracks(acquired); throw cancelled(); }
        stream = acquired; video.srcObject = acquired;
        for (const track of acquired.getTracks()) {
          const ended = () => { if (current === generation) stop(); };
          track.addEventListener?.('ended', ended, { once: true }); endedListeners.push([track, ended]);
        }
        await abortable(video.play(), owner.signal);
        owner.signal.throwIfAborted();
        phase = 'preview'; notify();
      } catch (failure) {
        if (!disposed && current === generation) {
          release(); phase = failure.name === 'AbortError' ? 'idle' : 'error'; error = failure.name === 'AbortError' ? null : failure.message; notify();
        }
        throw failure;
      }
    },
    async capture({ type = 'image/jpeg', quality = 0.85, maxEdge = 1280 } = {}) {
      usable();
      if (phase !== 'preview' || !stream || !controller) throw Error('Start the camera and wait for a visible frame first.');
      if (!IMAGE_TYPES.has(type) || !Number.isFinite(quality) || quality < 0 || quality > 1 || !Number.isSafeInteger(maxEdge) || maxEdge < 1 || maxEdge > 4096) throw Error('Invalid frame encoding options.');
      const width = video.videoWidth, height = video.videoHeight;
      if (!(width > 0 && height > 0)) throw Error('The camera has not supplied a frame. Wait or choose a file.');
      const current = generation, owner = controller;
      const canvas = document.createElement('canvas'), scale = Math.min(1, maxEdge / Math.max(width, height));
      canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext('2d');
      if (!context) throw Error('This browser cannot capture a frame. Choose an image file instead.');
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      // The preview frame is now independent of the live camera. Stop tracks
      // before the asynchronous encoder and keep the original review context.
      release(); phase = 'capturing'; notify();
      let timer;
      try {
        const encoding = new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(Error('Frame encoding timed out. Choose a file or try again.')), 10_000);
          canvas.toBlob(blob => blob ? resolve(blob) : reject(Error('The camera frame could not be encoded.')), type, quality);
        });
        const blob = await abortable(encoding, owner.signal);
        owner.signal.throwIfAborted();
        if (!blob.size || blob.size > maxBytes) throw Error('The captured image exceeds the evidence byte limit.');
        if (!IMAGE_TYPES.has(blob.type)) throw Error('The browser produced an unsupported image type.');
        phase = 'idle'; notify();
        return blob;
      } catch (failure) {
        if (!disposed && current === generation) { phase = failure.name === 'AbortError' ? 'idle' : 'error'; error = failure.name === 'AbortError' ? null : failure.message; notify(); }
        throw failure;
      } finally { clearTimeout(timer); canvas.width = canvas.height = 0; }
    },
    useFile(file) {
      usable();
      if (!(file instanceof Blob) || !IMAGE_TYPES.has(file.type) || !file.size || file.size > maxBytes) throw Error('Choose a JPEG, PNG or WebP image within the evidence byte limit.');
      stop();
      return file;
    },
    stop,
    stopAll() { stop(); return runtime.sensors.stopAll(); },
    dispose() {
      if (disposed) return;
      stop(); disposed = true; phase = 'closed';
      offSensors(); offStop();
      document.removeEventListener('visibilitychange', visible); window.removeEventListener('pagehide', stop);
      notify();
    },
  };
}
