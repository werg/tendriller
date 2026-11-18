import type { InstallationStatus, RuntimeInstallation } from "../../contract/index.mjs";

interface InstallPromptEvent extends Event {
  prompt(): Promise<unknown>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/** Browser-only installation signals. Construction makes no request and writes no storage. */
export function createInstallation(): { api: RuntimeInstallation; suspend(): void; resume(): void } {
  const userAgent = navigator.userAgent || "";
  const platform: InstallationStatus["platform"] = /iPhone|iPad|iPod/i.test(userAgent)
    || /Mac/i.test(navigator.platform || userAgent) && navigator.maxTouchPoints > 1 ? "ios"
    : /Android/i.test(userAgent) ? "android" : "desktop";
  let eligible = window.isSecureContext === true;
  try { eligible &&= window.top === window.self; } catch { eligible = false; }
  // Fullscreen also describes an ordinary browser tab (F11 or Fullscreen API),
  // so it cannot establish that this page is running as an installed app.
  const display = window.matchMedia?.("(display-mode: standalone), (display-mode: minimal-ui), (display-mode: window-controls-overlay)");
  let installed = false, suspended = true;
  let deferred: InstallPromptEvent | null = null;
  const listeners = new Set<(status: InstallationStatus) => void>();
  const status = (): InstallationStatus => ({
    state: !eligible ? "unavailable" : installed || display?.matches || (navigator as Navigator & { standalone?: boolean }).standalone === true
      ? "installed" : deferred && !suspended ? "available" : "manual",
    platform,
  });
  let previous = status().state;
  const publish = () => {
    if (suspended) return;
    const current = status();
    if (current.state === previous) return;
    previous = current.state;
    for (const listener of [...listeners]) {
      try { listener({ ...current }); } catch (error) { setTimeout(() => { throw error; }); }
    }
  };
  const beforeInstall = (event: Event) => {
    if (!eligible || suspended || status().state === "installed" || typeof (event as InstallPromptEvent).prompt !== "function") return;
    event.preventDefault();
    deferred = event as InstallPromptEvent;
    publish();
  };
  const appInstalled = () => { installed = true; deferred = null; publish(); };
  const displayChanged = () => { if (display?.matches) deferred = null; publish(); };
  const api: RuntimeInstallation = Object.freeze({
    status,
    on(listener: (status: InstallationStatus) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async prompt() {
      if (status().state !== "available" || !deferred) return "unavailable";
      const event = deferred;
      // A browser event is single-use, including when prompting fails. Consume it
      // before invoking browser code so repeated clicks cannot open two prompts.
      deferred = null;
      try {
        // Observe both promises immediately; a rejected userChoice must not be
        // left unhandled while the prompt itself is pending or throws.
        const choice = Promise.resolve(event.userChoice).then(result => result, () => null);
        const shown = event.prompt(); // Keep transient user activation: no await before this call.
        publish();
        await shown;
        const result = await choice;
        return result?.outcome === "accepted" || result?.outcome === "dismissed" ? result.outcome : "unavailable";
      } catch { return "unavailable"; }
      finally { publish(); }
    },
  });
  const suspend = () => {
    if (suspended) return;
    suspended = true;
    deferred = null;
    window.removeEventListener("beforeinstallprompt", beforeInstall);
    window.removeEventListener("appinstalled", appInstalled);
    display?.removeEventListener?.("change", displayChanged);
  };
  const resume = () => {
    if (!suspended) return;
    suspended = false;
    window.addEventListener("beforeinstallprompt", beforeInstall);
    window.addEventListener("appinstalled", appInstalled);
    display?.addEventListener?.("change", displayChanged);
    publish();
  };
  resume();
  return { api, suspend, resume };
}
