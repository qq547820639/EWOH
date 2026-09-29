/**
 * NO-68a 巡检 worker 的间隔解析回归。
 *
 * 真实缺陷（对抗式自查复现）：原实现 `Number(env ?? 默认)` 对非法值不设防——
 * `setInterval(fn, NaN)` 在 Node 里被当作 **1ms**（Node 会把非数字/小于 1 的
 * delay 归一为 1），一次配置手误就把"10 分钟巡检一次"变成每毫秒扫库的热循环。
 * 纪律与 `ingest.guard.ts` 的 `readPositiveInt` 同源：非法配置回退默认并留痕。
 */
import { backlogIntervalMs, ControlDeliveryBacklogWorkerService } from './control-delivery-backlog.worker';

describe('backlogIntervalMs（巡检间隔 env 解析）', () => {
  it('缺失/空白 → 默认 10 分钟', () => {
    expect(backlogIntervalMs({})).toBe(600_000);
    expect(backlogIntervalMs({ CONTROL_BACKLOG_WORKER_INTERVAL_MS: '   ' })).toBe(600_000);
  });

  it('合法正整数 → 取整生效', () => {
    expect(backlogIntervalMs({ CONTROL_BACKLOG_WORKER_INTERVAL_MS: '60000' })).toBe(60_000);
    expect(backlogIntervalMs({ CONTROL_BACKLOG_WORKER_INTERVAL_MS: '1500.9' })).toBe(1500);
  });

  it('非法值（NaN/负数/表达式）→ 回退默认并留痕，绝不变成 1ms 热循环', () => {
    const warnings: string[] = [];
    const onInvalid = (message: string) => warnings.push(message);
    for (const bad of ['abc', '-5', '10*60_000', 'Infinity']) {
      expect(backlogIntervalMs({ CONTROL_BACKLOG_WORKER_INTERVAL_MS: bad }, 600_000, onInvalid)).toBe(600_000);
    }
    expect(warnings).toHaveLength(4);
    expect(warnings[0]).toContain('非法 CONTROL_BACKLOG_WORKER_INTERVAL_MS');
  });
});

/**
 * F-16（V92 实测抓到的死留痕）。
 *
 * 为什么单独立一组：`ewoh_append_audit_log` 在 `org_id` 为 NULL 时要求
 * `app.is_global_admin='true'`，否则抛 42501（SQL 层与产品调用链各测一次：
 * `tmp/v92-sql-probe.mjs` Q2、`test/e2e/control-backlog-audit-trail.e2e.spec.ts` BA-01）。
 * 而 worker 的这段留痕写在 **ALS 之外**（外层 catch 里，请求/巡检事务早已结束），
 * 原实现又用 `.catch(() => undefined)` 把异常吞掉 ⇒ "巡检失败了"这件事**从来没有**
 * 进过审计链，只剩一行进程日志。修法沿用仓库自身的 P1-GUC 约定（后台跨 org 写
 * RLS 表必须自建全局管理员上下文），并保留"留痕失败不得打断巡检"的原意——但要 warn。
 */
describe('巡检失败的留痕路由（F-16）', () => {
  function harness(input: { failAudit?: boolean } = {}) {
    const appended: Array<Record<string, unknown>> = [];
    const warns: string[] = [];
    const auditService = {
      appendAuditLog: jest.fn(async (entry: Record<string, unknown>) => {
        appended.push(entry);
        if (input.failAudit) throw new Error('audit sink down');
      }),
    };
    const rdc = {
      // 让 org 清单读取直接失败，走外层 catch——这正是 F-16 的触发形状
      runInTransaction: jest.fn(() => Promise.reject(new Error('org 清单读取失败'))),
      systemGlobalAdminTransaction: jest.fn((op: () => unknown) => Promise.resolve().then(op)),
    };
    const worker = new ControlDeliveryBacklogWorkerService(
      { listOrgsWithPendingCommands: jest.fn() } as never,
      rdc as never,
      auditService as never,
    );
    // 覆盖私有 logger：断言"失败必须可见"时不需要真日志
    (worker as unknown as { logger: { warn(m: string): void } }).logger = {
      warn: (m: string) => warns.push(String(m)),
    };
    return { worker, appended, warns, rdc, auditService };
  }
  const tick = (worker: ControlDeliveryBacklogWorkerService) =>
    (worker as unknown as { tick(): Promise<void> }).tick();

  it('留痕必须经 systemGlobalAdminTransaction 建立上下文，而不是裸调（裸调恒 42501 ⇒ 0 行）', async () => {
    const { worker, appended, rdc, auditService } = harness();
    await tick(worker);
    expect(rdc.systemGlobalAdminTransaction).toHaveBeenCalledTimes(1);
    expect(auditService.appendAuditLog).toHaveBeenCalledTimes(1);
    expect(appended[0]).toMatchObject({
      action: 'control.delivery_backlog_sweep_failed',
      actorId: 'system:control-backlog',
      orgId: '',
      entityType: 'control_command',
      entityId: 'worker',
    });
    expect(String(appended[0]?.reason)).toContain('org 清单读取失败');
  });

  it('留痕自身失败时：巡检照常结束，但必须留下 warn（不得再静默）', async () => {
    const { worker, warns, appended } = harness({ failAudit: true });
    await expect(tick(worker)).resolves.toBeUndefined();
    expect(appended).toHaveLength(1);
    expect(warns.some((w) => w.includes('失败留痕未能写入'))).toBe(true);
    expect(warns.some((w) => w.includes('投递积压巡检失败'))).toBe(true);
  });
});
