/* duration-model-training.service.spec.ts — 模型重训/激活闭环（NO-13g / ADR-056，§10/§12/§33）。
 *
 * 覆盖：真实反馈 → 训练 → ewoh_model_registry 落版（supersede 旧 active +
 * 版本递增）+ provider 刷新；样本不足 → 显式 not_enough_data 不落版；
 * hydrate 从注册表回填（冷启动恢复训练态）。
 */
/// <reference types="jest" />
import { BadRequestException } from '@nestjs/common';
import { DurationModelTrainingService } from '../duration-model-training.service';
import { ewohSchedulingFeedback, ewohProductionTask, ewohModelRegistry } from '@server/database/schema';
import { orgModelId, orgTaskTypeModelId } from '../empirical-duration-model';
import type { EmpiricalDurationPredictionProvider } from '../empirical-duration-prediction-provider';

function makeFakeDb(seed: {
  feedback?: Array<Record<string, unknown>>;
  tasks?: Array<Record<string, unknown>>;
  models?: Array<Record<string, unknown>>;
}) {
  const feedback = [...(seed.feedback ?? [])];
  const tasks = [...(seed.tasks ?? [])];
  const models = [...(seed.models ?? [])];
  const updated: Array<Record<string, unknown>> = [];
  const rowsOf = (table: unknown): Array<Record<string, unknown>> => {
    if (table === ewohSchedulingFeedback) return feedback;
    if (table === ewohProductionTask) return tasks;
    if (table === ewohModelRegistry) return models;
    return [];
  };
  // 条件匹配（eq/and 树递归收集字符串：modelId / id 前缀）。
  function collectStrings(node: unknown, out: Set<string>, seen: WeakSet<object>): void {
    if (node == null || typeof node !== 'object') return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    for (const value of Object.values(node as Record<string, unknown>)) {
      if (typeof value === 'string') out.add(value);
      else collectStrings(value, out, seen);
    }
  }
  function matches(cond: unknown, row: Record<string, unknown>): boolean {
    const values = new Set<string>();
    collectStrings(cond, values, new WeakSet());
    const modelIds = [...values].filter((v) => v.includes('task-duration-empirical'));
    const ids = [...values].filter((v) => v.startsWith('m-'));
    // ADR-075：org 值过滤器排除列元数据串（org_id/…_org_id_unique 等含 '_' 的标识符），只匹配真实 org 值。
    const orgs = [...values].filter((v) => typeof v === 'string' && v.startsWith('org') && !v.includes('_'));
    // hydrateFromRegistry 用 like(`${orgModelId}%`) 前缀列举——以 % 结尾的值按前缀匹配。
    if (modelIds.length > 0) {
      const hit = modelIds.some((v) =>
        v.endsWith('%')
          ? String(row.modelId).startsWith(v.slice(0, -1))
          : String(row.modelId) === v,
      );
      if (!hit) return false;
    }
    if (ids.length > 0 && !ids.includes(String(row.id))) return false;
    if (orgs.length > 0 && !orgs.includes(String(row.orgId))) return false;
    return true;
  }
  function thenable(data: unknown[]): unknown {
    return {
      then: (resolve: (v: unknown[]) => void) => resolve(data),
      orderBy: jest.fn(() => thenable(data)),
      limit: jest.fn(() => thenable(data.slice(0, 2000))),
    };
  }
  const db = {
    select: jest.fn(() => ({
      from: jest.fn((table: unknown) => {
        const q = thenable(rowsOf(table)) as { where: jest.Mock; orderBy: jest.Mock };
        q.where = jest.fn((cond: unknown) => thenable(rowsOf(table).filter((r) => matches(cond, r))));
        return q;
      }),
    })),
    insert: jest.fn((table: unknown) => ({
      values: jest.fn((row: Record<string, unknown>) => {
        if (table === ewohModelRegistry) models.push(row);
        return { returning: jest.fn(async () => [row]) };
      }),
    })),
    update: jest.fn((table: unknown) => ({
      set: jest.fn((patch: Record<string, unknown>) => ({
        where: jest.fn((cond: unknown) => {
          updated.push(patch);
          for (const m of models) {
            if (matches(cond, m)) Object.assign(m, patch);
          }
          return { returning: jest.fn(async () => models) };
        }),
      })),
    })),
  };
  const provider = {
    refreshForOrg: jest.fn(),
  };
  const service = new DurationModelTrainingService(
    db as never,
    provider as unknown as EmpiricalDurationPredictionProvider,
  );
  return { db, models, tasks, updated, provider, service };
}

const DUR = (ms: number) => ({ start: new Date(0), end: new Date(ms) });

function feedbackRow(i: number, durationMs: number, orgId = 'org1') {
  return {
    id: `fb-${i}`,
    orgId,
    taskId: `t-${i}`,
    actualStart: new Date(1_700_000_000_000),
    actualEnd: new Date(1_700_000_000_000 + durationMs),
    receiptSource: 'real',
    productionTrainingEligible: true,
    provenanceJson: {
      policy: 'receipt-provenance-v1', source: 'real',
      independentReceipt: {
        policy: 'persisted-device-receipt-v1', source: 'device_receipt',
        executionId: `exec-${i}`, assignmentId: `a-${i}`, planId: `p-${i}`, taskId: `t-${i}`, deviceId: `d-${i}`,
        actualStartAt: new Date(1_700_000_000_000).toISOString(),
        actualEndAt: new Date(1_700_000_000_000 + durationMs).toISOString(),
      },
    },
  };
}

describe('DurationModelTrainingService（NO-13g / ADR-056）', () => {
  it('真实反馈 → 训练 → 注册表落版（版本递增 + supersede 旧 active）+ provider 刷新', async () => {
    const { models, updated, provider, service } = makeFakeDb({
      feedback: [1, 2, 3, 4, 5].map((i) => feedbackRow(i, 1000 + i * 100)),
      models: [
        {
          id: 'm-1',
          modelId: orgModelId('org1'),
          version: 'empirical-v2',
          status: 'active',
          cardJson: { n: 5, medianMs: 1200, p90Ms: 1400, spreadMs: 200 },
        },
      ],
    });
    const summary = await service.retrain('org1');
    expect(summary.ok).toBe(true);
    expect(summary.version).toBe('empirical-v3');
    expect(summary.model?.count).toBe(5);
    expect(models).toHaveLength(2);
    expect(models[1].status).toBe('active');
    // ADR-075：注册表行归属注入（org 事实 = R-91 modelId org 命名空间）。
    expect(models[1].orgId).toBe('org1');
    expect(models[0].status).toBe('superseded');
    expect(updated).toHaveLength(1);
    expect(provider.refreshForOrg).toHaveBeenCalledWith(
      'org1', expect.objectContaining({ count: 5 }), 3, expect.any(Map),
    );
  });

  it('样本不足（< MIN_SAMPLES）→ 显式 not_enough_data 不落版不伪造（§33）', async () => {
    const { models, provider, service } = makeFakeDb({
      feedback: [feedbackRow(1, 1000), feedbackRow(2, 1200)],
      models: [],
    });
    const summary = await service.retrain('org1');
    expect(summary.ok).toBe(false);
    expect(summary.version).toBeNull();
    expect(summary.notEnoughDataReason).toBe('not_enough_data:2');
    expect(models).toHaveLength(0);
    expect(provider.refreshForOrg).not.toHaveBeenCalled();
  });

  it('无反馈 → no_finite_samples 显式', async () => {
    const { service } = makeFakeDb({ feedback: [], models: [] });
    const summary = await service.retrain('org1');
    expect(summary.ok).toBe(false);
    expect(summary.notEnoughDataReason).toBe('no_finite_samples');
  });

  it('hydrateFromRegistry：冷启动从注册表回填训练态（版本号解析）', async () => {
    const { provider, service } = makeFakeDb({
      models: [
        {
          id: 'm-1',
          modelId: orgModelId('org1'),
          version: 'empirical-v4',
          status: 'active',
          cardJson: { n: 20, medianMs: 900, p90Ms: 1300, spreadMs: 400 },
        },
      ],
    });
    await service.hydrateFromRegistry('org1');
    expect(provider.refreshForOrg).toHaveBeenCalledWith(
      'org1', expect.objectContaining({ medianMs: 900, count: 20 }), 4, expect.any(Map),
    );
  });

  it('hydrate：无 active 或非法数值 → 不刷新（显式安全）', async () => {
    const { provider, service } = makeFakeDb({
      models: [
        { id: 'm-1', modelId: orgModelId('org1'), version: 'empirical-v1', status: 'superseded', cardJson: { n: 5, medianMs: 900, p90Ms: 1300, spreadMs: 400 } },
      ],
    });
    await service.hydrateFromRegistry('org1');
    expect(provider.refreshForOrg).not.toHaveBeenCalled();
  });

  // ── NO-13r / ADR-067：per-taskType 分组训练（决策 2/3） ──

  it('NO-13r：分组训练 → 每 taskType 独立注册表 modelId 链 + provider 分组映射刷新', async () => {
    const { models, provider, service } = makeFakeDb({
      // 8 条反馈：5 条 carry（taskType=carry）+ 3 条 work（不足 5 → 显式跳过）。
      feedback: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => feedbackRow(i, 1000 + i * 100)),
      tasks: [
        ...Array.from({ length: 5 }, (_, i) => ({ id: `t-${i + 1}`, taskType: 'carry' })),
        ...Array.from({ length: 3 }, (_, i) => ({ id: `t-${i + 6}`, taskType: 'work' })),
      ],
      models: [],
    });
    const summary = await service.retrain('org1');
    expect(summary.ok).toBe(true);
    // org 全局 + carry 分组 = 2 条注册表行；work 分组不足 5 样本 → 显式 skipped 不落版。
    expect(models.map((m) => m.modelId)).toEqual([
      orgModelId('org1'),
      orgTaskTypeModelId('org1', 'carry'),
    ]);
    expect(summary.perTaskType).toHaveLength(2);
    const carry = summary.perTaskType?.find((e) => e.taskType === 'carry');
    const work = summary.perTaskType?.find((e) => e.taskType === 'work');
    expect(carry?.ok).toBe(true);
    expect(carry?.model?.count).toBe(5);
    expect(work?.ok).toBe(false);
    expect(work?.notEnoughDataReason).toBe('not_enough_data:3');
    // provider org 键控刷新（org 全局 + carry 分组）。
    expect(provider.refreshForOrg).toHaveBeenCalled();
    const [refreshedOrg, , , refreshedMap] = provider.refreshForOrg.mock.calls[0] as [
      string, { count: number }, number, Map<string, { model: { count: number }; registryVersion: number }>
    ];
    expect(refreshedOrg).toBe('org1');
    const map = refreshedMap;
    expect(map.has('carry')).toBe(true);
    expect(map.get('carry')?.model.count).toBe(5);
    expect(map.has('work')).toBe(false);
    // 分组注册表行 cardJson 携带 taskType 判定事实。
    expect((models[1].cardJson as Record<string, unknown>).taskType).toBe('carry');
  });

  it('NO-13u：跨租户隔离机器强制——他租户反馈不参与本租户训练（§15/§16）', async () => {
    const { models, provider, service } = makeFakeDb({
      // org1 5 条 + org2 5 条（他租户不得进入 org1 模型）。
      feedback: [
        ...Array.from({ length: 5 }, (_, i) => feedbackRow(i + 1, 1000 + i * 100, 'org1')),
        ...Array.from({ length: 5 }, (_, i) => feedbackRow(i + 6, 5000 + i * 100, 'org2')),
      ],
      models: [],
    });
    const summary = await service.retrain('org1');
    expect(summary.ok).toBe(true);
    expect(summary.model?.count).toBe(5); // 仅本租户 5 条
    expect(models.map((m) => m.modelId)).toEqual([orgModelId('org1')]);
    // 他租户模型链未写入。
    expect(models.some((m) => m.modelId === orgModelId('org2'))).toBe(false);
  });

  it('NO-13u：retrain 缺 orgId → 显式 400（§15 不静默全局训练）', async () => {
    const { service } = makeFakeDb({ feedback: [], models: [] });
    await expect(service.retrain('  ')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('NO-13r：hydrate 全量回填 → 分组映射重建（冷启动恢复分组训练态）', async () => {
    const { provider, service } = makeFakeDb({
      models: [
        {
          id: 'm-1',
          modelId: orgModelId('org1'),
          version: 'empirical-v4',
          status: 'active',
          cardJson: { n: 20, medianMs: 900, p90Ms: 1300, spreadMs: 400 },
        },
        {
          id: 'm-2',
          modelId: orgTaskTypeModelId('org1', 'carry'),
          version: 'empirical-v2',
          status: 'active',
          cardJson: { n: 12, medianMs: 1500, p90Ms: 2100, spreadMs: 600 },
        },
      ],
    });
    await service.hydrateFromRegistry('org1');
    expect(provider.refreshForOrg).toHaveBeenCalled();
    const [hOrg, , , hMap] = provider.refreshForOrg.mock.calls[0] as [
      string, { medianMs: number }, number, Map<string, { model: { medianMs: number }; registryVersion: number }>
    ];
    expect(hOrg).toBe('org1');
    const map = hMap;
    expect(map.get('carry')?.model.medianMs).toBe(1500);
    expect(map.get('carry')?.registryVersion).toBe(2);
  });
});

