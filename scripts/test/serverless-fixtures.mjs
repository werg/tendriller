// Shared fake-session observations for the serverless adapter tests. The fakes
// follow the current Chronolog session: command() resolves with an
// ApplicationOperation-like handle once the intent is durable, and facts are
// observed independently through inspect()/materialized()/retained()/finalized().
export const inspection = (applicationId, operationId, extra = {}) => ({
  applicationId, author: 'ab'.repeat(32), authorTimestampMs: '1700000000000', proposalId: 'c'.repeat(64), operationId,
  stored: true, pending: null, materialized: null, retained: [], finalized: false, excluded: false, ...extra,
});
export const accepted = {outcome: 'accepted', rejectionCode: null, failingStatementIndex: null,
  revision: {digest: 'd'.repeat(64), view: 'local', executionManifestDigest: 'e'.repeat(64), policyDigest: 'f'.repeat(64)}};
export const handleFor = (applicationId, operationId, over = {}) => {
  let done = false;
  return {
    inspect: () => inspection(applicationId, operationId, done ? {materialized: accepted} : {}),
    materialized: async () => { done = true; return accepted; }, retained: async () => [], finalized: async () => accepted, ...over,
  };
};
