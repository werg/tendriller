/* Tendriller snippet: qr.js — show a QR code for a link, and scan codes with the camera.
 *
 * "Point your phone at this screen to join" on a display tendril:
 *   <div id="join"></div>
 *   <script src="_tendril/snippets/qr.js"></script>
 *   <script>
 *     // The agent makes the link (POST <api>/links {"role":"guest"}) and puts it in state or the page.
 *     tendrilSnippets.qr.render("#join", "https://…/s/…/", { size: 280, caption: "Scan to join" });
 *   </script>
 *
 * render(target, text, {size=256, margin=4, ecc:"L"|"M"|"Q"|"H", caption, showText=true,
 *        dark="#000", light="#fff"}) → Promise<svg element>
 *   Draws an SVG (role="img", named "QR code: <text>") and, by default, the text itself below it
 *   so people who cannot scan can type it. Uses qrcode-generator@2 from jsDelivr, loaded on first
 *   use (or an existing window.qrcode).
 *
 * scan(source, {formats:["qr_code"]}) → [{rawValue, format}]   (source: video, img, canvas, Blob)
 * scanLoop(video, {fps=4, onCode(rawValue, format)}) → {stop()}   — fires once per new code.
 *   Scanning uses the browser's BarcodeDetector (Chrome on Android/ChromeOS/macOS; not Firefox,
 *   not desktop Linux/Windows Chrome as of 2026). canScan() tells you; otherwise ask the user to
 *   type or paste the link.
 */
(() => {
  const ns = (window.tendrilSnippets = window.tendrilSnippets || {});
  const LIB = "https://cdn.jsdelivr.net/npm/qrcode-generator@2/dist/qrcode.js";
  let loading = null;

  function load() {
    if (window.qrcode) return Promise.resolve(window.qrcode);
    return (loading ||= new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = LIB;
      s.onload = () => (window.qrcode ? resolve(window.qrcode) : reject(new Error("qrcode-generator did not load")));
      s.onerror = () => { loading = null; reject(new Error("Could not load qrcode-generator from " + LIB)); };
      document.head.appendChild(s);
    }));
  }

  const supported = () => true; // rendering works anywhere the CDN script can load
  async function canScan() {
    if (!("BarcodeDetector" in window)) return false;
    try { return (await window.BarcodeDetector.getSupportedFormats()).includes("qr_code"); } catch { return false; }
  }

  async function render(target, text, { size = 256, margin = 4, ecc = "M", caption, showText = true, dark = "#000", light = "#fff" } = {}) {
    const host = typeof target === "string" ? document.querySelector(target) : target;
    const qrcode = await load();
    if (qrcode.stringToBytesFuncs && qrcode.stringToBytesFuncs["UTF-8"]) qrcode.stringToBytes = qrcode.stringToBytesFuncs["UTF-8"];
    const qr = qrcode(0, ecc);
    qr.addData(String(text));
    qr.make();
    const n = qr.getModuleCount(), total = n + margin * 2;
    let d = "";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + margin} ${r + margin}h1v1h-1z`;
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${total} ${total}`);
    svg.setAttribute("width", size);
    svg.setAttribute("height", size);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "QR code: " + text);
    svg.setAttribute("shape-rendering", "crispEdges");
    svg.dataset.modules = n;
    const bg = document.createElementNS(NS, "rect");
    Object.entries({ width: total, height: total, fill: light }).forEach(([k, v]) => bg.setAttribute(k, v));
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", dark);
    svg.append(bg, path);

    const fig = document.createElement("figure");
    fig.className = "tendril-qr";
    fig.style.cssText = "margin:0;display:inline-flex;flex-direction:column;align-items:center;gap:.5em";
    fig.appendChild(svg);
    if (caption || showText) {
      const cap = document.createElement("figcaption");
      cap.style.cssText = "text-align:center;max-width:" + Math.max(size, 200) + "px;overflow-wrap:anywhere";
      if (caption) cap.append(Object.assign(document.createElement("strong"), { textContent: caption }));
      if (caption && showText) cap.append(document.createElement("br"));
      if (showText) cap.append(Object.assign(document.createElement("span"), { textContent: text }));
      fig.appendChild(cap);
    }
    if (host) host.replaceChildren(fig);
    return svg;
  }

  async function scan(source, { formats = ["qr_code"] } = {}) {
    if (!("BarcodeDetector" in window)) throw new Error("This browser cannot scan codes (no BarcodeDetector). Type or paste the link instead.");
    if (source instanceof Blob) source = await createImageBitmap(source);
    const found = await new window.BarcodeDetector({ formats }).detect(source);
    return found.map((f) => ({ rawValue: f.rawValue, format: f.format }));
  }

  function scanLoop(video, { fps = 4, formats, onCode, onError } = {}) {
    let stopped = false, timer = null;
    const seen = new Set();
    const loop = async () => {
      if (stopped) return;
      try {
        if (video.readyState >= 2) for (const c of await scan(video, { formats })) {
          if (!seen.has(c.rawValue)) { seen.add(c.rawValue); onCode && onCode(c.rawValue, c.format); }
        }
      } catch (e) {
        stopped = true;
        return onError ? onError(e) : console.warn("qr:", e);
      }
      timer = setTimeout(loop, 1000 / fps);
    };
    loop();
    return { stop() { stopped = true; clearTimeout(timer); } };
  }

  ns.qr = { supported, canScan, render, scan, scanLoop, load };
})();
