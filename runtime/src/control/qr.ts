import qrcode from "qrcode-generator";

const SVG = "http://www.w3.org/2000/svg";

/** Renders `text` as a scalable SVG QR code (dark modules on a light quiet zone). */
export function qrSvg(text: string, label: string): SVGSVGElement {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const m = 4; // quiet zone
  const size = n + m * 2;
  let d = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) d += `M${c + m} ${r + m}h1v1h-1z`;
    }
  }
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("class", "qr");
  const bg = document.createElementNS(SVG, "rect");
  bg.setAttribute("width", String(size));
  bg.setAttribute("height", String(size));
  bg.setAttribute("fill", "#fff");
  const p = document.createElementNS(SVG, "path");
  p.setAttribute("d", d);
  p.setAttribute("fill", "#000");
  svg.append(bg, p);
  return svg;
}
