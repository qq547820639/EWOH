// task-scheduling-bridge.spec.ts — A1：任务写路径 → 事件驱动重排桥接测试
// 覆盖：
//   - TaskService.createTask 成功后 emit TASK_CREATED（回调收到 taskId）
//   - TaskService.transitionTaskState 成功后 emit TASK_UPDATED（带 actor）
//   - TaskSchedulingBridge.onModuleInit 注册回调 → injectSchedulingEvent 转发
//   - 桥接回调异常不阻断（fire-and-forget + catch）
/* eslint-disable @typescript-eslint/no-explicit-any */
import { TaskService } from '../../task/task.service';
import { TaskSchedulingBridge } from '../task-scheduling.bridge';

function makeTaskService(opts: { createReturns?: any } = {}) {
  const events: Array<{ taskId: string; trigger: string; actor?: any }> = [];
  // NO-36a：createTask 现在把「会话闸门读取 + 任务写入」放进同一事务，
  // 测试替身必须同形提供 transaction（否则 createTask 直接 TypeError——
  // 这正是"替身与真实写路径形状不一致"造成过一次全量红的情形）。
  const db: any = {
    insert: () => ({
      values: () => ({
        returning: async () => [opts.createReturns ?? { id: 'TASK-1' }],
      }),
    }),
  };
  db.transaction = async (cb: (tx: unknown) => Promise<unknown>) => cb(db);
  const svc = new TaskService(
    db,
    { appendAuditLog: jest.fn() } as any,
  );
  svc.onTaskEvent((taskId, trigger, actor) => {
    events.push({ taskId, trigger, actor });
  });
  return { svc, events };
}

describe('A1 TaskService 任务写事件发射', () => {
  /* NO-16a 修复：createTask 过去**不带 actor** 发事件，而桥接对缺 actor/org 的事件
   * fail-closed 拒绝（见下一条用例）——也就是说"新建任务触发重排"这条 A1 接线
   * 在创建路径上一直是**死的**：任务建了，调度不会被通知。现在创建与状态变更同样
   * 透传 actor，事件才真正到达桥接。 */
  it('createTask 成功后 emit TASK_CREATED（带 taskId + actor，桥接才会接受）', async () => {
    const { svc, events } = makeTaskService({ createReturns: { id: 'TASK-X' } });
    // NEST-612：任务写入必须带租户上下文（fail-closed）。
    const actor = { userId: 'u1', primaryOrgId: 'org1', isGlobalAdmin: false };
    await svc.createTask({ title: '搬运任务', taskType: 'transport' }, actor);
    expect(events).toEqual([
      { taskId: 'TASK-X', trigger: 'TASK_CREATED', actor: { userId: 'u1', primaryOrgId: 'org1', isGlobalAdmin: false } },
    ]);
  });

  it('transitionTaskState 成功后 emit TASK_UPDATED（带 actor）', async () => {
    const { svc, events } = makeTaskService();
    const db: any = svc as any;
    // 覆写 getTask 与 update 链（draft 合法 action: submit → pending_confirm）
    db.getTask = async () => ({ id: 'TASK-1', status: 'draft' });
    db.db = {
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => [{ id: 'TASK-1', status: 'pending_confirm' }],
          }),
        }),
      }),
    };
    const actor = { userId: 'u1', primaryOrgId: 'org1', accessibleOrgIds: ['org1'], isGlobalAdmin: false };
    await svc.transitionTaskState('TASK-1', 'submit', actor);
    expect(events).toContainEqual({ taskId: 'TASK-1', trigger: 'TASK_UPDATED', actor });
  });
});

describe('A1 TaskSchedulingBridge 桥接转发', () => {
  const actor = { userId: 'u1', primaryOrgId: 'org1', accessibleOrgIds: ['org1'], isGlobalAdmin: false };

  // RUN-01（2026-09-21）：桥接的续作必须**自带事务**，不能继承任务写请求的 store。
  // 替身同形：记录 GUC 设置并原样执行 operation（真实实现会开新连接并重绑 ALS store）。
  function makeDetachedDb() {
    const calls: unknown[] = [];
    const requestDatabaseContext = {
      runDetachedTransaction: jest.fn(
        async (settings: unknown, operation: () => Promise<unknown>) => {
          calls.push(settings);
          return operation();
        },
      ),
    };
    return { calls, requestDatabaseContext };
  }

  it('onModuleInit 注册回调 → 任务事件转发 injectSchedulingEvent（fire-and-forget + 独立事务）', async () => {
    const events: Array<{ taskId: string; trigger: string }> = [];
    const taskService = {
      onTaskEvent: (fn: (taskId: string, trigger: string, actor?: any) => void) => {
        // 模拟 TaskService 后续触发（NEST-119：事件必须带 actor/org 上下文）
        events.push({ taskId: 'TASK-1', trigger: 'TASK_CREATED' });
        fn('TASK-1', 'TASK_CREATED' as any, actor);
      },
    };
    const injected: Array<{ body: any; actor?: any }> = [];
    const schedulerService = {
      injectSchedulingEvent: jest
        .fn()
        .mockImplementation(async (body: any, actor?: any) => {
          injected.push({ body, actor });
          return { run: { runId: 'RUN-1' }, plans: [], debounced: false, cascaded: [] };
        }),
    };
    const { calls, requestDatabaseContext } = makeDetachedDb();
    const bridge = new TaskSchedulingBridge(
      taskService as any,
      schedulerService as any,
      requestDatabaseContext as any,
    );
    await bridge.onModuleInit();
    // 等待 fire-and-forget promise 落定
    await new Promise((r) => setTimeout(r, 10));
    expect(injected).toHaveLength(1);
    expect(injected[0].body).toEqual({ trigger: 'TASK_CREATED', entityId: 'TASK-1' });
    // NEST-119：actor 原样透传（重排归属可追溯）。
    expect(injected[0].actor).toBe(actor);
    // RUN-01：转发发生在 detached 事务里，且带该 actor 的租户 GUC —— 否则会挂到已结束的
    // 请求事务上静默丢失（实测 0 run / 0 trigger / 0 日志）；丢了 GUC 则掉进 RLS 静默空读。
    expect(calls).toHaveLength(1);
    const gucs = calls[0] as Array<{ name: string; value: string }>;
    expect(gucs.find((g) => g.name === 'app.current_org_id')?.value).toBe('org1');
  });

  it('NEST-119：无 actor/org 上下文的事件 → 拒绝桥接（fail-closed，不触发匿名重排）', async () => {
    const taskService = {
      onTaskEvent: (fn: any) => fn('TASK-9', 'TASK_UPDATED', undefined),
    };
    const schedulerService = {
      injectSchedulingEvent: jest.fn().mockResolvedValue({ run: null, plans: [], debounced: true, cascaded: [] }),
    };
    const { calls, requestDatabaseContext } = makeDetachedDb();
    const bridge = new TaskSchedulingBridge(taskService as any, schedulerService as any, requestDatabaseContext as any);
    bridge.onModuleInit();
    await new Promise((r) => setTimeout(r, 10));
    expect(schedulerService.injectSchedulingEvent).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('injectSchedulingEvent 失败 → 仅日志不抛出（fire-and-forget 容错）', async () => {
    const taskService = {
      onTaskEvent: (fn: any) => fn('TASK-1', 'TASK_UPDATED', actor),
    };
    const schedulerService = {
      injectSchedulingEvent: jest.fn().mockRejectedValue(new Error('replan down')),
    };
    const { requestDatabaseContext } = makeDetachedDb();
    const bridge = new TaskSchedulingBridge(taskService as any, schedulerService as any, requestDatabaseContext as any);
    bridge.onModuleInit(); // 同步注册（Nest onModuleInit 同步签名）
    await expect(Promise.resolve()).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 10));
    expect(schedulerService.injectSchedulingEvent).toHaveBeenCalledWith(
      { trigger: 'TASK_UPDATED', entityId: 'TASK-1' },
      actor,
    );
  });
});
