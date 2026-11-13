/* Tendriller snippet: geo.js — location as a page reflex: filtered watch, distance/bearing,
 * and route-step progress that tells the agent only when the step changes.
 *
 *   <script src="_tendril/snippets/geo.js"></script>
 *   <script>
 *     const geo = tendrilSnippets.geo;
 *     // Steps are the manoeuvre points of a route (the agent writes them, e.g. into state).
 *     const route = geo.route(tendril.state.get("route.steps"), {
 *       arriveRadius: 30,                                    // metres: "reached this step"
 *       onProgress: (p) => { next.textContent = `${p.step?.text} in ${Math.round(p.distanceToNext)} m`; },
 *       onStep: (p) => tendril.speak?.(p.step?.text ?? "You have arrived"),
 *       // sends {type:"route_step", index, text} on each change (wake:false), {type:"route_done"} at the end
 *     });
 *     startBtn.onclick = () => geo.watch({ maxAccuracy: 50, onPosition: route.update,
 *                                          onError: (msg) => alert(msg) });
 *   </script>
 *
 * watch({maxAccuracy=50 m, minDistance=0 m, highAccuracy=true, onPosition(pos), onError(msg)}) → {stop(), last}
 *   pos = {lat, lon, accuracy, heading, speed, ts}; fixes worse than maxAccuracy are skipped.
 * distance(a, b) → metres (haversine);  bearing(a, b) → degrees from north;  compass(deg) → "NE".
 * route(steps, {arriveRadius=30, send=true, wake=false, onStep, onProgress}) → {update(pos), index, reset()}
 *   steps = [{lat, lon, text?}, …]; update returns {index, step, distanceToNext, bearingToNext, done}.
 *   Reaching a later step directly (a skipped one) jumps ahead.
 * Note: location stops when the phone locks or the tab is in the background (use wakelock.js).
 */
(() => {
  const ns = (window.tendrilSnippets = window.tendrilSnippets || {});
  const supported = () => "geolocation" in navigator;
  const R = 6371008.8, rad = (d) => (d * Math.PI) / 180;

  function distance(a, b) {
    const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function bearing(a, b) {
    const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
    const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  }
  const compass = (deg) => ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(deg / 45) % 8];

  function explain(err) {
    if (!window.isSecureContext) return "Location needs a secure (HTTPS) page.";
    if (err.code === 1) return "Location permission was denied. Allow location for this site in the browser settings.";
    if (err.code === 2) return "Location is unavailable right now (no GPS fix or location services off).";
    if (err.code === 3) return "Getting a location fix took too long.";
    return "Location error: " + err.message;
  }

  function watch({ maxAccuracy = 50, minDistance = 0, highAccuracy = true, onPosition, onError } = {}) {
    if (!supported()) { onError && onError("This browser has no location access."); return { stop() {}, last: null }; }
    const api = { last: null, stop: () => navigator.geolocation.clearWatch(id) };
    const id = navigator.geolocation.watchPosition(
      (p) => {
        const c = p.coords;
        if (c.accuracy > maxAccuracy) return;
        const pos = { lat: c.latitude, lon: c.longitude, accuracy: c.accuracy, heading: c.heading, speed: c.speed, ts: p.timestamp };
        if (api.last && minDistance && distance(api.last, pos) < minDistance) return;
        api.last = pos;
        if (onPosition) onPosition(pos);
      },
      (e) => onError && onError(explain(e)),
      { enableHighAccuracy: highAccuracy, maximumAge: 2000, timeout: 30000 },
    );
    return api;
  }

  function route(steps, { arriveRadius = 30, send = true, wake = false, onStep, onProgress } = {}) {
    steps = steps || [];
    let index = 0; // the step we are heading towards
    const progress = (pos) => {
      const step = steps[index] || null;
      const done = index >= steps.length;
      return { index, step, done, total: steps.length,
        distanceToNext: step && pos ? distance(pos, step) : 0, bearingToNext: step && pos ? bearing(pos, step) : null };
    };
    const api = {
      get index() { return index; },
      update(pos) {
        const before = index;
        // Arrived at the current step, or at any later one (skipped steps): move past it.
        for (let j = steps.length - 1; j >= index; j--) {
          if (distance(pos, steps[j]) <= arriveRadius) { index = j + 1; break; }
        }
        const p = progress(pos);
        if (index !== before) {
          if (send && window.tendril) {
            const data = p.done ? { type: "route_done", total: steps.length } : { type: "route_step", index, text: p.step.text ?? null, total: steps.length };
            window.tendril.send(data, { wake });
          }
          if (onStep) onStep(p);
        }
        if (onProgress) onProgress(p);
        return p;
      },
      reset(newSteps) { if (newSteps) steps = newSteps; index = 0; },
    };
    return api;
  }

  ns.geo = { supported, watch, distance, bearing, compass, route };
})();
