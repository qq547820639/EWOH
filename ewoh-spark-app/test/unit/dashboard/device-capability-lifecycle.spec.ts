/* 设备能力生命周期（人工停用/恢复）单元测试 —— NO-15a。
 *
 * 为什么必须有人工通道（2026-09-11 审计）：摄入声明路径刻意不复活被人工停用的能力
 * （`ON CONFLICT` 不覆盖 status），但此前**没有任何 API 能设置 status**——
 * 保护不可达、能力台账只有自动写入口；而能力直接决定派工资格
 * （`requiredDeviceCapabilities ⊆ capabilities`），误声明只能改库。
 *
 * 本测试钉死 Service 承诺的每一条语义：
 *   1. 未知状态 / 空理由 → 400（不猜、不静默）；
 *   2. 跨租户 / 不存在 → 404（不泄露存在性）；
 *   3. 幂等：状态相同 → changed=false，不写库、不记审计；
 *   4. 停用：写 effective_to + 台账留痕 + 审计（before/after/理由）；
 *   5. 恢复：按权威契约重新校验；词表外能力名 → 409 拒绝恢复；
 *   6. 恢复时历史脏字段（kind/capabilityId）按词表自愈并如实列出；
 *   7. 审计写入失败 → 抛错（不静默成功）。
 */
/// <reference types="jest" />
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  DashboardService,
  parseCapabilityLifecycle,
} from '@server/modules/dashboard/dashboard.service';
import { DashboardModule } from '@server/modules/dashboard/dashboard.module';
import { ApprovalModule } from '@server/modules/approval/approval.module';
import { ewohDevice, ewohDeviceCapability } from '@server/database/schema';

const ORG = '11111111-1111-4111-8111-111111111111';
const CAP_ID = 'cap:device:ENV-1:observe.temperature';

/** 台账行（可覆盖任意列）。 */
function ledgerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    orgId: ORG,
    capabilityId: CAP_ID,
    deviceId: 'ENV-1',
    capabilityType: 'device_capability',
    capabilityKey: 'observe.temperature',
    capabilityValue: {
      mode: 'observation',
      label: '环境温度',
      fields: ['temperature'],
      subject: 'device:ENV-1',
      providerType: 'device',
      evidence: ['temperature'],
    },
    compatible: true,
    version: 1,
    status: 'active',
    effectiveFrom: new Date('2026-09-10T00:00:00.000Z'),
    effectiveTo: null,
    createdAt: new Date('2026-09-10T00:00:00.000Z'),
    updatedAt: new Date('2026-09-10T00:00:00.000Z'),
    ...overrides,
  };
}

function createHarness(opts: {
  row?: Record<string, unknown> | null;
  updateReturns?: unknown[] | null;
  auditFails?: boolean;
  actor?: Record<string, unknown>;
  /** 设备行（物化路径用：判断该能力是否经由列/型号生效）。 */
  device?: Record<string, unknown> | null;
  insertReturns?: unknown[] | null;
  /** NO-21a：审批服务替身（恢复高风险能力需审批）。 */
  approval?: unknown;
} = {}) {
  const selects: unknown[] = [];
  const updates: Array<{ values: Record<string, unknown> }> = [];
  const audits: Array<Record<string, unknown>> = [];
  const row = opts.row === undefined ? ledgerRow() : opts.row;

  const inserted: Array<Record<string, unknown>> = [];
  const deviceRow = opts.device === undefined ? null : opts.device;
  const db = {
    insert: jest.fn(() => ({
      values: jest.fn((values: Record<string, unknown>) => {
        inserted.push(values);
        return {
          returning: jest.fn().mockResolvedValue(
            opts.insertReturns === undefined
              ? [{ ...values, capabilityId: values.capabilityId }]
              : opts.insertReturns ?? [],
          ),
        };
      }),
    })),
    select: jest.fn(() => ({
      from: jest.fn((table: unknown) => ({
        where: jest.fn((cond: unknown) => {
          selects.push(cond);
          return {
            limit: jest.fn().mockResolvedValue(
              // 台账行 与 设备行 走同一 mock：以 from() 的表参数区分
              table === ewohDeviceCapability ? (row ? [row] : []) : (deviceRow ? [deviceRow] : []),
            ),
          };
        }),
      })),
    })),
    update: jest.fn(() => ({
      set: jest.fn((values: Record<string, unknown>) => {
        updates.push({ values });
        return {
          where: jest.fn(() => ({
            returning: jest.fn().mockResolvedValue(
              opts.updateReturns === undefined
                ? [{ ...(row ?? {}), ...values, capabilityId: CAP_ID }]
                : opts.updateReturns ?? [],
            ),
          })),
        };
      }),
    })),
  };
  const auditService = {
    appendAuditLog: jest.fn(async (entry: Record<string, unknown>) => {
      if (opts.auditFails) throw new Error('audit sink down');
      audits.push(entry);
    }),
  };
  // NO-22a：写路径变成事务（授权消耗与能力写入同事务）——mock 事务直接把同一个
  // db 对象交给回调，业务断言照旧看 updates/inserted；回滚语义由真实实现保证，
  // 单测另用"claim 被拒 → 不写库"钉住顺序。
  const dbWithTx = db as typeof db & { transaction: unknown };
  dbWithTx.transaction = jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(db));
  const svc = new DashboardService(db as never, auditService as never, (opts.approval ?? undefined) as never);
  return { svc, selects, updates, audits, auditService, db, inserted };
}

const ACTOR = { userId: 'u-1', primaryOrgId: ORG, roles: ['dispatcher'] };

describe('设备能力生命周期 · 参数校验', () => {
  it('未知状态 → 400（只允许 active/disabled，不猜）', async () => {
    const { svc } = createHarness();
    await expect(
      svc.setDeviceCapabilityStatus('ENV-1', 'observe.temperature', { status: 'paused' as never, reason: 'x' }, ACTOR as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('空理由 → 400（理由必须写入台账与审计）', async () => {
    const { svc } = createHarness();
    await expect(
      svc.setDeviceCapabilityStatus('ENV-1', 'observe.temperature', { status: 'disabled', reason: '   ' }, ACTOR as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('设备能力生命周期 · 定位与租户隔离', () => {
  it('找不到（或他租户）→ 404，不泄露存在性', async () => {
    const { svc } = createHarness({ row: null });
    await expect(
      svc.setDeviceCapabilityStatus('ENV-1', 'observe.temperature', { status: 'disabled', reason: '误声明' }, ACTOR as never),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('非 global_admin 且缺 org 上下文 → 400（fail-closed，不跨租户写）', async () => {
    const { svc } = createHarness();
    await expect(
      svc.setDeviceCapabilityStatus('ENV-1', 'observe.temperature', { status: 'disabled', reason: 'x' }, { userId: 'u-1', roles: ['dispatcher'] } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('设备能力生命周期 · 幂等', () => {
  it('状态相同 → changed=false，不写库、不记审计', async () => {
    const { svc, updates, audits } = createHarness({ row: ledgerRow({ status: 'disabled' }) });
    const res = await svc.setDeviceCapabilityStatus(
      'ENV-1',
      'observe.temperature',
      { status: 'disabled', reason: '重复点击' },
      ACTOR as never,
    );
    expect(res.changed).toBe(false);
    expect(res.status).toBe('disabled');
    expect(updates).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });
});

describe('设备能力生命周期 · 停用', () => {
  it('停用写 status/effective_to + 留痕 + 审计（含 before/after 与理由）', async () => {
    const { svc, updates, audits } = createHarness();
    const res = await svc.setDeviceCapabilityStatus(
      'ENV-1',
      'observe.temperature',
      { status: 'disabled', reason: '该设备实际无温度传感器' },
      ACTOR as never,
    );
    expect(res.changed).toBe(true);
    expect(res.previousStatus).toBe('active');
    expect(res.effectiveTo).not.toBeNull();

    const set = updates[0].values;
    expect(set.status).toBe('disabled');
    expect(set.effectiveTo).toBeInstanceOf(Date);
    const lifecycle = (set.capabilityValue as Record<string, unknown>).lifecycle as Record<string, unknown>;
    expect(lifecycle).toMatchObject({
      action: 'disable',
      operator: 'u-1',
      reason: '该设备实际无温度传感器',
      previousStatus: 'active',
    });

    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'device.capability.disable',
      entityType: 'device_capability',
      entityId: CAP_ID,
      reason: '该设备实际无温度传感器',
      before: { status: 'active' },
      after: { status: 'disabled' },
    });
  });

  it('审计写入失败 → 抛错（绝不静默成功）', async () => {
    const { svc } = createHarness({ auditFails: true });
    await expect(
      svc.setDeviceCapabilityStatus('ENV-1', 'observe.temperature', { status: 'disabled', reason: 'x' }, ACTOR as never),
    ).rejects.toThrow('audit sink down');
  });
});

describe('设备能力生命周期 · 恢复（fail-closed）', () => {
  it('词表外能力名 → 409 拒绝恢复（无法按权威契约校验）', async () => {
    const { svc } = createHarness({
      row: ledgerRow({ status: 'disabled', capabilityKey: 'legacy.magic_sensor' }),
    });
    await expect(
      svc.setDeviceCapabilityStatus('ENV-1', 'legacy.magic_sensor', { status: 'active', reason: '恢复' }, ACTOR as never),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('恢复写 effective_from、清空 effective_to、留痕 action=restore + 审计', async () => {
    const { svc, updates, audits } = createHarness({ row: ledgerRow({ status: 'disabled' }) });
    const res = await svc.setDeviceCapabilityStatus(
      'ENV-1',
      'observe.temperature',
      { status: 'active', reason: '已加装温度传感器' },
      ACTOR as never,
    );
    expect(res.changed).toBe(true);
    expect(res.status).toBe('active');
    const set = updates[0].values;
    expect(set.status).toBe('active');
    expect(set.effectiveTo).toBeNull();
    expect(set.effectiveFrom).toBeInstanceOf(Date);
    expect((set.capabilityValue as Record<string, unknown>).lifecycle).toMatchObject({
      action: 'restore',
      operator: 'u-1',
    });
    expect(audits[0]).toMatchObject({ action: 'device.capability.restore', after: { status: 'active' } });
  });

  it('历史脏字段（kind/capabilityId 自造）按词表自愈并如实列出 repairedFields', async () => {
    const { svc, updates } = createHarness({
      row: ledgerRow({
        status: 'disabled',
        capabilityType: 'observation', // 历史自造 kind
        capabilityId: 'cap:device:env-1:observe.temperature', // 曾把设备号 toLowerCase
      }),
    });
    const res = await svc.setDeviceCapabilityStatus(
      'ENV-1',
      'observe.temperature',
      { status: 'active', reason: '恢复' },
      ACTOR as never,
    );
    expect(res.repairedFields).toEqual(expect.arrayContaining(['capabilityType', 'capabilityId']));
    const set = updates[0].values;
    expect(set.capabilityType).toBe('device_capability');
    expect(set.capabilityId).toBe('cap:device:ENV-1:observe.temperature');
  });
});

describe('设备能力生命周期 · 型号派生能力的首次停用（物化人工决定）', () => {
  /* 型号派生的执行能力（NyExo→exo-lift）此前**停不掉**（台账无行 → 404），
   * 而它恰恰决定派工资格。首次停用必须能把人工决定落地为台账行。 */
  it('无台账行但白名单声明 → 物化 disabled 行 + 审计 + changed=true', async () => {
    const { svc, inserted, audits, updates } = createHarness({
      row: null,
      device: { id: 'd-1', deviceId: 'EXO-9', capabilities: [], deviceModel: 'NyExo-A1 Pro', orgId: ORG },
    });
    const res = await svc.setDeviceCapabilityStatus(
      'EXO-9',
      'exo-lift',
      { status: 'disabled', reason: '助力模块待修' },
      ACTOR as never,
    );
    expect(res.changed).toBe(true);
    expect(res.status).toBe('disabled');
    expect(res.previousStatus).toBe('active');
    // 物化了台账行（status=disabled + 留痕 + 来源标注）
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ deviceId: 'EXO-9', capabilityKey: 'exo-lift', status: 'disabled' });
    expect((inserted[0].capabilityValue as Record<string, unknown>).materializedBy).toBe('human_disable');
    expect((inserted[0].capabilityValue as Record<string, unknown>).lifecycle).toMatchObject({
      action: 'disable',
      operator: 'u-1',
      reason: '助力模块待修',
    });
    // 物化路径不再重复 UPDATE，但**必须**审计
    expect(updates).toHaveLength(0);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'device.capability.disable',
      metadata: { materializedFromDeclaration: true },
    });
  });

  it('无台账行且列/白名单都未声明该能力 → 404（有的放矢，不凭空造能力）', async () => {
    const { svc, inserted } = createHarness({
      row: null,
      device: { id: 'd-1', deviceId: 'ENV-9', capabilities: [], deviceModel: null, orgId: ORG },
    });
    await expect(
      svc.setDeviceCapabilityStatus('ENV-9', 'exo-lift', { status: 'disabled', reason: 'x' }, ACTOR as never),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(inserted).toHaveLength(0);
  });

  it('无台账行时"恢复"无意义 → 409（该能力本就在生效集中）', async () => {
    const { svc } = createHarness({
      row: null,
      device: { id: 'd-1', deviceId: 'EXO-9', capabilities: [], deviceModel: 'NyExo-A1 Pro', orgId: ORG },
    });
    await expect(
      svc.setDeviceCapabilityStatus('EXO-9', 'exo-lift', { status: 'active', reason: 'x' }, ACTOR as never),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('NO-21a：恢复高风险能力需安全负责人审批（与任务侧同一口径）', () => {
  function approvedFor(capabilityKey: string, deviceIds: string[], overrides: Record<string, unknown> = {}) {
    return {
      getApproval: jest.fn().mockResolvedValue({
        id: 'AP-R1',
        entityType: 'device_capability_change',
        entityId: `capability:${capabilityKey}`,
        status: 'approved',
        steps: [{ id: 's1', role: 'safety_admin', status: 'approved' }],
        // NO-22a：高风险授权必须带通过时间（时效由 shared 校验）
        approvedAt: new Date().toISOString(),
        subject: {
          objectType: 'device_capability_change',
          objectId: `capability:${capabilityKey}`,
          title: `恢复高风险能力：${capabilityKey}`,
          summary: '…',
          metrics: { capabilityKey, deviceIds: [...deviceIds].sort().join(',') },
        },
        createdAt: new Date().toISOString(),
        ...overrides,
      }),
      claimUsage: jest.fn().mockResolvedValue({ claimed: true, usageEventId: 'approval_usage:x' }),
    };
  }
  const disabledExoLift = () =>
    ledgerRow({
      status: 'disabled',
      capabilityKey: 'exo-lift',
      capabilityId: 'cap:exo:EXO-9:exo-lift',
      capabilityType: 'exo_capability',
      capabilityValue: { mode: 'execution', label: '助力提升', fields: [], subject: 'exo:EXO-9', providerType: 'exo', evidence: [] },
    });

  it('恢复高风险能力（exo-lift）无审批 → 409 且给出可照做的审批请求', async () => {
    const { svc, updates } = createHarness({ row: disabledExoLift() });
    const error = await svc
      .setDeviceCapabilityStatus('EXO-9', 'exo-lift', { status: 'active', reason: '助力模块已检修' }, ACTOR as never)
      .catch((e) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(String(error.message)).toContain('HIGH_RISK_CAPABILITY_RESTORE_REQUIRES_APPROVAL');
    expect(String(error.message)).toContain('device_capability_change');
    expect(String(error.message)).toContain('capability:exo-lift');
    expect(String(error.message)).toContain('获批后带 approvalId 重新提交');
    expect(updates).toHaveLength(0);
  });

  it('带"获批且名单含本设备"的审批 → 放行，并把审批 id 写入审计与返回', async () => {
    const { svc, updates, audits } = createHarness({
      row: disabledExoLift(),
      approval: approvedFor('exo-lift', ['EXO-9', 'EXO-10']),
    });
    const res = await svc.setDeviceCapabilityStatus(
      'EXO-9',
      'exo-lift',
      { status: 'active', reason: '助力模块已检修', approvalId: 'AP-R1' },
      ACTOR as never,
    );
    expect(res.status).toBe('active');
    expect(res.approvalId).toBe('AP-R1');
    expect(updates[0].values.status).toBe('active');
    expect(audits[0].metadata).toMatchObject({ approvalId: 'AP-R1' });
  });

  it('设备不在获批名单内 / 审批未通过 → 409，不写库', async () => {
    const notListed = createHarness({
      row: disabledExoLift(),
      approval: approvedFor('exo-lift', ['EXO-10']),
    });
    await expect(
      notListed.svc.setDeviceCapabilityStatus(
        'EXO-9',
        'exo-lift',
        { status: 'active', reason: 'x', approvalId: 'AP-R1' },
        ACTOR as never,
      ),
    ).rejects.toThrow(/不在获批名单内/);
    expect(notListed.updates).toHaveLength(0);

    const pending = createHarness({
      row: disabledExoLift(),
      approval: approvedFor('exo-lift', ['EXO-9'], { status: 'pending' }),
    });
    await expect(
      pending.svc.setDeviceCapabilityStatus(
        'EXO-9',
        'exo-lift',
        { status: 'active', reason: 'x', approvalId: 'AP-R1' },
        ACTOR as never,
      ),
    ).rejects.toThrow(/APPROVAL_INVALID/);
    expect(pending.updates).toHaveLength(0);
  });

  it('停用高风险能力（收紧）不需要审批；低风险恢复也不需要', async () => {
    const disable = createHarness({
      row: ledgerRow({
        status: 'active',
        capabilityKey: 'exo-lift',
        capabilityType: 'exo_capability',
        capabilityValue: { mode: 'execution', subject: 'exo:EXO-9', providerType: 'exo', evidence: [] },
      }),
    });
    const disabled = await disable.svc.setDeviceCapabilityStatus(
      'EXO-9',
      'exo-lift',
      { status: 'disabled', reason: '检修中' },
      ACTOR as never,
    );
    expect(disabled.status).toBe('disabled');

    const lowRisk = createHarness({
      row: ledgerRow({
        status: 'disabled',
        capabilityKey: 'observe.temperature',
        capabilityId: 'cap:device:ENV-9:observe.temperature',
        capabilityValue: { mode: 'observation', label: '环境温度', fields: ['temperature'], subject: 'device:ENV-9', providerType: 'device', evidence: ['temperature'] },
      }),
    });
    const restored = await lowRisk.svc.setDeviceCapabilityStatus(
      'ENV-1',
      'observe.temperature',
      { status: 'active', reason: '传感器已更换' },
      ACTOR as never,
    );
    expect(restored.status).toBe('active');
    expect(restored.approvalId).toBeUndefined();
  });
  it('未装配审批服务时 → 503 APPROVAL_PORT_UNAVAILABLE（不谎报审批不存在）', async () => {
    // 回归（2026-09-12 实测）：DashboardModule 曾漏 import ApprovalModule，
    // @Optional() 静默注入 undefined，导致"审批真实存在且已通过"也被判成
    // APPROVAL_INVALID；运维会去排查一张其实存在的审批单。
    const { svc, updates } = createHarness({ row: disabledExoLift() });
    const error = await svc
      .setDeviceCapabilityStatus(
        'EXO-9',
        'exo-lift',
        { status: 'active', reason: 'x', approvalId: 'AP-R1' },
        ACTOR as never,
      )
      .catch((e) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(String(error.message)).toContain('APPROVAL_PORT_UNAVAILABLE');
    expect(String(error.message)).not.toContain('APPROVAL_INVALID');
    expect(updates).toHaveLength(0);
  });

  it('DashboardModule 显式 import ApprovalModule（防止再次静默降级）', () => {
    const imports = (Reflect.getMetadata('imports', DashboardModule) ?? []) as unknown[];
    expect(imports).toContain(ApprovalModule);
  });

  // ── NO-22a：授权时效与消耗 ──────────────────────────────────────────────
  it('审批通过超过 24 小时 → 409 且说明"现场条件可能已变化"，不写库', async () => {
    const stale = createHarness({
      row: disabledExoLift(),
      approval: approvedFor('exo-lift', ['EXO-9'], {
        approvedAt: new Date(Date.now() - 25 * 3_600_000).toISOString(),
      }),
    });
    const error = await stale.svc
      .setDeviceCapabilityStatus(
        'EXO-9',
        'exo-lift',
        { status: 'active', reason: 'x', approvalId: 'AP-R1' },
        ACTOR as never,
      )
      .catch((e) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(String(error.message)).toContain('超出有效期');
    expect(stale.updates).toHaveLength(0);
  });

  it('审批缺少通过时间 → 409（无法判断时效的凭证不得当有效凭证）', async () => {
    const noTime = createHarness({
      row: disabledExoLift(),
      approval: approvedFor('exo-lift', ['EXO-9'], { approvedAt: undefined }),
    });
    await expect(
      noTime.svc.setDeviceCapabilityStatus(
        'EXO-9',
        'exo-lift',
        { status: 'active', reason: 'x', approvalId: 'AP-R1' },
        ACTOR as never,
      ),
    ).rejects.toThrow(/缺少通过时间/);
    expect(noTime.updates).toHaveLength(0);
  });

  it('审批已用于本设备的这次恢复 → 409 APPROVAL_ALREADY_CONSUMED（并说明谁在何时用过）', async () => {
    const approval = approvedFor('exo-lift', ['EXO-9']);
    (approval.claimUsage as jest.Mock).mockResolvedValue({
      claimed: false,
      usageEventId: 'approval_usage:AP-R1:capability:exo-lift|device:EXO-9',
      existing: { usedBy: 'admin', at: '2026-09-11T09:00:00.000Z', note: '上次检修恢复' },
    });
    const consumed = createHarness({ row: disabledExoLift(), approval });
    const error = await consumed.svc
      .setDeviceCapabilityStatus(
        'EXO-9',
        'exo-lift',
        { status: 'active', reason: 'x', approvalId: 'AP-R1' },
        ACTOR as never,
      )
      .catch((e) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(String(error.message)).toContain('APPROVAL_ALREADY_CONSUMED');
    expect(String(error.message)).toContain('admin');
    expect(String(error.message)).toContain('重新申请审批');
    // 消耗键必须带上本次设备（批量审批按台消耗）
    expect(approval.claimUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: 'AP-R1',
        usageKey: 'capability:exo-lift|device:EXO-9',
        usedBy: 'u-1',
      }),
      expect.anything(),
    );
    // 未写库：消耗被拒时能力状态保持不变
    expect(consumed.updates).toHaveLength(0);
  });

  it('已生效的重复请求 → no-op 先于闸门（不消耗审批额度，不报 409）', async () => {
    const approval = approvedFor('exo-lift', ['EXO-9']);
    const active = createHarness({
      row: ledgerRow({
        status: 'active',
        capabilityKey: 'exo-lift',
        capabilityType: 'exo_capability',
        capabilityValue: { mode: 'execution', subject: 'exo:EXO-9', providerType: 'exo', evidence: [] },
      }),
      approval,
    });
    const res = await active.svc.setDeviceCapabilityStatus(
      'EXO-9',
      'exo-lift',
      { status: 'active', reason: '重复点击', approvalId: 'AP-R1' },
      ACTOR as never,
    );
    expect(res.changed).toBe(false);
    expect(approval.claimUsage).not.toHaveBeenCalled();
    expect(active.updates).toHaveLength(0);
  });

  it('放行时把审批通过/失效时间写入审计（事后可核对是否在时效内）', async () => {
    const approval = approvedFor('exo-lift', ['EXO-9']);
    const harness = createHarness({ row: disabledExoLift(), approval });
    await harness.svc.setDeviceCapabilityStatus(
      'EXO-9',
      'exo-lift',
      { status: 'active', reason: '检修完成', approvalId: 'AP-R1' },
      ACTOR as never,
    );
    const approvedAt = (await (approval.getApproval as jest.Mock).mock.results[0].value).approvedAt as string;
    expect(harness.audits[0].metadata).toMatchObject({
      approvalId: 'AP-R1',
      approvalApprovedAt: approvedAt,
    });
    expect(String((harness.audits[0].metadata as Record<string, unknown>).approvalExpiresAt)).toBe(
      new Date(Date.parse(approvedAt) + 24 * 3_600_000).toISOString(),
    );
  });
});

describe('capability_value.lifecycle 解析（fail-honest）', () => {
  it('形状完整 → 原样返回', () => {
    expect(
      parseCapabilityLifecycle({
        action: 'disable',
        operator: 'u-1',
        reason: '误声明',
        at: '2026-09-11T00:00:00.000Z',
        previousStatus: 'active',
      }),
    ).toEqual({
      action: 'disable',
      operator: 'u-1',
      reason: '误声明',
      at: '2026-09-11T00:00:00.000Z',
      previousStatus: 'active',
    });
  });

  it('缺字段/脏 JSON → null（不半截渲染成"已人工确认"）', () => {
    expect(parseCapabilityLifecycle(null)).toBeNull();
    expect(parseCapabilityLifecycle({ action: 'disable' })).toBeNull();
    expect(parseCapabilityLifecycle({ action: 'nope', operator: 'u', reason: 'r', at: 't' })).toBeNull();
    expect(parseCapabilityLifecycle('not-an-object')).toBeNull();
  });
});
