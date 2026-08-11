export class ApplicationLifecycle {
  private readonly controller = new AbortController();
  private stopping = false;

  beginShutdown(): void {
    if (this.stopping) return;
    this.stopping = true;
    this.controller.abort(new Error("Application is shutting down"));
  }

  isStopping(): boolean {
    return this.stopping;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }
}
