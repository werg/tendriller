// Web Push subscription on the page (PROTOCOL sections 7 and 10). Owned by the push agent.
// subscribe() must be called from a user gesture (the control's toggle does that):
// Notification.requestPermission() is the first thing it does, before any await.
import type { Core, Push } from "./types";

export type PushWithReason = Push & {
  /** Why push is unavailable or blocked, in words the control can show. Undefined when it can be used. */
  readonly reason?: string;
};

const IOS_REASON = "On iPhone and iPad, notifications work only after you add this page to your Home Screen: tap Share, then \"Add to Home Screen\", and open it from there.";

function isIOS(): boolean {
  const ua = navigator.userAgent || "";
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && (navigator.maxTouchPoints || 0) > 1);
}
function isStandalone(): boolean {
  return (navigator as any).standalone === true || (typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches);
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b = s.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const bin = atob(b + "===".slice((b.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

export function setupPush(core: Core): PushWithReason {
  const vapid = core.config.features?.push ? core.config.features.vapid : null;
  const supported = typeof window !== "undefined" && "PushManager" in window && "serviceWorker" in navigator && "Notification" in window;

  let staticReason: string | undefined;
  if (!vapid) staticReason = "Notifications are not set up on this server.";
  else if (isIOS() && !isStandalone()) staticReason = IOS_REASON;
  else if (!supported) staticReason = "This browser does not support notifications.";

  // Service worker registration: looked up asynchronously; `available` turns false if none appears.
  let reg: ServiceWorkerRegistration | null = null;
  let regMissing = false;
  let regPromise: Promise<ServiceWorkerRegistration | null> | null = null;
  const findReg = (): Promise<ServiceWorkerRegistration | null> => {
    if (reg) return Promise.resolve(reg);
    if (!regPromise) {
      regPromise = (async () => {
        const sw = navigator.serviceWorker;
        let r: ServiceWorkerRegistration | null = null;
        try { r = (await sw.getRegistration(core.config.base)) ?? null; } catch { /* ignore */ }
        if (!r) {
          // index.ts may still be registering it; wait briefly for `ready`.
          r = await Promise.race([sw.ready.catch(() => null), new Promise<null>((res) => setTimeout(() => res(null), 5000))]);
        }
        if (r) { reg = r; regMissing = false; }
        else {
          regMissing = true;
          regPromise = null; // retry next time
          sw.ready.then((late) => { reg = late; regMissing = false; core.bus.emit("push", { available: api.available }); }).catch(() => {});
        }
        return r;
      })();
    }
    return regPromise;
  };

  const vapidBytes = vapid ? b64urlToBytes(vapid) : null;

  async function currentSub(): Promise<PushSubscription | null> {
    const r = await findReg();
    if (!r) return null;
    try { return await r.pushManager.getSubscription(); } catch { return null; }
  }

  async function register(sub: PushSubscription): Promise<boolean> {
    try {
      const reply = await core.request({ t: "push_subscribe", subscription: sub.toJSON() });
      return !reply?.error;
    } catch { return false; }
  }

  async function ensureSub(r: ServiceWorkerRegistration): Promise<PushSubscription> {
    let sub = await r.pushManager.getSubscription();
    if (sub && !sameKey(sub.options?.applicationServerKey, vapidBytes!)) {
      // Server key changed: the old subscription can no longer be used.
      try { await sub.unsubscribe(); } catch { /* ignore */ }
      sub = null;
    }
    return sub ?? (await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidBytes! }));
  }

  const api: PushWithReason = {
    get available() { return !staticReason && !regMissing && Notification.permission !== "denied"; },
    get reason() {
      if (staticReason) return staticReason;
      if (regMissing) return "Notifications need this page's offline support (service worker), which is not active.";
      if (Notification.permission === "denied") return "Notifications are blocked for this page in the browser settings.";
      return undefined;
    },
    async subscribed() {
      if (staticReason || Notification.permission !== "granted") return false;
      return !!(await currentSub());
    },
    async subscribe() {
      if (staticReason) return false;
      // First await: keeps the user gesture for the permission prompt (Safari requires this).
      let perm: NotificationPermission;
      try { perm = await Notification.requestPermission(); } catch { perm = Notification.permission; }
      if (perm !== "granted") { core.bus.emit("push", { subscribed: false, permission: perm }); return false; }
      const r = await findReg();
      if (!r) return false;
      let sub: PushSubscription;
      try { sub = await ensureSub(r); } catch { return false; }
      const ok = await register(sub);
      core.bus.emit("push", { subscribed: ok });
      return ok;
    },
    async unsubscribe() {
      const sub = staticReason ? null : await currentSub();
      if (sub) { try { await sub.unsubscribe(); } catch { /* ignore */ } }
      try { await core.request({ t: "push_unsubscribe" }); } catch { /* offline: server drops it on the next 404/410 */ }
      core.bus.emit("push", { subscribed: false });
    },
  };

  if (!staticReason) {
    void findReg();
    // On every (re)connect, re-send an existing subscription so the server has it,
    // renewing it silently if the server's VAPID key changed (permission is already granted).
    core.bus.on("welcome", () => {
      if (Notification.permission !== "granted") return;
      void (async () => {
        const r = await findReg();
        if (!r || !(await r.pushManager.getSubscription())) return;
        try { await register(await ensureSub(r)); } catch { /* ignore */ }
      })();
    });
  }
  return api;
}
