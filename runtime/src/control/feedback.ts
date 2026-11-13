// Gentle synthesised tones and haptics for presence transitions. No audio files.

let ctx: AudioContext | null = null;
let unlockInstalled = false;

function getCtx(): AudioContext | null {
  if (ctx) return ctx;
  const AC: typeof AudioContext | undefined = (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!AC) return null;
  try { ctx = new AC(); } catch { ctx = null; }
  return ctx;
}

/** Browsers only allow audio after a user gesture; resume the context on the first one. */
export function installAudioUnlock(): void {
  if (unlockInstalled) return;
  unlockInstalled = true;
  const unlock = () => {
    const c = getCtx();
    if (c && c.state === "suspended") c.resume().catch(() => {});
    if (c && c.state === "running") {
      document.removeEventListener("pointerdown", unlock, true);
      document.removeEventListener("keydown", unlock, true);
    }
  };
  document.addEventListener("pointerdown", unlock, true);
  document.addEventListener("keydown", unlock, true);
}

export type Cue = "working" | "done" | "attention";

const CUES: Record<Cue, { f: number; at: number; d: number }[]> = {
  // Two soft rising notes: "I'm on it".
  working: [{ f: 523.25, at: 0, d: 0.14 }, { f: 659.25, at: 0.11, d: 0.18 }],
  // A small three-note chime: "finished".
  done: [{ f: 659.25, at: 0, d: 0.16 }, { f: 783.99, at: 0.12, d: 0.16 }, { f: 1046.5, at: 0.24, d: 0.32 }],
  // Two even notes for things that need the owner (pair request).
  attention: [{ f: 587.33, at: 0, d: 0.16 }, { f: 587.33, at: 0.22, d: 0.16 }],
};

export function playCue(cue: Cue): void {
  const c = getCtx();
  if (!c || c.state !== "running") return;
  const t0 = c.currentTime + 0.02;
  const master = c.createGain();
  master.gain.value = 0.06;
  master.connect(c.destination);
  for (const n of CUES[cue]) {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = "sine";
    o.frequency.value = n.f;
    g.gain.setValueAtTime(0, t0 + n.at);
    g.gain.linearRampToValueAtTime(1, t0 + n.at + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + n.d);
    o.connect(g).connect(master);
    o.start(t0 + n.at);
    o.stop(t0 + n.at + n.d + 0.05);
  }
}

const PATTERNS: Record<Cue, number | number[]> = { working: 25, done: [20, 70, 20], attention: [40, 80, 40] };

export function haptic(cue: Cue): void {
  try { (navigator as any).vibrate?.(PATTERNS[cue]); } catch { /* ignore: absent on iOS */ }
}
