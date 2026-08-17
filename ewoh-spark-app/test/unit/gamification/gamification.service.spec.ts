import { NotFoundException } from '@nestjs/common';
import { GamificationService } from '../../../server/modules/gamification/gamification.service';
import {
  ewohDevice,
  ewohEvent,
  ewohSchedulePlan,
  ewohScheduleAudit,
  ewohSpatialEntity,
  ewohTelemetry,
} from '@server/database/schema';

function createDispatchDb(planRows: unknown[], deviceRows: unknown[]) {
  const updateWhere = jest.fn().mockResolvedValue([]);
  const auditReturning = jest.fn().mockResolvedValue([
    { auditId: 'AUDIT-1', planId: 'P-1' },
  ]);
  const insertRows: Array<{
    table: unknown;
    row: Record<string, unknown>;
  }> = [];
  const db = {
    select: jest.fn(() => ({
      from: jest.fn((table: unknown) => ({
        where: jest.fn(() => {
          if (table === ewohSchedulePlan) {
            return { limit: jest.fn().mockResolvedValue(planRows) };
          }
          const devicePromise = Promise.resolve(deviceRows);
          (
            devicePromise as Promise<unknown[]> & {
              limit: jest.Mock;
            }
          ).limit = jest.fn().mockResolvedValue(deviceRows);
          return devicePromise;
        }),
      })),
    })),
    insert: jest.fn((table: unknown) => ({
      values: jest.fn((row: Record<string, unknown>) => {
        insertRows.push({ table, row });
        return { returning: auditReturning };
      }),
    })),
    update: jest.fn(() => ({
      set: jest.fn(() => ({
        where: updateWhere,
      })),
    })),
  };
  return { db, updateWhere, auditReturning, insertRows };
}

describe('GamificationService player roles', () => {
  const originalRole = process.env.EWOH_PLAYER_ROLE;
  const originalName = process.env.EWOH_PLAYER_NAME;

  afterEach(() => {
    if (originalRole === undefined) {
      delete process.env.EWOH_PLAYER_ROLE;
    } else {
      process.env.EWOH_PLAYER_ROLE = originalRole;
    }
    if (originalName === undefined) {
      delete process.env.EWOH_PLAYER_NAME;
    } else {
      process.env.EWOH_PLAYER_NAME = originalName;
    }
  });

  it('maps workshop director permissions from the RBAC role (actor.roles → 玩家角色)', () => {
    // 角色映射（W4）：dispatcher/workshop_lead/safety_admin → 车间主任
    // （EWOH_PLAYER_ROLE env 不再参与角色判定）。
    const service = new GamificationService({} as never);

    const role = service.getRole({
      userId: 'u1',
      primaryOrgId: 'ORG-1',
      roles: ['dispatcher'],
    });
    expect(role.role).toBe('workshop_director');
    expect(role.roleName).toBe('车间主任');
    expect(role.permissions).toContain('dispatch_plan');
    expect(role.permissions).not.toContain('adjust_weights');

    const byLegacyRole = service.getRole({
      userId: 'u2',
      primaryOrgId: 'ORG-1',
      role: 'workshop_lead',
    });
    expect(byLegacyRole.role).toBe('workshop_director');
  });

  it('defaults to shift leader when no role is configured', () => {
    delete process.env.EWOH_PLAYER_ROLE;
    const service = new GamificationService({} as never);
    expect(service.getRole().role).toBe('shift_leader');
    expect(service.getRole().permissions).toContain('confirm_plan');
    expect(service.getRole().permissions).not.toContain('dispatch_plan');
  });
});

describe('GamificationService dispatch and feedback', () => {
  it('dispatches a confirmed plan when linked devices are online', async () => {
    const plan = {
      id: 'row-1',
      planId: 'P-1',
      status: 'confirmed',
      metricsJson: { assignedEntities: ['EXO-1'] },
    };
    const devices = [
      { deviceId: 'EXO-1', online: true, workerName: 'W-1' },
    ];
    const { db, updateWhere } = createDispatchDb([plan], devices);
    const service = new GamificationService(db as never);

    const result = await service.dispatchPlan(
      'P-1',
      {
        operator: 'supervisor',
      },
      // W4：写操作显式租户上下文（NULL orgId 存量行放行）。
      { userId: 'supervisor', primaryOrgId: 'ORG-1' },
    );

    expect(result.status).toBe('dispatched');
    expect(result.conflicts).toEqual([]);
    expect(updateWhere).toHaveBeenCalled();
  });

  it('returns conflict and refuses dispatch when a linked device is offline', async () => {
    const plan = {
      id: 'row-1',
      planId: 'P-1',
      status: 'confirmed',
      metricsJson: { assignedEntities: ['EXO-1'] },
    };
    const devices = [
      { deviceId: 'EXO-1', online: false, workerName: 'W-1' },
    ];
    const { db, updateWhere } = createDispatchDb([plan], devices);
    const service = new GamificationService(db as never);

    const result = await service.dispatchPlan(
      'P-1',
      {
        operator: 'supervisor',
      },
      { userId: 'supervisor', primaryOrgId: 'ORG-1' },
    );

    expect(result.status).toBe('conflict');
    expect(result.conflicts[0]).toContain('离线');
    expect(updateWhere).not.toHaveBeenCalled();
  });

  it('rejects exoskeleton feedback for an offline device', async () => {
    const { db } = createDispatchDb([], [
      { deviceId: 'EXO-1', online: false },
    ]);
    const service = new GamificationService(db as never);

    const result = await service.sendExoFeedback(
      'EXO-1',
      {
        type: 'tactile',
        tactilePattern: 'vibrate_high',
      },
      // NEST-311：设备按 (orgId, deviceId) 定位，需显式租户上下文。
      { userId: 'supervisor', primaryOrgId: 'ORG-1' },
    );

    expect(result.accepted).toBe(false);
    expect(result.error).toBe('设备离线');
  });

  it('records exoskeleton feedback events for online devices', async () => {
    const { db, insertRows } = createDispatchDb([], [
      { deviceId: 'EXO-1', online: true },
    ]);
    const service = new GamificationService(db as never);

    const result = await service.sendExoFeedback(
      'EXO-1',
      {
        type: 'voice',
        message: '负荷过高，请休息',
        priority: 'high',
      },
      { userId: 'supervisor', primaryOrgId: 'ORG-1' },
    );

    expect(result.accepted).toBe(true);
    expect(result.delivered).toBe(true);
    expect(
      insertRows.some((entry) => entry.table === ewohEvent),
    ).toBe(true);
  });
});

describe('GamificationService helpers', () => {
  it('normalizes load balance and extracts assigned entity ids', () => {
    const service = new GamificationService({} as never);
    const instance = service as unknown as {
      computeStdDevNormalized(values: number[]): number;
      extractEntityIds(metrics: Record<string, unknown>): string[];
    };
    expect(instance.computeStdDevNormalized([0.5, 0.5])).toBe(1);
    expect(
      instance.extractEntityIds({
        allocatedEntities: ['A', 'A'],
        assignedEntities: ['B'],
      }),
    ).toEqual(['A', 'B']);
  });
});

/** ADR-071（NO-13v）：allocate/orchestrate 直插路径的 db mock（insert/update 捕获）。 */
function createPlanWriteDb() {
  const insertRows: Array<{ table: unknown; row: Record<string, unknown> }> = [];
  const updateTables: unknown[] = [];
  function whereResult() {
    const groupBy = jest.fn().mockResolvedValue([]);
    const limit = jest.fn().mockResolvedValue([]);
    const t = Promise.resolve([]) as Promise<unknown[]> & {
      groupBy: jest.Mock;
      limit: jest.Mock;
    };
    t.groupBy = groupBy;
    t.limit = limit;
    return t;
  }
  const db = {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        innerJoin: jest.fn(() => ({
          where: jest.fn(whereResult),
        })),
        where: jest.fn(whereResult),
      })),
    })),
    update: jest.fn((table: unknown) => ({
      set: jest.fn(() => ({
        where: jest.fn(async () => {
          updateTables.push(table);
          return [];
        }),
      })),
    })),
    insert: jest.fn((table: unknown) => ({
      values: jest.fn((row: Record<string, unknown>) => {
        insertRows.push({ table, row });
        const t = Promise.resolve([row]) as Promise<unknown[]> & {
          returning: jest.Mock;
        };
        t.returning = jest.fn().mockResolvedValue([row]);
        return t;
      }),
    })),
  };
  return { db, insertRows, updateTables };
}

describe('GamificationService plan org isolation (ADR-071 / NO-13v)', () => {
  it('allocateResources 写方案行 orgId=primaryOrgId（ctx 归属，不再落全局行）', async () => {
    const { db, insertRows } = createPlanWriteDb();
    const service = new GamificationService(db as never);
    await service.allocateResources(
      {
        allocations: [
          { entityId: 'EXO-1', targetType: 'workstation', targetId: 'station:s1' },
        ],
        operator: 'op',
      },
      { userId: 'u1', primaryOrgId: 'ORG-1' },
    );
    const planRow = insertRows.find((e) => e.table === ewohSchedulePlan);
    expect(planRow?.row.orgId).toBe('ORG-1');
    // ADR-075：audit 行归属同源注入（001 ewoh_org_visible RLS 对齐）。
    const auditRow = insertRows.find((e) => e.table === ewohScheduleAudit);
    expect(auditRow?.row.orgId).toBe('ORG-1');
  });

  it('allocateResources 无 actor → fail-closed 拒绝（W4：写操作必须带租户上下文）', async () => {
    const { db, insertRows } = createPlanWriteDb();
    const service = new GamificationService(db as never);
    await expect(
      service.allocateResources({
        allocations: [
          { entityId: 'EXO-1', targetType: 'workstation', targetId: 'station:s1' },
        ],
      }),
    ).rejects.toThrow(/org context missing/);
    expect(insertRows).toHaveLength(0);
  });

  it('orchestrateTask 写方案行 orgId=primaryOrgId（ctx 归属）', async () => {
    const { db, insertRows } = createPlanWriteDb();
    const service = new GamificationService(db as never);
    await service.orchestrateTask(
      {
        orderId: 'WO-1',
        nodes: [
          {
            nodeId: 'n1',
            name: '装配',
            order: 1,
            assignedWorkstationId: 'station:s1',
            assignedPersonId: 'person:p1',
            estimatedTakt: 60,
            dependencies: [],
          },
        ],
      },
      { userId: 'u1', primaryOrgId: 'ORG-1' },
    );
    const planRow = insertRows.find((e) => e.table === ewohSchedulePlan);
    expect(planRow?.row.orgId).toBe('ORG-1');
    const auditRow = insertRows.find((e) => e.table === ewohScheduleAudit);
    expect(auditRow?.row.orgId).toBe('ORG-1');
  });

  it('dispatchPlan 跨租户 → NotFound（守卫先于业务校验，零状态变更）', async () => {
    const { db, updateWhere } = createDispatchDb(
      [
        {
          id: 'row-1',
          planId: 'P-1',
          status: 'confirmed',
          metricsJson: {},
          orgId: 'ORG-1',
        },
      ],
      [],
    );
    const service = new GamificationService(db as never);
    await expect(
      service.dispatchPlan(
        'P-1',
        { operator: 'supervisor' },
        { userId: 'u2', primaryOrgId: 'ORG-2' },
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(updateWhere).not.toHaveBeenCalled();
  });

  it('dispatchPlan NULL orgId 存量行 + actor → 放行（standalone_025 过渡边界）', async () => {
    const { db } = createDispatchDb(
      [
        {
          id: 'row-1',
          planId: 'P-1',
          status: 'confirmed',
          metricsJson: {},
        },
      ],
      [],
    );
    const service = new GamificationService(db as never);
    const result = await service.dispatchPlan(
      'P-1',
      { operator: 'supervisor' },
      { userId: 'u2', primaryOrgId: 'ORG-2' },
    );
    expect(result.status).toBe('dispatched');
  });
});

/** 递归收集 drizzle SQL 谓词里的绑定参数值（Param.value）——R2-SAM-001 同款。 */
function collectParams(node: unknown, out: unknown[] = []): unknown[] {
  if (!node || typeof node !== 'object') return out;
  const withChunks = node as { queryChunks?: unknown[] };
  if (Array.isArray(withChunks.queryChunks)) {
    for (const chunk of withChunks.queryChunks) {
      collectParams(chunk, out);
    }
    return out;
  }
  if ('value' in (node as Record<string, unknown>)) {
    out.push((node as { value: unknown }).value);
  }
  return out;
}

/**
 * R2-SBZ-005 / R2-SAM-004：orchestrateTask 的占用聚合（innerJoin）与工位名
 * 查询必须带 org 谓词。模拟行可见性：谓词绑定参数含 actorOrgId 时仅本租户
 * 行可见（与 eq(orgId) 等价）；enforceOrg=false 模拟修复前无谓词的全量泄漏。
 */
function createOrchestrateOrgDb(enforceOrg: boolean) {
  const occRows = [
    { entityId: 'station:s1', avgLoad: 0.5, org: 'ORG-1' },
    // 他租户同 ID 工位的高占用遥测（若无谓词会覆盖本租户值 → takt 60）
    { entityId: 'station:s1', avgLoad: 1.0, org: 'ORG-2' },
  ];
  const wsRows = [
    { entityId: 'station:s1', name: 'S1-本租户', org: 'ORG-1' },
    { entityId: 'station:s1', name: 'S1-他租户', org: 'ORG-2' },
  ];
  const insertRows: Array<{ table: unknown; row: Record<string, unknown> }> = [];
  const filter = (cond: unknown, rows: Array<{ org: string }>): unknown[] => {
    if (!enforceOrg) return rows;
    return collectParams(cond).includes('ORG-1') ? rows.filter((r) => r.org === 'ORG-1') : rows;
  };
  const rowsThenable = (rows: unknown[]) => {
    const t = Promise.resolve(rows) as Promise<unknown[]> & { groupBy: jest.Mock };
    t.groupBy = jest.fn().mockResolvedValue(rows);
    return t;
  };
  const occWhere = jest.fn((cond: unknown) => rowsThenable(filter(cond, occRows)));
  const wsWhere = jest.fn((cond: unknown) => rowsThenable(filter(cond, wsRows)));
  const db = {
    select: jest.fn(() => ({
      from: jest.fn((table: unknown) => {
        if (table === ewohTelemetry) {
          return { innerJoin: jest.fn(() => ({ where: occWhere })) };
        }
        return { where: wsWhere };
      }),
    })),
    insert: jest.fn((table: unknown) => ({
      values: jest.fn((row: Record<string, unknown>) => {
        insertRows.push({ table, row });
        const t = Promise.resolve([row]) as Promise<unknown[]> & { returning: jest.Mock };
        t.returning = jest.fn().mockResolvedValue([row]);
        return t;
      }),
    })),
  };
  return { db, insertRows, occWhere, wsWhere };
}

describe('GamificationService orchestrateTask org 谓词（R2-SBZ-005 / R2-SAM-004）', () => {
  const ORCHESTRATE_REQ = {
    orderId: 'WO-T',
    nodes: [
      {
        nodeId: 'n1',
        name: '装配',
        order: 1,
        assignedWorkstationId: 'station:s1',
        dependencies: [],
      },
    ],
  };

  it('占用聚合与工位名查询谓词均含本 org 参数，跨租户遥测/名称不进入结果', async () => {
    const { db, occWhere, wsWhere } = createOrchestrateOrgDb(true);
    const service = new GamificationService(db as never);
    const result = await service.orchestrateTask(ORCHESTRATE_REQ, {
      userId: 'u1',
      primaryOrgId: 'ORG-1',
    });
    // 两处查询的绑定参数都携带本租户 orgId（应用层谓词，不依赖 RLS 兜底）。
    expect(collectParams(occWhere.mock.calls[0]?.[0])).toContain('ORG-1');
    expect(collectParams(wsWhere.mock.calls[0]?.[0])).toContain('ORG-1');
    // 他租户高占用（avgLoad=1.0 → takt 60）被过滤：本租户 0.5 → takt 45。
    expect(result.nodes[0]).toMatchObject({ estimatedTakt: 45, taktSource: 'telemetry' });
    // 工位名不回显他租户实体名。
    expect(result.simulation.stationTakts[0]?.workstationName).toBe('S1-本租户');
    expect(result.simulation.bottleneckWorkstationName).toBe('S1-本租户');
  });

  it('对照（修复前行为）：无 org 谓词时他租户同 ID 工位污染节拍与名称', async () => {
    const { db } = createOrchestrateOrgDb(false);
    const service = new GamificationService(db as never);
    const result = await service.orchestrateTask(ORCHESTRATE_REQ, {
      userId: 'u1',
      primaryOrgId: 'ORG-1',
    });
    // 泄漏反证：他租户 avgLoad=1.0 覆盖本租户 0.5 → takt 60、名称被顶替。
    expect(result.nodes[0]).toMatchObject({ estimatedTakt: 60, taktSource: 'telemetry' });
    expect(result.simulation.stationTakts[0]?.workstationName).toBe('S1-他租户');
  });
});

describe('GamificationService applyBrainSuggestion 租户上下文（R2-SBZ-006）', () => {
  const APPLY_BODY = {
    type: 'load_balance' as const,
    title: '均衡负荷',
    description: 'd',
    affectedEntities: [],
    expectedBenefit: 'b',
    confidence: 0.8,
  };

  function makeApplyDb(plans: Array<Record<string, unknown>>) {
    const insertRows: Array<{ table: unknown; row: Record<string, unknown> }> = [];
    const db = {
      select: jest.fn(),
      insert: jest.fn((table: unknown) => ({
        values: jest.fn((row: Record<string, unknown>) => {
          insertRows.push({ table, row });
          const t = Promise.resolve([row]) as Promise<unknown[]> & { returning: jest.Mock };
          t.returning = jest.fn().mockResolvedValue([row]);
          return t;
        }),
      })),
    };
    const createRun = jest.fn().mockResolvedValue({
      run: { runId: 'RUN-1' },
      plans,
      debounced: false,
    });
    const service = new GamificationService(db as never, undefined, { createRun } as never);
    return { service, createRun, insertRows };
  }

  it('createRun 透传 actor（org 上下文），audit 行与调用方租户同源', async () => {
    const { service, createRun, insertRows } = makeApplyDb([
      { planId: 'RUN-1A', orgId: 'ORG-1', status: 'proposed' },
    ]);
    const result = await service.applyBrainSuggestion(APPLY_BODY, {
      userId: 'u1',
      primaryOrgId: 'ORG-1',
    });
    expect(createRun).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: 'MANUAL' }),
      expect.objectContaining({ primaryOrgId: 'ORG-1' }),
    );
    expect(result.planId).toBe('RUN-1A');
    const auditRow = insertRows.find((e) => e.table === ewohScheduleAudit);
    expect(auditRow?.row.orgId).toBe('ORG-1');
  });

  it('缺失 actor → fail-closed：createRun 前拒绝，不触发无租户上下文的调度 run', async () => {
    const { service, createRun, insertRows } = makeApplyDb([
      { planId: 'RUN-1A', orgId: 'ORG-1', status: 'proposed' },
    ]);
    await expect(service.applyBrainSuggestion(APPLY_BODY)).rejects.toThrow(
      /org context missing/,
    );
    expect(createRun).not.toHaveBeenCalled();
    expect(insertRows).toHaveLength(0);
  });

  it('plan 归属与调用方租户分裂（orgId=ORG-2）→ 拒绝且 audit 不落库', async () => {
    const { service, insertRows } = makeApplyDb([
      { planId: 'RUN-1A', orgId: 'ORG-2', status: 'proposed' },
    ]);
    await expect(
      service.applyBrainSuggestion(APPLY_BODY, { userId: 'u1', primaryOrgId: 'ORG-1' }),
    ).rejects.toThrow(/plan_tenant_mismatch/);
    expect(insertRows).toHaveLength(0);
  });

  it('plan.orgId 缺省（standalone_025 存量/过渡行）→ 放行不误伤', async () => {
    const { service } = makeApplyDb([{ planId: 'RUN-1A', status: 'proposed' }]);
    const result = await service.applyBrainSuggestion(APPLY_BODY, {
      userId: 'u1',
      primaryOrgId: 'ORG-1',
    });
    expect(result.planId).toBe('RUN-1A');
  });
});
