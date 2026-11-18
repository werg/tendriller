type AlarmStorage = Pick<DurableObjectStorage, 'getAlarm' | 'setAlarm' | 'deleteAlarm'>;

/** Keep the earliest outstanding wakeup; an earlier alarm can safely recheck later work. */
export class DeadlineAlarm {
  private scheduled: number | null | undefined;
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly storage: AlarmStorage) {}

  private serial(work: () => void | Promise<void>): Promise<void> {
    const next = this.pending.then(work);
    // A failed storage operation must remain retryable by the next caller.
    this.pending = next.catch(() => {});
    return next;
  }

  ensure(at: number): Promise<void> {
    return this.serial(async () => {
      if (this.scheduled === undefined) this.scheduled = await this.storage.getAlarm();
      if (this.scheduled !== null && this.scheduled <= at) return;
      await this.storage.setAlarm(at);
      this.scheduled = at;
    });
  }

  /** The runtime consumes the alarm before entering its handler. */
  fired(): Promise<void> {
    return this.serial(() => { this.scheduled = null; });
  }

  clear(): Promise<void> {
    return this.serial(async () => {
      await this.storage.deleteAlarm();
      this.scheduled = null;
    });
  }
}
