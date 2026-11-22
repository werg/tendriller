// Intentionally regenerate committed wake fixtures with FFmpeg + CMU Flite.
// Normal tests read the pinned files and never synthesize or record microphone audio.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const directory = fileURLToPath(new URL('../test/fixtures/speech/', import.meta.url));
mkdirSync(directory, { recursive: true });
const cases = [
  { file: 'wake-command.wav', transcript: 'Listen computer, check the sensor and record the temperature.', matched: true, command: 'check the sensor and record the temperature' },
  { file: 'wake-only.wav', transcript: 'Listen computer.', matched: true, command: '' },
  { file: 'wake-negative.wav', transcript: 'I listened to the computer today.', matched: false, command: '' },
];
for (const entry of cases) {
  const args = ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `flite=text='${entry.transcript}':voice=slt`, '-af', 'adelay=250,apad=pad_dur=0.75', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-map_metadata', '-1', '-fflags', '+bitexact', '-y', join(directory, entry.file)];
  execFileSync('ffmpeg', args, { stdio: 'inherit' });
  entry.sha256 = createHash('sha256').update(readFileSync(join(directory, entry.file))).digest('hex');
  entry.generator_command = ['ffmpeg', ...args.slice(0, -1), entry.file];
}
const manifest = {
  phrase: 'Listen computer', language: 'en', sample_rate: 16000, channels: 1, encoding: 'pcm_s16le',
  provenance: 'Synthetic sentences generated for Tendriller with the CMU Flite slt voice. No person was recorded and no third-party benchmark audio is included.',
  generator: execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0],
  limitation: 'An integration smoke corpus for exact wake matching and phrase-only/combined-command paths. It does not establish accuracy across people, accents, noise, devices or languages.',
  cases,
};
writeFileSync(join(directory, 'wake-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('Generated three wake fixtures. Review exact bytes, decisions and provenance before committing.');
