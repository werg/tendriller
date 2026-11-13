/* Tendriller snippet: screenshot.js — capture the visible page as a PNG and upload it.
 *
 * From the agent, via eval (the snippet loads itself if the page does not include it):
 *   POST <api>/eval  {"code": "if (!window.tendrilSnippets?.screenshot) await new Promise((r, j) => document.head.append(Object.assign(document.createElement('script'), {src: '_tendril/snippets/screenshot.js', onload: r, onerror: j}))); return await tendrilSnippets.screenshot.take()"}
 *   → {"id":"b_…","url":"_tendril/blob/b_…","width":…,"height":…}   then GET <api>/blobs/<id>
 *
 * In a page:
 *   <script src="_tendril/snippets/screenshot.js"></script>
 *   const shot = await tendrilSnippets.screenshot.take({ pixelRatio: 1, send: true });
 *
 * take({node=document.documentElement, fullPage=false, pixelRatio=devicePixelRatio (max 2),
 *       upload=true, send=false|true|{wake}, filter}) → {id, url, width, height} (+ blob)
 *   send: also sends {type:"screenshot", blob:id, url, width, height} (wakes unless {wake:false}).
 * Uses html-to-image@1 from jsDelivr, loaded on first use. It re-renders the DOM, so
 * cross-origin images without CORS, <video> frames and some canvases may come out blank.
 * Elements with the attribute data-screenshot-ignore are left out.
 */
(() => {
  const ns = (window.tendrilSnippets = window.tendrilSnippets || {});
  const LIB = "https://cdn.jsdelivr.net/npm/html-to-image@1/dist/html-to-image.js";
  let loading = null;

  function load() {
    if (window.htmlToImage) return Promise.resolve(window.htmlToImage);
    return (loading ||= new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = LIB;
      s.onload = () => resolve(window.htmlToImage);
      s.onerror = () => { loading = null; reject(new Error("Could not load html-to-image from " + LIB)); };
      document.head.appendChild(s);
    }));
  }

  const supported = () => typeof document !== "undefined" && "Promise" in window && !!document.createElement("canvas").getContext;

  async function take({ node = document.documentElement, fullPage = false, pixelRatio, upload = true, send = false, filter } = {}) {
    const lib = await load();
    const opts = {
      pixelRatio: pixelRatio ?? Math.min(2, window.devicePixelRatio || 1),
      cacheBust: false,
      filter: (n) => !(n.hasAttribute && n.hasAttribute("data-screenshot-ignore")) && (!filter || filter(n)),
    };
    if (!fullPage && node === document.documentElement) {
      // Crop to the viewport by shifting the clone by the current scroll offset.
      Object.assign(opts, {
        width: window.innerWidth,
        height: window.innerHeight,
        style: { transform: `translate(${-window.scrollX}px, ${-window.scrollY}px)` },
      });
    }
    const blob = await lib.toBlob(node, opts);
    if (!blob) throw new Error("Screenshot failed (empty image).");
    const bmp = await createImageBitmap(blob);
    const out = { width: bmp.width, height: bmp.height, blob };
    bmp.close && bmp.close();
    if (!upload) return out;
    const { id, url } = await window.tendril.upload(blob, { name: "screenshot.png" });
    Object.assign(out, { id, url });
    if (send) await window.tendril.send({ type: "screenshot", blob: id, url, width: out.width, height: out.height }, { wake: send.wake ?? true });
    // Blobs do not survive JSON (eval results); id/url/width/height do.
    Object.defineProperty(out, "blob", { enumerable: false });
    return out;
  }

  ns.screenshot = { supported, take, load };
})();
