import { HttpError } from './http';
import type { Tendril } from './tendril';

type Lifetime = 'ad_hoc' | 'resident';
const PENDING = 'lifetime_pending';
const recovery = new WeakMap<Tendril, Promise<void>>();

/** A pending downgrade reserves the local commit boundary before account I/O. */
export function hasResidentStorage(t: Pick<Tendril, 'db'>): boolean {
  return !!t.db.get('owner_account', null) && t.db.get<Lifetime>('lifetime', 'ad_hoc') === 'resident'
    && t.db.get<Lifetime | null>(PENDING, null) !== 'ad_hoc';
}

export function lifetimeChangePending(t: Pick<Tendril, 'db'>): boolean {
  return t.db.get<Lifetime | null>(PENDING, null) !== null;
}

function validate(t: Tendril, target: Lifetime): void {
  if (target === 'ad_hoc') {
    if (t.db.get('peer_generation_configuration', null))
      throw new HttpError(409, 'peer_controls_require_resident', 'Signed peer control state must remain retained until explicitly deleted');
  } else if (!t.db.get('owner_account', null)) {
    throw new HttpError(403, 'account_required', 'Open the page as its owner before making it resident');
  }
}

/** Complete the same idempotent account update after a lost reply or process restart. */
export function recoverLifetimeChange(t: Tendril): Promise<void> {
  const running = recovery.get(t);
  if (running) return running;
  const target = t.db.get<Lifetime | null>(PENDING, null);
  if (target === null) return Promise.resolve();
  const work = (async () => {
    // Publish the single-flight promise before any fallible account operation.
    await Promise.resolve();
    try {
      await t.env.ACCOUNTS.prepare('UPDATE tendrils SET lifetime = ? WHERE id = ?').bind(target, t.tid).run();
      t.transaction(() => {
        // Resident pages do not write per-request inactivity timestamps. Start
        // a full idle window when a downgrade finally commits, also on recovery.
        if (target === 'ad_hoc' && t.db.get<Lifetime>('lifetime', 'ad_hoc') === 'resident'
          && t.db.get<string | null>('owner_account', null))
          t.db.set('last_access', t.now());
        t.db.set('lifetime', target); t.db.del(PENDING);
      });
    } catch (error) {
      if (String(error).includes('account_residents_full')) {
        // This database constraint is a definite rollback, so release its intent.
        t.db.del(PENDING);
        throw new HttpError(429, 'quota', 'Account resident tendril limit reached', { limit: 3 });
      }
      // An unavailable/lost response cannot prove that the account write failed.
      // Keep the reservation until the same target has been reconciled.
      throw new HttpError(503, 'lifetime_pending', 'The durable lifetime change is waiting for account storage; retry the same lifetime');
    } finally {
      recovery.delete(t); t.scheduleAlarm();
    }
  })();
  recovery.set(t, work);
  return work;
}

export async function changeLifetime(t: Tendril, target: Lifetime): Promise<void> {
  const pending = t.db.get<Lifetime | null>(PENDING, null);
  if (pending !== null && pending !== target) await recoverLifetimeChange(t);
  t.transaction(() => {
    const current = t.db.get<Lifetime | null>(PENDING, null);
    if (current !== null && current !== target) throw new HttpError(409, 'lifetime_pending', 'Finish the pending lifetime change first');
    validate(t, target);
    t.db.set(PENDING, target);
    t.scheduleAlarm();
  });
  await recoverLifetimeChange(t);
}
