import { postgres } from './retention.service.postgres-mock';

jest.mock('postgres', () => ({
  __esModule: true,
  default: postgres.mock,
}));

import { RetentionService } from './retention.service';

describe('RetentionService cross-tenant cleanup boundary', () => {
  const originalOwnerUrl = process.env.EWOH_DATABASE_URL;

  afterEach(() => {
    if (originalOwnerUrl === undefined) delete process.env.EWOH_DATABASE_URL;
    else process.env.EWOH_DATABASE_URL = originalOwnerUrl;
    postgres.mock.mockClear();
    postgres.instances.length = 0;
    jest.restoreAllMocks();
  });

  it('explicitly skips instead of pretending runtime-role cleanup succeeded', async () => {
    delete process.env.EWOH_DATABASE_URL;
    const service = new RetentionService();
    const warn = jest.spyOn((service as unknown as { logger: { warn: (value: string) => void } }).logger, 'warn').mockImplementation();

    await expect(service.cleanOnce()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no EWOH_DATABASE_URL'));
    expect(postgres.instances).toHaveLength(0);
  });

  it('opens only the explicit owner pool and parameterizes deletion keys', async () => {
    process.env.EWOH_DATABASE_URL = 'postgresql://owner:test@127.0.0.1:55432/owner-db';
    const service = new RetentionService();
    const instance = postgres.instances.at(-1)!;
    instance.unsafe
      .mockResolvedValueOnce([{ id: 'event-1' }])
      .mockResolvedValue([])
      .mockResolvedValueOnce([{ id: 'event-1' }])
      .mockResolvedValue([]);

    await service.cleanOnce();
    await service.onModuleDestroy();

    expect(postgres.mock).toHaveBeenCalledWith(
      'postgresql://owner:test@127.0.0.1:55432/owner-db',
      expect.objectContaining({ max: 2, prepare: false }),
    );
    const deleteCalls = instance.unsafe.mock.calls.filter(([query]) => String(query).includes('DELETE FROM '));
    expect(deleteCalls.length).toBeGreaterThan(0);
    expect(deleteCalls.every(([query]) => !query.includes("'event-1'"))).toBe(true);
    const [deleteQuery, deleteValues] = deleteCalls[0];
    expect(deleteQuery).toContain('WHERE id = ANY($1)');
    expect(JSON.stringify(deleteValues)).toBe(JSON.stringify([['event-1']]));
    expect(instance.end).toHaveBeenCalledWith({ timeout: 5 });
  });
});
