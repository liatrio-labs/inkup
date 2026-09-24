// Push-to-pull bridge: callback-style engines push segments, consumers `for await` them.

export interface AsyncQueue<T> extends AsyncIterable<T> {
  push(item: T): void;
  /** No more items; iteration ends once the buffer drains. An error makes the iterator throw. */
  end(error?: unknown): void;
  readonly ended: boolean;
}

export function createAsyncQueue<T>(): AsyncQueue<T> {
  const buffer: T[] = [];
  let waiting: ((r: IteratorResult<T>) => void) | null = null;
  let rejectWaiting: ((e: unknown) => void) | null = null;
  let done = false;
  let failure: { error: unknown } | null = null;

  return {
    get ended() {
      return done;
    },
    push(item) {
      if (done) return;
      if (waiting) {
        const w = waiting;
        waiting = rejectWaiting = null;
        w({ value: item, done: false });
      } else buffer.push(item);
    },
    end(error) {
      if (done) return;
      done = true;
      if (error !== undefined) failure = { error };
      if (waiting) {
        const w = waiting;
        const r = rejectWaiting;
        waiting = rejectWaiting = null;
        if (failure) r!(failure.error);
        else w({ value: undefined, done: true });
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          if (buffer.length > 0) return Promise.resolve({ value: buffer.shift()!, done: false });
          if (done) return failure ? Promise.reject(failure.error) : Promise.resolve({ value: undefined, done: true });
          return new Promise<IteratorResult<T>>((resolve, reject) => {
            waiting = resolve;
            rejectWaiting = reject;
          });
        },
      };
    },
  };
}
