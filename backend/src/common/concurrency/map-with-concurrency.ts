/**
 * Run an async `worker` over `items` with at most `concurrency` calls in flight
 * at once, and never reject: results come back in input order as
 * `PromiseSettledResult`s, the same shape `Promise.allSettled` returns.
 *
 * Replaces the `for (const x of items) await work(x)` sweeps in the background
 * workers, whose total runtime was the *sum* of every item's latency —
 * pathological when each item does its own network I/O with retries
 * (#236, #237, #238).
 *
 * `concurrency` is clamped to at least 1; a value >= `items.length` runs every
 * item at once.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const limit = Math.max(1, Math.floor(concurrency) || 1);
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;

  const runner = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => runner()),
  );

  return results;
}

/** How many `PromiseSettledResult`s in `results` rejected. */
export function countRejected(results: PromiseSettledResult<unknown>[]): number {
  return results.reduce((n, r) => (r.status === 'rejected' ? n + 1 : n), 0);
}
