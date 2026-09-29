/* RUN-01（2026-09-21）：fire-and-forget 自动重排的**事务形状**契约。
 *
 * 背景（基线文档 §5.3f/§5.3g，均为实测）：ingest 与任务写桥接都在请求处理器里
 * 不 await 地启动重排。continuation 继承调用方的 ALS store，而
 * `RequestDatabaseContext.runInTransaction` 遇到已有 store 时加入同一事务且无 savepoint
 * → 响应返回、请求事务结束后，续作挂到那个已结束的事务上。
 * 实测两种形态：ingest 侧留下永不闭合的 `queued` run；桥接侧连触发去重记录都不产生。
 *
 * 本文件只钉"续作必须自带事务 + 必须带租户 GUC + 失败必须向外传播"这三条契约；
 * 端到端因果确认在 `test/e2e/pg-temporary-failure.e2e.spec.ts`（S-03/S-04）。
 */
/// <reference types="jest" />
import { ReplanCoordinatorService } from '../replan-coordinator.service';

const CTX = {
  userId: 'ingest',
  primaryOrgId: 'org1',
  accessibleOrgIds: ['org1'],
  isGlobalAdmin: false,
};

function makeService() {
  const detachedCalls: unknown[] = [];
  const requestDatabaseContext = {
    runDetachedTransaction: jest.fn(
      async (settings: unknown, operation: () => Promise<unknown>) => {
        detachedCalls.push(settings);
        return operation();
      },
    ),
    runInTransaction: jest.fn(async (_settings: unknown, operation: () => Promise<unknown>) =>
      operation(),
    ),
  };
  const svc = new ReplanCoordinatorService(
    {} as never,
    requestDatabaseContext as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const handleTrigger = jest
    .spyOn(svc as unknown as { handleTrigger: (...a: unknown[]) => Promise<unknown> }, 'handleTrigger')
    .mockResolvedValue({ run: null, plans: [], debounced: false, suppressed: false });
  return { svc, requestDatabaseContext, detachedCalls, handleTrigger };
}

describe('RUN-01 ReplanCoordinatorService.handleTriggerDetached 事务形状', () => {
  it('续作走 detached 事务并带 actor 的租户 GUC（绝不加入调用方请求事务）', async () => {
    const { svc, requestDatabaseContext, detachedCalls, handleTrigger } = makeService();

    await svc.handleTriggerDetached('DEVICE_OFFLINE', 'exo-1', CTX as never);

    expect(requestDatabaseContext.runDetachedTransaction).toHaveBeenCalledTimes(1);
    // 包装层自己不得再用 runInTransaction（那正是"加入已有 store"的入口）。
    expect(requestDatabaseContext.runInTransaction).not.toHaveBeenCalled();
    expect(detachedCalls[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'app.current_org_id', value: 'org1' }),
        expect.objectContaining({ name: 'app.user_id', value: 'ingest' }),
      ]),
    );
    // 第 5 个入参 = 守卫锁等待预算（F-10b）：事件路径必须带正数，
    // 否则撞锁就被丢掉且没有补投生产者（三次实测复现，其中两次红掉 S-03）。
    expect(handleTrigger).toHaveBeenCalledWith(
      'DEVICE_OFFLINE',
      'exo-1',
      CTX,
      undefined,
      expect.any(Number),
    );
    expect(handleTrigger.mock.calls[0][4]).toBeGreaterThan(0);
  });

  it('triggerIds 原样透传（聚合触发的完整实体列表不丢）', async () => {
    const { svc, handleTrigger } = makeService();

    await svc.handleTriggerDetached('ROUTE_BLOCKED', 'e1', CTX as never, ['e1', 'e2']);

    expect(handleTrigger).toHaveBeenCalledWith('ROUTE_BLOCKED', 'e1', CTX, ['e1', 'e2'],
      expect.any(Number));
  });

  it('内部异常向外传播：detached 事务不会把失败吞成"静默无变化"', async () => {
    const { svc, handleTrigger } = makeService();
    handleTrigger.mockRejectedValue(new Error('solve failed'));

    await expect(
      svc.handleTriggerDetached('DEVICE_OFFLINE', 'exo-1', CTX as never),
    ).rejects.toThrow('solve failed');
  });
});

/**
 * RUN-01 的收口侧（F-09 同类）：`closeRun` 必须把 0 行命中变成**显式痕迹**。
 * 三处 run 闭合 UPDATE 原来是「写完就走」，org 谓词不匹配 / 行被并发删除 / 无 GUC 时
 * RLS 静默空，都会让 run 永远停在 queued 且不留一行日志——正是最难定位的那类形态。
 */
describe('RUN-01 收口 ReplanCoordinatorService.closeRun', () => {
  function makeCloseRunService(rows: Array<Record<string, unknown>>) {
    const db = {
      update: jest.fn(() => ({
        set: jest.fn(() => ({
          where: jest.fn(() =>
            Object.assign(Promise.resolve(rows), { returning: () => Promise.resolve(rows) })),
        })),
      })),
    };
    const svc = new ReplanCoordinatorService(
      db as never,
      { runInTransaction: jest.fn(async (_g: unknown, op: () => Promise<unknown>) => op()) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const error = jest.fn();
    // 直接换掉实例 logger（jest.spyOn 只能 spy 方法，`logger` 是属性）；
    // 断言只关心「0 行命中有没有留下显式痕迹」，不关心输出到哪个 sink。
    (svc as unknown as {
      logger: { error: (m: string) => void; warn: (m: string) => void; log: (m: string) => void };
    }).logger = { error, warn: jest.fn(), log: jest.fn() };
    return { svc, db, error };
  }

  it('命中 0 行 → 返回 false 并按 runId 显式报错（不再静默留在 queued）', async () => {
    const { svc, error } = makeCloseRunService([]);

    const hit = await (svc as unknown as {
      closeRun: (i: unknown) => Promise<boolean>;
    }).closeRun({ runId: 'RUN-9', orgId: 'org1', stage: 'persisted', patch: { status: 'succeeded' } });

    expect(hit).toBe(false);
    expect(error.mock.calls.map((c) => String(c[0])).join('\n')).toContain('RUN-9 闭合未命中');
  });

  it('命中 1 行 → 返回 true 且不产生错误日志（正常闭合路径不被噪音污染）', async () => {
    const { svc, error, db } = makeCloseRunService([{ runId: 'RUN-9' }]);

    const hit = await (svc as unknown as {
      closeRun: (i: unknown) => Promise<boolean>;
    }).closeRun({ runId: 'RUN-9', orgId: 'org1', stage: 'failed', patch: { status: 'failed' } });

    expect(hit).toBe(true);
    expect(error).not.toHaveBeenCalled();
    expect(db.update).toHaveBeenCalledTimes(1);
  });
});
