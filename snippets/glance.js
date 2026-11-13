/* Tendriller snippet: glance.js — "glance" camera mode: upload a frame only when the scene changes.
 *
 *   <div id="view" style="width:320px;height:240px"></div>
 *   <button id="go">Start watching</button>
 *   <script src="_tendril/snippets/glance.js"></script>
 *   <script>
 *     document.getElementById("go").onclick = async () => {   // camera permission needs a tap
 *       const g = await tendrilSnippets.glance.start({
 *         el: "#view",            // where to show the viewfinder (omit to keep it hidden)
 *         intervalMs: 1000,       // how often to look (cheap: a 32x24 grey thumbnail)
 *         threshold: 0.08,        // 0..1 mean pixel difference that counts as "changed"
 *         minIntervalMs: 10000,   // never upload more often than this
 *         wake: false,            // events are recorded; set true to wake the agent
 *         onChange: (shot) => console.log("changed", shot.diff, shot.id),
 *       });
 *       // later: g.stop()
 *     };
 *   </script>
 *
 * Each change uploads a JPEG via tendril.upload and sends
 *   {type:"glance", blob:id, url, width, height, diff}   (unless send:false).
 * Pass `video` to use an existing <video> (e.g. cam.video from camera.js) instead of opening a camera.
 * The first frame is uploaded as a baseline unless captureFirst:false.
 */
(() => {
  const ns = (window.tendrilSnippets = window.tendrilSnippets || {});
  const supported = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  const TW = 32, TH = 24;

  /** Grey thumbnail of the current frame as a Float32Array (0..1). */
  function thumb(video, ctx) {
    ctx.drawImage(video, 0, 0, TW, TH);
    const d = ctx.getImageData(0, 0, TW, TH).data;
    const g = new Float32Array(TW * TH);
    for (let i = 0; i < g.length; i++) g[i] = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) / 255;
    return g;
  }

  /** Mean absolute difference between two thumbnails, 0..1. */
  function difference(a, b) {
    if (!a || !b || a.length !== b.length) return 1;
    let s = 0;
    for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
    return s / a.length;
  }

  async function start({
    video, el, facing = "environment", intervalMs = 1000, threshold = 0.08, minIntervalMs = 10000,
    maxWidth = 1024, quality = 0.8, send = true, wake = false, upload = true, captureFirst = true, onChange, onError,
  } = {}) {
    let stream = null;
    if (!video) {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing } }, audio: false });
      video = document.createElement("video");
      video.muted = true;
      video.setAttribute("playsinline", "");
      video.setAttribute("aria-label", "Camera viewfinder (glance mode)");
      video.srcObject = stream;
      const host = typeof el === "string" ? document.querySelector(el) : el;
      if (host) {
        video.style.cssText = "width:100%;height:100%;object-fit:cover";
        host.appendChild(video);
      } else video.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none";
      await video.play().catch(() => {});
    }
    const ctx = Object.assign(document.createElement("canvas"), { width: TW, height: TH }).getContext("2d", { willReadFrequently: true });
    let reference = null, lastShot = 0, busy = false, stopped = false, count = 0;

    async function shoot(diff, frame) {
      const vw = video.videoWidth, vh = video.videoHeight;
      const scale = Math.min(1, maxWidth / vw);
      const c = Object.assign(document.createElement("canvas"), { width: Math.round(vw * scale), height: Math.round(vh * scale) });
      c.getContext("2d").drawImage(video, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", quality));
      const shot = { diff: Math.round(diff * 1000) / 1000, width: c.width, height: c.height, blob, ts: Date.now() };
      reference = frame;
      lastShot = Date.now();
      count++;
      if (upload && window.tendril) {
        Object.assign(shot, await window.tendril.upload(blob, { name: "glance.jpg" }));
        if (send) await window.tendril.send({ type: "glance", blob: shot.id, url: shot.url, width: shot.width, height: shot.height, diff: shot.diff }, { wake });
      }
      if (onChange) onChange(shot);
    }

    async function tick() {
      if (stopped || busy || !video.videoWidth) return;
      busy = true;
      try {
        const frame = thumb(video, ctx);
        if (!reference) {
          if (captureFirst) await shoot(1, frame);
          else reference = frame;
        } else {
          const diff = difference(frame, reference);
          if (diff >= threshold && Date.now() - lastShot >= minIntervalMs) await shoot(diff, frame);
        }
      } catch (e) {
        if (onError) onError(e); else console.warn("glance:", e);
      } finally {
        busy = false;
      }
    }
    const timer = setInterval(tick, intervalMs);
    tick();
    return {
      video,
      get count() { return count; },
      stop() {
        stopped = true;
        clearInterval(timer);
        if (stream) { stream.getTracks().forEach((t) => t.stop()); video.remove(); }
      },
    };
  }

  ns.glance = { supported, start, difference };
})();
