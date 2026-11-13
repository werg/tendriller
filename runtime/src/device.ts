// Device identity (PROTOCOL 1), name guess and capability probe.

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

export function rand32(n: number): string {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  let s = "";
  for (const x of b) s += B32[x & 31];
  return s;
}

export interface StoredDevice { id: string; secret: string; name?: string; role?: string }

function key(tendrilId: string) { return `tendril:${tendrilId}:device`; }

export function loadDevice(tendrilId: string): StoredDevice {
  try {
    const raw = localStorage.getItem(key(tendrilId));
    if (raw) {
      const d = JSON.parse(raw);
      if (d && typeof d.id === "string" && typeof d.secret === "string") return d;
    }
  } catch { /* storage unavailable */ }
  const d: StoredDevice = { id: "d_" + rand32(16), secret: rand32(32) };
  saveDevice(tendrilId, d);
  return d;
}

export function saveDevice(tendrilId: string, d: StoredDevice): void {
  try { localStorage.setItem(key(tendrilId), JSON.stringify(d)); } catch { /* ignore */ }
}

export function guessName(ua: string = navigator.userAgent): string {
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "iPad";
  if (/Android/.test(ua)) {
    const pixel = /Pixel/.test(ua);
    const phone = /Mobile/.test(ua);
    if (pixel) return phone ? "Pixel phone" : "Pixel tablet";
    if (/SM-|Samsung/i.test(ua)) return phone ? "Samsung phone" : "Samsung tablet";
    return phone ? "Android phone" : "Android tablet";
  }
  if (/CrOS/.test(ua)) return "Chromebook";
  if (/Macintosh|Mac OS X/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows PC";
  if (/Linux/.test(ua)) return "Linux computer";
  return "Browser";
}

/** Summary of available APIs, sent in `hello.caps`. */
export function probeCaps(): Record<string, any> {
  const n: any = navigator;
  const w: any = window;
  let standalone = false;
  try { standalone = matchMedia("(display-mode: standalone)").matches || n.standalone === true; } catch { /* ignore */ }
  return {
    geolocation: "geolocation" in n,
    camera: !!(n.mediaDevices && n.mediaDevices.getUserMedia),
    speech_recognition: !!(w.SpeechRecognition || w.webkitSpeechRecognition),
    speech_synthesis: "speechSynthesis" in w,
    notifications: "Notification" in w,
    notification_permission: "Notification" in w ? (w.Notification.permission as string) : null,
    push: "PushManager" in w,
    service_worker: "serviceWorker" in n,
    wake_lock: "wakeLock" in n,
    vibrate: typeof n.vibrate === "function",
    share: typeof n.share === "function",
    clipboard: !!n.clipboard,
    bluetooth: "bluetooth" in n,
    usb: "usb" in n,
    serial: "serial" in n,
    hid: "hid" in n,
    nfc: "NDEFReader" in w,
    midi: typeof n.requestMIDIAccess === "function",
    barcode: "BarcodeDetector" in w,
    motion: "DeviceMotionEvent" in w,
    orientation: "DeviceOrientationEvent" in w,
    gamepad: typeof n.getGamepads === "function",
    webgpu: "gpu" in n,
    touch: (n.maxTouchPoints || 0) > 0,
    standalone,
    screen: { w: screen.width, h: screen.height, dpr: w.devicePixelRatio || 1 },
    language: n.language || null,
  };
}
