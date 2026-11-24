// Zero-dependency ISO/IEC 18004 QR Code encoder (Byte mode, ECC Level L, Versions 1–10).
// Supports up to 271 UTF-8 bytes and renders a compact, high-contrast SVG with a 4-module quiet zone.

// Capacity & RS block specs for ECC Level L, Versions 1–10:
// [totalDataCodewords, ecPerBlock, g1Blocks, g1Data, g2Blocks, g2Data]
const SPECS: ReadonlyArray<readonly [number, number, number, number, number, number]> = [
  [0, 0, 0, 0, 0, 0], // placeholder for 1-indexing
  [19, 7, 1, 19, 0, 0],     // V1  (21x21)
  [34, 10, 1, 34, 0, 0],    // V2  (25x25)
  [55, 15, 1, 55, 0, 0],    // V3  (29x29)
  [80, 20, 1, 80, 0, 0],    // V4  (33x33)
  [108, 26, 1, 108, 0, 0],  // V5  (37x37)
  [136, 18, 2, 68, 0, 0],   // V6  (41x41)
  [156, 20, 2, 78, 0, 0],   // V7  (45x45)
  [194, 24, 2, 97, 0, 0],   // V8  (49x49)
  [232, 30, 2, 116, 0, 0],  // V9  (53x53)
  [274, 18, 2, 68, 2, 69],  // V10 (57x57)
];

const ALIGNMENT: ReadonlyArray<readonly number[]> = [
  [], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

// Precomputed GF(256) tables with primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11d)
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]!;
}

const gfMul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!);

function rsGenerator(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    const root = GF_EXP[i]!;
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]!;
      next[j + 1] ^= gfMul(poly[j]!, root);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data: Uint8Array, ecLen: number): Uint8Array {
  const gen = rsGenerator(ecLen);
  const rem = new Uint8Array(ecLen);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i]! ^ rem[0]!;
    rem.copyWithin(0, 1);
    rem[ecLen - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < ecLen; j++) rem[j] ^= gfMul(gen[j + 1]!, factor);
    }
  }
  return rem;
}

function encodeData(bytes: Uint8Array): { version: number; codewords: Uint8Array } {
  let version = 0;
  for (let v = 1; v < SPECS.length; v++) {
    const lenBits = v < 10 ? 8 : 16;
    const maxBytes = Math.floor((SPECS[v]![0] * 8 - 4 - lenBits) / 8);
    if (bytes.length <= maxBytes) { version = v; break; }
  }
  if (!version) throw new RangeError("QR payload exceeds supported length (271 bytes)");

  const [totalData, ecPerBlock, g1Blocks, g1Data, g2Blocks, g2Data] = SPECS[version]!;
  const bits: number[] = [];
  const pushBits = (val: number, count: number) => {
    for (let i = count - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  pushBits(0b0100, 4); // Byte mode
  pushBits(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) pushBits(b, 8);
  const capBits = totalData * 8;
  pushBits(0, Math.min(4, capBits - bits.length)); // Terminator
  while (bits.length % 8 !== 0) bits.push(0);
  let padToggle = 0;
  while (bits.length < capBits) {
    pushBits(padToggle ? 0x11 : 0xec, 8);
    padToggle ^= 1;
  }

  const dataBytes = new Uint8Array(totalData);
  for (let i = 0; i < totalData; i++) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i * 8 + j]!;
    dataBytes[i] = b;
  }

  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (let i = 0; i < g1Blocks; i++) {
    const block = dataBytes.subarray(offset, offset + g1Data);
    offset += g1Data;
    dataBlocks.push(block);
    ecBlocks.push(rsRemainder(block, ecPerBlock));
  }
  for (let i = 0; i < g2Blocks; i++) {
    const block = dataBytes.subarray(offset, offset + g2Data);
    offset += g2Data;
    dataBlocks.push(block);
    ecBlocks.push(rsRemainder(block, ecPerBlock));
  }

  const out: number[] = [];
  const maxDataLen = Math.max(g1Data, g2Data);
  for (let i = 0; i < maxDataLen; i++) {
    for (const block of dataBlocks) if (i < block.length) out.push(block[i]!);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const ec of ecBlocks) out.push(ec[i]!);
  }
  return { version, codewords: new Uint8Array(out) };
}

function formatBits(mask: number): number {
  // ECC Level L = 01
  const data = (0b01 << 3) | mask;
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) {
    if (rem & (1 << i)) rem ^= 0x537 << (i - 10);
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function versionBits(version: number): number {
  let rem = version << 12;
  for (let i = 17; i >= 12; i--) {
    if (rem & (1 << i)) rem ^= 0x1f25 << (i - 12);
  }
  return (version << 12) | rem;
}

const MASK_FNS: ReadonlyArray<(r: number, c: number) => boolean> = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function penalty(grid: Uint8Array, size: number): number {
  let score = 0;
  const at = (r: number, c: number) => grid[r * size + c]!;
  // Rule 1: runs of 5+
  for (let r = 0; r < size; r++) {
    let run = 1;
    for (let c = 1; c < size; c++) {
      if (at(r, c) === at(r, c - 1)) { run++; if (run === 5) score += 3; else if (run > 5) score += 1; }
      else run = 1;
    }
  }
  for (let c = 0; c < size; c++) {
    let run = 1;
    for (let r = 1; r < size; r++) {
      if (at(r, c) === at(r - 1, c)) { run++; if (run === 5) score += 3; else if (run > 5) score += 1; }
      else run = 1;
    }
  }
  // Rule 2: 2x2 blocks
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = at(r, c);
      if (v === at(r, c + 1) && v === at(r + 1, c) && v === at(r + 1, c + 1)) score += 3;
    }
  }
  // Rule 4: dark/light balance
  let dark = 0;
  for (let i = 0; i < grid.length; i++) if (grid[i]) dark++;
  const diff = Math.abs(Math.round((dark * 100) / grid.length) - 50);
  score += Math.floor(diff / 5) * 10;
  return score;
}

export interface QrMatrix {
  readonly size: number;
  readonly version: number;
  readonly modules: Uint8Array;
}

export function encodeQr(text: string): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  const { version, codewords } = encodeData(bytes);
  const size = version * 4 + 17;
  const fixed = new Uint8Array(size * size);
  const base = new Uint8Array(size * size);
  const setFixed = (r: number, c: number, dark: boolean) => {
    if (r < 0 || r >= size || c < 0 || c >= size) return;
    fixed[r * size + c] = 1;
    base[r * size + c] = dark ? 1 : 0;
  };

  // Finder patterns + separators
  const placeFinder = (tr: number, tc: number) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const border = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const center = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        setFixed(tr + dr, tc + dc, inOuter && (border || center));
      }
    }
  };
  placeFinder(0, 0);
  placeFinder(0, size - 7);
  placeFinder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    setFixed(6, i, i % 2 === 0);
    setFixed(i, 6, i % 2 === 0);
  }

  // Alignment patterns
  const centers = ALIGNMENT[version]!;
  for (const r of centers) {
    for (const c of centers) {
      if (fixed[r * size + c]) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          setFixed(r + dr, c + dc, dark);
        }
      }
    }
  }

  // Reserve format info + dark module
  for (let i = 0; i < 9; i++) {
    if (!fixed[8 * size + i]) setFixed(8, i, false);
    if (!fixed[i * size + 8]) setFixed(i, 8, false);
  }
  for (let i = 0; i < 8; i++) {
    setFixed(8, size - 1 - i, false);
    setFixed(size - 1 - i, 8, false);
  }
  setFixed(size - 8, 8, true);

  // Version info (V7+)
  if (version >= 7) {
    const vBits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = Boolean((vBits >>> i) & 1);
      const r = Math.floor(i / 3), c = size - 11 + (i % 3);
      setFixed(r, c, bit);
      setFixed(c, r, bit);
    }
  }

  // Place data bits in upward/downward 2-column zig-zag
  let bitIdx = 0;
  const totalBits = codewords.length * 8;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const r = upward ? size - 1 - step : step;
      for (let dx = 0; dx < 2; dx++) {
        const c = right - dx;
        if (fixed[r * size + c]) continue;
        let dark = false;
        if (bitIdx < totalBits) {
          dark = Boolean((codewords[bitIdx >>> 3]! >>> (7 - (bitIdx & 7))) & 1);
          bitIdx++;
        }
        base[r * size + c] = dark ? 1 : 0;
      }
    }
    upward = !upward;
  }

  // Evaluate all 8 masks and pick the lowest penalty
  let bestGrid = base;
  let bestScore = Infinity;
  for (let m = 0; m < 8; m++) {
    const candidate = base.slice();
    const fn = MASK_FNS[m]!;
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!fixed[r * size + c] && fn(r, c)) candidate[r * size + c] ^= 1;
      }
    }
    const fmt = formatBits(m);
    const putFmt = (idx: number, r: number, c: number) => {
      candidate[r * size + c] = (fmt >>> idx) & 1;
    };
    // Around top-left (MSB b14 at (8,0) .. LSB b0 at (0,8))
    for (let i = 0; i <= 5; i++) putFmt(14 - i, 8, i);
    putFmt(8, 8, 7);
    putFmt(7, 8, 8);
    putFmt(6, 7, 8);
    for (let i = 0; i <= 5; i++) putFmt(i, i, 8);
    // Split across bottom-left (b14..b8, preserving fixed dark module at (size-8, 8)) & top-right (b7..b0)
    for (let i = 0; i < 7; i++) putFmt(14 - i, size - 1 - i, 8);
    for (let i = 0; i < 8; i++) putFmt(7 - i, 8, size - 8 + i);

    const score = penalty(candidate, size);
    if (score < bestScore) { bestScore = score; bestGrid = candidate; }
  }

  return { size, version, modules: bestGrid };
}

export function renderQrSvg(text: string, options: { quiet?: number; label?: string; sizePx?: number } = {}): string {
  const quiet = options.quiet ?? 4;
  const { size, modules } = encodeQr(text);
  const full = size + quiet * 2;
  const parts: string[] = [];
  for (let r = 0; r < size; r++) {
    let c = 0;
    while (c < size) {
      if (!modules[r * size + c]) { c++; continue; }
      const start = c;
      while (c < size && modules[r * size + c]) c++;
      parts.push(`M${start + quiet},${r + quiet}h${c - start}v1h-${c - start}z`);
    }
  }
  const px = options.sizePx ?? 184;
  const label = (options.label ?? "QR code").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${full} ${full}" width="${px}" height="${px}" role="img" aria-label="${label}" shape-rendering="crispEdges"><rect width="${full}" height="${full}" fill="#ffffff"/><path fill="#111111" d="${parts.join("")}"/></svg>`;
}
