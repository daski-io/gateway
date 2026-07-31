export class ApplicationLifecycle {
  private stopping = false;

  beginShutdown(): void {
    this.stopping = true;
  }

  isStopping(): boolean {
    return this.stopping;
  }
}
