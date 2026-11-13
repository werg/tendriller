/* Tendriller snippet: probe.js — report what this browser and device actually support.
 *
 * From the agent, via eval:
 *   POST <api>/eval  {"code": "if (!window.tendrilSnippets?.probe) await new Promise((r, j) => document.head.append(Object.assign(document.createElement('script'), {src: '_tendril/snippets/probe.js', onload: r, onerror: j}))); return await tendrilSnippets.probe.run()"}
 *   → {"ua":"…","secure":true,"geolocation":{"available":true,"permission":"prompt"},"camera":{…},…}
 *
 * In a page:  const caps = await tendrilSnippets.probe.run();  tendril.send({type:"probe", caps}, {wake:false})
 *
 * Every entry is a fact about the API's presence (and permission state where the browser
 * reports it); presence does not guarantee the user will grant it. Notes explain the
 * known caveats (e.g. iOS motion needs a tap, notifications need home-screen install on iOS).
 */
(() => {
  const ns = (window.tendrilSnippets = window.tendrilSnippets || {});
  const supported = () => true;

  async function perm(name) {
    try {
      return (await navigator.permissions.query({ name })).state;
    } catch {
      return null;
    }
  }

  function webgl() {
    try {
      const c = document.createElement("canvas");
      if (c.getContext("webgl2")) return "webgl2";
      return c.getContext("webgl") ? "webgl" : false;
    } catch {
      return false;
    }
  }

  async function run() {
    const nav = navigator, w = window;
    const SR = w.SpeechRecognition || w.webkitSpeechRecognition;
    const ios = /iP(hone|ad|od)/.test(nav.userAgent) || (nav.platform === "MacIntel" && nav.maxTouchPoints > 1);
    const standalone = (w.matchMedia && w.matchMedia("(display-mode: standalone)").matches) || nav.standalone === true;
    const media = !!(nav.mediaDevices && nav.mediaDevices.getUserMedia);
    let devices = null;
    try {
      if (nav.mediaDevices && nav.mediaDevices.enumerateDevices) {
        const list = await nav.mediaDevices.enumerateDevices();
        devices = { cameras: list.filter((d) => d.kind === "videoinput").length, microphones: list.filter((d) => d.kind === "audioinput").length };
      }
    } catch {}
    let barcodeFormats = null;
    try {
      if (w.BarcodeDetector && w.BarcodeDetector.getSupportedFormats) barcodeFormats = await w.BarcodeDetector.getSupportedFormats();
    } catch {}
    let battery = null;
    try {
      if (nav.getBattery) {
        const b = await nav.getBattery();
        battery = { level: b.level, charging: b.charging };
      }
    } catch {}
    let webgpu = false;
    try {
      webgpu = !!(nav.gpu && (await nav.gpu.requestAdapter()));
    } catch {}
    let bluetooth = !!nav.bluetooth;
    try {
      if (bluetooth && nav.bluetooth.getAvailability) bluetooth = { api: true, adapter: await nav.bluetooth.getAvailability() };
    } catch {}
    const motionPermission = typeof (w.DeviceMotionEvent && w.DeviceMotionEvent.requestPermission) === "function";

    return {
      ua: nav.userAgent,
      platform: { ios, android: /Android/.test(nav.userAgent), mobile: /Mobi|Android|iP(hone|od)/.test(nav.userAgent) },
      secure: w.isSecureContext,
      language: nav.language,
      online: nav.onLine,
      standalone,
      screen: { width: screen.width, height: screen.height, viewportWidth: w.innerWidth, viewportHeight: w.innerHeight, dpr: w.devicePixelRatio, orientation: (screen.orientation && screen.orientation.type) || null },
      touch: { points: nav.maxTouchPoints || 0, coarsePointer: !!(w.matchMedia && w.matchMedia("(pointer: coarse)").matches) },
      prefs: {
        reducedMotion: !!(w.matchMedia && w.matchMedia("(prefers-reduced-motion: reduce)").matches),
        darkMode: !!(w.matchMedia && w.matchMedia("(prefers-color-scheme: dark)").matches),
        moreContrast: !!(w.matchMedia && w.matchMedia("(prefers-contrast: more)").matches),
      },
      geolocation: { available: "geolocation" in nav, permission: await perm("geolocation") },
      motion: {
        devicemotion: "DeviceMotionEvent" in w,
        deviceorientation: "DeviceOrientationEvent" in w,
        needsPermissionTap: motionPermission,
        note: motionPermission ? "Call DeviceMotionEvent.requestPermission() from a tap (motion.js does this)." : undefined,
      },
      camera: { available: media, permission: await perm("camera") },
      microphone: { available: media, permission: await perm("microphone") },
      mediaDevices: devices,
      mediaRecorder: "MediaRecorder" in w ? ["audio/webm", "audio/mp4", "audio/ogg", "video/webm", "video/mp4"].filter((t) => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } }) : false,
      speechRecognition: !!SR,
      speechSynthesis: "speechSynthesis" in w ? { available: true, voices: w.speechSynthesis.getVoices().length } : false,
      wakeLock: "wakeLock" in nav,
      fullscreen: !!(document.fullscreenEnabled || document.webkitFullscreenEnabled),
      notifications: "Notification" in w ? { available: true, permission: Notification.permission, note: ios && !standalone ? "iOS shows notifications only for pages installed to the home screen." : undefined } : false,
      push: "PushManager" in w && "serviceWorker" in nav,
      serviceWorker: "serviceWorker" in nav,
      bluetooth,
      nfc: "NDEFReader" in w,
      serial: "serial" in nav,
      usb: "usb" in nav,
      hid: "hid" in nav,
      midi: "requestMIDIAccess" in nav,
      gamepad: "getGamepads" in nav,
      barcodeDetector: barcodeFormats ? { available: true, formats: barcodeFormats } : "BarcodeDetector" in w,
      textDetector: "TextDetector" in w,
      faceDetector: "FaceDetector" in w,
      share: { available: "share" in nav, files: "canShare" in nav },
      clipboard: { read: !!(nav.clipboard && nav.clipboard.read), write: !!(nav.clipboard && nav.clipboard.writeText) },
      filePicker: { input: true, showOpenFilePicker: "showOpenFilePicker" in w, capture: "capture" in document.createElement("input") },
      vibrate: "vibrate" in nav,
      webgpu,
      webgl: webgl(),
      webassembly: typeof WebAssembly === "object",
      storage: { localStorage: (() => { try { return !!w.localStorage; } catch { return false; } })(), indexedDB: "indexedDB" in w },
      battery,
      memoryGB: nav.deviceMemory || null,
      cores: nav.hardwareConcurrency || null,
      connection: nav.connection ? { type: nav.connection.effectiveType, saveData: !!nav.connection.saveData } : null,
    };
  }

  ns.probe = { supported, run };
})();
