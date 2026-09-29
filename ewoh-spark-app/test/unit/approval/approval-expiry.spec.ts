/* 授权到期主动提醒测试（NO-30a）。
 *
 * 钉死的语义：
 *   1. 只有 **approved** 且有失效时间的授权参与（待批/驳回没有"到期"可言）；
 *   2. 分桶：剩余 ≤2 小时 → expiring；已过期且在 24 小时窗口内 → expired；
 *      离失效还很远 / 过期太久 → 不提醒（避免噪音与永久提醒）；
 *   3. **幂等**：通知 id 由 (审批号, 桶, 渠道) 确定性推导 + ON CONFLICT DO NOTHING，
 *      重复扫描只增加 duplicates，不重复提醒；
 *   4. 通知正文给出可行动信息（剩余时间/审批号/范围/发起人/已消耗数）；
 *   5. 只读：扫描不改变授权状态。
 */
/// <reference types="jest" />
import { BadRequestException } from '@nestjs/common';
import { ApprovalExpiryService, EXPIRY_RETENTION_MS, EXPIRY_WARN_WINDOW_MS } from '@server/modules/approval/approval-expiry.service';
import { ApprovalExpiryWorkerService } from '@server/modules/approval/approval-expiry.worker';

const ORG = '11111111-1111-4111-8111-111111111111';
const ACTOR = { userId: 'safety.zhou', primaryOrgId: ORG, roles: ['safety_admin'] } as never;
const NOW = new Date('2026-09-12T10:00:00.000Z');

function authorization(overrides: Record<string, unknown> = {}) {
  return {
    approvalId: 'AP-1',
    entityType: 'device_capability_change',
    entityId: 'capability:exo-lift',
    status: 'approved',
    createdAt: '2026-09-12T08:00:00.000Z',
    approvedAt: '2026-09-12T08:00:00.000Z',
    expiresAt: '2026-09-12T10:30:00.000Z',
    expired: false,
    remainingMs: 30 * 60_000,
    subject: {
      objectType: 'device_capability_change',
      objectId: 'capability:exo-lift',
      title: '恢复高风险能力：exo-lift（2 台设备）',
      summary: '…',
      metrics: { capabilityKey: 'exo-lift', deviceIds: 'EXO-1,EXO-2' },
    },
    usage: [{ usageKey: 'capability:exo-lift|device:EXO-1', usedBy: 'admin', at: null, note: null }],
    createdBy: 'worker.zhangwei',
    ...overrides,
  };
}

function createHarness(items: Array<Record<string, unknown>>) {
  const inserted: Array<Record<string, unknown>> = [];
  const existingIds = new Set<string>();
  /**
   * NO-45a：`sweep` 在授权**已失效**时会关闭它的"即将失效"催办提醒（写通知表）。
   * 这里记录 UPDATE 的 patch/where，供断言"失效才关、未失效不关"。
   */
  const updates: Array<{ patch: Record<string, unknown>; where: unknown }> = [];
  const db = {
    update: jest.fn(() => ({
      set: jest.fn((patch: Record<string, unknown>) => ({
        where: jest.fn((where: unknown) => {
          updates.push({ patch, where });
          return { returning: jest.fn().mockResolvedValue([]) };
        }),
      })),
    })),
    insert: jest.fn(() => ({
      values: jest.fn((values: Record<string, unknown>) => {
        inserted.push(values);
        return {
          onConflictDoNothing: jest.fn(() => ({
            returning: jest.fn().mockResolvedValue(
              existingIds.has(String(values.notificationId)) ? [] : [{ notificationId: values.notificationId }],
            ),
          })),
        };
      }),
    })),
    execute: jest.fn().mockResolvedValue([]),
  };
  const approvals = { listCapabilityAuthorizations: jest.fn().mockResolvedValue(items) };
  const service = new ApprovalExpiryService(db as never, approvals as never);
  return { service, inserted, updates, db, approvals, existingIds };
}

describe('ApprovalExpiryService（NO-30a 授权到期主动提醒）', () => {
  it('缺 org 上下文 → 400（不跨租户扫描）', async () => {
    const { service } = createHarness([]);
    await expect(service.sweep(undefined)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('剩余 ≤2 小时 → expiring 提醒，正文含剩余时间/审批号/范围/发起人/消耗数', async () => {
    const { service, inserted } = createHarness([authorization()]);
    const result = await service.sweep(ACTOR, { now: NOW });

    // 两位收件人：安全管理员（有权重批）+ 发起人本人（NO-32a 点名到人）
    expect(result).toMatchObject({ scanned: 1, expiringSoon: 1, expired: 0, created: 2, duplicates: 0 });
    expect(inserted).toHaveLength(2);
    const notification = inserted.find((n) => n.recipientType === 'role') ?? inserted[0];
    const personal = inserted.find((n) => n.recipientType === 'user');
    expect(notification.notificationId).toBe('NTF-EXPR-AP-1-expiring-app');
    expect(notification.recipientId).toBe('safety_admin');
    expect(personal).toMatchObject({
      recipientId: 'worker.zhangwei',
      notificationId: 'NTF-EXPR-AP-1-expiring-user-worker.zhangwei-app',
    });
    expect(String(personal?.title)).toContain('（你发起的）');
    expect(notification.externalRef).toBe('AP-1');
    expect(String(notification.title)).toContain('即将失效');
    expect(String(notification.body)).toContain('剩余约 30 分钟');
    expect(String(notification.body)).toContain('EXO-1,EXO-2');
    expect(String(notification.body)).toContain('worker.zhangwei');
    expect(String(notification.body)).toContain('已消耗 1 个对象');
  });

  it('已过期且在 24 小时窗口内 → expired 提醒（写明已不可用、需重新申请）', async () => {
    const { service, inserted, updates } = createHarness([
      authorization({ expiresAt: '2026-09-12T06:00:00.000Z', expired: true, remainingMs: 0 }),
    ]);
    const result = await service.sweep(ACTOR, { now: NOW });
    expect(result).toMatchObject({ expired: 1, expiringSoon: 0, created: 2 });
    expect(String(inserted[0].title)).toContain('已失效');
    expect(String(inserted[0].body)).toContain('该授权已不可用');
    // NO-45a：失效 → 关闭"即将失效"催办提醒（它的前提已消失）；
    // 关闭范围必须是本审批的 expiring 桶（前缀限定），而不是整表。
    expect(updates).toHaveLength(2);
    expect(updates.every((u) => u.patch.resolution === 'approval_expired')).toBe(true);
    expect(updates.every((u) => u.patch.resolvedBy === 'system:expiry-sweep')).toBe(true);
    // 其中一次是 pending → resolved，另一次是已读行补痕（状态不动）
    expect(updates.some((u) => u.patch.status === 'resolved')).toBe(true);
    expect(updates.some((u) => !('status' in u.patch))).toBe(true);
  });

  it('离失效还远 → 不提醒（避免噪音）', async () => {
    const { service, inserted, updates } = createHarness([
      authorization({ expiresAt: '2026-09-13T08:00:00.000Z', remainingMs: 22 * 3_600_000 }),
    ]);
    expect(updates).toHaveLength(0);
    const result = await service.sweep(ACTOR, { now: NOW });
    expect(result).toMatchObject({ scanned: 1, expiringSoon: 0, expired: 0, created: 0 });
    expect(inserted).toHaveLength(0);
  });

  it('过期超过 24 小时 → 不再提醒（否则变成永久噪音）', async () => {
    const { service, inserted } = createHarness([
      authorization({
        expiresAt: new Date(NOW.getTime() - EXPIRY_RETENTION_MS - 60_000).toISOString(),
        expired: true,
        remainingMs: 0,
      }),
    ]);
    const result = await service.sweep(ACTOR, { now: NOW });
    expect(result).toMatchObject({ expired: 0, created: 0 });
    expect(inserted).toHaveLength(0);
  });

  it('待批 / 未通过的授权不参与（没有"到期"可言）', async () => {
    const { service, created } = {
      ...createHarness([
        authorization({ status: 'pending', expiresAt: null, approvedAt: null, remainingMs: null }),
        authorization({ approvalId: 'AP-2', status: 'rejected', expiresAt: null, approvedAt: null, remainingMs: null }),
      ]),
      created: 0,
    };
    const result = await service.sweep(ACTOR, { now: NOW });
    expect(result).toMatchObject({ scanned: 2, expiringSoon: 0, expired: 0, created: 0 });
  });

  it('幂等：重复扫描只增加 duplicates，不重复提醒（确定性 id + ON CONFLICT）', async () => {
    const harness = createHarness([authorization()]);
    const first = await harness.service.sweep(ACTOR, { now: NOW });
    // 模拟唯一约束生效：第二次插入相同 id 返回空
    harness.existingIds.add('NTF-EXPR-AP-1-expiring-app');
    harness.existingIds.add('NTF-EXPR-AP-1-expiring-user-worker.zhangwei-app');
    const second = await harness.service.sweep(ACTOR, { now: NOW });

    expect(first).toMatchObject({ created: 2, duplicates: 0 });
    // 第二次：两条（角色 + 本人）都已被唯一约束挡住 → 全部计为 duplicates
    expect(second).toMatchObject({ created: 0, duplicates: 2 });
    expect(harness.inserted).toHaveLength(4);
    // 同一条通知（角色渠道）id 稳定：重复扫描不会生成第二个 id
    expect(harness.inserted[0].notificationId).toBe(harness.inserted[2].notificationId);
  });

  it('窗口常量：2 小时提醒、24 小时过期保留（防止被悄悄改小/改大）', () => {
    expect(EXPIRY_WARN_WINDOW_MS).toBe(2 * 60 * 60 * 1000);
    expect(EXPIRY_RETENTION_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('控制类授权同样参与到期提醒（NO-31a：授权视图纳入 control_request）', async () => {
    const { service, inserted } = createHarness([
      authorization({
        approvalId: 'AP-CTL',
        entityType: 'control_request',
        entityId: 'ctl-1',
        subject: undefined,
      }),
    ]);
    const result = await service.sweep(ACTOR, { now: NOW });
    expect(result).toMatchObject({ scanned: 1, expiringSoon: 1, created: 2 });
    expect(inserted[0].notificationId).toBe('NTF-EXPR-AP-CTL-expiring-app');
    // 没有对象描述符时范围如实写"范围未记录"（不编能力名）
    expect(String(inserted[0].body)).toContain('范围未记录');
  });

  it('listOrgsWithRecentApprovalInstances：只回非空 org_id（跨租户列出租户是 worker 的职责边界）', async () => {
    const db = {
      execute: jest.fn().mockResolvedValue([
        { org_id: ORG },
        { org_id: '22222222-2222-4222-8222-222222222222' },
        { org_id: null },
        { org_id: '  ' },
      ]),
    };
    const service = new ApprovalExpiryService(db as never, {} as never);
    await expect(service.listOrgsWithRecentApprovalInstances()).resolves.toEqual([
      ORG, '22222222-2222-4222-8222-222222222222',
    ]);
  });

  // V207：worker 的 tick **必须自己建立数据库上下文**。`ewoh_event` 开着 RLS，无上下文时
  // 跨租户列举一律返回 0 行（不报错），于是"到点自己扫"这条恢复路径可以长期什么都不做而日志一片干净。
  // 下面两支钉的是同一件事的两面：列租户要在全局管理员上下文里、逐租户扫描要各开一个带该租户 org 的上下文。
  it('worker.tick：列租户走全局管理员事务，逐租户 sweep 各开一个带 app.current_org_id 的事务', async () => {
    const contexts: Array<{ kind: string; org: string }> = [];
    const swept: string[] = [];
    const dbCtx = {
      systemGlobalAdminTransaction: async (op: () => Promise<string[]>) => {
        contexts.push({ kind: 'global', org: '' });
        return op();
      },
      runInTransaction: async (settings: Array<{ name: string; value: string }>, op: () => Promise<unknown>) => {
        const org = settings.find((s) => s.name === 'app.current_org_id')?.value ?? '';
        contexts.push({ kind: 'per-org', org });
        // 极性对照：没有该租户的 GUC 就不许扫——放开这一条，本用例必须红。
        if (!org) throw new Error('per-org 事务缺 app.current_org_id ⇒ RLS 下必然读不到行');
        return op();
      },
    };
    const service = {
      listOrgsWithRecentApprovalInstances: async () => [ORG, '22222222-2222-4222-8222-222222222222'],
      sweep: async (actor: { primaryOrgId: string }) => {
        swept.push(actor.primaryOrgId);
        if (actor.primaryOrgId.startsWith('2222')) throw new Error('db down');
        return { created: 2, duplicates: 0, resolved: 0, scanned: 1 };
      },
    };
    const worker = new ApprovalExpiryWorkerService(service as never, dbCtx as never);
    await worker.tick();
    expect(contexts.filter((c) => c.kind === 'global')).toHaveLength(1);
    expect(contexts.filter((c) => c.kind === 'per-org').map((c) => c.org)).toEqual([ORG, '22222222-2222-4222-8222-222222222222']);
    // 单租户失败不中断其它租户（两个租户都要被扫过）
    expect(swept).toEqual([ORG, '22222222-2222-4222-8222-222222222222']);
  });

  it('worker.tick：列租户本身失败 ⇒ 不外抛（worker 不许被一次异常带走），且不得退化成"无上下文直接扫"', async () => {
    let swept = 0;
    const dbCtx = {
      systemGlobalAdminTransaction: async () => { throw new Error('listing down'); },
      runInTransaction: async () => { swept += 1; return null; },
    };
    const service = {
      listOrgsWithRecentApprovalInstances: async () => [ORG],
      sweep: async () => { swept += 1; return { created: 0 }; },
    };
    const worker = new ApprovalExpiryWorkerService(service as never, dbCtx as never);
    await expect(worker.tick()).resolves.toBeUndefined();
    expect(swept).toBe(0);
  });
});
