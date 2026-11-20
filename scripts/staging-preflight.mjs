import { resolve } from 'node:path';
import { preflightReviewSource, reviewSource } from './review/preflight.mjs';

export const STAGING_ORIGIN = 'https://staging.tendriller.dev';
/** Read-only source/readiness admission before any staging fixture or account is provisioned. */
export function preflightStaging({ root = resolve(import.meta.dirname, '..'), source, fetch } = {}) {
  return preflightReviewSource(STAGING_ORIGIN, source ?? reviewSource(root), { fetch });
}
