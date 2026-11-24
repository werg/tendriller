// Opt-in Web Push notification management and PWA App Badging (zero eager network work).
import type { NotificationStatus, RuntimeInstallation, RuntimeNotifications } from "../../contract/index.mjs";

function urlBase64ToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function pushSupported(): boolean {
  return typeof Notification !== "undefined"
    && "serviceWorker" in navigator
    && typeof PushManager !== "undefined";
}

export function createNotifications(
  base: string,
  installation: RuntimeInstallation,
  ensureServiceWorker: () => Promise<ServiceWorkerRegistration | null>,
): RuntimeNotifications {
  const getRegistration = async (): Promise<ServiceWorkerRegistration | null> => {
    if (!("serviceWorker" in navigator)) return null;
    try {
      const existing = await navigator.serviceWorker.getRegistration(base);
      return existing ?? null;
    } catch {
      return null;
    }
  };

  const status = async (): Promise<NotificationStatus> => {
    const inst = installation.status();
    if (inst.platform === "ios" && inst.state !== "installed") {
      return { state: "install_required", subscribed: false };
    }
    if (!pushSupported()) {
      return { state: "unsupported", subscribed: false };
    }
    const perm = Notification.permission;
    const state: NotificationStatus["state"] = perm === "granted" ? "granted" : perm === "denied" ? "denied" : "prompt";
    if (state !== "granted") return { state, subscribed: false };
    try {
      const reg = await getRegistration();
      const sub = reg?.pushManager ? await reg.pushManager.getSubscription() : null;
      return { state, subscribed: Boolean(sub) };
    } catch {
      return { state, subscribed: false };
    }
  };

  const enable = async (): Promise<NotificationStatus> => {
    const inst = installation.status();
    if (inst.platform === "ios" && inst.state !== "installed") {
      return { state: "install_required", subscribed: false };
    }
    if (!pushSupported()) {
      return { state: "unsupported", subscribed: false };
    }
    const permission = Notification.permission === "granted"
      ? "granted"
      : await Notification.requestPermission();
    if (permission !== "granted") {
      return { state: permission === "denied" ? "denied" : "prompt", subscribed: false };
    }
    const keyRes = await fetch(`${base}_tendril/push/key`, { credentials: "same-origin", cache: "no-store" });
    if (!keyRes.ok) throw new Error("Could not check notification configuration on this host.");
    const keyData = await keyRes.json() as { configured?: boolean; publicKey?: string | null };
    if (!keyData.configured || !keyData.publicKey) {
      throw new Error("Push notifications are not configured on this host yet.");
    }
    const reg = (await getRegistration()) ?? (await ensureServiceWorker());
    if (!reg || !reg.pushManager) {
      throw new Error("Service worker is unavailable for push notifications.");
    }
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(keyData.publicKey),
      });
    }
    const subJson = sub.toJSON();
    const res = await fetch(`${base}_tendril/push/subscribe`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        endpoint: sub.endpoint,
        keys: {
          p256dh: subJson.keys?.p256dh || "",
          auth: subJson.keys?.auth || "",
        },
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => null) as { error?: { message?: string } } | null;
      throw new Error(err?.error?.message || "Could not save notification subscription.");
    }
    return { state: "granted", subscribed: true };
  };

  const disable = async (): Promise<void> => {
    const reg = await getRegistration();
    const sub = reg?.pushManager ? await reg.pushManager.getSubscription() : null;
    if (sub) {
      const endpoint = sub.endpoint;
      try { await sub.unsubscribe(); } catch { /* ignore */ }
      try {
        await fetch(`${base}_tendril/push/subscribe`, {
          method: "DELETE",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint }),
        });
      } catch { /* ignore offline unsubscribe */ }
    }
  };

  const setBadge = async (count?: number): Promise<void> => {
    const nav = navigator as Navigator & {
      setAppBadge?: (count?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    try {
      if (!count || count <= 0) await nav.clearAppBadge?.();
      else await nav.setAppBadge?.(Math.min(999, Math.floor(count)));
    } catch { /* ignore unsupported badging */ }
  };

  return Object.freeze({ status, enable, disable, setBadge });
}
