import { commit } from './tuple.mjs';

// Only typed absence/pending conditions minted by our verifier are waitable.
// Authentication, hash/identity mismatch, corrupt metadata and failed CI retain
// their ordinary hard failure. Explicit source/apply requests always fail.
export function waitingReceipt(error, { receiver = false, previouslyPublishedSource } = {}) {
  if (!receiver || error?.code !== 'release_prerequisite_not_ready') return null;
  if (error.stage === 'published' && error.source === previouslyPublishedSource) return null;
  const published = ['source-release-not-published', 'source-manifest-not-published'];
  const qualified = ['ci.yml', 'peer-generation.yml', 'collaboration.yml'].map(name => `contrib-${name}-pending`);
  if (!(error.stage === 'published' && published.includes(error.reason) ||
      error.stage === 'qualified' && qualified.includes(error.reason))) return null;
  return { state: 'waiting-prerequisite', qualified: false, source: commit(error.source),
    stage: error.stage, reason: error.reason, observedAt: new Date().toISOString(),
    noProposalOrDispatch: true, nextAction: 'Wait for exact-source publication or required MAIN CI, then rerun the receiver. Do not substitute another graph.' };
}
