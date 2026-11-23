// A live, permission-aware description of this browser. Never prompts for access.
import type { Capability, CapabilityReport } from "../../contract/index.mjs";
export type { Capability, CapabilityReport } from "../../contract/index.mjs";

const definitions: Record<string, { available: () => boolean; permission?: string; tap?: boolean; note?: string }> = {
  camera: { available: () => !!navigator.mediaDevices?.getUserMedia, permission: "camera", tap: true },
  microphone: { available: () => !!navigator.mediaDevices?.getUserMedia, permission: "microphone", tap: true },
  location: { available: () => !!navigator.geolocation, permission: "geolocation", tap: true },
  motion: { available: () => "DeviceMotionEvent" in window, permission: "accelerometer", tap: true },
  orientation: { available: () => "DeviceOrientationEvent" in window, permission: "gyroscope", tap: true },
  screen_capture: { available: () => !!navigator.mediaDevices?.getDisplayMedia, permission: "display-capture", tap: true },
  file_picker: { available: () => true, tap: true },
  touch: { available: () => navigator.maxTouchPoints > 0 },
  pointer: { available: () => "PointerEvent" in window },
  keyboard: { available: () => true },
  speech_recognition: { available: () => !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition), tap: true },
  speech_synthesis: { available: () => "speechSynthesis" in window, tap: true },
  clipboard_read: { available: () => !!navigator.clipboard?.read, permission: "clipboard-read", tap: true },
  clipboard_write: { available: () => !!navigator.clipboard?.write, permission: "clipboard-write", tap: true },
  web_share: { available: () => !!navigator.share, tap: true },
  gamepad: { available: () => !!navigator.getGamepads, tap: true },
  vibration: { available: () => !!navigator.vibrate, tap: true },
  bluetooth: { available: () => !!(navigator as any).bluetooth, permission: "bluetooth", tap: true },
  usb: { available: () => !!(navigator as any).usb, tap: true },
  serial: { available: () => !!(navigator as any).serial, tap: true },
  hid: { available: () => !!(navigator as any).hid, tap: true },
  nfc: { available: () => "NDEFReader" in window, tap: true },
  midi: { available: () => !!(navigator as any).requestMIDIAccess, permission: "midi", tap: true },
  barcode: { available: () => "BarcodeDetector" in window },
  webxr: { available: () => !!(navigator as any).xr, tap: true },
  notifications: { available: () => "Notification" in window, permission: "notifications", tap: true },
  wake_lock: { available: () => !!navigator.wakeLock, permission: "screen-wake-lock", tap: true },
  ambient_light: { available: () => "AmbientLightSensor" in window, permission: "ambient-light-sensor" },
  proximity: { available: () => "ProximitySensor" in window },
  magnetometer: { available: () => "Magnetometer" in window, permission: "magnetometer" },
  gyroscope: { available: () => "Gyroscope" in window, permission: "gyroscope" },
  accelerometer: { available: () => "Accelerometer" in window, permission: "accelerometer" },
  contacts: { available: () => !!(navigator as any).contacts?.select, tap: true },
  eye_dropper: { available: () => "EyeDropper" in window, tap: true },
  file_system_access: { available: () => "showOpenFilePicker" in window, tap: true },
  directory_picker: { available: () => "showDirectoryPicker" in window, tap: true },
  drag_drop: { available: () => "DataTransfer" in window },
  pointer_lock: { available: () => "pointerLockElement" in document, tap: true },
  keyboard_lock: { available: () => !!(navigator as any).keyboard?.lock, tap: true },
  screen_orientation_lock: { available: () => !!screen.orientation?.lock, tap: true },
  battery: { available: () => !!(navigator as any).getBattery },
};

async function permission(name?: string): Promise<Capability["permission"]> {
  if (!name || !navigator.permissions?.query) return "unknown";
  try {
    const p = await navigator.permissions.query({ name: name as PermissionName });
    return p.state;
  } catch { return "unknown"; }
}

export async function describeCapabilities(active: readonly string[] = [], filter?: readonly string[]): Promise<CapabilityReport> {
  if (filter !== undefined && (!Array.isArray(filter) || filter.some(name => typeof name !== "string")))
    throw new TypeError("Capability filter must be an array of names");
  const selected = filter === undefined ? null : new Set(filter);
  const activeSet = new Set(active);
  const coreKinds: Record<string, string> = { camera: "camera", microphone: "microphone", location: "location",
    motion: "motion", orientation: "motion", screen_capture: "screen" };
  // Start every selected no-prompt permission query together. Filtering happens
  // before even probing availability; unrelated permissions are never queried.
  const entries = await Promise.all(Object.entries(definitions)
    .filter(([name]) => selected === null || selected.has(name))
    .map(async ([name, definition]): Promise<[string, Capability]> => {
      let available = false;
      try { available = definition.available(); } catch { /* unavailable */ }
      const coreKind = coreKinds[name];
      return [name, {
        available,
        permission: available ? await permission(definition.permission) : "unknown",
        needs_user_tap: !!definition.tap,
        active: activeSet.has(name) || (coreKind !== undefined && activeSet.has(coreKind)) ? true : coreKind !== undefined ? false : null,
        ...(definition.note ? { note: definition.note } : {}),
      }];
    }));
  return { captured_at: Date.now(), secure: window.isSecureContext, device: navigator.userAgent,
    capabilities: Object.fromEntries(entries) };
}

/** One owner orders reports from browser signals and explicit sensor refreshes. */
export function observeCapabilities(active: () => string[], changed: (report: Awaited<ReturnType<typeof describeCapabilities>>) => void): { refresh(): void; dispose(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false, generation = 0;
  const refresh = () => {
    if (stopped) return;
    const current = ++generation;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (stopped) return;
      void describeCapabilities(active()).then(report => {
        // Permission queries may resolve after a newer report or after pagehide.
        if (!stopped && current === generation) changed(report);
      }).catch(() => {});
    }, 100);
  };
  const statuses: PermissionStatus[] = [];
  if (navigator.permissions?.query) {
    for (const name of new Set(Object.values(definitions).map((d) => d.permission).filter(Boolean))) {
      void navigator.permissions.query({ name: name as PermissionName }).then((status) => {
        if (stopped) return;
        status.addEventListener("change", refresh);
        statuses.push(status);
      }).catch(() => {});
    }
  }
  navigator.mediaDevices?.addEventListener?.("devicechange", refresh);
  window.addEventListener("online", refresh);
  window.addEventListener("offline", refresh);
  const dispose = () => {
    if (stopped) return;
    stopped = true;
    generation++;
    if (timer) clearTimeout(timer);
    for (const status of statuses) status.removeEventListener("change", refresh);
    navigator.mediaDevices?.removeEventListener?.("devicechange", refresh);
    window.removeEventListener("online", refresh);
    window.removeEventListener("offline", refresh);
  };
  return { refresh, dispose };
}
