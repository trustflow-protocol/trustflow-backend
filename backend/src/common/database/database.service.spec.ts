import { DatabaseService } from './database.service';

describe('DatabaseService', () => {
  describe('when unconfigured (pool is null)', () => {
    let service: DatabaseService;

    beforeEach(() => {
      service = new DatabaseService(null);
    });

    it('reports isConfigured as false', () => {
      expect(service.isConfigured).toBe(false);
    });

    it('getPool throws a descriptive error', () => {
      expect(() => service.getPool()).toThrow(/PostgreSQL is not configured/);
    });

    it('query rejects with the "not configured" error', async () => {
      await expect(service.query('SELECT 1')).rejects.toThrow(/PostgreSQL is not configured/);
    });

    it('ping resolves false without throwing', async () => {
      await expect(service.ping()).resolves.toBe(false);
    });

    it('onModuleDestroy is a no-op', async () => {
      await expect(service.onModuleDestroy()).resolves.toBeUndefined();
    });
  });

  describe('when configured', () => {
    function makePool(overrides: Partial<{ query: jest.Mock; end: jest.Mock }> = {}) {
      return {
        query: overrides.query ?? jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        end: overrides.end ?? jest.fn().mockResolvedValue(undefined),
      } as any;
    }

    it('reports isConfigured as true', () => {
      const service = new DatabaseService(makePool());
      expect(service.isConfigured).toBe(true);
    });

    it('getPool returns the underlying pool', () => {
      const pool = makePool();
      const service = new DatabaseService(pool);
      expect(service.getPool()).toBe(pool);
    });

    it('query delegates to the pool with text and params', async () => {
      const pool = makePool();
      const service = new DatabaseService(pool);

      await service.query('SELECT * FROM gigs WHERE id = $1', ['gig-1']);

      expect(pool.query).toHaveBeenCalledWith('SELECT * FROM gigs WHERE id = $1', ['gig-1']);
    });

    it('ping resolves true when the pool responds', async () => {
      const service = new DatabaseService(makePool());
      await expect(service.ping()).resolves.toBe(true);
    });

    it('ping resolves false (not throw) when the pool query fails', async () => {
      const pool = makePool({
        query: jest.fn().mockRejectedValue(new Error('connection refused')),
      });
      const service = new DatabaseService(pool);

      await expect(service.ping()).resolves.toBe(false);
    });

    it('onModuleDestroy ends the pool', async () => {
      const pool = makePool();
      const service = new DatabaseService(pool);

      await service.onModuleDestroy();

      expect(pool.end).toHaveBeenCalled();
    });
  });
});
