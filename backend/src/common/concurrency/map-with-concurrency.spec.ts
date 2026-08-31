import { mapWithConcurrency, countRejected } from './map-with-concurrency';

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

describe('mapWithConcurrency', () => {
  it('returns results in input order regardless of completion order', async () => {
    const results = await mapWithConcurrency([30, 10, 20, 0], 4, async ms => {
      await sleep(ms);
      return ms;
    });
    expect(results.map(r => (r.status === 'fulfilled' ? r.value : null))).toEqual([30, 10, 20, 0]);
  });

  it('never runs more than `concurrency` workers at once', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await sleep(5);
      inFlight -= 1;
    });
    expect(peak).toBe(3);
  });

  it('is faster than sequential for many slow items', async () => {
    const items = Array.from({ length: 12 }, (_, i) => i);
    const start = Date.now();
    await mapWithConcurrency(items, 6, () => sleep(20));
    const elapsed = Date.now() - start;
    // Sequential would be ~240ms; 6-wide is ~40ms. Allow generous slack.
    expect(elapsed).toBeLessThan(150);
  });

  it('captures a rejection per item instead of aborting the batch', async () => {
    const results = await mapWithConcurrency([1, 2, 3], 2, async n => {
      if (n === 2) throw new Error('boom');
      return n;
    });
    expect(results[0]).toEqual({ status: 'fulfilled', value: 1 });
    expect(results[1].status).toBe('rejected');
    expect(results[2]).toEqual({ status: 'fulfilled', value: 3 });
    expect(countRejected(results)).toBe(1);
  });

  it('clamps concurrency to at least 1 and handles an empty list', async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
    const results = await mapWithConcurrency([1, 2], 0, async n => n);
    expect(results.map(r => (r.status === 'fulfilled' ? r.value : null))).toEqual([1, 2]);
  });
});
