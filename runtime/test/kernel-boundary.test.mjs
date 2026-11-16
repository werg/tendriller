import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
const compiled = await build({ entryPoints: [new URL('../src/kernel.ts', import.meta.url).pathname], bundle: true, format: 'iife', globalName: 'Kernel', platform: 'browser', metafile: true, write: false });
test('the headless kernel imports no presentation, voice, domain rules or Node tools', () => {
  const forbidden = /(?:\/control\/|\/voice\/|\/rules\.|\/tools\/|phonon-tts|qrcode-generator)/;
  for (const input of Object.keys(compiled.metafile.inputs)) assert.equal(forbidden.test(input), false, input);
});
test('importing the kernel works without browser globals and performs no mounting or permissions', () => {
  const context = {};
  runInNewContext(compiled.outputFiles[0].text, context);
  assert.equal(typeof context.Kernel.startRuntime, 'function');
  assert.deepEqual(Object.keys(context).sort(), ['Kernel']);
});
