// Tracks live sensor use by page code so independent utilities can show indicators and offer
// one stop switch. Wrappers are installed during runtime bootstrap, synchronously
// from tendril.js before any page script runs.

import type { SensorKind, SensorStatus } from "../../contract/index.mjs";
export type { SensorKind, SensorStatus } from "../../contract/index.mjs";

export interface SensorTracker {
  /** Observed use and unanswered acquisitions are separate, coherent views. */
  status(): SensorStatus;
  onChange(fn: () => void): () => void;
  /** Stops tracked resources and abandons pending acquisitions/callbacks. Returns the number stopped or cancelled. */
  stopAll(): number;
}

const MOTION_TYPES = new Set(["devicemotion", "deviceorientation", "deviceorientationabsolute"]);
const RECENT_LOCATION_MS = 15000;
const SENSOR_ORDER: SensorKind[] = ["camera", "microphone", "screen", "location", "motion"];

let singleton: SensorTracker | null = null;

export function installSensorWrappers(): SensorTracker {
  if (singleton) return singleton;
  const w = window as any;
  const tracks = new Map<MediaStreamTrack, SensorKind>();
  // Keep provenance weakly after live resources are cleared. A late stream event
  // or a clone of an old stream must not revive a cancelled acquisition.
  const trackSources = new WeakMap<MediaStreamTrack, { kind: SensorKind; epoch: number }>();
  const streamSources = new WeakMap<MediaStream, { screen: boolean; epoch: number }>();
  const pendingMedia = new Map<() => void, SensorKind[]>();
  type LocationRequest = { epoch: number; active: boolean };
  const watches = new Map<number, LocationRequest>();
  const pendingLocations = new Set<LocationRequest>();
  const motion: { type: string; listener: any; options: any; wrapped: any; cleanup(): void }[] = [];
  const recognizers = new Set<any>();
  const subs = new Set<() => void>();
  let recentLocationUntil = 0;
  let lastSig = "|";
  let epoch = 0;

  const compute = (): SensorStatus => {
    const out = new Set<SensorKind>();
    for (const [t, k] of tracks) {
      if (t.readyState === "live") out.add(k);
      else tracks.delete(t);
    }
    if (recognizers.size) out.add("microphone");
    if (watches.size || Date.now() < recentLocationUntil) out.add("location");
    if (motion.length || w.ondevicemotion || w.ondeviceorientation || w.ondeviceorientationabsolute) out.add("motion");
    const pending = new Set<SensorKind>();
    for (const kinds of pendingMedia.values()) for (const kind of kinds) pending.add(kind);
    if (pendingLocations.size) pending.add("location");
    return { active: SENSOR_ORDER.filter(k => out.has(k)), pending: SENSOR_ORDER.filter(k => pending.has(k)) };
  };
  const check = () => {
    const status = compute();
    const sig = status.active.join(",") + "|" + status.pending.join(",");
    if (sig !== lastSig) {
      lastSig = sig;
      for (const f of subs) { try { f(); } catch { /* ignore */ } }
    }
  };
  const notify = () => queueMicrotask(check);

  // --- Media (camera, microphone, screen) ---
  const addTrack = (t: MediaStreamTrack, screen: boolean, acquisitionEpoch: number) => {
    const source = trackSources.get(t) ?? {
      kind: (screen ? "screen" : t.kind === "video" ? "camera" : "microphone") as SensorKind,
      epoch: acquisitionEpoch,
    };
    trackSources.set(t, source);
    if (source.epoch !== epoch) {
      try { t.stop(); } catch { /* observation is best-effort */ }
      return;
    }
    // A new, independently acquired track may deliberately be reused in an old
    // stream. Its own acquisition, rather than that stream's age, owns its life.
    if (tracks.has(t) || t.readyState !== "live") return;
    tracks.set(t, source.kind);
    try { t.addEventListener("ended", notify); } catch { /* ignore */ }
  };
  const trackStream = (s: MediaStream, screen: boolean, acquisitionEpoch: number, trackExisting = true) => {
    if (streamSources.has(s)) return;
    streamSources.set(s, { screen, epoch: acquisitionEpoch });
    try {
      if (trackExisting) for (const t of s.getTracks()) addTrack(t, screen, acquisitionEpoch);
      s.addEventListener?.("addtrack", (e: any) => {
        if (e.track) { addTrack(e.track, screen, acquisitionEpoch); notify(); }
      });
    } catch { /* ignore */ }
    notify();
  };
  const acquireMedia = (request: () => Promise<MediaStream>, screen: boolean, kinds: SensorKind[]): Promise<MediaStream> => {
    const acquisitionEpoch = epoch;
    return new Promise((resolve, reject) => {
      let settled = false;
      const cancel = () => {
        if (settled) return;
        settled = true;
        pendingMedia.delete(cancel);
        notify();
        reject(new DOMException("Sensor acquisition was cancelled by Stop all.", "AbortError"));
      };
      pendingMedia.set(cancel, kinds);
      notify();
      // Call the native method synchronously so its user-activation semantics
      // remain intact. Browser-owned permission UI itself is not cancellable.
      let requested: Promise<MediaStream>;
      try { requested = request(); }
      catch (error) {
        pendingMedia.delete(cancel);
        notify();
        if (!settled) { settled = true; reject(error); }
        return;
      }
      Promise.resolve(requested).then((stream) => {
        // Always observe the native result, even after rejecting our promise:
        // late grants and later addtrack events still need resource cleanup.
        trackStream(stream, screen, acquisitionEpoch);
        if (acquisitionEpoch !== epoch) { cancel(); return; }
        pendingMedia.delete(cancel);
        notify();
        if (!settled) { settled = true; resolve(stream); }
      }, (error) => {
        pendingMedia.delete(cancel);
        notify();
        if (!settled) { settled = true; reject(error); }
      });
    });
  };
  const md: any = navigator.mediaDevices;
  let origGUM: ((c: MediaStreamConstraints) => Promise<MediaStream>) | null = null;
  if (md && typeof md.getUserMedia === "function") {
    origGUM = md.getUserMedia.bind(md);
    try {
      md.getUserMedia = function getUserMedia(c: MediaStreamConstraints) {
        const kinds: SensorKind[] = [];
        if (c?.video) kinds.push("camera");
        if (c?.audio) kinds.push("microphone");
        return acquireMedia(() => origGUM!(c), false, kinds);
      };
    } catch { /* ignore */ }
  }
  if (md && typeof md.getDisplayMedia === "function") {
    const orig = md.getDisplayMedia.bind(md);
    try {
      md.getDisplayMedia = function getDisplayMedia(c?: any) {
        return acquireMedia(() => orig(c), true, ["screen"]);
      };
    } catch { /* ignore */ }
  }
  const MST: any = w.MediaStreamTrack;
  const nativeCloneTrack = MST?.prototype?.clone;
  if (MST?.prototype) {
    const origStop = MST.prototype.stop;
    try {
      MST.prototype.stop = function (this: MediaStreamTrack) { const r = origStop.call(this); if (tracks.has(this)) notify(); return r; };
      MST.prototype.clone = function (this: MediaStreamTrack) {
        const c = nativeCloneTrack.call(this);
        const source = trackSources.get(this);
        if (source) { addTrack(c, source.kind === "screen", source.epoch); notify(); }
        return c;
      };
    } catch { /* ignore */ }
  }
  const MS: any = w.MediaStream;
  if (MS?.prototype?.clone && MS.prototype.getTracks && nativeCloneTrack) {
    const origClone = MS.prototype.clone;
    const getTracks = MS.prototype.getTracks;
    try {
      MS.prototype.clone = function (this: MediaStream) {
        const originals: MediaStreamTrack[] = getTracks.call(this);
        const source = streamSources.get(this);
        if (!source && !originals.some(track => trackSources.has(track))) return origClone.call(this);
        // MediaStream.clone is defined as constructing a fresh stream with a
        // native clone of each track. Do that explicitly for known sources:
        // getTracks ordering is not stable, so source/copy arrays cannot be
        // zipped to recover provenance after a native whole-stream clone.
        const copies: MediaStreamTrack[] = [];
        try {
          for (const original of originals) {
            const copy: MediaStreamTrack = nativeCloneTrack.call(original);
            copies.push(copy);
            const provenance = trackSources.get(original);
            if (provenance) addTrack(copy, provenance.kind === "screen", provenance.epoch);
          }
          const copy: MediaStream = new MS(copies);
          // Unknown tracks manually composed into a stream retain unknown
          // provenance. Only future native addtrack events inherit its origin.
          if (source) trackStream(copy, source.screen, source.epoch, false);
          notify();
          return copy;
        } catch (error) {
          for (const track of copies) { try { track.stop(); } catch { /* ignore */ } }
          notify();
          throw error;
        }
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
      const wrapCallback = (fn: any, request: LocationRequest, once: boolean, optional = false) => {
        if (typeof fn !== "function" && !(optional && fn == null)) return fn;
        return function (this: any, ...args: any[]) {
          if (!request.active || request.epoch !== epoch) return;
          if (once) {
            request.active = false; pendingLocations.delete(request);
            if (!optional) {
              recentLocationUntil = Date.now() + RECENT_LOCATION_MS;
              setTimeout(notify, RECENT_LOCATION_MS + 50);
            }
            notify();
          }
          return fn?.apply(this, args);
        };
      };
      if (origWatch) geo.watchPosition = function watchPosition(success: any, error?: any, options?: any) {
        const request = { epoch, active: true };
        const id = origWatch(wrapCallback(success, request, false), wrapCallback(error, request, false, true), options);
        if (request.epoch !== epoch) { request.active = false; origClear?.(id); }
        else watches.set(id, request);
        notify();
        return id;
      };
      if (origGet) geo.getCurrentPosition = function getCurrentPosition(success: any, error?: any, options?: any) {
        const request = { epoch, active: true };
        pendingLocations.add(request);
        notify();
        try {
          return origGet(wrapCallback(success, request, true), wrapCallback(error, request, true, true), options);
        } catch (error) {
          request.active = false; pendingLocations.delete(request);
          notify();
          throw error;
        }
      };
      if (origClear) geo.clearWatch = function clearWatch(id: number) {
        const request = watches.get(id);
        if (request) request.active = false;
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
      if (target !== window || !listener || !MOTION_TYPES.has(type)) return origAdd.call(target, type, listener, options);
      if (options?.signal?.aborted) return;
      const existing = motion.find(m => m.type === type && m.listener === listener && capture(m.options) === capture(options));
      if (existing) return origAdd.call(target, type, existing.wrapped, options);
      const record = { type, listener, options, wrapped: null as any, cleanup: () => {} };
      const remove = () => {
        const index = motion.indexOf(record);
        if (index >= 0) motion.splice(index, 1);
        options?.signal?.removeEventListener("abort", remove);
        notify();
      };
      record.cleanup = remove;
      record.wrapped = function(this: any, event: Event) {
        if (options?.once) remove();
        if (typeof listener === "function") return listener.call(this, event);
        return listener.handleEvent(event);
      };
      origAdd.call(target, type, record.wrapped, options);
      motion.push(record); options?.signal?.addEventListener("abort", remove, { once: true }); notify();
    };
    w.removeEventListener = function removeEventListener(this: any, type: string, listener: any, options?: any) {
      const target = this ?? window;
      if (target === window && MOTION_TYPES.has(type)) {
        const record = motion.find(m => m.type === type && m.listener === listener && capture(m.options) === capture(options));
        if (record) { record.cleanup(); return origRemove.call(target, type, record.wrapped, options); }
      }
      return origRemove.call(target, type, listener, options);
    };
  } catch { /* observation is best-effort; browser controls remain authoritative */ }

  // --- Page-owned speech recognition (microphone) ---
  const SR: any = w.SpeechRecognition || w.webkitSpeechRecognition;
  if (SR?.prototype?.start) {
    const origStart = SR.prototype.start;
    try {
      SR.prototype.start = function (this: any, ...a: any[]) {
        const r = origStart.apply(this, a);
        if (!recognizers.has(this)) {
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
    status: compute,
    onChange(fn) { subs.add(fn); return () => subs.delete(fn); },
    stopAll() {
      // Invalidate first, before stopping resources can invoke page callbacks.
      // Calls deliberately made after this boundary belong to the next epoch.
      epoch++;
      let n = 0;
      for (const cancel of [...pendingMedia.keys()]) { cancel(); n++; }
      for (const request of pendingLocations) { request.active = false; n++; }
      pendingLocations.clear();
      const stoppedTracks = [...tracks.keys()];
      tracks.clear();
      const stoppedWatches = [...watches];
      watches.clear();
      recentLocationUntil = 0;
      for (const t of stoppedTracks) { if (t.readyState === "live") { try { t.stop(); n++; } catch { /* ignore */ } } }
      for (const [id, request] of stoppedWatches) { request.active = false; try { origClear?.(id); n++; } catch { /* ignore */ } }
      for (const m of [...motion]) { try { origRemove.call(window, m.type, m.wrapped, m.options); n++; } catch { /* ignore */ } m.cleanup(); }
      for (const k of ["ondevicemotion", "ondeviceorientation", "ondeviceorientationabsolute"]) {
        if (w[k]) { try { w[k] = null; n++; } catch { /* ignore */ } }
      }
      for (const r of [...recognizers]) { try { r.abort(); n++; } catch { /* ignore */ } }
      recognizers.clear();
      check();
      return n;
    },

  };
  return singleton;
}
