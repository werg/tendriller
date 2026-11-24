// Managed Screen Wake Lock tied into tendril.sensors cooperative tracking.
import type { RegisteredSensorHandle, RegisteredSensorOptions } from "../../contract/index.mjs";

export interface WakeLockOptions {
  label?: string;
  /** Re-acquire automatically when returning to visible while this lease remains open. Defaults to false. */
  autoReacquire?: boolean;
}

export interface WakeLockLease {
  readonly supported: boolean;
  readonly active: boolean;
  release(): Promise<void>;
}

interface SentinelLike extends EventTarget {
  readonly released: boolean;
  release(): Promise<void>;
}

interface WakeLockNavigator {
  wakeLock?: { request(type: "screen"): Promise<SentinelLike> };
}

export function createWakeLockLease(
  register: (options: RegisteredSensorOptions) => RegisteredSensorHandle,
  onStopped: (fn: () => void) => () => void,
  options: WakeLockOptions = {},
): Promise<WakeLockLease> {
  const wakeLock = (navigator as unknown as WakeLockNavigator).wakeLock;
  if (!wakeLock || typeof wakeLock.request !== "function") {
    return Promise.resolve({ supported: false, active: false, async release() {} });
  }
  const label = options.label ?? "Keep screen awake";
  const autoReacquire = options.autoReacquire === true;
  let released = false;
  let sentinel: SentinelLike | null = null;
  let pending: Promise<SentinelLike> | null = null;
  let handle: RegisteredSensorHandle | null = null;

  const stopSentinel = async () => {
    const wait = pending;
    pending = null;
    const granted = await wait?.catch(() => null);
    const active = sentinel ?? granted;
    sentinel = null;
    if (active && !active.released) {
      try { await active.release(); } catch { /* already released by UA */ }
    }
  };

  const acquire = (): Promise<boolean> => {
    if (released || document.visibilityState === "hidden") return Promise.resolve(false);
    if (sentinel && !sentinel.released) return Promise.resolve(true);
    const current = register({
      kind: "wake_lock",
      label,
      stop: async () => {
        if (handle === current) handle = null;
        await stopSentinel();
      },
    });
    handle = current;
    try {
      // Call synchronously inside caller's gesture stack before any await.
      const req = wakeLock.request("screen");
      pending = req;
      return req.then(granted => {
        if (pending === req) pending = null;
        if (released || current.signal.aborted || handle !== current) {
          void granted.release().catch(() => {});
          return false;
        }
        sentinel = granted;
        current.setState("active");
        granted.addEventListener("release", () => {
          if (sentinel === granted) sentinel = null;
          if (handle === current) { handle = null; current.unregister(); }
        }, { once: true });
        return true;
      }, () => {
        if (pending === req) pending = null;
        if (handle === current) handle = null;
        current.unregister();
        return false;
      });
    } catch {
      if (handle === current) handle = null;
      current.unregister();
      return Promise.resolve(false);
    }
  };

  const onVisibility = () => {
    if (released) return;
    if (document.visibilityState === "hidden") {
      handle?.unregister();
    } else if (autoReacquire) {
      void acquire();
    }
  };

  const cleanup = async () => {
    if (released) return;
    released = true;
    document.removeEventListener("visibilitychange", onVisibility);
    offStopped();
    const h = handle;
    handle = null;
    h?.unregister();
    await stopSentinel();
  };

  const offStopped = onStopped(() => { void cleanup(); });
  document.addEventListener("visibilitychange", onVisibility);

  const initial = acquire();
  return initial.then(() => ({
    supported: true,
    get active() { return !released && Boolean(sentinel && !sentinel.released); },
    release: cleanup,
  }));
}
