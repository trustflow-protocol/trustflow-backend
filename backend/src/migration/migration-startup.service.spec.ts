import { MigrationStartupService } from './migration-startup.service';
import { MigrationRegistryService } from './migration-registry.service';
import { MigrationRunnerService } from './migration-runner.service';

describe('MigrationStartupService', () => {
  const originalEnv = process.env.RUN_MIGRATIONS_ON_STARTUP;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.RUN_MIGRATIONS_ON_STARTUP = originalEnv;
    process.env.NODE_ENV = originalNodeEnv;
  });

  function makeService(
    definitions: Array<{ name: string; targetTable: string; description: string }>,
  ) {
    const registry = {
      list: jest.fn().mockReturnValue(definitions),
    } as unknown as MigrationRegistryService;
    const runner = {
      run: jest.fn().mockResolvedValue(undefined),
    } as unknown as MigrationRunnerService;
    return { service: new MigrationStartupService(registry, runner), registry, runner };
  }

  it('runs every registered migration by name on bootstrap', async () => {
    process.env.RUN_MIGRATIONS_ON_STARTUP = 'true';
    const { service, runner } = makeService([
      { name: 'gigs-add-priority-column', targetTable: 'gigs', description: 'x' },
      { name: 'escrows-add-notes-column', targetTable: 'escrows', description: 'y' },
    ]);

    await service.onApplicationBootstrap();

    expect(runner.run).toHaveBeenCalledWith('gigs-add-priority-column');
    expect(runner.run).toHaveBeenCalledWith('escrows-add-notes-column');
    expect(runner.run).toHaveBeenCalledTimes(2);
  });

  it('does not throw and still attempts remaining migrations when one fails', async () => {
    process.env.RUN_MIGRATIONS_ON_STARTUP = 'true';
    const { service, runner } = makeService([
      { name: 'broken-migration', targetTable: 'gigs', description: 'x' },
      { name: 'healthy-migration', targetTable: 'escrows', description: 'y' },
    ]);
    (runner.run as jest.Mock).mockImplementation((name: string) =>
      name === 'broken-migration' ? Promise.reject(new Error('boom')) : Promise.resolve(),
    );

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();

    expect(runner.run).toHaveBeenCalledWith('broken-migration');
    expect(runner.run).toHaveBeenCalledWith('healthy-migration');
  });

  it('does nothing when there are no registered migrations', async () => {
    process.env.RUN_MIGRATIONS_ON_STARTUP = 'true';
    const { service, runner } = makeService([]);

    await service.onApplicationBootstrap();

    expect(runner.run).not.toHaveBeenCalled();
  });

  it('skips entirely when RUN_MIGRATIONS_ON_STARTUP=false', async () => {
    process.env.RUN_MIGRATIONS_ON_STARTUP = 'false';
    const { service, runner } = makeService([{ name: 'm', targetTable: 't', description: 'd' }]);

    await service.onApplicationBootstrap();

    expect(runner.run).not.toHaveBeenCalled();
  });

  it('defaults to disabled when NODE_ENV=test and RUN_MIGRATIONS_ON_STARTUP is unset', async () => {
    delete process.env.RUN_MIGRATIONS_ON_STARTUP;
    process.env.NODE_ENV = 'test';
    const { service, runner } = makeService([{ name: 'm', targetTable: 't', description: 'd' }]);

    await service.onApplicationBootstrap();

    expect(runner.run).not.toHaveBeenCalled();
  });

  it('defaults to enabled when NODE_ENV is not test and RUN_MIGRATIONS_ON_STARTUP is unset', async () => {
    delete process.env.RUN_MIGRATIONS_ON_STARTUP;
    process.env.NODE_ENV = 'production';
    const { service, runner } = makeService([{ name: 'm', targetTable: 't', description: 'd' }]);

    await service.onApplicationBootstrap();

    expect(runner.run).toHaveBeenCalledWith('m');
  });
});
