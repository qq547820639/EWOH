/* 任务能力要求的写路径（NO-16a）。
 *
 * 为什么需要：`ewoh_production_task.required_device_capabilities` /
 * `required_station_capabilities` 此前**没有任何 API 写入口**（只有种子/直连库），
 * 于是"能力模型"在真实作业里用不起来——调度按能力要求匹配，但没人能把要求写进任务。
 *
 * 本测试钉死新写路径的每条语义：
 *   1. 形状非法（非数组/非字符串/超长/超量）→ 400（不猜、不截断）；
 *   2. 规范化：去空白、去空项、按首次出现顺序去重；
 *   3. 未登记/当前无法匹配的能力名**允许写入**，但必须显式提示（不静默）；
 *   4. 工位能力提示按"本租户工位实际声明过的能力"核对（不猜固定词表）；
 *   5. 变更留审计（before/after）并触发 TASK_UPDATED（旧方案按旧要求算的）；
 *   6. 租户隔离：找不到任务 → 404。
 */
/// <reference types="jest" />
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { TaskService } from '@server/modules/task/task.service';

interface HarnessOptions {
  existing?: Record<string, unknown> | null;
  inserted?: Record<string, unknown> | null;
  updated?: Record<string, unknown> | null;
  stationEntityTypes?: string[];
  /** NO-36a：外骨骼会话守卫替身（缺省 = 无任何会话冲突）。 */
  exoSession?: unknown;
}

function createHarness(opts: HarnessOptions & { approval?: unknown } = {}) {
  const inserted: Array<Record<string, unknown>> = [];
  const updated: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  const existing = opts.existing === undefined
    ? {
        id: '00000000-0000-4000-8000-0000000000a1',
        status: 'draft',
        orgId: 'org-1',
        requiredDeviceCapabilities: [],
        requiredStationCapabilities: [],
      }
    : opts.existing;

  const db = {
    // getTask 直接 await where(...)（没有 limit）；所以 where 必须 thenable，
    // 同时支持 .limit()/.orderBy() 链（列表路径）。
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => {
          const rows = existing ? [existing] : [];
          return {
            limit: jest.fn().mockResolvedValue(rows),
            orderBy: jest.fn(() => ({ limit: jest.fn().mockResolvedValue(rows) })),
            then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
          };
        }),
      })),
    })),
    selectDistinct: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn().mockResolvedValue(
          (opts.stationEntityTypes ?? []).map((entityType) => ({ entityType })),
        ),
      })),
    })),
    insert: jest.fn(() => ({
      values: jest.fn((values: Record<string, unknown>) => {
        inserted.push(values);
        return {
          returning: jest.fn().mockResolvedValue([
            opts.inserted === undefined ? { id: 't-new', ...values } : opts.inserted,
          ]),
        };
      }),
    })),
    update: jest.fn(() => ({
      set: jest.fn((values: Record<string, unknown>) => {
        updated.push(values);
        return {
          where: jest.fn(() => ({
            returning: jest.fn().mockResolvedValue([
              opts.updated === undefined
                ? { id: '00000000-0000-4000-8000-0000000000a1', ...values }
                : opts.updated,
            ]),
          })),
        };
      }),
    })),
  };
  const audit = {
    appendAuditLog: jest.fn(async (entry: Record<string, unknown>) => {
      audits.push(entry);
    }),
  };
  // NO-22a：能力要求写入与授权消耗同事务——mock 事务把同一 db 交给回调，
  // 业务断言照旧看 updated/inserted。
  const dbWithTx = db as typeof db & { transaction: unknown };
  dbWithTx.transaction = jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(db));
  const service = new TaskService(
    db as never,
    audit as never,
    (opts.approval ?? undefined) as never,
    // 显式传 null = 模拟"未装配会话服务"（?? 会把 null 当缺省，故用 in 判定）。
    ('exoSession' in opts
      ? opts.exoSession
      : { assertAssignmentsAllowed: async () => {} }) as never,
  );
  const events: Array<{ taskId: string; trigger: string }> = [];
  service.onTaskEvent((taskId, trigger) => events.push({ taskId, trigger }));
  return { service, inserted, updated, audits, events, db };
}

const ACTOR = { userId: 'u-1', primaryOrgId: 'org-1', roles: ['dispatcher'] };
/** getTask 要求合法 UUID（非 UUID 直接 404）：测试用真实形状的 id。 */
const TASK_UUID = '00000000-0000-4000-8000-0000000000t1'.replace('t', 'a');

describe('任务能力要求 · 创建任务', () => {
  it('global_admin 也能创建任务（org 取自令牌；"不加租户过滤"≠"没有租户"）', async () => {
    // 回归（2026-09-12 e2e 实测）：此前用 orgCondition(actor) 判空，
    // 而 global_admin 的 orgCondition 返回 undefined（＝不加过滤），
    // 导致平台管理员创建任务报 "org context missing"。
    const { service, inserted } = createHarness();
    const created = await service.createTask(
      { title: '管理员创建', taskType: 'assembly' },
      { userId: 'admin', primaryOrgId: 'org-1', roles: ['global_admin'], isGlobalAdmin: true } as never,
    );
    expect(created.id).toBeTruthy();
    expect(inserted[0].orgId).toBe('org-1');
  });

  it('写入能力要求（规范化：去空白/去重/保序）+ 审计 + warnings 透出', async () => {
    const { service, inserted, audits } = createHarness({ stationEntityTypes: ['workstation'] });
    const row = await service.createTask(
      {
        title: ' 搬运任务 ',
        taskType: 'material_handling',
        requiredDeviceCapabilities: [' exo-lift ', 'exo-lift', '', 'vacuum'],
        requiredStationCapabilities: ['workstation'],
      },
      ACTOR as never,
    );
    expect(inserted).toHaveLength(1);
    expect(inserted[0].requiredDeviceCapabilities).toEqual(['exo-lift', 'vacuum']);
    expect(inserted[0].requiredStationCapabilities).toEqual(['workstation']);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: 'task.create', entityType: 'production_task' });
    // exo-lift / vacuum 已在能力词表内 → 无"未登记"提示
    expect((row as { capabilityWarnings: string[] }).capabilityWarnings).toEqual([]);
  });

  it('未登记能力名：允许写入但显式提示（否则任务永远匹配不到资源而无从知晓）', async () => {
    const { service, inserted } = createHarness();
    const row = await service.createTask(
      {
        title: 't',
        taskType: 'work',
        requiredDeviceCapabilities: ['observe.temperature', 'custom.magic_lift'],
      },
      ACTOR as never,
    );
    expect(inserted[0].requiredDeviceCapabilities).toEqual(['observe.temperature', 'custom.magic_lift']);
    const warnings = (row as { capabilityWarnings: string[] }).capabilityWarnings;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('custom.magic_lift');
    expect(warnings[0]).toContain('不在能力词表内');
  });

  it('形状非法（非数组 / 非字符串项 / 超长 / 超量）→ 400，且不写库', async () => {
    const { service, inserted } = createHarness();
    const base = { title: 't', taskType: 'work' };
    await expect(
      service.createTask({ ...base, requiredDeviceCapabilities: 'exo-lift' as never }, ACTOR as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.createTask({ ...base, requiredDeviceCapabilities: [1 as never] }, ACTOR as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.createTask({ ...base, requiredDeviceCapabilities: ['x'.repeat(65)] }, ACTOR as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.createTask(
        { ...base, requiredDeviceCapabilities: Array.from({ length: 33 }, (_, i) => `cap-${i}`) },
        ACTOR as never,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(inserted).toHaveLength(0);
  });

  it('工位能力要求按本租户工位实际声明核对（未声明 → 显式提示）', async () => {
    const { service } = createHarness({ stationEntityTypes: ['workstation'] });
    const row = await service.createTask(
      { title: 't', taskType: 'work', requiredStationCapabilities: ['workstation', 'paint_booth'] },
      ACTOR as never,
    );
    const warnings = (row as { capabilityWarnings: string[] }).capabilityWarnings;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('paint_booth');
    expect(warnings[0]).toContain('工位能力要求');
  });
});

describe('NO-20a：高风险能力放宽的审批闸门', () => {
  /** 已获批的审批实例（形状与 ApprovalInstance 一致）。 */
  function approvedApproval(subject: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
    return {
      getApproval: jest.fn().mockResolvedValue({
        id: 'AP-1',
        entityType: 'task_capability_change',
        entityId: TASK_UUID,
        status: 'approved',
        steps: [{ id: 's1', role: 'safety_admin', status: 'approved' }],
        // NO-22a：高风险授权必须带通过时间（时效由 shared 校验）
        approvedAt: new Date().toISOString(),
        subject,
        createdAt: new Date().toISOString(),
        ...overrides,
      }),
      claimUsage: jest.fn().mockResolvedValue({ claimed: true, usageEventId: 'approval_usage:x' }),
    };
  }
  const expectedSubject = {
    objectType: 'task_capability_change',
    objectId: TASK_UUID,
    title: '放宽高风险能力要求：crane',
    summary: '…',
    metrics: {
      relaxedHighRiskCapabilities: 'crane',
      resultingDeviceCapabilities: '',
      resultingStationCapabilities: '',
    },
  };

  it('放宽高风险能力但未带审批 → 409 且提示如何申请（调度员不得单独决定）', async () => {
    const { service, updated } = createHarness({
      existing: {
        id: TASK_UUID,
        title: '吊装任务',
        status: 'pending_dispatch',
        orgId: 'org-1',
        requiredDeviceCapabilities: ['crane'],
        requiredStationCapabilities: [],
      },
    });
    const error = await service
      .updateTaskRequirements(TASK_UUID, { requiredDeviceCapabilities: [] }, ACTOR as never)
      .catch((e) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(String(error.message)).toContain('HIGH_RISK_CAPABILITY_RELAXATION_REQUIRES_APPROVAL');
    expect(String(error.message)).toContain('安全管理员审批');
    // 提示里必须给出可直接照做的审批请求（entityType/entityId/subject 指纹）
    expect(String(error.message)).toContain('task_capability_change');
    expect(String(error.message)).toContain('relaxedHighRiskCapabilities');
    expect(updated).toHaveLength(0);
  });

  it('带"已获批且指纹一致"的审批 → 放行，并把审批 id 写入审计与返回', async () => {
    const { service, updated, audits } = createHarness({
      existing: {
        id: TASK_UUID,
        title: '吊装任务',
        status: 'pending_dispatch',
        orgId: 'org-1',
        requiredDeviceCapabilities: ['crane'],
        requiredStationCapabilities: [],
      },
      approval: approvedApproval(expectedSubject),
    });
    const res = await service.updateTaskRequirements(
      TASK_UUID,
      { requiredDeviceCapabilities: [], approvalId: 'AP-1' },
      ACTOR as never,
    );
    expect(updated[0].requiredDeviceCapabilities).toEqual([]);
    expect(res).toMatchObject({ approvalId: 'AP-1', relaxedHighRiskCapabilities: ['crane'] });
    expect(audits[0].metadata).toMatchObject({
      approvalId: 'AP-1',
      relaxedHighRiskCapabilities: ['crane'],
    });
  });

  it('审批未通过 / 指纹不符（想多放宽一项）→ 409，不写库', async () => {
    const pending = createHarness({
      existing: {
        id: TASK_UUID, title: 't', status: 'pending_dispatch', orgId: 'org-1',
        requiredDeviceCapabilities: ['crane'], requiredStationCapabilities: [],
      },
      approval: approvedApproval(expectedSubject, { status: 'pending' }),
    });
    await expect(
      pending.service.updateTaskRequirements(
        TASK_UUID, { requiredDeviceCapabilities: [], approvalId: 'AP-1' }, ACTOR as never,
      ),
    ).rejects.toThrow(/APPROVAL_INVALID/);
    expect(pending.updated).toHaveLength(0);

    const mismatch = createHarness({
      existing: {
        id: TASK_UUID, title: 't', status: 'pending_dispatch', orgId: 'org-1',
        requiredDeviceCapabilities: ['crane', 'exo-lift'], requiredStationCapabilities: [],
      },
      approval: approvedApproval(expectedSubject),
    });
    await expect(
      mismatch.service.updateTaskRequirements(
        TASK_UUID, { requiredDeviceCapabilities: [], approvalId: 'AP-1' }, ACTOR as never,
      ),
    ).rejects.toThrow(/不一致/);
    expect(mismatch.updated).toHaveLength(0);
  });

  it('收紧（新增高风险要求）不需要审批', async () => {
    const { service, updated } = createHarness({
      existing: {
        id: TASK_UUID, title: 't', status: 'pending_dispatch', orgId: 'org-1',
        requiredDeviceCapabilities: [], requiredStationCapabilities: [],
      },
    });
    await service.updateTaskRequirements(
      TASK_UUID, { requiredDeviceCapabilities: ['crane'] }, ACTOR as never,
    );
    expect(updated[0].requiredDeviceCapabilities).toEqual(['crane']);
  });

  it('放宽低风险能力不需要审批（不制造额外流程）', async () => {
    const { service, updated } = createHarness({
      existing: {
        id: TASK_UUID, title: 't', status: 'pending_dispatch', orgId: 'org-1',
        requiredDeviceCapabilities: ['observe.temperature'], requiredStationCapabilities: [],
      },
    });
    await service.updateTaskRequirements(TASK_UUID, { requiredDeviceCapabilities: [] }, ACTOR as never);
    expect(updated[0].requiredDeviceCapabilities).toEqual([]);
  });

  // ── NO-22a：授权时效与消耗（同一口径的设备侧用例见 dashboard 生命周期测试）──
  const craneRelaxHarness = (approval: unknown) =>
    createHarness({
      existing: {
        id: TASK_UUID, title: 't', status: 'pending_dispatch', orgId: 'org-1',
        requiredDeviceCapabilities: ['crane'], requiredStationCapabilities: [],
      },
      approval,
    });

  it('审批通过超过 24 小时 → 409（旧审批不能成为今天的放行凭证）', async () => {
    const stale = craneRelaxHarness(
      approvedApproval(expectedSubject, {
        approvedAt: new Date(Date.now() - 25 * 3_600_000).toISOString(),
      }),
    );
    const error = await stale.service
      .updateTaskRequirements(TASK_UUID, { requiredDeviceCapabilities: [], approvalId: 'AP-1' }, ACTOR as never)
      .catch((e) => e);
    expect(String(error.message)).toContain('超出有效期');
    expect(stale.updated).toHaveLength(0);
  });

  it('审批缺少通过时间 → 409（无法判断时效）', async () => {
    const noTime = craneRelaxHarness(approvedApproval(expectedSubject, { approvedAt: undefined }));
    await expect(
      noTime.service.updateTaskRequirements(
        TASK_UUID, { requiredDeviceCapabilities: [], approvalId: 'AP-1' }, ACTOR as never,
      ),
    ).rejects.toThrow(/缺少通过时间/);
    expect(noTime.updated).toHaveLength(0);
  });

  it('同一审批已用于本任务的放宽 → 409 APPROVAL_ALREADY_CONSUMED，不写库', async () => {
    const approval = approvedApproval(expectedSubject);
    (approval.claimUsage as jest.Mock).mockResolvedValue({
      claimed: false,
      usageEventId: 'approval_usage:AP-1:task:x',
      existing: { usedBy: 'admin', at: '2026-09-11T09:00:00.000Z', note: null },
    });
    const reused = craneRelaxHarness(approval);
    const error = await reused.service
      .updateTaskRequirements(TASK_UUID, { requiredDeviceCapabilities: [], approvalId: 'AP-1' }, ACTOR as never)
      .catch((e) => e);
    expect(String(error.message)).toContain('APPROVAL_ALREADY_CONSUMED');
    expect(String(error.message)).toContain('admin');
    expect(approval.claimUsage).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: 'AP-1', usageKey: `task:${TASK_UUID}`, usedBy: 'u-1' }),
      expect.anything(),
    );
    expect(reused.updated).toHaveLength(0);
  });

  it('放行时审计记录审批通过/失效时间（可对账是否在时效内）', async () => {
    const approval = approvedApproval(expectedSubject);
    const harness = craneRelaxHarness(approval);
    await harness.service.updateTaskRequirements(
      TASK_UUID, { requiredDeviceCapabilities: [], approvalId: 'AP-1' }, ACTOR as never,
    );
    const instance = await (approval.getApproval as jest.Mock).mock.results[0].value;
    expect(harness.audits[0].metadata).toMatchObject({
      approvalId: 'AP-1',
      approvalApprovedAt: instance.approvedAt,
    });
  });
});

describe('任务能力要求 · 变更要求（PATCH /api/tasks/:id/requirements）', () => {
  it('更新能力要求 + 审计 before/after + 触发 TASK_UPDATED（旧方案按旧要求算的）', async () => {
    const { service, updated, audits, events } = createHarness({
      existing: {
        id: TASK_UUID,
        status: 'pending_dispatch',
        orgId: 'org-1',
        requiredDeviceCapabilities: ['vacuum'],
        requiredStationCapabilities: [],
      },
    });
    const res = await service.updateTaskRequirements(
      TASK_UUID,
      { requiredDeviceCapabilities: ['exo-lift'], requiredStationCapabilities: ['workstation'] },
      ACTOR as never,
    );
    expect(updated[0]).toMatchObject({
      requiredDeviceCapabilities: ['exo-lift'],
      requiredStationCapabilities: ['workstation'],
    });
    expect(res).toMatchObject({
      taskId: TASK_UUID,
      requiredDeviceCapabilities: ['exo-lift'],
      requiredStationCapabilities: ['workstation'],
    });
    expect(audits[0]).toMatchObject({
      action: 'task.requirements.update',
      before: { requiredDeviceCapabilities: ['vacuum'] },
      after: { requiredDeviceCapabilities: ['exo-lift'] },
    });
    expect(events).toEqual([{ taskId: TASK_UUID, trigger: 'TASK_UPDATED' }]);
  });

  it('传空数组 = 清空要求（显式语义，不是"不改动"）', async () => {
    const { service, updated } = createHarness();
    await service.updateTaskRequirements(TASK_UUID, { requiredDeviceCapabilities: [] }, ACTOR as never);
    expect(updated[0].requiredDeviceCapabilities).toEqual([]);
  });

  it('任务不存在（或不属于本租户）→ 404', async () => {
    const { service } = createHarness({ existing: null });
    await expect(
      service.updateTaskRequirements(
        '00000000-0000-4000-8000-0000000000ff',
        { requiredDeviceCapabilities: ['exo-lift'] },
        ACTOR as never,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

/* ── NO-36a：任务创建是"设备 + 人员"的第二条指派写路径，执行边界必须同样成立 ── */
describe('任务创建 · 外骨骼会话执行边界（NO-36a）', () => {
  it('指定了设备且该设备正被别人佩戴 → 409（不写入任务）', async () => {
    const conflict = new ConflictException(
      'EXO_SESSION_ASSIGNMENT_CONFLICT：设备 EXO-001 处于外骨骼会话 exo-session:x（佩戴者 w）',
    );
    const exoSession = { assertAssignmentsAllowed: jest.fn(async () => { throw conflict; }) };
    const { service, inserted } = createHarness({ exoSession });
    const error = await service
      .createTask(
        {
          title: '佩戴冲突任务',
          taskType: 'assembly',
          assigneeId: '11111111-1111-4111-8111-111111111111',
          deviceId: '22222222-2222-4222-8222-222222222222',
        },
        ACTOR,
      )
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(ConflictException);
    expect(String(error.message)).toContain('EXO_SESSION_ASSIGNMENT_CONFLICT');
    // 冲突即不落库：不允许"先写任务再补会话判定"。
    expect(inserted).toHaveLength(0);
    expect(exoSession.assertAssignmentsAllowed).toHaveBeenCalledWith(
      'org-1',
      [
        {
          deviceId: '22222222-2222-4222-8222-222222222222',
          personId: '11111111-1111-4111-8111-111111111111',
          label: expect.stringContaining('task:new'),
        },
      ],
      // 执行器必须是**事务句柄**（不是 undefined/根句柄）：闸门读会话与任务写入
      // 处于同一原子单元，避免"判定后、写入前"的窗口被并发会话利用。
      expect.anything(),
      'EXO_SESSION_ASSIGNMENT_CONFLICT',
    );
  });

  it('佩戴者本人 + 该设备 → 放行（人机同体）；未指定设备 → 不触发会话判定', async () => {
    const exoSession = { assertAssignmentsAllowed: jest.fn(async () => {}) };
    const { service, inserted } = createHarness({ exoSession });
    await service.createTask(
      { title: '同体任务', taskType: 'assembly', assigneeId: 'p-1', deviceId: 'd-1' },
      ACTOR,
    );
    expect(exoSession.assertAssignmentsAllowed).toHaveBeenCalledTimes(1);
    await service.createTask({ title: '无设备任务', taskType: 'assembly' }, ACTOR);
    expect(exoSession.assertAssignmentsAllowed).toHaveBeenCalledTimes(1);
    expect(inserted).toHaveLength(2);
  });

  it('指定了设备但本实例未装配会话服务 → 503 fail-closed（既不静默放行也不谎报冲突）', async () => {
    const { service, inserted } = createHarness({ exoSession: null });
    const error = await service
      .createTask(
        { title: '装配缺失', taskType: 'assembly', deviceId: 'd-1' },
        ACTOR,
      )
      .catch((caught) => caught);
    expect(error?.getStatus?.()).toBe(503);
    expect(String(error.message)).toContain('EXO_SESSION_GUARD_UNAVAILABLE');
    expect(inserted).toHaveLength(0);
  });
});
