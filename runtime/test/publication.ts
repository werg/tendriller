import type { Page } from '@playwright/test';

/** Public acknowledgement; no private config or cache inspection. */
export async function savedForOffline(page: Page) {
  return page.evaluate(async () => (await window.tendril.publication.saveOffline()).id);
}
