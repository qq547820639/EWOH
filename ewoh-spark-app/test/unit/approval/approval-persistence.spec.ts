/* 审批持久化服务：时效投影与授权消耗（NO-22a）。
 *
 * 为什么单测这两件事：
 *   1. `approvedAt` / `decidedAt` 是高风险执行边界授权的**时效依据**——投影错一天，
 *      闸门就会放行过期凭证或拒绝有效凭证，属于安全语义而不是展示细节；
 *   2. `claimUsage` 的"一次授权只能用一次"必须由**数据库唯一约束**保证（不是先查后写），
 *      所以这里钉死：插入用 ON CONFLICT DO NOTHING、冲突时回读原始消耗记录如实回报，
 *      以及键形状非法时显式报错（不静默写一条错键的消耗记录）。
 */
/// <reference types="jest" />
import { BadRequestException } from '@nestjs/common';
import { ApprovalPersistenceService } from '@server/modules/approval/approval-persistence.service';
import { CAPABILITY_APPROVAL_VALIDITY_MS } from '@shared/capability-requirements';
import { ewohEvent, ewohEventChain } from '@server/database/schema';

const INSTANCE_ID = 'AP-1';
const ORG = '11111111-1111-4111-8111-111111111111';

interface MockOptions {
  /**
   * ewoh_event 的 select 结果队列（按调用顺序出队）。
   * 单项 = 单行结果；数组 = 多行结果（授权视图会一次取多行）。
   * 第 1 个给实例行，第 2 个给消耗记录回读。
   */
  eventSelects?: Array<Record<string, unknown> | null | Array<Record<string, unknown>>>;
  chainRows?: Array<Record<string, unknown>>;
  /** insert(...).returning() 的结果（空数组 = 唯一约束冲突被 DO NOTHING 吞掉）。 */
  insertReturns?: Array<Record<string, unknown>>;
}

function createDbMock(opts: MockOptions = {}) {
  const eventQueue = [...(opts.eventSelects ?? [])];
  const insertValues: Array<Record<string, unknown>> = [];
  const conflictTargets: unknown[] = [];

  const buildSelect = () => ({
    from: jest.fn((table: unknown) => ({
      where: jest.fn(() => {
        if (table === ewohEventChain) {
          return {
            orderBy: jest.fn().mockResolvedValue(opts.chainRows ?? []),
            limit: jest.fn().mockResolvedValue(opts.chainRows ?? []),
          };
        }
        const next = eventQueue.length > 0 ? eventQueue.shift() : null;
        const rows = Array.isArray(next) ? next : next ? [next] : [];
        return {
          limit: jest.fn().mockResolvedValue(rows),
          orderBy: jest.fn(() => ({
            limit: jest.fn().mockResolvedValue(rows),
            then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
          })),
          // getApproval 直接 await where(...)（没有 .limit()）：必须 thenable
          then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
        };
      }),
    })),
  });

  const db = {
    select: jest.fn(() => buildSelect()),
    insert: jest.fn(() => ({
      values: jest.fn((values: Record<string, unknown>) => {
        insertValues.push(values);
        return {
          onConflictDoNothing: jest.fn((target: unknown) => {
            conflictTargets.push(target);
            return {
              returning: jest.fn().mockResolvedValue(opts.insertReturns ?? [{ eventId: values.eventId }]),
            };
          }),
          returning: jest.fn().mockResolvedValue(opts.insertReturns ?? [{ eventId: values.eventId }]),
        };
      }),
    })),
    transaction: jest.fn(),
  };
  return { db, insertValues, conflictTargets };
}

const auditMock = { appendAuditLog: jest.fn(async () => undefined) };

describe('审批时间投影（NO-22a）', () => {
  it('已通过的实例带 approvedAt；步骤带 decidedAt', async () => {
    const { db } = createDbMock({
      eventSelects: [
        {
          eventId: INSTANCE_ID,
          eventType: 'approval_instance',
          title: 't',
          status: 'approved',
          createdAt: new Date('2026-09-11T08:00:00.000Z'),
          updatedAt: new Date('2026-09-11T09:30:00.000Z'),
          orgId: ORG,
          evidenceJson: { entityType: 'device_capability_change', entityId: 'capability:exo-lift' },
        },
      ],
      chainRows: [
        {
          eventId: 'step-1',
          description: JSON.stringify({ role: 'safety_admin', status: 'approved', reason: 'ok' }),
          updatedAt: new Date('2026-09-11T09:30:00.000Z'),
        },
      ],
    });
    const service = new ApprovalPersistenceService(db as never, auditMock as never);

    const instance = await service.getApproval(INSTANCE_ID, {
      userId: 'u-1',
      primaryOrgId: ORG,
      roles: ['global_admin'],
    } as never);

    expect(instance.approvedAt).toBe('2026-09-11T09:30:00.000Z');
    expect(instance.steps[0]).toMatchObject({
      id: 'step-1',
      status: 'approved',
      decidedAt: '2026-09-11T09:30:00.000Z',
    });
  });

  it('未通过的实例不得暴露 approvedAt（没有"通过时间"这回事）', async () => {
    const { db } = createDbMock({
      eventSelects: [
        {
          eventId: INSTANCE_ID,
          eventType: 'approval_instance',
          title: 't',
          status: 'pending',
          createdAt: new Date('2026-09-11T08:00:00.000Z'),
          updatedAt: new Date('2026-09-11T08:05:00.000Z'),
          orgId: ORG,
          evidenceJson: { entityType: 'device_capability_change', entityId: 'capability:exo-lift' },
        },
      ],
      chainRows: [
        {
          eventId: 'step-1',
          description: JSON.stringify({ role: 'safety_admin', status: 'pending' }),
          updatedAt: new Date('2026-09-11T08:05:00.000Z'),
        },
      ],
    });
    const service = new ApprovalPersistenceService(db as never, auditMock as never);

    const instance = await service.getApproval(INSTANCE_ID, {
      userId: 'u-1',
      primaryOrgId: ORG,
      roles: ['global_admin'],
    } as never);

    expect(instance.approvedAt).toBeUndefined();
    expect(instance.status).toBe('pending');
  });
});

describe('授权消耗 claimUsage（NO-22a）', () => {
  it('首次消耗 → claimed=true，写入确定键的 approval_usage 事件行', async () => {
    const { db, insertValues, conflictTargets } = createDbMock();
    const service = new ApprovalPersistenceService(db as never, auditMock as never);

    const result = await service.claimUsage({
      approvalId: INSTANCE_ID,
      usageKey: 'capability:exo-lift|device:EXO-1',
      usedBy: 'admin',
      note: '检修完成',
      orgId: ORG,
      entityType: 'device_capability_change',
      entityId: 'capability:exo-lift',
      deviceId: 'EXO-1',
      at: new Date('2026-09-11T10:00:00.000Z'),
    });

    expect(result.claimed).toBe(true);
    // 键形状 = 审批号 + 消耗键：唯一约束由 event_id 提供，不靠"先查后写"
    expect(insertValues[0].eventId).toBe('approval_usage:AP-1:capability:exo-lift|device:EXO-1');
    expect(insertValues[0]).toMatchObject({
      eventType: 'approval_usage',
      status: 'consumed',
      deviceId: 'EXO-1',
      causationId: INSTANCE_ID,
      orgId: ORG,
    });
    expect(insertValues[0].evidenceJson).toMatchObject({
      approvalId: INSTANCE_ID,
      usageKey: 'capability:exo-lift|device:EXO-1',
      usedBy: 'admin',
      note: '检修完成',
    });
    // 冲突处理必须显式声明目标列（否则并发下会静默插入重复消耗）
    expect(conflictTargets).toHaveLength(1);
  });

  it('重复消耗 → claimed=false，并回读"谁在何时用过"（不覆盖、不猜测）', async () => {
    const { db } = createDbMock({
      insertReturns: [],
      eventSelects: [
        {
          evidenceJson: {
            usedBy: 'worker.li',
            at: '2026-09-11T09:00:00.000Z',
            note: '上一次检修',
          },
        },
      ],
    });
    const service = new ApprovalPersistenceService(db as never, auditMock as never);

    const result = await service.claimUsage({
      approvalId: INSTANCE_ID,
      usageKey: 'capability:exo-lift|device:EXO-1',
      usedBy: 'admin',
      orgId: ORG,
    });

    expect(result.claimed).toBe(false);
    expect(result.existing).toEqual({
      usedBy: 'worker.li',
      at: '2026-09-11T09:00:00.000Z',
      note: '上一次检修',
    });
  });

  it('缺 org 上下文时不回读消耗记录（不做跨租户按键查询，如实说"未记录"）', async () => {
    const { db } = createDbMock({
      insertReturns: [],
      eventSelects: [{ evidenceJson: { usedBy: 'other-tenant-user', at: '2026-09-11T09:00:00.000Z' } }],
    });
    const service = new ApprovalPersistenceService(db as never, auditMock as never);

    const result = await service.claimUsage({
      approvalId: INSTANCE_ID,
      usageKey: 'capability:exo-lift|device:EXO-1',
      usedBy: 'admin',
    });

    expect(result.claimed).toBe(false);
    expect(result.existing?.usedBy).toBe('未知操作人');
    // 未带 org 时**不应**发起回读（宁可如实说未记录，也不做跨租户按键查询）
    expect((db.select as jest.Mock).mock.calls).toHaveLength(0);
  });

  it('键缺失 / 键过长 → 400（不静默写一条无法对账的消耗记录）', async () => {
    const { db } = createDbMock();
    const service = new ApprovalPersistenceService(db as never, auditMock as never);

    await expect(service.claimUsage({ approvalId: '', usageKey: 'x', usedBy: 'a' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.claimUsage({ approvalId: 'AP-1', usageKey: '  ', usedBy: 'a' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      service.claimUsage({ approvalId: 'AP-1', usageKey: 'd'.repeat(260), usedBy: 'a' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('传入事务连接时用事务写消耗（与业务写入同生共死）', async () => {
    const { db } = createDbMock();
    const tx = createDbMock();
    const service = new ApprovalPersistenceService(db as never, auditMock as never);

    const result = await service.claimUsage(
      { approvalId: 'AP-1', usageKey: 'task:T-1', usedBy: 'u-1' },
      tx.db as never,
    );

    expect(result.claimed).toBe(true);
    expect(tx.insertValues).toHaveLength(1);
    // 主连接不得被使用（否则事务回滚时消耗记录会残留 → 白烧一次授权）
    expect((db.insert as jest.Mock).mock.calls).toHaveLength(0);
  });

  // ── NO-24a：执行边界授权视图 ─────────────────────────────────────────────
  describe('执行边界授权视图 listCapabilityAuthorizations', () => {
    const ORG = '11111111-1111-4111-8111-111111111111';
    const instanceRow = (overrides: Record<string, unknown> = {}) => ({
      eventId: 'AP-1',
      eventType: 'approval_instance',
      title: 't',
      status: 'approved',
      createdAt: new Date(Date.now() - 3 * 3_600_000),
      updatedAt: new Date(Date.now() - 2 * 3_600_000),
      orgId: ORG,
      evidenceJson: {
        entityType: 'device_capability_change',
        entityId: 'capability:exo-lift',
        subject: {
          objectType: 'device_capability_change',
          objectId: 'capability:exo-lift',
          title: '恢复高风险能力：exo-lift',
          summary: '…',
          metrics: { capabilityKey: 'exo-lift', deviceIds: 'EXO-1,EXO-2' },
        },
      },
      ...overrides,
    });
    const usageRow = (overrides: Record<string, unknown> = {}) => ({
      eventId: 'approval_usage:AP-1:capability:exo-lift|device:EXO-1',
      eventType: 'approval_usage',
      causationId: 'AP-1',
      createdAt: new Date(Date.now() - 1 * 3_600_000),
      orgId: ORG,
      evidenceJson: {
        approvalId: 'AP-1',
        usageKey: 'capability:exo-lift|device:EXO-1',
        usedBy: 'admin',
        at: new Date(Date.now() - 1 * 3_600_000).toISOString(),
        note: '检修完成',
      },
      ...overrides,
    });

    it('通过中的授权带通过/失效时间与剩余毫秒（只有 approved 才有通过时间）', async () => {
      const { db } = createDbMock({ eventSelects: [[instanceRow()], []] });
      const service = new ApprovalPersistenceService(db as never, auditMock as never);

      const [item] = await service.listCapabilityAuthorizations(ORG);

      expect(item.approvalId).toBe('AP-1');
      expect(item.status).toBe('approved');
      expect(item.expired).toBe(false);
      expect(item.approvedAt).toBeTruthy();
      // 失效时间 = 通过时间 + 24 小时（与闸门同一常量）
      expect(Date.parse(String(item.expiresAt)) - Date.parse(String(item.approvedAt))).toBe(
        CAPABILITY_APPROVAL_VALIDITY_MS,
      );
      expect(item.remainingMs).toBeGreaterThan(0);
      expect(item.usage).toEqual([]);
    });

    it('超过 24 小时的授权标记 expired（界面据此显示"不可用"）', async () => {
      const { db } = createDbMock({
        eventSelects: [[instanceRow({ updatedAt: new Date(Date.now() - 30 * 3_600_000) })], []],
      });
      const service = new ApprovalPersistenceService(db as never, auditMock as never);

      const [item] = await service.listCapabilityAuthorizations(ORG);
      expect(item.expired).toBe(true);
      expect(item.remainingMs).toBe(0);
    });

    it('未通过的审批没有"通过时间/失效时间"（不伪造时效）', async () => {
      const { db } = createDbMock({ eventSelects: [[instanceRow({ status: 'pending' })], []] });
      const service = new ApprovalPersistenceService(db as never, auditMock as never);

      const [item] = await service.listCapabilityAuthorizations(ORG);
      expect(item.approvedAt).toBeNull();
      expect(item.expiresAt).toBeNull();
      expect(item.remainingMs).toBeNull();
      expect(item.expired).toBe(false);
    });

    it('消耗记录按审批号归组（谁/何时/备注），并如实保留未记录的字段', async () => {
      const { db } = createDbMock({
        eventSelects: [
          [instanceRow()],
          [
            usageRow(),
            usageRow({
              eventId: 'approval_usage:AP-1:capability:exo-lift|device:EXO-2',
              evidenceJson: { approvalId: 'AP-1', usageKey: 'capability:exo-lift|device:EXO-2' },
            }),
          ],
        ],
      });
      const service = new ApprovalPersistenceService(db as never, auditMock as never);

      const [item] = await service.listCapabilityAuthorizations(ORG);
      expect(item.usage).toHaveLength(2);
      expect(item.usage[0]).toMatchObject({
        usageKey: 'capability:exo-lift|device:EXO-1',
        usedBy: 'admin',
        note: '检修完成',
      });
      // 缺失字段如实留空，不编造操作人/时间
      expect(item.usage[1]).toMatchObject({ usedBy: '未知操作人', at: null, note: null });
    });

    it('排序：有效且最快过期优先，其次已过期，最后待批/终态', async () => {
      const soon = instanceRow({
        eventId: 'AP-SOON',
        updatedAt: new Date(Date.now() - 23 * 3_600_000),
      });
      const fresh = instanceRow({ eventId: 'AP-FRESH', updatedAt: new Date() });
      const expired = instanceRow({
        eventId: 'AP-EXPIRED',
        updatedAt: new Date(Date.now() - 40 * 3_600_000),
      });
      const pending = instanceRow({ eventId: 'AP-PENDING', status: 'pending' });
      const { db } = createDbMock({ eventSelects: [[pending, expired, fresh, soon], []] });
      const service = new ApprovalPersistenceService(db as never, auditMock as never);

      const items = await service.listCapabilityAuthorizations(ORG);
      expect(items.map((i) => i.approvalId)).toEqual(['AP-SOON', 'AP-FRESH', 'AP-EXPIRED', 'AP-PENDING']);
    });

    it('缺租户上下文 → 400（授权视图不接受全局查询）', async () => {
      const { db } = createDbMock();
      const service = new ApprovalPersistenceService(db as never, auditMock as never);
      await expect(service.listCapabilityAuthorizations('')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('无授权记录 → 空数组（不是 null/报错）', async () => {
      const { db } = createDbMock({ eventSelects: [[]] });
      const service = new ApprovalPersistenceService(db as never, auditMock as never);
      await expect(service.listCapabilityAuthorizations(ORG)).resolves.toEqual([]);
    });
  });
});
