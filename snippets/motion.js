/* Tendriller snippet: motion.js — device motion and orientation, with the iOS permission tap,
 * smoothing, and simple step and shake detection.
 *
 *   <div id="enable"></div>
 *   <script src="_tendril/snippets/motion.js"></script>
 *   <script>
 *     const motion = tendrilSnippets.motion;
 *     // iOS Safari (and recent Chrome, which added the same API) only allow motion after a
 *     // permission request from a tap: button() shows a button only where it is needed.
 *     motion.button("#enable", { label: "Enable motion" }).then(() => {
 *       motion.start({
 *         onStep: (n) => steps.textContent = n,
 *         onShake: () => tendril.send({ type: "shake" }, { wake: false }),
 *         onOrientation: (o) => dial.style.rotate = -(o.heading ?? 0) + "deg",   // compass heading
 *         onMotion: (m) => {},                                                   // smoothed, ~60 Hz
 *       });
 *     }, (msg) => console.warn(msg));
 *   </script>
 *
 * requestPermission() → "granted" | "denied" | "not-needed"   (call it inside a tap handler)
 * button(target, {label}) → Promise resolving once motion may be used (immediately where no tap is needed).
 * start({smoothing=0.2, stepThreshold=1.2 m/s², shakeThreshold=15 m/s², onMotion, onOrientation, onStep, onShake})
 *   → {stop(), steps}. onMotion gets {x,y,z, magnitude} (acceleration incl. gravity, smoothed);
 *   onOrientation gets {alpha, beta, gamma, heading} (heading: degrees from north when known).
 * Step counting is a heuristic (peak detection on acceleration); expect ±10%.
 */
(() => {
  const ns = (window.tendrilSnippets = window.tendrilSnippets || {});
  const supported = () => "DeviceMotionEvent" in window || "DeviceOrientationEvent" in window;
  const needsPermission = () => typeof (window.DeviceMotionEvent && DeviceMotionEvent.requestPermission) === "function";

  async function requestPermission() {
    if (!needsPermission()) return "not-needed";
    try {
      const m = await DeviceMotionEvent.requestPermission();
      if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === "function") await DeviceOrientationEvent.requestPermission().catch(() => {});
      return m === "granted" ? "granted" : "denied";
    } catch {
      return "denied"; // e.g. not called from a tap
    }
  }

  function button(target, { label = "Enable motion sensors" } = {}) {
    if (!supported()) return Promise.reject("This device or browser has no motion sensors.");
    if (!needsPermission()) return Promise.resolve("not-needed");
    const host = typeof target === "string" ? document.querySelector(target) : target;
    return new Promise((resolve, reject) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.style.cssText = "min-height:44px;padding:.6em 1.2em;font:inherit";
      b.onclick = async () => {
        const r = await requestPermission();
        b.remove();
        r === "denied" ? reject("Motion permission was denied. Reload the page to ask again.") : resolve(r);
      };
      host.appendChild(b);
    });
  }

  function start({ smoothing = 0.2, stepThreshold = 1.2, shakeThreshold = 15, onMotion, onOrientation, onStep, onShake } = {}) {
    let s = null, gravity = 9.81, wasAbove = false, lastStep = 0, steps = 0;
    let shakes = [];
    const onM = (e) => {
      const a = e.accelerationIncludingGravity;
      if (!a || a.x == null) return;
      const raw = { x: a.x, y: a.y, z: a.z };
      s = s ? { x: s.x + smoothing * (raw.x - s.x), y: s.y + smoothing * (raw.y - s.y), z: s.z + smoothing * (raw.z - s.z) } : raw;
      const mag = Math.hypot(s.x, s.y, s.z);
      gravity += 0.02 * (mag - gravity); // slow baseline
      const now = e.timeStamp || performance.now();
      const above = mag - gravity > stepThreshold;
      if (above && !wasAbove && now - lastStep > 300) {
        lastStep = now;
        steps++;
        if (onStep) onStep(steps);
      }
      wasAbove = above;
      const lin = e.acceleration && e.acceleration.x != null ? Math.hypot(e.acceleration.x, e.acceleration.y, e.acceleration.z) : Math.abs(Math.hypot(raw.x, raw.y, raw.z) - 9.81);
      if (lin > shakeThreshold) {
        shakes = shakes.filter((t) => now - t < 800).concat(now);
        if (shakes.length >= 3) { shakes = []; if (onShake) onShake(); }
      }
      if (onMotion) onMotion({ ...s, magnitude: mag });
    };
    const onO = (e) => {
      let heading = null;
      if (typeof e.webkitCompassHeading === "number") heading = e.webkitCompassHeading; // iOS
      else if (e.absolute && e.alpha != null) heading = (360 - e.alpha) % 360;
      if (onOrientation) onOrientation({ alpha: e.alpha, beta: e.beta, gamma: e.gamma, heading });
    };
    const oEvent = "ondeviceorientationabsolute" in window ? "deviceorientationabsolute" : "deviceorientation";
    addEventListener("devicemotion", onM);
    if (onOrientation) addEventListener(oEvent, onO);
    return {
      get steps() { return steps; },
      stop() { removeEventListener("devicemotion", onM); removeEventListener(oEvent, onO); },
    };
  }

  ns.motion = { supported, needsPermission, requestPermission, button, start };
})();
