/** Only the latest request may commit. Errors never replace the current asset. */
export class LatestImport {
  private generation = 0;
  private disposed = false;

  async run<T>(load: () => Promise<T>, handlers: {
    success: (asset: T) => void;
    failure: (error: unknown) => void;
  }): Promise<void> {
    const request = ++this.generation;
    try {
      const asset = await load();
      if (!this.disposed && request === this.generation) handlers.success(asset);
    } catch (error) {
      if (!this.disposed && request === this.generation) handlers.failure(error);
    }
  }

  cancel() { this.generation++; }
  dispose() { this.disposed = true; this.cancel(); }
}
