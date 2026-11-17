import { describe, expect, it, vi } from 'vitest';
import { admitPageTraffic } from '../src/traffic-budget';

function rate(success: boolean) {
  return { limit: vi.fn(async () => ({ success })) } as unknown as RateLimit;
}

describe('page and account traffic budgets', () => {
  it('counts an unclaimed page against its page budget only', async () => {
    const PAGE_RATE = rate(true), ACCOUNT_RATE = rate(true);
    await admitPageTraffic({ PAGE_RATE, ACCOUNT_RATE }, 'page-a', null);
    expect(PAGE_RATE.limit).toHaveBeenCalledWith({ key: 'page-a' });
    expect(ACCOUNT_RATE.limit).not.toHaveBeenCalled();
  });

  it('counts owned pages against a shared owner budget', async () => {
    const PAGE_RATE = rate(true), ACCOUNT_RATE = rate(true);
    await admitPageTraffic({ PAGE_RATE, ACCOUNT_RATE }, 'page-a', 'owner-1');
    await admitPageTraffic({ PAGE_RATE, ACCOUNT_RATE }, 'page-b', 'owner-1');
    expect(PAGE_RATE.limit).toHaveBeenCalledWith({ key: 'page-b' });
    expect(ACCOUNT_RATE.limit).toHaveBeenCalledTimes(2);
    expect(ACCOUNT_RATE.limit).toHaveBeenLastCalledWith({ key: 'owner-1' });
  });

  it('stops at the page budget before charging the account budget', async () => {
    const PAGE_RATE = rate(false), ACCOUNT_RATE = rate(true);
    await expect(admitPageTraffic({ PAGE_RATE, ACCOUNT_RATE }, 'page-a', 'owner-1')).rejects.toMatchObject({ status: 429, code: 'page_rate_limited' });
    expect(ACCOUNT_RATE.limit).not.toHaveBeenCalled();
  });

  it('rejects exhausted account budgets', async () => {
    await expect(admitPageTraffic({ PAGE_RATE: rate(true), ACCOUNT_RATE: rate(false) }, 'page-a', 'owner-1'))
      .rejects.toMatchObject({ status: 429, code: 'account_rate_limited' });
  });
});
