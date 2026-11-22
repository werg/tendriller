// Foreground microphone ownership is shared by every voice adapter on this origin.
// A lease is released only AFTER the caller has stopped its tracks/recognizer,
// including a getUserMedia request which may still resolve after cancellation.
export const MICROPHONE_LOCK = "tendriller-microphone";
export const MAX_WAKE_SESSION_MS = 5 * 60_000;
const MAX_CAPTURE_SESSION_MS = 60_000;
const POLICY_QUERY_MS = 1_000;

export interface MicrophoneSession {
  /** Release after microphone shutdown; safe to call more than once. */
  release(): void;
  /** Resolves only once Web Locks confirms its callback has returned. */
  readonly settled: Promise<void>;
}
export interface MicrophoneSessionOptions {
  signal?: AbortSignal;
  wake?: boolean;
  /** Stop capture synchronously where possible, then release the lease. */
  onStop(reason: string): void;
  /** May shorten, but never extend, the session's hard maximum. */
  maxDurationMs?: number;
}
interface BatteryStatus extends EventTarget { charging: boolean; level: number }
interface DataConnection extends EventTarget { saveData?: boolean }
type VoiceNavigator = Navigator & {
  getBattery?: () => Promise<BatteryStatus>;
  connection?: DataConnection;
};

function aborted(): DOMException { return new DOMException("Microphone start was cancelled.", "AbortError"); }

/**
 * Acquire after explicit local consent and before any microphone request. No
 * storage-based election is used: browsers without Web Locks fail closed.
 * Battery/Permissions APIs are advisory and are absent on some supported browsers;
 * their absence never disables the foreground and hard-duration safety bounds.
 */
export async function acquireMicrophoneSession(options: MicrophoneSessionOptions): Promise<MicrophoneSession> {
  if (options.signal?.aborted) throw aborted();
  if (globalThis.isSecureContext === false) throw new Error("Microphone access requires HTTPS or localhost.");
  if (document.visibilityState !== "visible") throw new Error("Open this page before starting the microphone.");
  const nav = navigator as VoiceNavigator;
  if (!nav.locks?.request) throw new Error("This browser cannot safely share microphone access between tabs. Use a browser with Web Locks or type instead.");
  const maximum = options.wake ? MAX_WAKE_SESSION_MS : MAX_CAPTURE_SESSION_MS;
  if (options.maxDurationMs !== undefined && (!Number.isFinite(options.maxDurationMs) || options.maxDurationMs <= 0)) {
    throw new Error("The microphone session duration must be a positive finite number.");
  }
  const duration = Math.min(maximum, options.maxDurationMs ?? maximum);
  let released = false;
  let granted = false;
  let stopped: Error | null = null;
  let rejectStart: (reason: Error) => void = () => {};
  let unlock: () => void = () => {};
  let settleLease: () => void = () => {};
  let requestIssued = false;
  const cleanups = new Set<() => void>();
  const hold = new Promise<void>(resolve => { unlock = resolve; });
  const settled = new Promise<void>(resolve => { settleLease = resolve; });
  const detach = () => { for (const off of cleanups) off(); cleanups.clear(); };
  const lease: MicrophoneSession = {
    settled,
    release() {
      if (released) return;
      released = true;
      detach();
      unlock();
      if (!requestIssued) settleLease();
    },
  };
  const stop = (reason: string, error: Error = new Error(reason)) => {
    if (released || stopped) return;
    stopped = error;
    detach();
    if (granted) options.onStop(reason);
    else rejectStart(error);
  };
  const ensureCurrent = () => {
    if (stopped) throw stopped;
    if (released || options.signal?.aborted) throw aborted();
    if (document.visibilityState !== "visible") throw new Error("Open this page before starting the microphone.");
  };
  const listen = (target: EventTarget, type: string, callback: () => void) => {
    target.addEventListener(type, callback);
    cleanups.add(() => target.removeEventListener(type, callback));
  };
  listen(document, "visibilitychange", () => {
    if (document.visibilityState !== "visible") stop("Microphone stopped because this page is hidden. Tap Start to resume.");
  });
  listen(document, "freeze", () => stop("Microphone stopped because the page was suspended. Tap Start to resume."));
  listen(window, "pagehide", () => stop("Microphone stopped because you left the page. Tap Start to resume."));
  if (options.signal) listen(options.signal, "abort", () => stop("Microphone start was cancelled.", aborted()));

  const startFailure = new Promise<never>((_, reject) => { rejectStart = reject; });
  // The race is attached immediately, so a synchronous policy event has a handler.
  const bounded = async (task: Promise<unknown>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>(resolve => { timer = setTimeout(resolve, POLICY_QUERY_MS); });
    try { await Promise.race([task, timeout, startFailure]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  };

  try {
    const checks: Promise<unknown>[] = [];
    if (nav.permissions?.query) {
      // Safari versions which do not implement the microphone descriptor throw;
      // getUserMedia remains the permission authority in those browsers.
      checks.push(Promise.resolve().then(() => nav.permissions.query({ name: "microphone" as PermissionName })).then(permission => {
        if (released || stopped) return;
        const check = () => { if (permission.state === "denied") stop("Microphone permission was denied or revoked. Review site permissions and tap Start again."); };
        listen(permission, "change", check);
        check();
      }, () => {}));
    }
    if (options.wake) {
      const connection = nav.connection;
      if (connection) {
        const check = () => { if (connection.saveData) stop("Wake listening is disabled while Data Saver is enabled. Use tap-to-talk or type instead."); };
        listen(connection, "change", check);
        check();
      }
      if (nav.getBattery) {
        checks.push(Promise.resolve().then(() => nav.getBattery!()).then(battery => {
          if (released || stopped) return;
          const check = () => {
            if (!battery.charging && Number.isFinite(battery.level) && battery.level <= 0.2) {
              stop("Wake listening stopped to save battery. Charge above 20%, connect power, or use tap-to-talk.");
            }
          };
          listen(battery, "chargingchange", check);
          listen(battery, "levelchange", check);
          check();
        }, () => {}));
      }
    }
    await bounded(Promise.all(checks));
    ensureCurrent();
    const acquired = new Promise<MicrophoneSession>((resolve, reject) => {
      requestIssued = true;
      const request = nav.locks.request(MICROPHONE_LOCK, { mode: "exclusive", ifAvailable: true }, async lock => {
        if (released || stopped || options.signal?.aborted) { reject(stopped || aborted()); return; }
        if (!lock) { reject(new Error("Another tab is using the microphone. Stop it there, then tap Start here.")); return; }
        try { ensureCurrent(); }
        catch (error) { reject(error); return; }
        granted = true;
        const timer = setTimeout(() => stop(options.wake
          ? "Wake listening reached its session time limit. The microphone is stopped; tap Start for another session."
          : "Microphone capture reached its session time limit. Tap the microphone to try again."), duration);
        cleanups.add(() => clearTimeout(timer));
        resolve(lease);
        await hold;
      });
      // Both synchronous implementations and promise rejection are handled. A
      // cancelled request which receives a late lock immediately returns it.
      void request.then(settleLease, error => {
        settleLease();
        reject(error instanceof Error ? error : new Error("Microphone ownership could not be acquired."));
      });
    });
    return await Promise.race([acquired, startFailure]);
  } catch (error) {
    lease.release();
    throw error;
  }
}
