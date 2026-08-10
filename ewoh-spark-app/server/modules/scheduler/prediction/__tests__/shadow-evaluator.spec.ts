/* Incremental Replan V2 / M05：Prediction Shadow Learning（08 §11）。
 *
 * 覆盖：样本记录正确；actual 回填后 MAE/RMSE/P50/P95/calibration 聚合正确；
 * fallbackRate/coverage 计算；canary 回退（error 超阈值 → canary 0 + rollback 事件）；
 * advisory-only 不写生产调度（纯内存，无 dispatch/plan 写入依赖）；
 * 租户隔离（orgA 样本不影响 orgB 聚合）。
 */
/// <reference types="jest" />
import { ShadowEvaluatorService } from '../shadow-evaluator.service';
import type { OrgContext } from '../../../shared/org-context.interceptor';

const orgA: OrgContext = {
  userId: 'uA',
  primaryOrgId: 'orgA',
  role: 'system',
  accessibleOrgIds: ['orgA'],
  isGlobalAdmin: false,
};
const orgB: OrgContext = {
  userId: 'uB',
  primaryOrgId: 'orgB',
  role: 'system',
  accessibleOrgIds: ['orgB'],
  isGlobalAdmin: false,
};

const NOW = '2026-08-10T00:00:00.000Z';

describe('M05 ShadowEvaluatorService', () => {
  it('样本记录正确：prediction/baseline/confidence/createdAt 保留，actual 初始 null', () => {
    const svc = new ShadowEvaluatorService();
    svc.recordSample(
      {
        modelVersion: 'model-v2',
        predictionType: 'task_duration',
        inputVersion: 'ws-v1',
        prediction: 30,
        baseline: 40,
        confidence: 0.9,
        createdAt: NOW,
        taskId: 't1',
      },
      orgA,
    );
    const samples = svc.listSamples(orgA);
    expect(samples).toHaveLength(1);
    expect(samples[0].prediction).toBe(30);
    expect(samples[0].baseline).toBe(40);
    expect(samples[0].actual).toBeNull();
    expect(samples[0].absoluteError).toBeNull();
  });

  it('actual 回填后 MAE/RMSE/P50/P95/calibration 聚合正确', () => {
    const svc = new ShadowEvaluatorService();
    // 误差集合：|30−20|=10, |50−60|=10, |100−90|=10 → MAE=10, RMSE=10, P50=10, P95=10。
    svc.recordSample({ modelVersion: 'm1', predictionType: 'task_duration', inputVersion: 'v1', prediction: 30, baseline: 40, confidence: 0.9, createdAt: `${NOW}-1`, taskId: 't1' }, orgA);
    svc.recordSample({ modelVersion: 'm1', predictionType: 'task_duration', inputVersion: 'v1', prediction: 50, baseline: 40, confidence: 0.9, createdAt: `${NOW}-2`, taskId: 't2' }, orgA);
    svc.recordSample({ modelVersion: 'm1', predictionType: 'task_duration', inputVersion: 'v1', prediction: 100, baseline: 40, confidence: 0.9, createdAt: `${NOW}-3`, taskId: 't3' }, orgA);
    svc.backfillActual('task_duration', 20, `${NOW}-1`, orgA);
    svc.backfillActual('task_duration', 60, `${NOW}-2`, orgA);
    svc.backfillActual('task_duration', 90, `${NOW}-3`, orgA);

    const agg = svc.aggregate(orgA);
    expect(agg.mae).toBeCloseTo(10);
    expect(agg.rmse).toBeCloseTo(10);
    expect(agg.p50).toBeCloseTo(10);
    expect(agg.p95).toBeCloseTo(10);
    // coverage：3/3 有 actual。
    expect(agg.coverage).toBeCloseTo(1);
    // fallbackRate：confidence 0.9 且 modelVersion != deterministic → 0。
    expect(agg.fallbackRate).toBeCloseTo(0);
  });

  it('fallbackRate/coverage：低置信度/确定性基线样本计入 fallback，未回填样本拉低 coverage', () => {
    const svc = new ShadowEvaluatorService();
    svc.recordSample({ modelVersion: 'deterministic-v1', predictionType: 'task_duration', inputVersion: 'v1', prediction: 30, baseline: 30, confidence: 0.3, createdAt: `${NOW}-a`, taskId: 't1' }, orgA);
    svc.recordSample({ modelVersion: 'ml-v1', predictionType: 'task_duration', inputVersion: 'v1', prediction: 50, baseline: 30, confidence: 0.9, createdAt: `${NOW}-b`, taskId: 't2' }, orgA);
    svc.backfillActual('task_duration', 55, `${NOW}-b`, orgA);
    const agg = svc.aggregate(orgA);
    // fallback：样本 a（deterministic/低置信度）→ 1/2。
    expect(agg.fallbackRate).toBeCloseTo(0.5);
    // coverage：仅 b 有 actual → 1/2。
    expect(agg.coverage).toBeCloseTo(0.5);
  });

  it('canary 回退：error 超阈值 → canary 归 0 + rollback 事件', () => {
    const svc = new ShadowEvaluatorService();
    svc.setCanaryFraction(0.2, orgA);
    expect(svc.getCanaryFraction(orgA)).toBe(0.2);
    // 大误差样本。
    svc.recordSample({ modelVersion: 'm1', predictionType: 'task_duration', inputVersion: 'v1', prediction: 100, baseline: 10, confidence: 0.9, createdAt: `${NOW}-x`, taskId: 't1' }, orgA);
    svc.backfillActual('task_duration', 1, `${NOW}-x`, orgA);
    const result = svc.evaluateCanary(
      { autoRollbackOn: { maxAbsoluteError: 0.25, maxFallbackRate: 0.5, minCoverage: 0.8 } },
      orgA,
    );
    expect(result.rolledBack).toBe(true);
    expect(result.canaryFraction).toBe(0);
    expect(result.reasons.some((r) => r.startsWith('mae_exceeded'))).toBe(true);
    // canary 已归零 → shouldSample=false。
    expect(svc.shouldSample(123, orgA)).toBe(false);
  });

  it('canary 达标时不回退（保持采样）', () => {
    const svc = new ShadowEvaluatorService();
    svc.setCanaryFraction(0.2, orgA);
    svc.recordSample({ modelVersion: 'm1', predictionType: 'task_duration', inputVersion: 'v1', prediction: 10, baseline: 10, confidence: 0.9, createdAt: `${NOW}-y`, taskId: 't1' }, orgA);
    svc.backfillActual('task_duration', 10, `${NOW}-y`, orgA);
    const result = svc.evaluateCanary(
      { autoRollbackOn: { maxAbsoluteError: 0.25, maxFallbackRate: 0.5, minCoverage: 0.8 } },
      orgA,
    );
    expect(result.rolledBack).toBe(false);
    expect(svc.getCanaryFraction(orgA)).toBe(0.2);
  });

  it('advisory-only：纯内存，不依赖 dispatch/plan 写入（无 db/outbox 依赖）', () => {
    // ShadowEvaluatorService 构造不注入 DB/outbox/dispatch —— 通过构造签名验证。
    const svc = new ShadowEvaluatorService();
    svc.recordSample({ modelVersion: 'm1', predictionType: 'task_duration', inputVersion: 'v1', prediction: 10, baseline: 10, confidence: 0.9, createdAt: NOW }, orgA);
    // 聚合/回退均不触达任何生产写路径。
    expect(svc.aggregate(orgA).mae).toBe(0);
  });

  it('租户隔离：orgA 样本不影响 orgB 聚合', () => {
    const svc = new ShadowEvaluatorService();
    svc.recordSample({ modelVersion: 'm1', predictionType: 'task_duration', inputVersion: 'v1', prediction: 30, baseline: 40, confidence: 0.9, createdAt: `${NOW}-1`, taskId: 't1' }, orgA);
    svc.backfillActual('task_duration', 20, `${NOW}-1`, orgA);
    svc.recordSample({ modelVersion: 'm1', predictionType: 'task_duration', inputVersion: 'v1', prediction: 1000, baseline: 10, confidence: 0.9, createdAt: `${NOW}-2`, taskId: 't9' }, orgB);

    const aggA = svc.aggregate(orgA);
    const aggB = svc.aggregate(orgB);
    expect(aggA.mae).toBeCloseTo(10);
    // orgB 只有一条未回填样本 → coverage=0, mae=0。
    expect(aggB.coverage).toBeCloseTo(0);
    expect(aggB.mae).toBe(0);
    expect(svc.listSamples(orgB)).toHaveLength(1);
  });
});
