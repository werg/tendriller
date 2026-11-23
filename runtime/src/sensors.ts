// Tracks live sensor use by page code so independent utilities can show indicators and offer
// one stop switch. Wrappers are installed during runtime bootstrap, synchronously
// from tendril.js before any page script runs.

import type { SensorKind, SensorStatus, ResourcePhase, RegisteredSensorOptions, RegisteredSensorHandle, RegisteredSensorStatus } from "../../contract/index.mjs";
export type { SensorKind, SensorStatus, ResourcePhase, RegisteredSensorOptions, RegisteredSensorHandle, RegisteredSensorStatus } from "../../contract/index.mjs";

export interface SensorTracker {
  /** Observed use and unanswered acquisitions are separate, coherent views. */
  status(): SensorStatus;
  onChange(fn: () => void): () => void;
  register(options: RegisteredSensorOptions): RegisteredSensorHandle;
  /** Stops tracked resources and abandons pending acquisitions/callbacks. Returns the number stopped or cancelled. */
  stopAll(): number;
}

const MOTION_TYPES = new Set(["devicemotion", "deviceorientation", "deviceorientationabsolute"]);
const RECENT_LOCATION_MS = 15000;
const SENSOR_ORDER: SensorKind[] = ["camera", "microphone", "screen", "location", "motion"];

let singleton: SensorTracker | null = null;

// Optional adapters are separate bundles. A private, non-enumerable promise
// marker carries the native acquisition lifetime across that boundary without
// delaying Stop all's public cancellation result.
const MEDIA_SETTLED = Symbol.for("tendriller.media-settled.v1");
export function mediaRequestSettled(request: Promise<MediaStream>): Promise<void> {
  const native = (request as Promise<MediaStream> & { [key: symbol]: Promise<void> | undefined })[MEDIA_SETTLED];
  return Promise.resolve(native || request).then(() => {}, () => {});
}

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
  type Resource = { id: string; kind: string; label?: string; state: ResourcePhase;
    controller: AbortController; stop: () => void | Promise<void>; stopRequested: boolean };
  const resources = new Map<string, Resource>();
  const phases = new Set<ResourcePhase>(["pending", "active", "stopping", "failed"]);
  let nextResource = 0;
  let recentLocationUntil = 0;
  let lastSig = '{"active":[],"pending":[]}';
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
    const registered: RegisteredSensorStatus[] = [];
    for (const resource of resources.values()) {
      if (resource.state === "active") out.add(resource.kind);
      if (resource.state === "pending") pending.add(resource.kind);
      registered.push({ id: resource.id, kind: resource.kind, state: resource.state,
        ...(resource.label === undefined ? {} : { label: resource.label }) });
    }
    const ordered = (kinds: Set<SensorKind>) => [...SENSOR_ORDER.filter(k => kinds.has(k)),
      ...[...kinds].filter(k => !SENSOR_ORDER.includes(k))];
    return { active: ordered(out), pending: ordered(pending), ...(registered.length ? { resources: registered } : {}) };
  };
  const check = () => {
    const status = compute();
    const sig = JSON.stringify(status);
    if (sig !== lastSig) {
      lastSig = sig;
      for (const f of subs) { try { f(); } catch { /* ignore */ } }
    }
  };
  const notify = () => queueMicrotask(check);

  // --- Cooperative page-owned resources ---
  const prepareStop = (resource: Resource): boolean => {
    if (resource.stopRequested || !resources.has(resource.id)) return false;
    resource.stopRequested = true;
    resource.state = "stopping";
    return true;
  };
  const invalidate = (resource: Resource) => {
    resource.controller.abort(new DOMException("Sensor resource was cancelled.", "AbortError"));
  };
  const finishStop = (resource: Resource) => {
    resources.delete(resource.id);
    notify();
  };
  const failedStop = (resource: Resource) => {
    // Do not report physical shutdown when page-owned cleanup failed.
    resource.state = "failed";
    notify();
  };
  const invokeStop = (resource: Resource) => {
    try {
      const stop = resource.stop;
      const result = stop();
      if (result && typeof result.then === "function")
        void Promise.resolve(result).then(() => finishStop(resource), () => failedStop(resource));
      else finishStop(resource);
    } catch { failedStop(resource); }
  };
  const CONTROL_CHARS = /[\x00-\x1f\x7f]/u;
  const register = (options: RegisteredSensorOptions): RegisteredSensorHandle => {
    if (!options || typeof options.kind !== "string" || !options.kind.trim() ||
        options.kind !== options.kind.trim() || options.kind.length > 128 || CONTROL_CHARS.test(options.kind) ||
        typeof options.stop !== "function")
      throw new TypeError("Sensor registration requires a kind and stop callback");
    let label: string | undefined;
    if (options.label !== undefined) {
      if (typeof options.label !== "string" || CONTROL_CHARS.test(options.label))
        throw new TypeError("Sensor label must contain 1–160 printable characters");
      label = options.label.trim();
      if (!label || label.length > 160)
        throw new TypeError("Sensor label must contain 1–160 printable characters");
    }
    const state = options.state ?? "pending";
    if (!phases.has(state)) throw new TypeError("Unknown sensor resource phase");
    const resource: Resource = { id: "resource-" + ++nextResource, kind: options.kind,
      ...(label === undefined ? {} : { label }), state,
      controller: new AbortController(), stop: options.stop, stopRequested: false };
    resources.set(resource.id, resource);
    notify();
    return Object.freeze({
      signal: resource.controller.signal,
      setState(state: ResourcePhase) {
        if (!phases.has(state)) throw new TypeError("Unknown sensor resource phase");
        if (resource.stopRequested || !resources.has(resource.id)) return;
        resource.state = state;
        notify();
      },
      unregister(options?: { acknowledgeFailure: true }) {
        if (options !== undefined) {
          if (!options || typeof options !== "object" || Array.isArray(options) ||
              Object.keys(options).length !== 1 || !Object.hasOwn(options, "acknowledgeFailure") ||
              options.acknowledgeFailure !== true)
            throw new TypeError("Failure acknowledgement requires { acknowledgeFailure: true }");
          // Repeated teardown must not hide a failed physical cleanup. Only a
          // deliberate acknowledgement after recovery removes that failure;
          // it cannot stop fresh work or hide cleanup that is still pending.
          if (resource.stopRequested && resource.state === "failed" && resources.delete(resource.id)) notify();
          return;
        }
        if (prepareStop(resource)) {
          invalidate(resource);
          invokeStop(resource);
          notify();
        }
      },
    });
  };

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
    let settleNative: () => void;
    const nativeSettled = new Promise<void>(resolve => { settleNative = resolve; });
    const acquisition = new Promise<MediaStream>((resolve, reject) => {
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
        settleNative!();
        return;
      }
      Promise.resolve(requested).then((stream) => {
        // Always observe the native result, even after rejecting our promise:
        // late grants and later addtrack events still need resource cleanup.
        try {
          trackStream(stream, screen, acquisitionEpoch);
          if (acquisitionEpoch !== epoch) { cancel(); return; }
          pendingMedia.delete(cancel);
          notify();
          if (!settled) { settled = true; resolve(stream); }
        } finally { settleNative!(); }
      }, (error) => {
        pendingMedia.delete(cancel);
        notify();
        if (!settled) { settled = true; reject(error); }
        settleNative!();
      });
    });
    Object.defineProperty(acquisition, MEDIA_SETTLED, { value: nativeSettled });
    return acquisition;
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
    register,
    stopAll() {
      // Invalidate first, before stopping resources can invoke page callbacks.
      // Calls deliberately made after this boundary belong to the next epoch.
      epoch++;
      const stopping = [...resources.values()].filter(prepareStop);
      // Snapshot the old epoch before abort listeners can start fresh work.
      const cancelledMedia = [...pendingMedia.keys()];
      pendingMedia.clear();
      const cancelledLocations = [...pendingLocations];
      pendingLocations.clear();
      for (const request of cancelledLocations) request.active = false;
      const stoppedTracks = [...tracks.keys()];
      tracks.clear();
      const stoppedWatches = [...watches];
      watches.clear();
      for (const [, request] of stoppedWatches) request.active = false;
      const stoppedMotion = motion.splice(0);
      const stoppedHandlers = ["ondevicemotion", "ondeviceorientation", "ondeviceorientationabsolute"]
        .map(key => [key, w[key]] as const);
      const stoppedRecognizers = [...recognizers];
      recognizers.clear();
      recentLocationUntil = 0;
      // Prepare every entry before abort listeners can reenter unregister or
      // stopAll, then invalidate all signals before invoking any stop callback.
      for (const resource of stopping) invalidate(resource);
      let n = stopping.length + cancelledLocations.length;
      for (const cancel of cancelledMedia) { cancel(); n++; }
      for (const t of stoppedTracks) { if (t.readyState === "live") { try { t.stop(); n++; } catch { /* ignore */ } } }
      for (const [id] of stoppedWatches) { try { origClear?.(id); n++; } catch { /* ignore */ } }
      for (const m of stoppedMotion) { try { origRemove.call(window, m.type, m.wrapped, m.options); n++; } catch { /* ignore */ } m.cleanup(); }
      for (const [key, handler] of stoppedHandlers) {
        if (handler && w[key] === handler) { try { w[key] = null; n++; } catch { /* ignore */ } }
      }
      for (const r of stoppedRecognizers) { try { r.abort(); n++; } catch { /* ignore */ } }
      for (const resource of stopping) invokeStop(resource);
      check();
      return n;
    },

  };
  return singleton;
}
