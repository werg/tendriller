// Tracks live sensor use by page code so the control can show indicators and offer
// one stop switch. Wrappers are installed at mount time, which happens synchronously
// from tendril.js before any page script runs.

export type SensorKind = "camera" | "microphone" | "screen" | "location" | "motion";

export interface SensorTracker {
  /** Sensors currently in use by page code. */
  active(): SensorKind[];
  onChange(fn: () => void): () => void;
  /** Stops every tracked track, watch, listener and recognizer. Returns how many things were stopped. */
  stopAll(): number;
  /** Unwrapped getUserMedia for the control's own use (not shown as page use). */
  getUserMedia(c: MediaStreamConstraints): Promise<MediaStream>;
  /** Mark a SpeechRecognition instance as the control's own. */
  own(rec: object): void;
}

const MOTION_TYPES = new Set(["devicemotion", "deviceorientation", "deviceorientationabsolute"]);
const RECENT_LOCATION_MS = 15000;

let singleton: SensorTracker | null = null;

export function installSensorWrappers(): SensorTracker {
  if (singleton) return singleton;
  const w = window as any;
  const tracks = new Map<MediaStreamTrack, SensorKind>();
  const watches = new Set<number>();
  const motion: { type: string; listener: any; options: any }[] = [];
  const recognizers = new Set<any>();
  const ownRecognizers = new WeakSet<object>();
  const subs = new Set<() => void>();
  let recentLocationUntil = 0;
  let lastSig = "";

  const compute = (): SensorKind[] => {
    const out = new Set<SensorKind>();
    for (const [t, k] of tracks) {
      if (t.readyState === "live") out.add(k);
      else tracks.delete(t);
    }
    if (recognizers.size) out.add("microphone");
    if (watches.size || Date.now() < recentLocationUntil) out.add("location");
    if (motion.length || w.ondevicemotion || w.ondeviceorientation || w.ondeviceorientationabsolute) out.add("motion");
    const order: SensorKind[] = ["camera", "microphone", "screen", "location", "motion"];
    return order.filter((k) => out.has(k));
  };
  const check = () => {
    const sig = compute().join(",");
    if (sig !== lastSig) {
      lastSig = sig;
      for (const f of subs) { try { f(); } catch { /* ignore */ } }
    }
  };
  const notify = () => queueMicrotask(check);

  // --- Media (camera, microphone, screen) ---
  const addTrack = (t: MediaStreamTrack, screen: boolean) => {
    const kind: SensorKind = screen ? "screen" : t.kind === "video" ? "camera" : "microphone";
    if (tracks.has(t)) return;
    tracks.set(t, kind);
    try { t.addEventListener("ended", notify); } catch { /* ignore */ }
  };
  const trackStream = (s: MediaStream, screen: boolean) => {
    try {
      for (const t of s.getTracks()) addTrack(t, screen);
      s.addEventListener?.("addtrack", (e: any) => { if (e.track) { addTrack(e.track, screen); notify(); } });
    } catch { /* ignore */ }
    notify();
  };
  const md: any = navigator.mediaDevices;
  let origGUM: ((c: MediaStreamConstraints) => Promise<MediaStream>) | null = null;
  if (md && typeof md.getUserMedia === "function") {
    origGUM = md.getUserMedia.bind(md);
    try {
      md.getUserMedia = function getUserMedia(c: MediaStreamConstraints) {
        return origGUM!(c).then((s) => { trackStream(s, false); return s; });
      };
    } catch { /* ignore */ }
  }
  // Legacy callback APIs reach the same devices; MediaRecorder and AudioContext can only get
  // camera or microphone input through one of these, so tracking them covers recording too.
  const nav: any = navigator;
  for (const name of ["getUserMedia", "webkitGetUserMedia", "mozGetUserMedia"]) {
    const orig = nav[name];
    if (typeof orig !== "function") continue;
    try {
      nav[name] = function legacyGetUserMedia(c: MediaStreamConstraints, ok: (s: MediaStream) => void, fail?: (e: any) => void) {
        return orig.call(nav, c, (s: MediaStream) => { trackStream(s, false); ok?.(s); }, fail);
      };
    } catch { /* ignore */ }
  }
  if (md && typeof md.getDisplayMedia === "function") {
    const orig = md.getDisplayMedia.bind(md);
    try {
      md.getDisplayMedia = function getDisplayMedia(c?: any) {
        return orig(c).then((s: MediaStream) => { trackStream(s, true); return s; });
      };
    } catch { /* ignore */ }
  }
  const MST: any = w.MediaStreamTrack;
  if (MST?.prototype) {
    const origStop = MST.prototype.stop;
    const origClone = MST.prototype.clone;
    try {
      MST.prototype.stop = function (this: MediaStreamTrack) { const r = origStop.call(this); if (tracks.has(this)) notify(); return r; };
      MST.prototype.clone = function (this: MediaStreamTrack) {
        const c = origClone.call(this);
        const k = tracks.get(this);
        if (k) { tracks.set(c, k); notify(); }
        return c;
      };
    } catch { /* ignore */ }
  }

  // --- Geolocation ---
  const geo: any = navigator.geolocation;
  let origClear: ((id: number) => void) | null = null;
  if (geo) {
    const origWatch = geo.watchPosition?.bind(geo);
    const origGet = geo.getCurrentPosition?.bind(geo);
    origClear = geo.clearWatch?.bind(geo) ?? null;
    try {
      if (origWatch) geo.watchPosition = function watchPosition(...a: any[]) {
        const id = origWatch(...a);
        watches.add(id); notify();
        return id;
      };
      if (origGet) geo.getCurrentPosition = function getCurrentPosition(...a: any[]) {
        recentLocationUntil = Date.now() + RECENT_LOCATION_MS; notify();
        setTimeout(notify, RECENT_LOCATION_MS + 50);
        return origGet(...a);
      };
      if (origClear) geo.clearWatch = function clearWatch(id: number) {
        watches.delete(id); notify();
        return origClear!(id);
      };
    } catch { /* ignore */ }
  }

  // --- Motion and orientation listeners on window ---
  const origAdd = w.addEventListener;
  const origRemove = w.removeEventListener;
  const capture = (o: any) => !!(typeof o === "boolean" ? o : o?.capture);
  try {
    w.addEventListener = function addEventListener(this: any, type: string, listener: any, options?: any) {
      const target = this ?? window;
      if (target === window && listener && MOTION_TYPES.has(type)) {
        if (!motion.some((m) => m.type === type && m.listener === listener && capture(m.options) === capture(options))) {
          motion.push({ type, listener, options });
          notify();
        }
      }
      return origAdd.call(target, type, listener, options);
    };
    w.removeEventListener = function removeEventListener(this: any, type: string, listener: any, options?: any) {
      const target = this ?? window;
      if (target === window && MOTION_TYPES.has(type)) {
        const i = motion.findIndex((m) => m.type === type && m.listener === listener && capture(m.options) === capture(options));
        if (i >= 0) { motion.splice(i, 1); notify(); }
      }
      return origRemove.call(target, type, listener, options);
    };
  } catch { /* ignore */ }

  // --- Page-owned speech recognition (microphone) ---
  const SR: any = w.SpeechRecognition || w.webkitSpeechRecognition;
  if (SR?.prototype?.start) {
    const origStart = SR.prototype.start;
    try {
      SR.prototype.start = function (this: any, ...a: any[]) {
        const r = origStart.apply(this, a);
        if (!ownRecognizers.has(this) && !recognizers.has(this)) {
          recognizers.add(this);
          const done = () => { recognizers.delete(this); notify(); };
          try { this.addEventListener("end", done, { once: true }); } catch { /* ignore */ }
          notify();
        }
        return r;
      };
    } catch { /* ignore */ }
  }

  // Track ends, `on…` handler properties and expiry of one-off location reads are
  // not all observable through events; a light poll catches them.
  setInterval(check, 2000);

  singleton = {
    active: compute,
    onChange(fn) { subs.add(fn); return () => subs.delete(fn); },
    stopAll() {
      let n = 0;
      for (const t of [...tracks.keys()]) { if (t.readyState === "live") { try { t.stop(); n++; } catch { /* ignore */ } } }
      tracks.clear();
      for (const id of [...watches]) { try { origClear?.(id); n++; } catch { /* ignore */ } }
      watches.clear();
      recentLocationUntil = 0;
      for (const m of motion.splice(0)) { try { origRemove.call(window, m.type, m.listener, m.options); n++; } catch { /* ignore */ } }
      for (const k of ["ondevicemotion", "ondeviceorientation", "ondeviceorientationabsolute"]) {
        if (w[k]) { try { w[k] = null; n++; } catch { /* ignore */ } }
      }
      for (const r of [...recognizers]) { try { r.abort(); n++; } catch { /* ignore */ } }
      recognizers.clear();
      check();
      return n;
    },
    getUserMedia(c) {
      if (origGUM) return origGUM(c);
      return Promise.reject(new Error("getUserMedia unavailable"));
    },
    own(rec) { ownRecognizers.add(rec); },
  };
  return singleton;
}
