// Terminal QR code via the optional `qrcode-generator` package. Returns null if
// the package cannot be resolved from the CLI's location or the current directory.
import { createRequire } from "node:module";
import { join } from "node:path";

function loadQr() {
  for (const base of [import.meta.url, join(process.cwd(), "noop.js")]) {
    try { return createRequire(base)("qrcode-generator"); } catch { /* try next */ }
  }
  return null;
}

export function terminalQr(text) {
  const qrcode = loadQr();
  if (!qrcode) return null;
  const qr = qrcode(0, "L");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const q = 2; // quiet zone
  const dark = (r, c) => r >= 0 && c >= 0 && r < n && c < n && qr.isDark(r, c);
  const lines = [];
  for (let r = -q; r < n + q; r += 2) {
    let line = "\x1b[47m\x1b[30m";
    for (let c = -q; c < n + q; c++) {
      const t = dark(r, c), b = dark(r + 1, c);
      line += t && b ? "█" : t ? "▀" : b ? "▄" : " ";
    }
    lines.push(line + "\x1b[0m");
  }
  return lines.join("\n");
}
