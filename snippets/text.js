/* Tendriller snippet: text.js — read text from an image or camera frame, on the device.
 *
 *   <script src="_tendril/snippets/text.js"></script>
 *   <script>
 *     const r = await tendrilSnippets.text.recognize(cam.video, { lang: "eng" });
 *     // → {text:"MILK 2.49\nBREAD 1.99", lines:[{text:"MILK 2.49", box:{x,y,w,h}}], engine:"tesseract", confidence:87}
 *     tendril.send({ type: "receipt_text", text: r.text }, { wake: true });
 *   </script>
 *
 * recognize(source, {lang="eng", engine:"auto"|"native"|"tesseract"}) where source is an
 * <img>, <video>, <canvas>, ImageBitmap or Blob. Boxes are 0..1 of the frame (overlay.js units).
 * Engines: the browser's TextDetector (Shape Detection API; mostly Chrome on Android/ChromeOS/macOS,
 * fast, no language choice) when present, else tesseract.js@7 from jsDelivr (≈ 2 MB runtime +
 * ≈ 2–10 MB per language on first use; slow on phones: seconds per frame).
 * Tesseract `lang` codes: "eng", "deu", "fra", "spa", "eng+deu", …   terminate() frees the worker.
 */
(() => {
  const ns = (window.tendrilSnippets = window.tendrilSnippets || {});
  const LIB = "https://cdn.jsdelivr.net/npm/tesseract.js@7/dist/tesseract.min.js";
  const hasNative = () => "TextDetector" in window;
  const supported = () => hasNative() || typeof WebAssembly === "object";

  let libLoading = null;
  const workers = {};
  function loadLib() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    return (libLoading ||= new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = LIB;
      s.onload = () => resolve(window.Tesseract);
      s.onerror = () => { libLoading = null; reject(new Error("Could not load tesseract.js from " + LIB)); };
      document.head.appendChild(s);
    }));
  }

  /** Copy any source to a canvas so every engine sees a plain bitmap. */
  async function toCanvas(src) {
    if (src instanceof Blob) src = await createImageBitmap(src);
    const w = src.videoWidth || src.naturalWidth || src.width, h = src.videoHeight || src.naturalHeight || src.height;
    if (!w || !h) throw new Error("The image has no pixels yet.");
    const c = Object.assign(document.createElement("canvas"), { width: w, height: h });
    c.getContext("2d").drawImage(src, 0, 0, w, h);
    return c;
  }

  async function recognize(source, { lang = "eng", engine = "auto" } = {}) {
    const canvas = await toCanvas(source);
    const W = canvas.width, H = canvas.height;
    if (engine === "native" || (engine === "auto" && hasNative())) {
      try {
        const found = await new window.TextDetector().detect(canvas);
        const lines = found.map((t) => ({ text: t.rawValue, box: { x: t.boundingBox.x / W, y: t.boundingBox.y / H, w: t.boundingBox.width / W, h: t.boundingBox.height / H } }));
        return { text: lines.map((l) => l.text).join("\n"), lines, engine: "native" };
      } catch (e) {
        if (engine === "native") throw e; // otherwise fall through to tesseract
      }
    }
    const T = await loadLib();
    const worker = await (workers[lang] ||= T.createWorker(lang));
    const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
    const lines = [];
    for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) {
      const bb = l.bbox;
      lines.push({ text: l.text.trim(), box: { x: bb.x0 / W, y: bb.y0 / H, w: (bb.x1 - bb.x0) / W, h: (bb.y1 - bb.y0) / H } });
    }
    return { text: (data.text || "").trim(), lines, engine: "tesseract", confidence: Math.round(data.confidence || 0) };
  }

  async function terminate() {
    for (const k of Object.keys(workers)) {
      const w = await workers[k];
      delete workers[k];
      await w.terminate();
    }
  }

  ns.text = { supported, recognize, terminate };
})();
