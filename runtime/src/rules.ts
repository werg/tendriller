// Device rules (PROTOCOL section 10). Owned by the push agent.
// Rules arrive in `welcome.rules` and `{"t":"rules"}` and run on the device while
// the page is open. When one fires, its actions run and `rule_fired` goes to the server.
import type { Core } from "./types";

type When =
  | { type: "geofence"; lat: number; lon: number; radius_m: number; on: "enter" | "exit" }
  | { type: "time"; at: string; days?: string[] }
  | { type: "interval"; minutes: number };
type Action =
  | { type: "notify"; title: string; body?: string }
  | { type: "event"; data?: any }
  | { type: "state"; path: string | string[]; value: any }
  | { type: "navigate"; hash: string }
  | { type: "say"; text: string };
export interface Rule { id: string; when: When; do: Action[]; once?: boolean }

const TICK_MS = 20_000;          // time and interval check
const TIME_GRACE_MS = 2 * 60_000; // a time rule still fires if a tick was late by up to this much
const GEO_STATE_MAX_AGE = 30 * 60_000; // remembered inside/outside state is trusted for this long
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Great-circle distance in metres. */
export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function valid(r: any): r is Rule {
  if (!r || typeof r.id !== "string" || !r.when || !Array.isArray(r.do)) return false;
  const w = r.when;
  switch (w.type) {
    case "geofence": return Number.isFinite(w.lat) && Number.isFinite(w.lon) && Number.isFinite(w.radius_m) && w.radius_m > 0;
    case "time": return typeof w.at === "string" && /^\d{1,2}:\d{2}$/.test(w.at);
    case "interval": return Number.isFinite(w.minutes) && w.minutes > 0;
    default: return false;
  }
}

function dateKey(d: Date): string { return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; }

export function startRules(core: Core): void {
  const prefix = `tendril:${core.config.id}:rules:`;
  const store = {
    get(k: string): string | null { try { return localStorage.getItem(prefix + k); } catch { return null; } },
    set(k: string, v: string) { try { localStorage.setItem(prefix + k, v); } catch { /* storage full or blocked */ } },
  };

  let rules: Rule[] = [];
  let watchId: number | null = null;
  let tick: ReturnType<typeof setInterval> | null = null;
  const intervalLast = new Map<string, number>();

  // A `once` rule is remembered by id plus content, so a changed rule with the same id re-arms.
  const onceKey = (r: Rule) => `once:${r.id}:${hash(JSON.stringify([r.when, r.do]))}`;
  const geoKey = (r: Rule) => { const w = r.when as any; return `geo:${r.id}:${hash(JSON.stringify([w.lat, w.lon, w.radius_m]))}`; };
  const spent = (r: Rule) => !!r.once && store.get(onceKey(r)) !== null;

  function stop() {
    if (watchId !== null) { try { navigator.geolocation.clearWatch(watchId); } catch { /* ignore */ } watchId = null; }
    if (tick !== null) { clearInterval(tick); tick = null; }
  }

  function apply(list: unknown) {
    stop();
    rules = Array.isArray(list) ? list.filter(valid) : [];
    const now = Date.now();
    const ids = new Set(rules.map((r) => r.id));
    for (const id of [...intervalLast.keys()]) if (!ids.has(id)) intervalLast.delete(id);
    for (const r of rules) if (r.when.type === "interval" && !intervalLast.has(r.id)) intervalLast.set(r.id, now);

    const active = rules.filter((r) => !spent(r));
    if (active.some((r) => r.when.type === "geofence") && typeof navigator !== "undefined" && navigator.geolocation) {
      try {
        watchId = navigator.geolocation.watchPosition(onPosition, () => { /* denied or unavailable: geofences stay idle */ },
          { enableHighAccuracy: true, maximumAge: 15_000, timeout: 60_000 });
      } catch { watchId = null; }
    }
    if (active.some((r) => r.when.type === "time" || r.when.type === "interval")) {
      tick = setInterval(onTick, TICK_MS);
      onTick();
    }
  }

  function onPosition(pos: GeolocationPosition) {
    const { latitude, longitude, accuracy } = pos.coords;
    const now = Date.now();
    for (const r of rules) {
      if (r.when.type !== "geofence" || spent(r)) continue;
      const w = r.when;
      const dist = haversine(latitude, longitude, w.lat, w.lon);
      // Hysteresis: inside at <= radius, outside only beyond radius + margin, so jitter
      // at the boundary does not fire enter/exit repeatedly.
      const margin = Math.max(20, w.radius_m * 0.25, Math.min(accuracy || 0, 200));
      const k = geoKey(r);
      let prev: boolean | null = null;
      const saved = store.get(k);
      if (saved) { const [s, t] = saved.split(":"); if (now - Number(t) < GEO_STATE_MAX_AGE) prev = s === "in"; }
      let inside: boolean | null;
      if (dist <= w.radius_m) inside = true;
      else if (dist > w.radius_m + margin) inside = false;
      else inside = prev; // in the hysteresis band: keep the previous state
      if (inside === null) continue;
      store.set(k, `${inside ? "in" : "out"}:${now}`);
      if (inside === prev) continue;
      // First fix with no remembered state: being inside counts as entering; exit needs an observed inside.
      const fire = w.on === "exit" ? prev === true && !inside : inside;
      if (fire) run(r, { type: "geofence", on: w.on, distance_m: Math.round(dist), accuracy_m: Math.round(accuracy || 0), lat: latitude, lon: longitude });
    }
  }

  function onTick() {
    const now = new Date();
    const t = now.getTime();
    for (const r of rules) {
      if (spent(r)) continue;
      const w = r.when;
      if (w.type === "interval") {
        const every = Math.max(1, w.minutes) * 60_000;
        const last = intervalLast.get(r.id) ?? t;
        if (t - last >= every) { intervalLast.set(r.id, t); run(r, { type: "interval", minutes: w.minutes, ts: t }); }
      } else if (w.type === "time") {
        const [hh, mm] = w.at.split(":").map(Number);
        const due = new Date(now); due.setHours(hh, mm, 0, 0);
        if (t < due.getTime() || t - due.getTime() > TIME_GRACE_MS) continue;
        if (w.days?.length && !w.days.some((d) => String(d).toLowerCase().slice(0, 3) === DAYS[due.getDay()])) continue;
        const k = `time:${r.id}`, today = dateKey(due);
        if (store.get(k) === today) continue; // already fired today (survives reloads)
        store.set(k, today);
        run(r, { type: "time", at: w.at, ts: t });
      }
    }
  }

  function run(r: Rule, detail: Record<string, unknown>) {
    if (r.once) store.set(onceKey(r), String(Date.now()));
    for (const a of r.do) {
      try { act(r, a, detail); } catch (e) { console.warn("[tendril] rule action failed", r.id, a?.type, e); }
    }
    const cid = `rule-${r.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    core.raw({ t: "rule_fired", cid, rule_id: r.id, detail });
    core.bus.emit("rule_fired", { rule_id: r.id, detail });
    // A spent `once` geofence/time rule may leave nothing to watch.
    if (r.once && !rules.some((x) => !spent(x) && x.when.type === r.when.type)) {
      if (r.when.type === "geofence" && watchId !== null) { try { navigator.geolocation.clearWatch(watchId); } catch { /* ignore */ } watchId = null; }
    }
  }

  function act(r: Rule, a: Action, detail: Record<string, unknown>) {
    switch (a?.type) {
      case "notify": notify(r, String(a.title ?? ""), a.body == null ? "" : String(a.body)); break;
      case "event": void core.send(a.data !== undefined ? a.data : { rule: r.id, detail }).catch(() => {}); break;
      case "state": core.state.set(a.path, a.value); break;
      case "navigate": { const h = String(a.hash ?? ""); location.hash = h.startsWith("#") ? h : "#" + h; break; }
      case "say": say(String(a.text ?? "")); break;
    }
  }

  function notify(r: Rule, title: string, body: string) {
    const granted = typeof Notification !== "undefined" && Notification.permission === "granted";
    if (!granted) { core.bus.emit("notify_local", { title, body }); return; }
    const opts: NotificationOptions = { body, tag: `rule-${r.id}`, data: { url: location.href } };
    const fallback = () => {
      try { new Notification(title, opts); } catch { core.bus.emit("notify_local", { title, body }); }
    };
    // Android Chrome only allows notifications through the service worker.
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.getRegistration(core.config.base)
        .then((reg) => (reg ? reg.showNotification(title, opts) : fallback()))
        .catch(fallback);
    } else fallback();
  }

  function say(text: string) {
    if (!text || typeof speechSynthesis === "undefined") return;
    let prefs: any;
    try { prefs = core.state.get(["_prefs"]); } catch { prefs = null; }
    if (prefs?.audio === false) return;
    const u = new SpeechSynthesisUtterance(text);
    if (prefs?.language) u.lang = prefs.language;
    speechSynthesis.speak(u);
  }

  core.bus.on("welcome", (w: any) => apply(w?.rules));
  core.bus.on("rules", (m: any) => apply(Array.isArray(m) ? m : m?.rules));
}
