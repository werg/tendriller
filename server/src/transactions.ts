/** Database savepoints and external effects share one commit boundary. */
export type CommitEffect = () => void | Promise<void>;

interface Storage {
  transactionSync<T>(write: () => T): T;
}

export class Transactions {
  private frames: CommitEffect[][] = [];

  constructor(
    private storage: Storage,
    private invalidate: () => void,
    private waitUntil: (work: Promise<unknown>) => void,
    private failed: (error: unknown) => void = error => console.error("Post-commit effect failed", error),
  ) {}

  run<T>(write: () => T): T {
    if (write.constructor.name === "AsyncFunction")
      throw new TypeError("Transactions must be synchronous; async callbacks cannot be rolled back safely");
    const effects: CommitEffect[] = [];
    this.frames.push(effects);
    let result: T;
    try {
      result = this.storage.transactionSync(() => {
        const value = write();
        if (value && typeof (value as any).then === "function") {
          void Promise.resolve(value).catch(() => {});
          throw new TypeError("Transactions must be synchronous; perform I/O before the transaction or after commit");
        }
        return value;
      });
    } catch (error) {
      this.frames.pop();
      // SQLite rolls back writes, but not the application's in-memory cache.
      this.invalidate();
      throw error;
    }
    this.frames.pop();
    const parent = this.frames.at(-1);
    if (parent) parent.push(...effects);
    else for (const effect of effects) this.dispatch(effect);
    return result;
  }

  afterCommit(effect: CommitEffect): void {
    const frame = this.frames.at(-1);
    if (frame) frame.push(effect);
    else this.dispatch(effect);
  }

  private dispatch(effect: CommitEffect): void {
    // Once committed, a notification failure must not turn a successful write
    // into an apparent rollback. Durable delivery intents remain retryable.
    try {
      const work = effect();
      if (work && typeof work.then === "function") this.waitUntil(work.catch(this.failed));
    } catch (error) { this.failed(error); }
  }
}
