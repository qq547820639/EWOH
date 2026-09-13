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
    // 大误差样本：预测 100 / 实际 1 → 相对误差 99。
    svc.recordSample({ modelVersion: 'm1', predictionType: 'task_duration', inputVersion: 'v1', prediction: 100, baseline: 10, confidence: 0.9, createdAt: `${NOW}-x`, taskId: 't1' }, orgA);
    svc.backfillActual('task_duration', 1, `${NOW}-x`, orgA);
    const result = svc.evaluateCanary(
      { autoRollbackOn: { maxAbsoluteError: 0.25, maxFallbackRate: 0.5, minCoverage: 0.8 } },
      orgA,
    );
    expect(result.rolledBack).toBe(true);
    expect(result.canaryFraction).toBe(0);
    expect(result.reasons.some((r) => r.startsWith('relative_error_exceeded'))).toBe(true);
    // canary 已归零 → shouldSample=false。
    expect(svc.shouldSample(123, orgA)).toBe(false);
  });

  /**
   * 刻度不变量（2026-09-13 修正）：
   * `autoRollbackOn` 的三个阈值都是 **[0,1] 比率**（0.25 / 0.5 / 0.8），而样本的
   * prediction/actual **一律毫秒**。原先拿 ms 与 0.25 比 → "误差超过 0.25 毫秒即回退"，
   * 任何一次真实回填都会把 canary 归零，阶梯永远无法放量（可触发但不可用）。
   * 现在按相对误差判定；下面两条把两个方向都钉住。
   */
  it('刻度：绝对误差大但相对误差小 → 不回退（毫秒不再被当成比率）', () => {
    const svc = new ShadowEvaluatorService();
    svc.setCanaryFraction(0.2, orgA);
    // 30 分钟的任务，预测 31 分钟：绝对误差 60000ms（远超 0.25），相对误差 ~3.2%。
    svc.recordSample({ modelVersion: 'm1', predictionType: 'task_duration', inputVersion: 'v1', prediction: 1_860_000, baseline: 1_800_000, confidence: 0.9, createdAt: `${NOW}-scale-ok`, taskId: 't1' }, orgA);
    svc.backfillActual('task_duration', 1_800_000, `${NOW}-scale-ok`, orgA);
    const result = svc.evaluateCanary(
      { autoRollbackOn: { maxAbsoluteError: 0.25, maxFallbackRate: 0.5, minCoverage: 0.8 } },
      orgA,
    );
    expect(result.rolledBack).toBe(false);
    expect(svc.getCanaryFraction(orgA)).toBe(0.2);
  });

  it('刻度：相对误差超阈值 → 回退，且 reason 同时给出两个刻度', () => {
    const svc = new ShadowEvaluatorService();
    svc.setCanaryFraction(0.2, orgA);
    // 预测 30 分钟、实际 15 分钟：相对误差 100%（绝对 900000ms）。
    svc.recordSample({ modelVersion: 'm1', predictionType: 'task_duration', inputVersion: 'v1', prediction: 1_800_000, baseline: 1_800_000, confidence: 0.9, createdAt: `${NOW}-scale-bad`, taskId: 't1' }, orgA);
    svc.backfillActual('task_duration', 900_000, `${NOW}-scale-bad`, orgA);
    const result = svc.evaluateCanary(
      { autoRollbackOn: { maxAbsoluteError: 0.25, maxFallbackRate: 0.5, minCoverage: 0.8 } },
      orgA,
    );
    expect(result.rolledBack).toBe(true);
    const reason = result.reasons.find((r) => r.startsWith('relative_error_exceeded')) ?? '';
    expect(reason).toContain('绝对 mae=');
  });

  it('无带 actual 的样本 → error 不判定（缺证据 ≠ 零误差达标）', () => {
    const svc = new ShadowEvaluatorService();
    svc.setCanaryFraction(0.2, orgA);
    // 只采样、不回填：没有任何 relativeError 可算。
    svc.recordSample({ modelVersion: 'm1', predictionType: 'task_duration', inputVersion: 'v1', prediction: 100, baseline: 90, confidence: 0.9, createdAt: `${NOW}-nofill`, taskId: 't1' }, orgA);
    const result = svc.evaluateCanary(
      { autoRollbackOn: { maxAbsoluteError: 0.25, maxFallbackRate: 0.5, minCoverage: 0.8 } },
      orgA,
    );
    expect(result.reasons.some((r) => r.startsWith('error_undecidable'))).toBe(true);
  });

  /**
   * 自查修正（2026-09-13，R-3 接线实测）：canary 评估发生在**每条回执**之后，而采样
   * cohort 的其余任务此时还在执行。若 coverage 把在途（未到期）样本计入缺失：
   * 第一条回执必然 coverage=1/N < 0.8 → canary 被误杀归零（实测 coverage_low:0.5000），
   * 阶梯永远无法放量——与 mae 刻度问题同类"可触发但不可用"。修正后：只有过了
   * 预计可回填时刻（expectedActualAt，缺省 createdAt+baseline）+宽限仍无 actual 的
   * 样本才算缺失证据。
   */
  it('coverage：在途（未到期）样本不算缺失——首条回执不误杀 canary', () => {
    const svc = new ShadowEvaluatorService();
    svc.setCanaryFraction(0.2, orgA);
    const nowIso = new Date().toISOString();
    for (const t of ['t1', 't2']) {
      svc.recordSample({ modelVersion: 'm1', predictionType: 'task_duration', inputVersion: 'v1', prediction: 1_800_000, baseline: 1_800_000, confidence: 0.9, createdAt: nowIso, taskId: t, correlationId: `P|A|${t}`, expectedActualAt: new Date(Date.parse(nowIso) + 1_800_000).toISOString() }, orgA);
    }
    // t1 的回执先到（零误差）；t2 仍在途（计划窗口未结束）。
    svc.backfillActual('task_duration', 1_800_000, nowIso, orgA, { correlationId: 'P|A|t1' });
    const result = svc.evaluateCanary(undefined, orgA);
    expect(result.rolledBack).toBe(false);
    expect(svc.getCanaryFraction(orgA)).toBe(0.2);
  });

  it('coverage：到期仍无 actual 的样本照样触发回退（护栏不放松）', () => {
    const svc = new ShadowEvaluatorService();
    svc.setCanaryFraction(0.2, orgA);
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    // t1：零误差已回填（不构成坏证据）；t2：预计回填时刻已过 24h 仍未回填 → 断链证据。
    svc.recordSample({ modelVersion: 'm1', predictionType: 'task_duration', inputVersion: 'v1', prediction: 1_800_000, baseline: 1_800_000, confidence: 0.9, createdAt: old, taskId: 't1', correlationId: 'P|A|t1', expectedActualAt: old }, orgA);
    svc.recordSample({ modelVersion: 'm1', predictionType: 'task_duration', inputVersion: 'v1', prediction: 1_800_000, baseline: 1_800_000, confidence: 0.9, createdAt: old, taskId: 't2', correlationId: 'P|A|t2', expectedActualAt: old }, orgA);
    svc.backfillActual('task_duration', 1_800_000, old, orgA, { correlationId: 'P|A|t1' });
    const result = svc.evaluateCanary(undefined, orgA);
    expect(result.rolledBack).toBe(true);
    expect(result.reasons.some((r) => r.startsWith('coverage_low'))).toBe(true);
    expect(svc.getCanaryFraction(orgA)).toBe(0);
  });

  it('误差不可判定不单独回退（唯一回填样本 actual=0 → 只观测，canary 保持）', () => {
    const svc = new ShadowEvaluatorService();
    svc.setCanaryFraction(0.2, orgA);
    const nowIso = new Date().toISOString();
    svc.recordSample({ modelVersion: 'm1', predictionType: 'task_duration', inputVersion: 'v1', prediction: 1_800_000, baseline: 1_800_000, confidence: 0.9, createdAt: nowIso, taskId: 't1', correlationId: 'P|A|t1' }, orgA);
    // actual=0 → relativeError=null（除零保护）；此时误差不可判定。
    svc.backfillActual('task_duration', 0, nowIso, orgA, { correlationId: 'P|A|t1' });
    const result = svc.evaluateCanary(undefined, orgA);
    expect(result.reasons.some((r) => r.startsWith('error_undecidable'))).toBe(true);
    // 缺证据 ≠ 判负：canary 不因此归零。
    expect(result.rolledBack).toBe(false);
    expect(svc.getCanaryFraction(orgA)).toBe(0.2);
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
