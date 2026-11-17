import { test, expect } from '@playwright/test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../lib/preview.mjs';

test('authored pages keep their own interaction and relative assets without a protocol emulator', async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), 'authored-browser-preview-'));
  await writeFile(join(root, 'index.html'), '<!doctype html><head><title>Authored preview</title><script type="module" src="page.mjs"></script></head><body><button>Record click</button><output>0</output></body>');
  await writeFile(join(root, 'page.mjs'), 'let value=0;document.querySelector("button").onclick=()=>document.querySelector("output").textContent=String(++value);');
  const server = await startServer(root), requests: string[] = [];
  page.on('request', request => requests.push(request.url()));
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole('button').click(); await expect(page.locator('output')).toHaveText('1');
    expect(requests.some(path => /\/(?:ws|events|state|streams)(?:\?|$)/.test(path))).toBe(false);
    expect(await page.evaluate(() => typeof (globalThis as any).tendril)).toBe('undefined');
  } finally { await server.stopPreview(); await rm(root, { recursive: true, force: true }); }
});
