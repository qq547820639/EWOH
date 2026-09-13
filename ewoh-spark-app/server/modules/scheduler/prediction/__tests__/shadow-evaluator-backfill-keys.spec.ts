/* R-3（2026-09-13）学习腿接线：采样/回填关联键 regression。
 *
 * 锁定不变量：backfillActual 的**内存**匹配优先级必须与持久化侧 applyPersistedBackfill 完全一致
 * （correlationId → (taskId, predictionType) → (predictionType, createdAt)）。
 *
 * 为什么值得锁定：采样发生在方案派工前、回填发生在任务真实执行后，回填侧拿不到采样时刻
 * （createdAt），只能用 correlationId 精确匹配。若内存侧仍严格按 createdAt 比较：
 *   - 内存样本 actual 永久为 null → coverage 恒 0 → canary 永不达标（autoRollbackOn 形同虚设）；
 *   - DB 行被更新而内存聚合不更新 → aggregate() 与 aggregatePersisted() 长期互相矛盾。
 * 这两条都是"静默"故障（无异常、无日志降级），只有回归断言能拦住。
 */
/// <reference types="jest" />
import {
  ShadowEvaluatorService,
  shadowCorrelationId,
  stableSampleSeed,
} from '../shadow-evaluator.service';
import type { OrgContext } from '../../../shared/org-context.interceptor';

const orgA: OrgContext = {
  userId: 'uA',
  primaryOrgId: 'orgA',
  role: 'system',
  accessibleOrgIds: ['orgA'],
  isGlobalAdmin: false,
};

const NOW = '2026-08-10T00:00:00.000Z';

describe('R-3 shadow backfill 关联键', () => {
  it('correlationId 优先：采样时刻与回填时刻不同也能精确命中', () => {
    const svc = new ShadowEvaluatorService();
    const corr = shadowCorrelationId('PLAN-1', 'ASG-1', 'TASK-1')!;
    svc.recordSample(
      {
        modelVersion: 'empirical-v1',
        predictionType: 'task_duration',
        inputVersion: 'ws-v1',
        prediction: 30,
        baseline: 40,
        confidence: 0.9,
        createdAt: NOW,
        taskId: 'TASK-1',
        correlationId: corr,
      },
      orgA,
    );

    // 回填侧只有执行回执（actualEnd），拿不到采样时刻 NOW。
    const matched = svc.backfillActual('task_duration', 10, '2026-08-10T09:00:00.000Z', orgA, {
      taskId: 'TASK-1',
      correlationId: corr,
    });

    expect(matched).toBe(true);
    const [sample] = svc.listSamples(orgA);
    expect(sample.actual).toBe(10);
    expect(sample.absoluteError).toBe(20);
    expect(sample.relativeError).toBeCloseTo(2);
  });

  it('correlationId 优先于同 createdAt 的其它样本（不会串台）', () => {
    const svc = new ShadowEvaluatorService();
    const corrA = shadowCorrelationId('PLAN-1', 'ASG-1', 'TASK-1')!;
    const corrB = shadowCorrelationId('PLAN-1', 'ASG-2', 'TASK-2')!;
    // 同一时刻两条样本：只有 correlationId 能区分它们。
    for (const [corr, taskId, prediction] of [
      [corrA, 'TASK-1', 30],
      [corrB, 'TASK-2', 90],
    ] as const) {
      svc.recordSample(
        {
          modelVersion: 'empirical-v1',
          predictionType: 'task_duration',
          inputVersion: 'ws-v1',
          prediction,
          baseline: 40,
          confidence: 0.9,
          createdAt: NOW,
          taskId,
          correlationId: corr,
        },
        orgA,
      );
    }

    svc.backfillActual('task_duration', 10, NOW, orgA, { correlationId: corrA });

    const samples = svc.listSamples(orgA);
    const a = samples.find((s) => s.correlationId === corrA)!;
    const b = samples.find((s) => s.correlationId === corrB)!;
    expect(a.actual).toBe(10);
    expect(a.absoluteError).toBe(20);
    expect(b.actual).toBeNull();
    // coverage：只有 1/2 被回填（另一条仍开放）。
    expect(svc.aggregate(orgA).coverage).toBeCloseTo(0.5);
  });

  it('无 correlationId 时按 (taskId, predictionType) 回退匹配（与持久化侧一致）', () => {
    const svc = new ShadowEvaluatorService();
    svc.recordSample(
      {
        modelVersion: 'empirical-v1',
        predictionType: 'task_duration',
        inputVersion: 'ws-v1',
        prediction: 50,
        baseline: 50,
        confidence: 0.9,
        createdAt: `${NOW}-a`,
        taskId: 'TASK-9',
      },
      orgA,
    );

    expect(
      svc.backfillActual('task_duration', 60, '2026-08-11T00:00:00.000Z', orgA, { taskId: 'TASK-9' }),
    ).toBe(true);
    expect(svc.listSamples(orgA)[0].absoluteError).toBe(10);
  });

  it('缺关联键时保持既有 (predictionType, createdAt) 语义', () => {
    const svc = new ShadowEvaluatorService();
    svc.recordSample(
      {
        modelVersion: 'm1',
        predictionType: 'task_duration',
        inputVersion: 'v1',
        prediction: 30,
        baseline: 40,
        confidence: 0.9,
        createdAt: `${NOW}-1`,
        taskId: 't1',
      },
      orgA,
    );

    // 时刻不匹配 → 不命中（旧语义必须保持，否则会误回填到别的窗口样本上）。
    expect(svc.backfillActual('task_duration', 20, `${NOW}-2`, orgA)).toBe(false);
    expect(svc.listSamples(orgA)[0].actual).toBeNull();
    // 时刻匹配 → 命中。
    expect(svc.backfillActual('task_duration', 20, `${NOW}-1`, orgA)).toBe(true);
    expect(svc.listSamples(orgA)[0].actual).toBe(20);
  });

  it('已回填样本不会被二次回填（actual IS NULL 前提）', () => {
    const svc = new ShadowEvaluatorService();
    const corr = shadowCorrelationId('PLAN-1', 'ASG-1', 'TASK-1')!;
    svc.recordSample(
      {
        modelVersion: 'empirical-v1',
        predictionType: 'task_duration',
        inputVersion: 'ws-v1',
        prediction: 30,
        baseline: 30,
        confidence: 0.9,
        createdAt: NOW,
        taskId: 'TASK-1',
        correlationId: corr,
      },
      orgA,
    );

    expect(svc.backfillActual('task_duration', 20, NOW, orgA, { correlationId: corr })).toBe(true);
    // 第二次同键回填：样本已关闭 → 不再改写（避免重复回执覆盖首个真值）。
    expect(svc.backfillActual('task_duration', 999, NOW, orgA, { correlationId: corr })).toBe(false);
    expect(svc.listSamples(orgA)[0].actual).toBe(20);
    expect(svc.listSamples(orgA)[0].absoluteError).toBe(10);
  });

  it('shadowCorrelationId：稳定键语义 + 不可构造时显式 null', () => {
    expect(shadowCorrelationId('PLAN-1', 'ASG-1', 'TASK-1')).toBe('PLAN-1|ASG-1|TASK-1');
    // 同一入参恒等（采样/回填两侧不漂移的前提）。
    expect(shadowCorrelationId('PLAN-1', 'ASG-1', 'TASK-1')).toBe(
      shadowCorrelationId('PLAN-1', 'ASG-1', 'TASK-1'),
    );
    // plan 级观测（无 assignment/task）→ 无可精确匹配键，调用方应显式不采样。
    expect(shadowCorrelationId('PLAN-1', null, null)).toBeNull();
    expect(shadowCorrelationId('', 'ASG-1', 'TASK-1')).toBeNull();
  });

  it('stableSampleSeed：确定性且落在 [0,1000)', () => {
    const key = shadowCorrelationId('PLAN-1', 'ASG-1', 'TASK-1')!;
    const seed = stableSampleSeed(key);
    expect(seed).toBe(stableSampleSeed(key));
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThan(1000);
  });
});
