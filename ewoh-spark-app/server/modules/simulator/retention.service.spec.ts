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

  /**
   * V284：模拟告警批量过期不得覆盖并发处置结果。
   * 这里用一份行状态表模拟「SELECT 之后、UPDATE 之前运维点了处置」的交错；
   * 牙口有三条——守卫谓词在不在 SQL 里、日志条数取自 RETURNING 还是取自读到的行数、
   * 被并发处置那行的最终状态。它钉的是语句形状与计数语义，不是真库并发（真库复现另轮）。
   */
  it('EXPIR-01 只过期仍是 open 的行，并按实际改写条数计数', async () => {
    process.env.EWOH_DATABASE_URL = 'postgresql://owner:test@127.0.0.1:55432/owner-db';
    const service = new RetentionService();
    const instance = postgres.instances.at(-1)!;
    const rows = new Map<string, string>([['ev-1', 'open'], ['ev-2', 'open']]);
    const logs: string[] = [];
    jest.spyOn((service as unknown as { logger: { log: (v: string) => void } }).logger, 'log')
      .mockImplementation((v: string) => logs.push(v));

    let interleaved = false;
    instance.unsafe.mockImplementation(async (query: unknown, values?: unknown[]) => {
      const sql = String(query);
      if (sql.includes('SELECT id FROM ewoh_event')) {
        return [...rows.entries()].filter(([, s]) => s === 'open').map(([id]) => ({ id }));
      }
      if (sql.includes('UPDATE ewoh_event')) {
        // 交错点：读完待过期清单后，ev-2 被运维处置掉（并发方先提交）。
        if (!interleaved) { rows.set('ev-2', 'handled'); interleaved = true; }
        // 只有来源态谓词仍然成立的行会被改到 expired；RETURNING 只回这些行。
        const guarded = /AND\s+status\s*=\s*'open'/.test(sql);
        const ids = (values as Array<string[]>)[0];
        const flipped = ids.filter((id) => rows.get(id) === 'open');
        if (guarded) flipped.forEach((id) => rows.set(id, 'expired'));
        else ids.forEach((id) => rows.set(id, 'expired'));
        return flipped.map((id) => ({ id }));
      }
      return [];
    });

    await (service as unknown as { expireStaleSimulatedEvents(now: number): Promise<void> })
      .expireStaleSimulatedEvents(Date.now());

    const updateCall = instance.unsafe.mock.calls.find(([q]) => String(q).includes('UPDATE ewoh_event'));
    expect(updateCall).toBeDefined();
    // ① 来源态谓词必须与 id 清单同处一个 WHERE（缺它 ⇒ ②③ 同时失守，故三条都要断）
    expect(String(updateCall![0])).toMatch(/WHERE id = ANY\(\$1\)\s+AND status = 'open'/);
    // ② 日志条数取自实际改写行数：读到 2 行、只过期 1 行
    expect(logs.some((l) => l.includes('expired 1 stale simulated events'))).toBe(true);
    // ③ 并发处置那行没被覆盖成 expired
    expect(rows.get('ev-2')).toBe('handled');
    expect(rows.get('ev-1')).toBe('expired');
  });

  /**
   * V285：终止条件要由「确实改到了行」保证。
   * 夹具把「SELECT 每轮都读到同一批 open 行、UPDATE 每轮改写 0 行」钉成事实——
   * 这正是守卫谓词与 SELECT 脱钩、或被并发反复重开时的形状。轮次封顶让缺守卫时
   * 本例以「拒绝 + 封顶原因」快速翻红，而不是把 jest worker 挂在微任务里出不来。
   */
  it('LOOP-01 一轮改不到任何行就退出，不在同一批行上空转', async () => {
    process.env.EWOH_DATABASE_URL = 'postgresql://owner:test@127.0.0.1:55432/owner-db';
    const service = new RetentionService();
    const instance = postgres.instances.at(-1)!;
    let selects = 0;
    let updates = 0;
    instance.unsafe.mockImplementation(async (query: unknown) => {
      const sql = String(query);
      if (sql.includes('SELECT id FROM ewoh_event')) {
        selects += 1;
        if (selects > 8) throw new Error(`retention 空转：SELECT 第 ${selects} 轮仍读到待过期行`);
        return [{ id: 'ev-1' }];
      }
      if (sql.includes('UPDATE ewoh_event')) {
        updates += 1;
        return [];
      }
      return [];
    });

    await (service as unknown as { expireStaleSimulatedEvents(now: number): Promise<void> })
      .expireStaleSimulatedEvents(Date.now());

    expect(updates).toBe(1);
    expect(selects).toBe(1);
  });
});
