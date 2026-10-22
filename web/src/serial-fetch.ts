// Thumbnail fetches share one slot, including retries and response decoding.
// Removing an aborted waiter must not release the currently running request.
export class SerialFetch {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    const previous = this.tail;
    let release!: () => void;
    const finished = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tail = previous.then(() => finished);
    let onAbort = () => {};
    try {
      await Promise.race([
        previous,
        new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(signal.reason);
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort();
        }),
      ]);
      signal.throwIfAborted();
      return await task();
    } finally {
      signal.removeEventListener('abort', onAbort);
      release();
    }
  }
}
