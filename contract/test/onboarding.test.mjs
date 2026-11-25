import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onboardingDescriptor } from '../onboarding.mjs';
import { CORE_RELEASE } from '../index.mjs';

test('onboarding identifies its canonical service and keeps every setup route on that origin', () => {
  for (const base of ['https://staging.example/', 'https://self-hosted.example:8443', 'http://localhost:8787/']) {
    const origin = new URL(base).origin;
    const descriptor = onboardingDescriptor(base);
    assert.equal(descriptor.serviceOrigin, origin);
    const targets = [descriptor.service, descriptor.start_here, descriptor.agent_instructions, descriptor.starter,
      descriptor.capabilities, ...Object.values(descriptor.documentation), descriptor.interfaces.service_descriptor,
      descriptor.interfaces.readiness, descriptor.interfaces.contract, descriptor.interfaces.create_page.url];
    for (const target of targets) assert.equal(new URL(target).origin, origin, target);
    assert.equal(descriptor.workflow[0].id, 'create');
    assert(descriptor.workflow.findIndex(step => step.id === 'publish') < descriptor.workflow.findIndex(step => step.id === 'claim'));
    assert.equal(descriptor.interfaces.readiness, origin + '/api/readiness');
    assert.deepEqual(descriptor.firstApp.release, {
      manifest: `https://github.com/werg/tendriller/releases/download/source-unbuilt/manifest.json`,
      archive: `https://github.com/werg/tendriller/releases/download/source-unbuilt/tendriller-first-app-${CORE_RELEASE}.tgz`,
      sqlArchive: `https://github.com/werg/tendriller/releases/download/source-unbuilt/tendriller-first-app-sql-${CORE_RELEASE}.tgz`,
    });
  }
});
