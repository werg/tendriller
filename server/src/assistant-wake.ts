/** The page owns one retained observation slot and shares its existing alarm. */
export interface AssistantWork {
  readonly cursorRevision: number;
  readonly observe: boolean;
  readonly due: number | null;
  readonly failures: number;
}

export class AssistantWake {
  private activeRevision: number | null = null;

  constructor(private readonly persistence: {
    read(): AssistantWork | null;
    write(value: AssistantWork | null): void;
  }, private readonly clock: () => number) {}

  deferred(): boolean { return this.persistence.read()?.due === null; }

  deadline(): number | null { return this.persistence.read()?.due ?? null; }

  notify(): number {
    const now = this.clock(), work = this.persistence.read();
    // A pending observation already covers incoming notices. During a drain,
    // record one successor so acknowledgement cannot erase a concurrent wake.
    if (work?.observe && work.due !== null && (this.activeRevision === null || work.cursorRevision !== this.activeRevision)) return work.due;
    const revision = this.activeRevision === null ? 0 : this.activeRevision + 1;
    const due = work?.observe && work.due !== null ? work.due : Math.min(now + 50, work?.due ?? Infinity);
    this.persistence.write({ cursorRevision: revision, due, observe: true, failures: work?.due === null ? 0 : work?.failures ?? 0 });
    return due;
  }

  async run(drain: (observe: boolean) => Promise<{ more: boolean; nextDue: number | null }>): Promise<void> {
    const work = this.persistence.read();
    if (!work || work.due === null || work.due > this.clock() || this.activeRevision !== null) return;
    this.activeRevision = work.cursorRevision;
    let result: { more: boolean; nextDue: number | null };
    try {
      result = await drain(work.observe);
    } catch (error) {
      const current = this.persistence.read();
      if (current) {
        const failures = current.failures + 1;
        this.persistence.write({ ...current, failures, due: failures >= 8 ? null : this.clock() + Math.min(300_000, 1000 * 2 ** failures) });
      }
      throw error;
    } finally { this.activeRevision = null; }
    const current = this.persistence.read();
    if (!current) return; // Page deletion or explicit disable won the race.
    const observe = result.more || current.cursorRevision !== work.cursorRevision;
    if (!observe && result.nextDue === null) {
      this.persistence.write(null);
      return;
    }
    const due = observe ? Math.min(this.clock() + 100, result.nextDue ?? Infinity) : result.nextDue!;
    this.persistence.write({ cursorRevision: 0, observe, due, failures: 0 });
  }
}
