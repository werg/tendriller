import type { Env } from './env';
import { HttpError } from './http';

/** Approximate regional request budgets; no Durable Object storage reads or writes. */
export async function admitPageTraffic(env: Pick<Env, 'PAGE_RATE' | 'ACCOUNT_RATE'>, pageId: string, ownerAccount: string | null): Promise<void> {
  if (!(await env.PAGE_RATE.limit({ key: pageId })).success)
    throw new HttpError(429, 'page_rate_limited', 'This page is receiving too many requests. Try again shortly.');
  if (ownerAccount && !(await env.ACCOUNT_RATE.limit({ key: ownerAccount })).success)
    throw new HttpError(429, 'account_rate_limited', 'This account is receiving too many page requests. Try again shortly.');
}
