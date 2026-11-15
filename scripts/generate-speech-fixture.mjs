// Regenerate only when intentionally changing the committed synthetic fixture.
// Requires FFmpeg built with libflite; ordinary tests use the committed WAV.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const dir = fileURLToPath(new URL("../test/fixtures/speech/", import.meta.url));
const text = "Please check the sensor and record the temperature.";
mkdirSync(dir, { recursive: true });
const file = "sensor-check.wav";
const args = ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `flite=text='${text}':voice=slt`, "-af", "adelay=250,apad=pad_dur=0.25", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", "-map_metadata", "-1", "-fflags", "+bitexact", "-y", join(dir, file)];
execFileSync("ffmpeg", args, { stdio: "inherit" });
const manifest = { file, transcript: text, sample_rate: 16000, channels: 1, encoding: "pcm_s16le",
  sha256: createHash("sha256").update(readFileSync(join(dir, file))).digest("hex"),
  provenance: "Synthetic test audio generated for Tendriller with the CMU Flite slt voice. No third-party recording or microphone input is included.",
  generator: execFileSync("ffmpeg", ["-version"], { encoding: "utf8" }).split("\n")[0],
  command: ["ffmpeg", ...args.slice(0, -1), file], max_word_error_rate: 0.3 };
writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`Generated ${file}; review the transcript and manifest before committing.`);
