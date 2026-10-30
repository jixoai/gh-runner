export class AppLifecycle {
  #stopping = false;
  #shutdown: Promise<void> | null = null;
  #exited = false;

  constructor(
    private readonly cleanup: Array<() => void | Promise<void>>,
    private readonly exit: (code: number) => void,
    private readonly reportError: (error: unknown) => void,
    private readonly timeoutMs = 5_000,
  ) {}

  get stopping(): boolean {
    return this.#stopping;
  }

  shutdown(): Promise<void> {
    if (this.#shutdown) return this.#shutdown;
    this.#stopping = true;
    this.#shutdown = Promise.resolve().then(async () => {
      const deadline = setTimeout(() => this.#finish(), this.timeoutMs);
      deadline.unref?.();
      try {
        for (const cleanup of this.cleanup) {
          if (this.#exited) break;
          try {
            await cleanup();
          } catch (error) {
            this.reportError(error);
          }
        }
      } finally {
        clearTimeout(deadline);
        this.#finish();
      }
    });
    return this.#shutdown;
  }

  #finish(): void {
    if (this.#exited) return;
    this.#exited = true;
    this.exit(0);
  }
}
