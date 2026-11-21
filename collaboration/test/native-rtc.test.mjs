import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
test('native wrapper uses canonical direct policy, cancels and exits without RTC handles', async () => {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./native-rtc-fixture.mjs', import.meta.url))], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 20_000);
    child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, timedOut, stdout, stderr }); });
  });
  assert.equal(result.timedOut, false, 'Native RTC cleanup retained live sockets/timers');
  assert.equal(result.code, 0, result.stderr); assert.equal(result.signal, null);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { passed: true, direct: 2, bidirectional: true, cancelled: true, relayCalls: 0 });
});
