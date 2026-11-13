/* Tendriller snippet: overlay.js — point and ask: draw arrows, boxes, circles and labels over a
 * camera view or image, in normalized coordinates (0..1 of the captured frame).
 *
 * Easiest: let the agent drive it through state.
 *   <script src="_tendril/snippets/overlay.js"></script>
 *   <script>tendrilSnippets.overlay.watch({ target: "video" });</script>
 * Then the agent PATCHes state:
 *   {"_overlay": {"frame": "b_…", "shapes": [
 *      {"shape":"arrow","x":0.62,"y":0.40,"text":"this screw"},          // arrow tip at x,y
 *      {"shape":"box","x":0.1,"y":0.2,"w":0.3,"h":0.25,"text":"fuse"},  // x,y = top-left
 *      {"shape":"circle","x":0.5,"y":0.5,"w":0.1,"color":"#0a84ff"},     // x,y = centre, w = diameter
 *      {"shape":"label","x":0.05,"y":0.9,"text":"Turn anticlockwise"}]}}
 *   - `_overlay` may also be just the array of shapes, or {"shapes": {"<id>": shape, …}} keyed by id.
 *   - optional "target": CSS selector of the <video>/<img>/<canvas> to draw over.
 *   - optional "frame": blob id of the photo the coordinates refer to (e.g. from camera.js
 *     capture). It is shown frozen over the live view so the marks stay on the right spot;
 *     set "frame": null to go back to live.  Set "_overlay": null to clear everything.
 *
 * Direct use:
 *   const ov = tendrilSnippets.overlay.attach(cam.video);
 *   ov.draw([{ shape: "box", x: .2, y: .3, w: .2, h: .2, text: "here" }]);  ov.clear();  ov.detach();
 *
 * Arrow: tip at (x,y); tail at (x2,y2), default up-left of the tip. Coordinates follow the
 * element's object-fit (cover, contain, fill, none, scale-down) and object-position, and a
 * mirrored preview (CSS scaleX(-1)) is handled, so they line up with camera.js captures.
 * Accessible: the drawing is an image whose name lists every label; changes are announced.
 */
(() => {
  const ns = (window.tendrilSnippets = window.tendrilSnippets || {});
  const SVGNS = "http://www.w3.org/2000/svg";
  const supported = () => !!document.createElementNS;

  /** Where the intrinsic frame lands inside an element box of size box (CSS px). */
  function layout(box, intrinsic, fit = "fill", position = "50% 50%") {
    const bw = box.width, bh = box.height, iw = intrinsic.width || bw, ih = intrinsic.height || bh;
    let sx = bw / iw, sy = bh / ih;
    if (fit === "contain") sx = sy = Math.min(sx, sy);
    else if (fit === "cover") sx = sy = Math.max(sx, sy);
    else if (fit === "none") sx = sy = 1;
    else if (fit === "scale-down") sx = sy = Math.min(1, Math.min(sx, sy));
    const w = iw * sx, h = ih * sy;
    const [px, py] = parsePosition(position, bw - w, bh - h);
    return { x: px + 0, y: py + 0, width: w, height: h }; // + 0 turns -0 into 0
  }
  function parsePosition(pos, freeX, freeY) {
    const words = { left: "0%", top: "0%", center: "50%", right: "100%", bottom: "100%" };
    let [a = "50%", b = "50%"] = String(pos).trim().split(/\s+/).map((t) => words[t] || t);
    if (/^(top|bottom)$/.test(String(pos).split(/\s+/)[0])) [a, b] = [b, a];
    const v = (t, free) => (t.endsWith("%") ? (parseFloat(t) / 100) * free : parseFloat(t) || 0);
    return [v(a, freeX), v(b, freeY)];
  }

  function intrinsicSize(el) {
    if (el.tagName === "VIDEO") return { width: el.videoWidth, height: el.videoHeight };
    if (el.tagName === "IMG") return { width: el.naturalWidth, height: el.naturalHeight };
    if (el.tagName === "CANVAS") return { width: el.width, height: el.height };
    return { width: el.clientWidth, height: el.clientHeight };
  }

  function attach(target, { frameUrl = (id) => "_tendril/blob/" + id } = {}) {
    let el = typeof target === "string" ? document.querySelector(target) : target;
    if (!el) throw new Error("overlay: target not found: " + target);
    const root = document.createElement("div");
    root.setAttribute("data-tendril-overlay", "");
    root.style.cssText = "position:absolute;overflow:hidden;pointer-events:none;z-index:2147483000";
    const frameImg = document.createElement("img");
    frameImg.alt = "";
    frameImg.style.cssText = "position:absolute;display:none";
    const svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("role", "img");
    svg.style.cssText = "position:absolute;inset:0;width:100%;height:100%;overflow:visible";
    const live = document.createElement("div");
    live.setAttribute("aria-live", "polite");
    live.style.cssText = "position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)";
    root.append(frameImg, svg, live);
    document.body.appendChild(root);

    let shapes = [], frame = null, lastAnnounce = "";

    function place() {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const pl = parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth), pt = parseFloat(cs.paddingTop) + parseFloat(cs.borderTopWidth);
      const cw = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const ch = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      Object.assign(root.style, { left: r.left + scrollX + pl + "px", top: r.top + scrollY + pt + "px", width: cw + "px", height: ch + "px" });
      const fit = cs.objectFit || "fill";
      const size = frame && frameImg.naturalWidth ? { width: frameImg.naturalWidth, height: frameImg.naturalHeight } : intrinsicSize(el);
      const L = layout({ width: cw, height: ch }, size, el.tagName === "DIV" ? "fill" : fit, cs.objectPosition);
      const m = /matrix\(([^,]+)/.exec(cs.transform);
      const mirrored = m && parseFloat(m[1]) < 0;
      if (frame) Object.assign(frameImg.style, { display: "block", left: L.x + "px", top: L.y + "px", width: L.width + "px", height: L.height + "px" });
      else frameImg.style.display = "none";
      render(L, mirrored && !frame);
      return L;
    }

    function render(L, mirrored) {
      svg.textContent = "";
      const X = (nx) => L.x + (mirrored ? 1 - nx : nx) * L.width;
      const Y = (ny) => L.y + ny * L.height;
      const stroke = Math.max(3, Math.min(L.width, L.height) / 120);
      const add = (tag, attrs, parent = svg) => {
        const n = document.createElementNS(SVGNS, tag);
        for (const k in attrs) n.setAttribute(k, attrs[k]);
        parent.appendChild(n);
        return n;
      };
      const labels = [];
      shapes.forEach((s, i) => {
        const color = s.color || "#ff3b30";
        const g = add("g", { "data-shape": s.shape, "data-index": i, stroke: color, fill: "none", "stroke-width": stroke, "stroke-linecap": "round", "stroke-linejoin": "round" });
        let tx = X(s.x), ty = Y(s.y);
        if (s.shape === "box") {
          const x1 = X(s.x), x2 = X(s.x + (s.w || 0));
          add("rect", { x: Math.min(x1, x2), y: Y(s.y), width: Math.abs(x2 - x1), height: (s.h || 0) * L.height, rx: stroke }, g);
          tx = Math.min(x1, x2); ty = Y(s.y) - stroke * 2;
        } else if (s.shape === "circle") {
          const rx = ((s.w || 0.1) / 2) * L.width, ry = s.h != null ? (s.h / 2) * L.height : rx;
          add("ellipse", { cx: X(s.x), cy: Y(s.y), rx, ry }, g);
          ty = Y(s.y) - ry - stroke * 2;
        } else if (s.shape === "arrow") {
          const x2 = X(s.x2 ?? s.x - 0.12), y2 = Y(s.y2 ?? s.y - 0.12);
          const a = Math.atan2(ty - y2, tx - x2), head = stroke * 5;
          add("line", { x1: x2, y1: y2, x2: tx, y2: ty }, g);
          add("polyline", { points: `${tx - head * Math.cos(a - 0.5)},${ty - head * Math.sin(a - 0.5)} ${tx},${ty} ${tx - head * Math.cos(a + 0.5)},${ty - head * Math.sin(a + 0.5)}` }, g);
          tx = x2; ty = y2 - stroke * 2;
        }
        if (s.text) {
          labels.push(s.text);
          const t = add("text", {
            x: tx, y: ty, fill: s.shape === "label" ? "#fff" : color, stroke: "#000", "stroke-width": Math.max(3, stroke),
            "paint-order": "stroke", "font-size": Math.max(16, L.height / 22), "font-family": "system-ui, sans-serif", "font-weight": 700,
          }, g);
          t.textContent = s.text;
        }
      });
      const name = labels.length ? "Annotations: " + labels.join("; ") : shapes.length ? `${shapes.length} annotation(s)` : "No annotations";
      svg.setAttribute("aria-label", name);
      if (labels.length && name !== lastAnnounce) live.textContent = name;
      lastAnnounce = name;
    }

    const onChange = () => place();
    const ro = window.ResizeObserver ? new ResizeObserver(onChange) : null;
    const watchEl = () => {
      if (ro) ro.observe(el);
      el.addEventListener("loadedmetadata", onChange);
      el.addEventListener("resize", onChange); // video dimension changes
      el.addEventListener("load", onChange);
    };
    watchEl();
    frameImg.addEventListener("load", onChange);
    addEventListener("resize", onChange);
    addEventListener("scroll", onChange, true);

    const api = {
      root, svg,
      draw(list) { shapes = Array.isArray(list) ? list.slice() : Object.values(list || {}); return place(); },
      clear() { shapes = []; frame = null; frameImg.removeAttribute("src"); place(); },
      setFrame(id) {
        frame = id || null;
        if (frame) frameImg.src = /^(https?:|data:|blob:|\/)/.test(frame) ? frame : frameUrl(frame);
        else frameImg.removeAttribute("src");
        place();
      },
      setTarget(t) {
        const n = typeof t === "string" ? document.querySelector(t) : t;
        if (!n || n === el) return;
        if (ro) ro.unobserve(el);
        el = n;
        watchEl();
        place();
      },
      /** Normalized frame coords → page coords (CSS px, relative to the document). */
      toPage(nx, ny) { const L = place(); const b = root.getBoundingClientRect(); return { x: b.left + scrollX + L.x + nx * L.width, y: b.top + scrollY + L.y + ny * L.height }; },
      layout: () => place(),
      detach() {
        if (ro) ro.disconnect();
        removeEventListener("resize", onChange);
        removeEventListener("scroll", onChange, true);
        root.remove();
      },
    };
    place();
    return api;
  }

  /** Follow state `_overlay` (or another key). Returns the overlay (or null until a target exists). */
  function watch({ target = "video, img, canvas", key = "_overlay", frameUrl } = {}) {
    const t = window.tendril;
    if (!t || !t.state) throw new Error("overlay.watch needs window.tendril.state");
    let ov = null;
    const api = { overlay: null, stop: () => {} };
    const apply = (val) => {
      const spec = Array.isArray(val) ? { shapes: val } : val || {};
      const sel = spec.target || target;
      if (!ov) {
        if (!val || !document.querySelector(sel)) return;
        ov = attach(sel, { frameUrl });
        api.overlay = ov;
      } else if (spec.target) ov.setTarget(spec.target);
      ov.setFrame(spec.frame || null);
      ov.draw(spec.shapes || []);
    };
    api.stop = t.state.on((state) => apply(state && state[key]));
    apply(t.state.get(key));
    return api;
  }

  ns.overlay = { supported, attach, watch, layout };
})();
