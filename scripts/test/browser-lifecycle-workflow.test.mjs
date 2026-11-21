import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
test('the required unprivileged release browser gate runs actual headed owner lifecycle coverage',()=>{
 const workflow=readFileSync(new URL('../../.github/workflows/service.yml',import.meta.url),'utf8');
 assert.match(workflow,/name: Qualify shared and elected application owners in Chromium\s+env:\s+TENDRILLER_BROWSER_LIFECYCLE: '1'\s+run: xvfb-run -a npm run test:collaboration:browser/);
 assert(workflow.includes('.results/collaboration-browser.json'));
 const browser=readFileSync(new URL('../test-collaboration-browser.mjs',import.meta.url),'utf8');
 assert(browser.includes("import {launchNetworkBrowser} from '../test/e2e/network-qualification/browser-launch.mjs'"));
 assert(browser.includes('automaticChromiumFreezeResume:qualifyLifecycle'));
});
