/* Task 6 单元测试：调度策略版本闭环（cmd-map-scheduling-closed-loop）。
 *
 * 覆盖：
 * - 生效策略/配置被正确返回（getActivePolicy / getConfig）
 * - 注册候选版本（inactive，configVersion 递增，绝不自动激活）
 * - 注册候选后生产策略仍未被激活
 * - compare/shadow 对比只读，不激活、不修改生产策略
 * - activate 翻转 active 并解除前一版本（唯一生产策略翻转路径）
 * - 反馈驱动（SchedulingFeedback KPI）的 shadow 对比生效
 */
import { NotFoundException } from '@nestjs/common';
import { validateDecision } from '@shared/decision';
import type { PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { ewohSchedulingPolicy } from '@server/database/schema';
import { EligibilityService } from '../eligibility.service';
import { SchedulingPolicyService } from '../scheduling-policy.service';
import { SchedulingFeedbackService } from '../scheduling-feedback.service';
import { SchedulerService } from '../scheduler.service';
import { RequestDatabaseContext } from '@server/database/request-database-context';
import { AuditService } from '@server/modules/shared/audit.service';
import { defaultConfig } from './scheduler-test-helpers';
import type {
  SchedulingPolicyConfig,
  SchedulingFeedbackKpis,
} from '@shared/api.interface';

/** drizzle eq() SQL 的 DB 列名 → 行字段名映射。 */
const COL_TO_KEY: Record<string, string> = {
  config_version: 'configVersion',
  config_json: 'configJson',
  active: 'active',
  org_id: 'orgId',
  updated_by: 'updatedBy',
  _created_at: 'createdAt',
  _updated_at: 'updatedAt',
};

/**
 * 从 drizzle SQL 谓词对象递归求值（R2-SSV-01：UPDATE/SELECT where 已含
 * and(eq, or(isNull, eq)) 嵌套——旧版仅扫顶层 eq，嵌套谓词被当作恒真导致
 * 全行命中）。支持 eq / isNull / and / or：按 or 分组，组内合取，组间析取。
 */
function matchesEq(row: Record<string, unknown>, sqlExpr: unknown): boolean {
  const chunks = (sqlExpr as { queryChunks?: unknown[] } | undefined)?.queryChunks;
  if (!Array.isArray(chunks)) return true;
  const groups: Array<Array<() => boolean>> = [[]];
  let pendingCol: string | null = null;
  for (const raw of chunks) {
    const c = raw as {
      name?: string; value?: unknown; encoder?: unknown; queryChunks?: unknown[];
    } | undefined;
    if (!c || typeof c !== 'object') continue;
    // 列名。
    if (typeof c.name === 'string' && !('encoder' in c)) {
      pendingCol = c.name;
      continue;
    }
    // 操作符文本（StringChunk）。
    if (typeof c.value === 'string' && !('encoder' in c)) {
      if (/\bor\b/.test(c.value)) groups.push([]);
      else if (/is\s+null/i.test(c.value) && pendingCol) {
        const key = COL_TO_KEY[pendingCol] ?? pendingCol;
        groups[groups.length - 1].push(() => row[key] == null);
        pendingCol = null;
      }
      continue;
    }
    // Param（eq 值）。
    if ('encoder' in c && 'value' in c && pendingCol) {
      const key = COL_TO_KEY[pendingCol] ?? pendingCol;
      const expected = c.value;
      groups[groups.length - 1].push(() => row[key] === expected);
      pendingCol = null;
      continue;
    }
    // 嵌套 SQL（and/or 包裹）递归求值。
    if (Array.isArray(c.queryChunks)) {
      const nested = raw;
      groups[groups.length - 1].push(() => matchesEq(row, nested));
    }
  }
  if (groups.every((g) => g.length === 0)) return true;
  return groups.some((g) => g.every((fn) => fn()));
}

/** ewoh_scheduling_policy 表的 in-memory 状态化 fake db（支持 eq 过滤 / insert / update）。 */
function makePolicyDb(seed: Array<Record<string, unknown>> = []) {
  const policies: Array<Record<string, unknown>> = seed.map((p) => ({ ...p }));

  const buildQuery = (
    filter?: (r: Record<string, unknown>) => boolean,
    sortDesc?: boolean,
  ) => {
    const rows = () => {
      let r = [...policies];
      if (filter) r = r.filter(filter);
      if (sortDesc)
        r = r.sort(
          (a, b) =>
            (Number(b.configVersion) ?? 0) - (Number(a.configVersion) ?? 0),
        );
      return r;
    };
    const q: any = Promise.resolve(rows());
    q.where = (pred: unknown) => buildQuery((r) => matchesEq(r, pred), sortDesc);
    q.orderBy = () => buildQuery(filter, true);
    q.limit = (n?: number) => Promise.resolve(rows().slice(0, n ?? rows().length));
    return q;
  };

  const db: any = {
    select: () => ({ from: () => buildQuery(undefined, false) }),
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        const arr = (Array.isArray(values) ? values : [values]) as Array<
          Record<string, unknown>
        >;
        for (const row of arr) {
          if (table === ewohSchedulingPolicy) policies.push({ ...row });
        }
        return { returning: () => Promise.resolve(arr.length ? [arr[0]] : []) };
      },
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: (pred: unknown) => {
          if (table === ewohSchedulingPolicy) {
            for (const row of policies) {
              if (matchesEq(row, pred)) Object.assign(row, patch);
            }
            return { returning: () => Promise.resolve([...policies]) };
          }
          return { returning: () => Promise.resolve([]) };
        },
      }),
    }),
  };
  return { db: db as PostgresJsDatabase, policies };
}

function seedPolicyRows(config: SchedulingPolicyConfig, version: number) {
  return [
    {
      configVersion: version,
      configJson: config,
      active: true,
      orgId: 'org1',
      updatedBy: 'admin',
      createdAt: new Date('2026-08-08T00:00:00.000Z'),
      updatedAt: new Date('2026-08-08T00:00:00.000Z'),
    },
  ];
}

const baseFeedbackKpis: SchedulingFeedbackKpis = {
  totalFeedback: 10,
  accepted: 8,
  rejected: 2,
  pendingAcceptance: 0,
  acceptanceRate: 0.8,
  overrideRate: 0.1,
  fallbackRate: 0,
  solverRuntimeMs: 250,
  replanCount: 3,
  conflictCount: 1,
};

/** 构造 SchedulerService（仅依赖 policy + feedback，其余为 mock）。 */
function makeScheduler(
  policyDb: PostgresJsDatabase,
  feedbackKpis: SchedulingFeedbackKpis = baseFeedbackKpis,
  replayMock?: { isEvaluated: jest.Mock; evaluate: jest.Mock },
) {
  const requestDatabaseContext = {
    runInTransaction: jest.fn(async (_guc: unknown, cb: () => Promise<void>) => {
      await cb();
    }),
  };
  const auditService = {
    appendAuditLog: jest.fn().mockResolvedValue(undefined),
  };
  const policyService = new SchedulingPolicyService(policyDb);
  const feedbackService = {
    deriveKpis: jest.fn().mockResolvedValue(feedbackKpis),
  };
  // Phase 4 / P4-T2：replay 评估 mock（默认视为已评估，供激活守卫通过；新守卫测试可覆盖）。
  const policyReplay =
    replayMock ?? {
      isEvaluated: jest.fn().mockReturnValue(true),
      evaluate: jest.fn().mockResolvedValue(null),
    };
  const svc = new SchedulerService(
    policyDb,
    requestDatabaseContext as unknown as RequestDatabaseContext,
    auditService as unknown as AuditService,
    { getCurrentWorldState: jest.fn() } as never,
    { evaluate: jest.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    new EligibilityService(),
    {} as never,
    policyService,
    feedbackService as unknown as SchedulingFeedbackService,
    { enqueue: jest.fn() } as never,
    undefined,
    undefined,
    undefined,
    policyReplay as never,
  );
  return { svc, auditService, policyService, feedbackService, policyReplay };
}

/** R2-SMI-010：约束/策略应用写路径 actor 必传（fail-closed）——测试统一带租户上下文。 */
const ACTOR = { userId: 'admin', primaryOrgId: 'org1' };

describe('SchedulingPolicy 版本闭环（Task 6）', () => {
  it('生效策略/配置被正确返回（active row）', async () => {
    const config = defaultConfig();
    const { db } = makePolicyDb(seedPolicyRows(config, 1));
    const policyService = new SchedulingPolicyService(db);

    const active = await policyService.getActivePolicy();
    expect(active.version).toBe(1);
    expect(active.solverVersion).toBe('heuristic-v2');

    const got = await policyService.getConfig();
    expect(got.configVersion).toBe(1);
  });

  it('注册候选版本返回递增 configVersion 且 inactive，不激活', async () => {
    const config = defaultConfig();
    const { db, policies } = makePolicyDb(seedPolicyRows(config, 1));
    const policyService = new SchedulingPolicyService(db);

    const candidateConfig = {
      ...defaultConfig(),
      horizonMinutes: 720,
      priority: { ...defaultConfig().priority, deadlineRiskWeight: 2 },
    };
    const saved = await policyService.registerCandidatePolicy(
      candidateConfig,
      'org1',
      'op1',
    );

    expect(saved.configVersion).toBe(2);
    expect(policies).toHaveLength(2);
    const candidateRow = policies.find((p) => p.configVersion === 2);
    expect(candidateRow?.active).toBe(false);
    expect(candidateRow?.updatedBy).toBe('op1');

    // 生产策略仍为 v1。
    const active = await policyService.getActivePolicy();
    expect(active.version).toBe(1);
  });

  it('候选版本绝不自动激活（register 后生效策略不变）', async () => {
    const config = defaultConfig();
    const { db } = makePolicyDb(seedPolicyRows(config, 1));
    const policyService = new SchedulingPolicyService(db);

    await policyService.registerCandidatePolicy(
      { ...defaultConfig(), horizonMinutes: 600 },
      'org1',
      'op1',
    );
    await policyService.registerCandidatePolicy(
      { ...defaultConfig(), horizonMinutes: 900 },
      'org1',
      'op2',
    );

    const active = await policyService.getActivePolicy();
    expect(active.version).toBe(1);
    const versions = await policyService.listVersions();
    expect(versions.filter((v) => v.active)).toHaveLength(1);
    expect(versions.find((v) => v.active)?.configVersion).toBe(1);
  });

  it('compare/shadow 只读，不激活、不修改生产策略', async () => {
    const config = defaultConfig();
    const { db, policies } = makePolicyDb(seedPolicyRows(config, 1));
    const { svc } = makeScheduler(db);

    // 预置一个 inactive 候选 v2。
    const candidateConfig = {
      ...defaultConfig(),
      horizonMinutes: 720,
      priority: { ...defaultConfig().priority, deadlineRiskWeight: 2 },
    };
    await svc.registerPolicyVersion(candidateConfig, ACTOR);

    const comparison = await svc.comparePolicyVersion(2);
    expect(comparison.readOnly).toBe(true);
    expect(comparison.candidateVersion).toBe(2);
    expect(comparison.activeVersion).toBe(1);
    // 差异字段：horizonMinutes + priority.deadlineRiskWeight。
    expect(comparison.paramDeltas['horizonMinutes']).toEqual({
      active: 480,
      candidate: 720,
    });
    expect(comparison.paramDeltas['priority.deadlineRiskWeight']).toEqual({
      active: 1,
      candidate: 2,
    });
    expect(comparison.feedbackKpis).toEqual(baseFeedbackKpis);

    // compare 后仍是 v1 active，未被激活。
    const v1 = policies.find((p) => p.configVersion === 1);
    const v2 = policies.find((p) => p.configVersion === 2);
    expect(v1?.active).toBe(true);
    expect(v2?.active).toBe(false);
  });

  it('activate 翻转 active 并解除前一版本 + 写入审计（P4-T2：需 approver+reason 且已评估）', async () => {
    const config = defaultConfig();
    const { db, policies } = makePolicyDb(seedPolicyRows(config, 1));
    const { svc, auditService } = makeScheduler(db);

    await svc.registerPolicyVersion({
      ...defaultConfig(),
      horizonMinutes: 720,
    }, ACTOR);

    const { config: activated } = await svc.activatePolicyVersion(
      2,
      { approver: 'op1', reason: '人工审批激活' },
      // R2-SMI-010：注册/激活同租户作用域（注册侧 actor 必传后，激活侧
      // 保持同一 org 上下文，翻转/解除均落在本 org 行上）。
      ACTOR,
    );
    expect(activated.configVersion).toBe(2);

    const v1 = policies.find((p) => p.configVersion === 1);
    const v2 = policies.find((p) => p.configVersion === 2);
    expect(v1?.active).toBe(false);
    expect(v2?.active).toBe(true);

    const active = await svc.getPolicy();
    expect(active.config.configVersion).toBe(2);

    // 审计已写入（含 approver + reason）。
    expect(auditService.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'scheduler.policy.activate',
        entityId: '2',
        entityType: 'scheduling_policy',
        actorId: 'op1',
        reason: '人工审批激活',
      }),
    );
  });

  it('反馈驱动的 shadow 对比返回 KPIs（离线评估，不激活）', async () => {
    const config = defaultConfig();
    const { db, policies } = makePolicyDb(seedPolicyRows(config, 1));
    const feedbackKpis: SchedulingFeedbackKpis = {
      ...baseFeedbackKpis,
      acceptanceRate: 0.9,
      overrideRate: 0.05,
    };
    const { svc, feedbackService } = makeScheduler(db, feedbackKpis);

    await svc.registerPolicyVersion({ ...defaultConfig(), horizonMinutes: 600 }, ACTOR);
    const comparison = await svc.comparePolicyVersion(2);

    expect(feedbackService.deriveKpis).toHaveBeenCalled();
    expect(comparison.feedbackKpis.acceptanceRate).toBe(0.9);
    expect(comparison.feedbackKpis.overrideRate).toBe(0.05);
    // 对比后生产策略仍为 v1。
    const v1 = policies.find((p) => p.configVersion === 1);
    expect(v1?.active).toBe(true);
  });

  it('对比/激活不存在的版本 → NotFoundException', async () => {
    const config = defaultConfig();
    const { db } = makePolicyDb(seedPolicyRows(config, 1));
    const { svc } = makeScheduler(db);

    await expect(svc.comparePolicyVersion(99)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      svc.activatePolicyVersion(99, { approver: 'op1', reason: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('P4-T2: Shadow Policy 真实 replay + guarded activate', () => {
  it('comparePolicyVersion 无历史快照 → replay=null（回退参数 delta 估算，不伪造）', async () => {
    const config = defaultConfig();
    const { db } = makePolicyDb(seedPolicyRows(config, 1));
    const { svc, policyReplay } = makeScheduler(db);
    await svc.registerPolicyVersion({ ...defaultConfig(), horizonMinutes: 720 }, ACTOR);
    policyReplay.evaluate.mockResolvedValue(null);

    const comparison = await svc.comparePolicyVersion(2);
    expect(comparison.replay).toBeNull();
    expect(comparison.paramDeltas['horizonMinutes']).toBeDefined();
  });

  it('有历史快照 + solver mock → comparePolicyVersion 附带真实 replay（objective/KPI 对比可复现）', async () => {
    const config = defaultConfig();
    const { db } = makePolicyDb(seedPolicyRows(config, 1));
    const replay = {
      snapshotVersion: 'WS-HIST-0001',
      solverVersion: 'heuristic-v2',
      active: {
        objective: 12,
        assignmentCount: 3,
        unassignedCount: 0,
        metrics: { lateMinutes: 2, walkingMeters: 100, stationWaitMinutes: 1, maxWorkload: 3, changeCost: 0.5 },
      },
      candidate: {
        objective: 9,
        assignmentCount: 3,
        unassignedCount: 0,
        metrics: { lateMinutes: 1, walkingMeters: 80, stationWaitMinutes: 1, maxWorkload: 3, changeCost: 0.5 },
      },
      objectiveDelta: -3,
      verdict: 'candidate_better' as const,
    };
    const { svc, policyReplay } = makeScheduler(db, baseFeedbackKpis, {
      isEvaluated: jest.fn().mockReturnValue(true),
      evaluate: jest.fn().mockResolvedValue(replay),
    });
    await svc.registerPolicyVersion({ ...defaultConfig(), horizonMinutes: 720 }, ACTOR);

    const comparison = await svc.comparePolicyVersion(2);
    expect(comparison.replay).toEqual(replay);
    expect(comparison.replay!.objectiveDelta).toBe(-3);
    expect(comparison.replay!.verdict).toBe('candidate_better');
    // 旧字段保持兼容。
    expect(comparison.candidateVersion).toBe(2);
    expect(comparison.feedbackKpis).toEqual(baseFeedbackKpis);
  });

  it('activate 无 approver → 拒绝 400（APPROVER_REQUIRED）', async () => {
    const config = defaultConfig();
    const { db } = makePolicyDb(seedPolicyRows(config, 1));
    const { svc } = makeScheduler(db);
    await svc.registerPolicyVersion({ ...defaultConfig(), horizonMinutes: 720 }, ACTOR);
    await expect(
      svc.activatePolicyVersion(2, { reason: 'x' }),
    ).rejects.toThrow('APPROVER_REQUIRED');
    await expect(
      svc.activatePolicyVersion(2, { approver: '', reason: 'x' }),
    ).rejects.toThrow('APPROVER_REQUIRED');
  });

  it('activate 无 reason → 拒绝 400（REASON_REQUIRED）', async () => {
    const config = defaultConfig();
    const { db } = makePolicyDb(seedPolicyRows(config, 1));
    const { svc } = makeScheduler(db);
    await svc.registerPolicyVersion({ ...defaultConfig(), horizonMinutes: 720 }, ACTOR);
    await expect(
      svc.activatePolicyVersion(2, { approver: 'op1', reason: '' }),
    ).rejects.toThrow('REASON_REQUIRED');
  });

  it('未完成 replay 评估 → 拒绝 409（POLICY_NOT_EVALUATED）', async () => {
    const config = defaultConfig();
    const { db } = makePolicyDb(seedPolicyRows(config, 1));
    const { svc } = makeScheduler(db, baseFeedbackKpis, {
      isEvaluated: jest.fn().mockReturnValue(false),
      evaluate: jest.fn().mockResolvedValue(null),
    });
    await svc.registerPolicyVersion({ ...defaultConfig(), horizonMinutes: 720 }, ACTOR);
    await expect(
      svc.activatePolicyVersion(2, { approver: 'op1', reason: 'x' }),
    ).rejects.toThrow('POLICY_NOT_EVALUATED');
  });

  it('已激活版本不可重复 activate → 拒绝 409（POLICY_ALREADY_ACTIVE）', async () => {
    const config = defaultConfig();
    const { db } = makePolicyDb(seedPolicyRows(config, 1));
    const { svc } = makeScheduler(db);
    await expect(
      svc.activatePolicyVersion(1, { approver: 'op1', reason: 'x' }),
    ).rejects.toThrow('POLICY_ALREADY_ACTIVE');
  });
});

describe('P2-T2: Solver Objective 8 权重版本化', () => {
  function makePolicyDbWithConfig(config: SchedulingPolicyConfig, weightsJson?: unknown) {
    const rows = [
      {
        configVersion: 1,
        configJson: config,
        weightsJson: weightsJson ?? null,
        active: true,
        orgId: 'org1',
        updatedBy: 'admin',
        createdAt: new Date('2026-08-08T00:00:00.000Z'),
        updatedAt: new Date('2026-08-08T00:00:00.000Z'),
      },
    ];
    const { db } = makePolicyDb(rows);
    return new SchedulingPolicyService(db);
  }

  it('旧配置无 weights → 8 权重用默认常量（不再魔法数派生，向后兼容）', async () => {
    const policyService = makePolicyDbWithConfig(defaultConfig());
    const policy = await policyService.getActivePolicy();
    expect(policy.weights).toEqual({
      lateness: 3,
      travel: 1,
      wait: 1,
      workload: 1,
      station: 1,
      change: 0.5,
      risk: 1,
      energy: 0.5,
    });
    // 旧字段兼容别名 = 权威权重。
    expect(policy.latenessWeight).toBe(3);
    expect(policy.walkingWeight).toBe(1);
    expect(policy.stationWaitWeight).toBe(1);
    expect(policy.changeCostWeight).toBe(0.5);
  });

  it('config.weights 完整 8 项 → 权威权重直接采用', async () => {
    const config: SchedulingPolicyConfig = {
      ...defaultConfig(),
      weights: {
        lateness: 5,
        travel: 2,
        wait: 3,
        workload: 4,
        station: 2,
        change: 1,
        risk: 6,
        energy: 0.1,
      },
    };
    const policyService = makePolicyDbWithConfig(config);
    const policy = await policyService.getActivePolicy();
    expect(policy.weights).toEqual({
      lateness: 5,
      travel: 2,
      wait: 3,
      workload: 4,
      station: 2,
      change: 1,
      risk: 6,
      energy: 0.1,
    });
  });

  it('weights_json 列优先于 config.weights（权威存储）', async () => {
    const config: SchedulingPolicyConfig = {
      ...defaultConfig(),
      weights: { lateness: 1, travel: 1, wait: 1, workload: 1, station: 1, change: 1, risk: 1, energy: 1 },
    };
    const policyService = makePolicyDbWithConfig(config, {
      lateness: 9,
      travel: 8,
      wait: 7,
      workload: 6,
      station: 5,
      change: 4,
      risk: 3,
      energy: 2,
    });
    const policy = await policyService.getActivePolicy();
    expect(policy.weights.lateness).toBe(9);
    expect(policy.weights.energy).toBe(2);
  });

  it('旧配置子集（workloadBalance/stationWait/changeCost/energy）→ 兼容映射补齐默认', async () => {
    const config: SchedulingPolicyConfig = {
      ...defaultConfig(),
      weights: { workloadBalance: 4, stationWait: 5, changeCost: 2, energy: 0.7 },
    };
    const policyService = makePolicyDbWithConfig(config);
    const policy = await policyService.getActivePolicy();
    expect(policy.weights.workload).toBe(4);
    expect(policy.weights.wait).toBe(5);
    expect(policy.weights.change).toBe(2);
    expect(policy.weights.energy).toBe(0.7);
    // 缺失项用默认常量。
    expect(policy.weights.lateness).toBe(3);
    expect(policy.weights.station).toBe(1);
  });

  // ── NO-13o / ADR-064：policy_activation 决策留痕（kind #8——8 类收口） ──

  it('NO-13o：activate 行翻转 → decisionJson 与 active 同 UPDATE 落库（契约门内 + 判定事实）', async () => {
    const config = defaultConfig();
    const { db, policies } = makePolicyDb(seedPolicyRows(config, 1));
    const { svc } = makeScheduler(db);

    await svc.registerPolicyVersion({ ...defaultConfig(), horizonMinutes: 720 }, ACTOR);
    const { config: activated } = await svc.activatePolicyVersion(
      2,
      { approver: 'op1', reason: '人工审批激活' },
      { userId: 'op1', primaryOrgId: 'org1' } as never,
    );
    expect(activated.configVersion).toBe(2);
    const v2 = policies.find((p) => p.configVersion === 2);
    const decision = v2?.decisionJson as Record<string, unknown>;
    expect(decision).toBeDefined();
    expect(decision.decisionId).toBe('decision:policy:v2:activation');
    expect(decision.kind).toBe('policy_activation');
    expect(decision.status).toBe('executed');
    expect(decision.decisionAuthority).toBe('human');
    expect(decision.subject).toBe('policy:v2');
    expect(decision.riskLevel).toBe('high');
    expect((decision.selected as Record<string, unknown>).reason).toEqual(['人工审批激活']);
    expect((decision.approver as Record<string, unknown>).actor).toBe('user:op1');
    expect(validateDecision(decision)).toEqual([]);
  });

  it('NO-13o：savePolicy 直接保存即激活路径 → decisionJson 落库（reason 缺省）', async () => {
    const { db, policies } = makePolicyDb(seedPolicyRows(defaultConfig(), 1));
    const requestDatabaseContext = {
      runInTransaction: jest.fn(async (_guc: unknown, cb: () => Promise<void>) => cb()),
    };
    const policyService = new SchedulingPolicyService(
      db,
      requestDatabaseContext as unknown as RequestDatabaseContext,
    );
    const saved = await policyService.savePolicy(defaultConfig(), 'org1', 'admin');
    expect(requestDatabaseContext.runInTransaction).toHaveBeenCalledTimes(1);
    expect(saved.configVersion).toBe(2);
    const v2 = policies.find((p) => p.configVersion === 2);
    const decision = v2?.decisionJson as Record<string, unknown>;
    expect(decision).toBeDefined();
    expect(decision.decisionId).toBe('decision:policy:v2:activation');
    expect((decision.selected as Record<string, unknown>).reason).toEqual(['policy-save-activated']);
    expect(validateDecision(decision)).toEqual([]);
  });
});
