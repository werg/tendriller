/* Tendriller snippet: wakelock.js — keep the screen on, and go fullscreen.
 *
 *   <div id="display-controls"></div>
 *   <script src="_tendril/snippets/wakelock.js"></script>
 *   <script>
 *     const wl = tendrilSnippets.wakelock;
 *     wl.button("#display-controls");          // "Keep screen on" + "Fullscreen" toggles (accessible)
 *     // or by hand, from a tap:
 *     await wl.keepAwake();                     // re-acquired automatically when the tab comes back
 *     wl.release();
 *     await wl.fullscreen.toggle(document.documentElement);
 *   </script>
 *
 * keepAwake() → Promise<boolean> (false if unsupported or refused, e.g. battery saver).
 * release(), active (getter), onChange(fn(active)) → unsubscribe.
 * fullscreen: {supported(), active(), enter(el?), exit(), toggle(el?)}  (iPhone Safari only
 *   allows fullscreen for <video>; enter() falls back to webkitEnterFullscreen there).
 * The lock drops whenever the page is hidden; this snippet re-requests it on return.
 */
(() => {
  const ns = (window.tendrilSnippets = window.tendrilSnippets || {});
  const supported = () => "wakeLock" in navigator;
  let sentinel = null, wanted = false;
  const listeners = new Set();
  const emit = () => listeners.forEach((f) => f(!!sentinel));

  async function acquire() {
    try {
      sentinel = await navigator.wakeLock.request("screen");
      sentinel.addEventListener("release", () => { sentinel = null; emit(); });
      emit();
      return true;
    } catch {
      sentinel = null;
      emit();
      return false;
    }
  }
  async function keepAwake() {
    wanted = true;
    if (!supported()) return false;
    return sentinel ? true : acquire();
  }
  function release() {
    wanted = false;
    if (sentinel) sentinel.release().catch(() => {});
  }
  document.addEventListener("visibilitychange", () => {
    if (wanted && !sentinel && document.visibilityState === "visible" && supported()) acquire();
  });

  const d = document;
  const fullscreen = {
    supported: () => !!(d.fullscreenEnabled || d.webkitFullscreenEnabled || d.createElement("video").webkitEnterFullscreen),
    active: () => !!(d.fullscreenElement || d.webkitFullscreenElement),
    async enter(el = d.documentElement) {
      if (el.requestFullscreen) return el.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
      if (el.webkitRequestFullscreen) return el.webkitRequestFullscreen();
      if (el.webkitEnterFullscreen) return el.webkitEnterFullscreen(); // iPhone: <video> only
    },
    async exit() {
      if (d.exitFullscreen && d.fullscreenElement) return d.exitFullscreen().catch(() => {});
      if (d.webkitExitFullscreen) return d.webkitExitFullscreen();
    },
    toggle(el) { return fullscreen.active() ? fullscreen.exit() : fullscreen.enter(el); },
  };

  function button(target, { fullscreenButton = true } = {}) {
    const host = typeof target === "string" ? d.querySelector(target) : target;
    const mk = (text) => {
      const b = d.createElement("button");
      b.type = "button";
      b.textContent = text;
      b.setAttribute("aria-pressed", "false");
      b.style.cssText = "min-height:44px;padding:.6em 1em;font:inherit;margin:.2em";
      host.appendChild(b);
      return b;
    };
    const awake = mk("Keep screen on");
    if (!supported()) { awake.disabled = true; awake.title = "Not supported in this browser"; }
    awake.onclick = () => (sentinel || wanted ? release() : keepAwake());
    onChange((on) => awake.setAttribute("aria-pressed", String(on)));
    if (fullscreenButton && fullscreen.supported()) {
      const fs = mk("Fullscreen");
      fs.onclick = () => fullscreen.toggle();
      d.addEventListener("fullscreenchange", () => fs.setAttribute("aria-pressed", String(fullscreen.active())));
    }
  }

  function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  ns.wakelock = { supported, keepAwake, release, onChange, button, fullscreen, get active() { return !!sentinel; } };
})();
