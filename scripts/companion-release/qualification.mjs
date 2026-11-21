import assert from 'node:assert/strict';
import { commit } from './tuple.mjs';

export function qualificationSpec(mode, workflow, refs) {
  assert(['contrib', 'chronolog'].includes(mode));
  const allowed = mode === 'contrib' ? ['ci.yml', 'peer-generation.yml', 'collaboration.yml'] : ['ci.yml', 'browser-peer.yml', 'webrtc.yml'];
  assert(allowed.includes(workflow));
  if (workflow === 'ci.yml' || workflow === 'browser-peer.yml') return { inputs: {} };
  const core = commit(refs.core);
  if (mode === 'contrib') {
    const kernel = commit(refs.kernel);
    return { inputs: { tendriller_ref: core, chronolog_ref: kernel }, title: `Companion core=${core} kernel=${kernel}` };
  }
  const contrib = commit(refs.contrib);
  return { inputs: { host_ref: core, contrib_ref: contrib }, title: `Companion core=${core} contrib=${contrib}` };
}

export function bindRunName(text, mode) {
  assert(['contrib', 'chronolog'].includes(mode));
  const line = mode === 'contrib'
    ? 'run-name: "Companion core=${{ inputs.tendriller_ref || \'tuple\' }} kernel=${{ inputs.chronolog_ref || \'tuple\' }}"'
    : 'run-name: "Companion core=${{ inputs.host_ref || \'tuple\' }} contrib=${{ inputs.contrib_ref || \'tuple\' }}"';
  const existing = text.match(/^run-name:.*$/m);
  if (existing) { assert.equal(existing[0], line, 'Unknown run-name cannot prove dispatch inputs'); return text; }
  assert(/^name: [^\n]+\n/.test(text), 'Expected a named workflow');
  return text.replace(/^(name: [^\n]+\n)/, `$1${line}\n`);
}
