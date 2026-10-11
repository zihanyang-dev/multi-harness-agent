import type { Event } from '@ag-ui/core';

/** A bounded, single-consumer observation lane. It never backpressures native execution. */
export function createActivityChannel() {
  const pending: { event: Event; bytes: number }[] = [];
  let bytes = 0;
  let closed = false;
  let abandoned = false;
  const abandonment = Promise.withResolvers<void>();
  let failure: Error | undefined;
  let wake: (() => void) | undefined;
  const stop = () => {
    closed = true;
    pending.length = 0;
    bytes = 0;
    wake?.();
  };
  const events: AsyncIterableIterator<Event> = {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      while (!closed && pending.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
      if (failure !== undefined) throw failure;
      const item = pending.shift();
      if (item === undefined) return { done: true, value: undefined };
      bytes -= item.bytes;
      return { done: false, value: item.event };
    },
    async return() {
      abandoned = true;
      abandonment.resolve();
      stop();
      return { done: true, value: undefined };
    },
  };
  return {
    events,
    abandonedPromise: abandonment.promise,
    get abandoned() {
      return abandoned;
    },
    push(event: Event): void {
      if (closed) return;
      try {
        const size = Buffer.byteLength(JSON.stringify(event));
        if (pending.length >= 256 || bytes + size > 256 * 1024) {
          failure = new Error('Public activity observation overflow');
          stop();
          return;
        }
        pending.push({ event, bytes: size });
        bytes += size;
        wake?.();
      } catch {
        failure = new Error('Public activity observation failed');
        stop();
      }
    },
    close(): void {
      closed = true;
      wake?.();
    },
  };
}
export type ActivityChannel = ReturnType<typeof createActivityChannel>;
