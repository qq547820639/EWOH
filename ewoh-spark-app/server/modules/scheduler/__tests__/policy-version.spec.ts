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

/** 从 drizzle eq(col, value) 的 SQL 对象 queryChunks 中提取相等谓词并应用于行。 */
function matchesEq(row: Record<string, unknown>, sqlExpr: unknown): boolean {
  const chunks = (sqlExpr as { queryChunks?: unknown[] } | undefined)?.queryChunks;
  if (!Array.isArray(chunks)) return true;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i] as { name?: string } | undefined;
    if (c && typeof c === 'object' && typeof c.name === 'string') {
      // 列名后紧跟 StringChunk(" = ")，再是 Param(value)，需向后扫描定位 Param。
      for (let j = i + 1; j < chunks.length; j++) {
        const n = chunks[j] as { encoder?: unknown; value?: unknown; name?: string } | undefined;
        if (n && typeof n === 'object' && 'encoder' in n && !Array.isArray(n.value)) {
          const key = COL_TO_KEY[c.name] ?? c.name;
          if (row[key] !== n.value) return false;
          break;
        }
        if (n && typeof n === 'object' && typeof n.name === 'string') break;
      }
    }
  }
  return true;
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
  );
  return { svc, auditService, policyService, feedbackService };
}

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
    await svc.registerPolicyVersion(candidateConfig);

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

  it('activate 翻转 active 并解除前一版本 + 写入审计', async () => {
    const config = defaultConfig();
    const { db, policies } = makePolicyDb(seedPolicyRows(config, 1));
    const { svc, auditService } = makeScheduler(db);

    await svc.registerPolicyVersion({
      ...defaultConfig(),
      horizonMinutes: 720,
    });

    const { config: activated } = await svc.activatePolicyVersion(2);
    expect(activated.configVersion).toBe(2);

    const v1 = policies.find((p) => p.configVersion === 1);
    const v2 = policies.find((p) => p.configVersion === 2);
    expect(v1?.active).toBe(false);
    expect(v2?.active).toBe(true);

    const active = await svc.getPolicy();
    expect(active.config.configVersion).toBe(2);

    // 审计已写入。
    expect(auditService.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'scheduler.policy.activate',
        entityId: '2',
        entityType: 'scheduling_policy',
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

    await svc.registerPolicyVersion({ ...defaultConfig(), horizonMinutes: 600 });
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
    await expect(svc.activatePolicyVersion(99)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});