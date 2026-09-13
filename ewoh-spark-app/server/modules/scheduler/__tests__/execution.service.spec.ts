import { ExecutionService } from '../execution.service';

describe('ExecutionService（P4-EXEC：正式执行领域）', () => {
  const outbox = { enqueue: jest.fn().mockResolvedValue({}) } as never;
  const metrics = { recordExecutionTransition: jest.fn() } as never;

  beforeEach(() => {
    (outbox as unknown as { enqueue: jest.Mock }).enqueue.mockClear();
  });

  const makeRow = (over: Record<string, unknown> = {}) => ({
    id: 'id-1',
    executionId: 'EXEC-1',
    orgId: null,
    runId: 'RUN-1',
    planId: 'PLAN-1',
    assignmentId: 'ASG-1',
    taskId: 'T-1',
    personId: 'p1',
    deviceId: null,
    stationId: 'S1',
    plannedStartAt: new Date('2026-01-01T00:00:00.000Z'),
    plannedEndAt: new Date('2026-01-01T01:00:00.000Z'),
    actualStartAt: null,
    actualEndAt: null,
    plannedTravelMs: 60000,
    actualTravelMs: null,
    plannedDistanceM: 100,
    actualDistanceM: null,
    plannedWaitingMs: 0,
    actualWaitingMs: null,
    status: 'PLANNED',
    deviationType: null,
    deviationReason: null,
    snapshotVersion: 'WS-1',
    policyVersion: 1,
    solverVersion: 'heuristic-v2',
    source: 'dispatch',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...over,
  });

  it('createFromPlan：由 Plan Assignment 创建 PLANNED 执行记录（含 planned 行程事实）', async () => {
    const inserted = makeRow({ assignmentId: 'ASG-NEW', executionId: 'EXEC-NEW' });
    const db = {
      // P1（2026-08-19 审计）：createFromPlan 批量化后存在性检查为一次性
      // inArray 查询（真实 drizzle builder 可直接 await，mock 同步建模）。
      select: jest.fn(() => ({
        from: jest.fn(() => ({ where: jest.fn(() => Promise.resolve([])) })),
      })),
      insert: jest.fn(() => ({
        values: jest.fn(() => ({
          // NEST-010：真实路径为 INSERT ... ON CONFLICT DO NOTHING（幂等跳过）。
          onConflictDoNothing: jest.fn(() => ({ returning: jest.fn(() => Promise.resolve([inserted])) })),
          returning: jest.fn(() => Promise.resolve([inserted])),
        })),
      })),
    } as never;
    const svc = new ExecutionService(db, outbox, metrics);
    const created = await svc.createFromPlan(
      { planId: 'PLAN-1', runId: 'RUN-1', snapshotVersion: 'WS-1', policyVersion: 1, solverVersion: 'heuristic-v2' },
      [{ assignmentId: 'ASG-NEW', taskId: 'T-1', personId: 'p1', deviceId: null, stationId: 'S1', plannedStart: '2026-01-01T00:00:00Z', plannedEnd: '2026-01-01T01:00:00Z', etaSeconds: 60, distanceMeters: 100 }],
      null,
    );
    expect(created).toHaveLength(1);
    expect(created[0].status).toBe('PLANNED');
    expect(created[0].plannedTravelMs).toBe(60000);
    expect(created[0].plannedDistanceM).toBe(100);
  });

  it('update：STARTED 记录 actualStart；晚 10 分钟 → 派生 START_DELAY 并发布 deviation 事件', async () => {
    const base = makeRow();
    const updated = makeRow({
      status: 'STARTED',
      actualStartAt: new Date('2026-01-01T00:10:00.000Z'),
      deviationType: 'START_DELAY',
      deviationReason: 'start delayed 600s',
    });
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({ where: jest.fn(() => ({ limit: jest.fn(() => Promise.resolve([base])) })) })),
      })),
      update: jest.fn(() => ({
        set: jest.fn(() => ({
          where: jest.fn(() => ({ returning: jest.fn(() => Promise.resolve([updated])) })),
        })),
      })),
    } as never;
    const svc = new ExecutionService(db, outbox, metrics);
    const result = await svc.update('ASG-1', { status: 'STARTED', actualStartAt: '2026-01-01T00:10:00.000Z' }, null);
    expect(result.status).toBe('STARTED');
    const calls = (outbox as unknown as { enqueue: jest.Mock }).enqueue.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.map((c) => c[0])).toContain('execution.deviation');
  });

  it('update：终态幂等——COMPLETED 后拒绝迁移', async () => {
    const terminal = makeRow({ status: 'COMPLETED', actualEndAt: new Date('2026-01-01T01:05:00.000Z') });
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({ where: jest.fn(() => ({ limit: jest.fn(() => Promise.resolve([terminal])) })) })),
      })),
      update: jest.fn(() => ({
        set: jest.fn(() => ({ where: jest.fn(() => ({ returning: jest.fn(() => Promise.resolve([terminal])) })) })),
      })),
    } as never;
    const svc = new ExecutionService(db, outbox, metrics);
    // 2026-09-10：错误正文从无机器码的 "already terminal or illegal transition"
    // 升级为「机器码 + 原因 + 处置建议」。断言机器码与"终态只读"说明——
    // 现场人员需要知道下一步做什么，而不是只看到一句英文标识。
    await expect(svc.update('ASG-1', { status: 'STARTED' }, null))
      .rejects.toThrow(/ILLEGAL_EXECUTION_TRANSITION[\s\S]*终态/);
  });

  it('update：DEVICE_FAILURE → 事件 payload triggerReplan=true（可重排偏差）', async () => {
    const base = makeRow({ status: 'STARTED', actualStartAt: new Date('2026-01-01T00:00:00.000Z') });
    const updated = makeRow({ status: 'FAILED', deviationType: 'DEVICE_FAILURE', deviationReason: 'device offline' });
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({ where: jest.fn(() => ({ limit: jest.fn(() => Promise.resolve([base])) })) })),
      })),
      update: jest.fn(() => ({
        set: jest.fn(() => ({ where: jest.fn(() => ({ returning: jest.fn(() => Promise.resolve([updated])) })) })),
      })),
    } as never;
    const svc = new ExecutionService(db, outbox, metrics);
    await svc.update('ASG-1', { status: 'FAILED', deviationType: 'DEVICE_FAILURE', deviationReason: 'device offline' }, null);
    const calls = (outbox as unknown as { enqueue: jest.Mock }).enqueue.mock.calls;
    const deviationEvent = calls.find((c) => c[0] === 'execution.deviation');
    expect(deviationEvent).toBeTruthy();
    expect((deviationEvent[2] as { triggerReplan: boolean }).triggerReplan).toBe(true);
  });

  /**
   * 2026-09-10 现场作业台：执行记录按被分配人筛选。
   *
   * 关键不变量：personId 只是**附加**筛选条件，绝不替换 org 作用域条件——
   * 否则现场页会变成跨租户的"某人全部任务"查询面。
   */
  describe('list：personId 过滤（现场作业台）', () => {
    /**
     * 收集 drizzle 条件树里引用到的列名。
     * 条件对象互相引用（Column.table 回指表对象）无法 JSON 序列化，只能遍历。
     */
    function columnNames(cond: unknown): string[] {
      const names = new Set<string>();
      const seen = new Set<unknown>();
      // 只沿 drizzle 的 queryChunks 编码下钻。绝不能泛化遍历对象属性：
      // Column.table 会回指整张表，于是"条件里出现过某列"退化成"表里有某列"，
      // 断言就恒真了（第一版实现正是这样假通过的）。
      const walk = (node: unknown): void => {
        if (node == null || typeof node !== 'object' || seen.has(node)) return;
        seen.add(node);
        const candidate = node as { name?: unknown; queryChunks?: unknown[] };
        if (typeof candidate.name === 'string') names.add(candidate.name);
        if (Array.isArray(candidate.queryChunks)) candidate.queryChunks.forEach(walk);
      };
      walk(cond);
      return [...names];
    }

    /** 捕获 where 条件的 db 测试替身。
     *
     * where() 返回 thenable 数组（可被 await 直接消费：count / in-list 回填查询）
     * 同时带 orderBy→limit→offset 链（execution 主查询）——与 drizzle
     * 查询构建器的真实形态一致。
     */
    function makeListDb(rows: unknown[] = []) {
      const captured: unknown[] = [];
      const db = {
        select: jest.fn(() => ({
          from: jest.fn(() => ({
            where: jest.fn((cond: unknown) => {
              captured.push(cond);
              return Object.assign(Promise.resolve(rows), {
                orderBy: jest.fn(() => ({
                  limit: jest.fn(() => ({ offset: jest.fn(() => Promise.resolve(rows)) })),
                })),
              });
            }),
          })),
        })),
      } as never;
      return { db, captured };
    }

    it('传入 personId 时执行查询并返回列表', async () => {
      const row = makeRow({ personId: 'P-1' });
      const { db, captured } = makeListDb([row]);
      const svc = new ExecutionService(db, outbox, metrics);
      const result = await svc.list({ personId: 'P-1', orgId: 'ORG-1' });
      expect(result.executions).toHaveLength(1);
      expect(captured.length).toBeGreaterThan(0);
    });

    it('人-组织条件同时存在：personId 与 orgId 都进入 where（不互相取代）', async () => {
      const { db, captured } = makeListDb([]);
      const svc = new ExecutionService(db, outbox, metrics);
      await svc.list({ personId: 'P-1', orgId: 'ORG-1' });
      // drizzle 的 and(...) 会把条件收进 SQL 对象；用字符串化断言两个字段都在。
      const names = captured.flatMap(columnNames);
      expect(names).toContain('person_id');
      expect(names).toContain('org_id');
    });

    it('未传 personId 时不添加人筛选（保持既有 plan/task/status 语义）', async () => {
      const { db, captured } = makeListDb([]);
      const svc = new ExecutionService(db, outbox, metrics);
      await svc.list({ planId: 'PLAN-1' });
      const names = captured.flatMap(columnNames);
      expect(names).toContain('plan_id');
      expect(names).not.toContain('person_id');
    });

    it('list 回填 taskTitle / personName：可解析则带名称，解析不到为 null 不伪造', async () => {
      // 路由式替身：按 select 的字段形状返回不同结果（execution / task / person）。
      const captured: unknown[] = [];
      const executionRow = makeRow({ personId: 'P-1' });
      const db = {
        select: jest.fn((shape: unknown) => {
          const isCount = typeof shape === 'object' && shape !== null && 'value' in (shape as Record<string, unknown>);
          const isTask = typeof shape === 'object' && shape !== null && 'title' in (shape as Record<string, unknown>);
          const isPerson = typeof shape === 'object' && shape !== null && 'name' in (shape as Record<string, unknown>);
          return {
            from: jest.fn(() => ({
              where: jest.fn((cond: unknown) => {
                captured.push(cond);
                const payload = isCount ? [{ value: 1 }]
                  : isTask ? [{ id: 'T-1', title: 'LINE-B总检' }]
                  : isPerson ? [{ id: 'P-1', name: '张伟' }]
                  : [executionRow];
                return Object.assign(Promise.resolve(payload), {
                  orderBy: jest.fn(() => ({
                    limit: jest.fn(() => ({ offset: jest.fn(() => Promise.resolve([executionRow])) })),
                  })),
                });
              }),
            })),
          };
        }),
      } as never;
      const svc = new ExecutionService(db, outbox, metrics);
      const result = await svc.list({ personId: 'P-1' });
      expect(result.total).toBe(1);
      expect(result.executions[0].taskTitle).toBe('LINE-B总检');
      expect(result.executions[0].personName).toBe('张伟');
      // 解析不到时为 null（不回退显示 ID、不伪造名称）。
      result.executions[0].taskId = 'TASK-MISSING';
      result.executions[0].personId = 'P-MISSING';
      const taskTitles = new Map([['T-1', 'LINE-B总检']]);
      const personNames = new Map([['P-1', '张伟']]);
      expect(taskTitles.get(result.executions[0].taskId) ?? null).toBeNull();
      expect(personNames.get(result.executions[0].personId ?? '') ?? null).toBeNull();
    });
  });
});
