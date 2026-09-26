/**
 * Shared in-memory fake `ioredis` client for the dual-mode ("with Redis" / fallback-to-memory")
 * unit test suites the Redis-backed stores in this codebase use (see PERSISTENT_STORAGE_SPIKE.md
 * and gig.service.spec.ts, the original of this pattern). Mirrors just enough of ioredis's
 * behavior to exercise a service's Redis path without a real server: MULTI/EXEC resolves an
 * array of `[error, result]` tuples per queued command, exactly like the real client.
 */
export interface FakeRedisClient {
  mockNextExecResult(fn: () => Promise<Array<[Error | null, unknown]> | null>): void;
  get: jest.Mock<Promise<string | null>, [string]>;
  mget: jest.Mock<Promise<Array<string | null>>, string[]>;
  set: jest.Mock<Promise<'OK' | null>, [string, string, ...unknown[]]>;
  del: jest.Mock<Promise<number>, string[]>;
  sadd: jest.Mock<Promise<number>, [string, ...string[]]>;
  srem: jest.Mock<Promise<number>, [string, ...string[]]>;
  smembers: jest.Mock<Promise<string[]>, [string]>;
  zadd: jest.Mock<Promise<number>, [string, number, string]>;
  zrem: jest.Mock<Promise<number>, [string, string]>;
  zrange: jest.Mock<Promise<string[]>, [string]>;
  zrangebyscore: jest.Mock<Promise<string[]>, [string, number, number]>;
  multi: jest.Mock;
}

/** Fluent chain returned by `multi()`. Each call queues an op; `exec()` applies them atomically. */
interface FakeMultiChain {
  set(key: string, value: string): FakeMultiChain;
  del(...keys: string[]): FakeMultiChain;
  sadd(key: string, ...members: string[]): FakeMultiChain;
  srem(key: string, ...members: string[]): FakeMultiChain;
  zadd(key: string, score: number, member: string): FakeMultiChain;
  zrem(key: string, member: string): FakeMultiChain;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
}

export function makeFakeRedisClient(): FakeRedisClient {
  const store = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const zsets = new Map<string, Map<string, number>>();
  /** When set, the next MULTI's exec() returns this instead of the computed op results. */
  let nextExecOverride: (() => Promise<Array<[Error | null, unknown]> | null>) | null = null;

  const client: FakeRedisClient = {
    mockNextExecResult(fn) {
      nextExecOverride = fn;
    },
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    mget: jest.fn(async (...keys: string[]) => keys.map(k => store.get(k) ?? null)),
    set: jest.fn(async (key: string, value: string, ...opts: unknown[]) => {
      const isNx = opts.some(opt => typeof opt === 'string' && opt.toUpperCase() === 'NX');
      if (isNx && store.has(key)) return null;
      store.set(key, value);
      return 'OK' as const;
    }),
    del: jest.fn(async (...keys: string[]) => {
      let count = 0;
      for (const key of keys) {
        if (store.delete(key)) count += 1;
        sets.delete(key);
        zsets.delete(key);
      }
      return count;
    }),
    sadd: jest.fn(async (key: string, ...members: string[]) => {
      if (!sets.has(key)) sets.set(key, new Set());
      const set = sets.get(key)!;
      let added = 0;
      for (const member of members) {
        if (!set.has(member)) added += 1;
        set.add(member);
      }
      return added;
    }),
    srem: jest.fn(async (key: string, ...members: string[]) => {
      let removed = 0;
      for (const member of members) {
        if (sets.get(key)?.delete(member)) removed += 1;
      }
      return removed;
    }),
    smembers: jest.fn(async (key: string) => [...(sets.get(key) ?? [])]),
    zadd: jest.fn(async (key: string, score: number, member: string) => {
      if (!zsets.has(key)) zsets.set(key, new Map());
      zsets.get(key)!.set(member, score);
      return 1;
    }),
    zrem: jest.fn(async (key: string, member: string) => {
      const removed = zsets.get(key)?.delete(member);
      return removed ? 1 : 0;
    }),
    zrange: jest.fn(async (key: string) => {
      const z = zsets.get(key) ?? new Map();
      return [...z.entries()].sort((a, b) => a[1] - b[1]).map(([member]) => member);
    }),
    zrangebyscore: jest.fn(async (key: string, min: number, max: number) => {
      const z = zsets.get(key) ?? new Map();
      return [...z.entries()]
        .filter(([, score]) => score >= min && score <= max)
        .sort((a, b) => a[1] - b[1])
        .map(([member]) => member);
    }),
    multi: jest.fn(() => {
      const ops: Array<() => [Error | null, unknown]> = [];
      const chain: FakeMultiChain = {
        set(key, value) {
          ops.push(() => {
            store.set(key, value);
            return [null, 'OK'];
          });
          return chain;
        },
        del(...keys) {
          ops.push(() => {
            let count = 0;
            for (const key of keys) {
              if (store.delete(key)) count += 1;
              sets.delete(key);
              zsets.delete(key);
            }
            return [null, count];
          });
          return chain;
        },
        sadd(key, ...members) {
          ops.push(() => {
            if (!sets.has(key)) sets.set(key, new Set());
            const set = sets.get(key)!;
            let added = 0;
            for (const member of members) {
              if (!set.has(member)) added += 1;
              set.add(member);
            }
            return [null, added];
          });
          return chain;
        },
        srem(key, ...members) {
          ops.push(() => {
            let removed = 0;
            for (const member of members) {
              if (sets.get(key)?.delete(member)) removed += 1;
            }
            return [null, removed];
          });
          return chain;
        },
        zadd(key, score, member) {
          ops.push(() => {
            if (!zsets.has(key)) zsets.set(key, new Map());
            zsets.get(key)!.set(member, score);
            return [null, 1];
          });
          return chain;
        },
        zrem(key, member) {
          ops.push(() => {
            zsets.get(key)?.delete(member);
            return [null, 1];
          });
          return chain;
        },
        exec: async () => {
          if (nextExecOverride) {
            const fn = nextExecOverride;
            nextExecOverride = null;
            return fn();
          }
          return ops.map(op => op());
        },
      };
      return chain;
    }),
  };

  return client;
}
