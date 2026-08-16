/* empirical-duration-prediction.spec.ts — 经验时长模型 + 预测提供者（NO-13g / ADR-056，§10/§33）。 */
import {
  DURATION_MODEL_MIN_SAMPLES,
  durationConfidence,
  durationModelVersion,
  trainDurationModel,
} from '../empirical-duration-model';
import { EmpiricalDurationPredictionProvider } from '../empirical-duration-prediction-provider';
import { DEFAULT_TASK_DURATION_MS } from '../prediction-provider';

const SAMPLES = [10, 12, 15, 18, 20, 25, 30, 40, 50, 60];

describe('trainDurationModel（真实统计：median/p90/count/spread）', () => {
  it('样本集 → median/p90（最近秩百分位）确定性可重放', () => {
    const a = trainDurationModel(SAMPLES);
    const b = trainDurationModel(SAMPLES);
    expect(a).toEqual(b);
    expect(a.model).toEqual({ medianMs: 20, p90Ms: 50, count: 10, spreadMs: 30 });
  });

  it('空/非有限/样本不足 → null + 显式理由（§33 不伪造）', () => {
    expect(trainDurationModel([])).toEqual({ model: null, notEnoughDataReason: 'no_finite_samples' });
    expect(trainDurationModel([NaN, Infinity, -1] as number[])).toEqual({
      model: null,
      notEnoughDataReason: 'no_finite_samples',
    });
    expect(trainDurationModel([1, 2])).toEqual({
      model: null,
      notEnoughDataReason: `not_enough_data:2`,
    });
    expect(trainDurationModel('x' as never)).toEqual({ model: null, notEnoughDataReason: 'invalid_samples' });
  });

  it('置信度：样本量升 → 升；离散度升 → 降（0..1 裁剪）', () => {
    const small = trainDurationModel(SAMPLES.slice(0, DURATION_MODEL_MIN_SAMPLES)).model!;
    const large = trainDurationModel([...SAMPLES, ...Array.from({ length: 100 }, (_, i) => 20 + i)]).model!;
    expect(durationConfidence(large)).toBeGreaterThan(durationConfidence(small));
    const tight = trainDurationModel([20, 20, 20, 20, 20]).model!;
    const wide = trainDurationModel([1, 10, 20, 100, 500]).model!;
    expect(durationConfidence(tight)).toBeGreaterThan(durationConfidence(wide));
    for (const m of [small, large, tight, wide]) {
      const c = durationConfidence(m);
      expect(c).toBeGreaterThanOrEqual(0.1);
      expect(c).toBeLessThanOrEqual(0.95);
    }
  });

  it('版本串：注册表版本号递增 → empirical-vN', () => {
    expect(durationModelVersion(3)).toBe('empirical-v3');
  });
});

describe('EmpiricalDurationPredictionProvider（NO-13g / ADR-056）', () => {
  it('未训练（冷启动）→ 显式回退确定性基线（§33 不静默）', async () => {
    const provider = new EmpiricalDurationPredictionProvider();
    const result = await provider.predictTaskDuration({ taskId: 't1' });
    expect(result.value).toBe(DEFAULT_TASK_DURATION_MS);
    expect(result.source).toBe('deterministic');
    expect(result.modelVersion).toBe('deterministic-v1');
  });

  it('已训练（org 键控）→ 时长预测采用模型 median（ml 来源 + 版本 + 置信度）', async () => {
    const provider = new EmpiricalDurationPredictionProvider();
    const { model } = trainDurationModel(SAMPLES);
    provider.refreshForOrg('org1', model!, 3);
    const result = await provider.predictTaskDuration({ taskId: 't1', orgId: 'org1' });
    expect(result.value).toBe(20);
    expect(result.source).toBe('ml');
    expect(result.modelVersion).toBe('empirical-v3');
    expect(result.confidence).toBe(durationConfidence(model!));
    // 他租户不共享（§15 隔离机器强制）：缺 org 上下文 → 确定性基线。
    const other = await provider.predictTaskDuration({ taskId: 't2', orgId: 'org2' });
    expect(other.source).toBe('deterministic');
  });

  it('任务自带时长 = 任务级真实事实 → 确定性路径（模型不叠加）', async () => {
    const provider = new EmpiricalDurationPredictionProvider();
    const { model } = trainDurationModel(SAMPLES);
    provider.refreshForOrg('org1', model!, 1);
    const result = await provider.predictTaskDuration({ taskId: 't1', orgId: 'org1', durationMs: 1_200_000 });
    expect(result.value).toBe(1_200_000);
    expect(result.source).toBe('deterministic');
  });

  it('其余维度（travel/battery/queue/risk/fatigue）保持确定性基线', async () => {
    const provider = new EmpiricalDurationPredictionProvider();
    expect((await provider.predictBatteryConsumption({})).source).toBe('deterministic');
    expect((await provider.predictStationQueueTime({})).source).toBe('deterministic');
    expect(provider.isAvailable()).resolves.toBe(true);
  });

  // ── NO-13r / ADR-067：per-taskType 分组预测（两级回退显式） ──

  it('NO-13r：taskType 命中分组 → 分组模型优先（median + 分组版本链）', async () => {
    const provider = new EmpiricalDurationPredictionProvider();
    provider.refreshForOrg(
      'org1',
      { medianMs: 1000, p90Ms: 1400, count: 20, spreadMs: 400 },
      3,
      new Map([
        ['carry', { model: { medianMs: 2400, p90Ms: 3200, count: 12, spreadMs: 800 }, registryVersion: 2 }],
      ]),
    );
    const result = await provider.predictTaskDuration({ taskId: 't1', orgId: 'org1', taskType: 'carry' });
    expect(result.value).toBe(2400);
    expect(result.modelVersion).toBe('empirical-v2');
    expect(result.source).toBe('ml');
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('NO-13r：未知 taskType / 无分组 → 回退全局模型 → 再回退确定性基线（显式两级）', async () => {
    const provider = new EmpiricalDurationPredictionProvider();
    provider.refreshForOrg('org1', { medianMs: 1000, p90Ms: 1400, count: 20, spreadMs: 400 }, 3, new Map());
    // 未知 taskType → org 全局模型。
    const viaGlobal = await provider.predictTaskDuration({ taskId: 't2', orgId: 'org1', taskType: 'unknown' });
    expect(viaGlobal.value).toBe(1000);
    expect(viaGlobal.modelVersion).toBe('empirical-v3');
    expect(viaGlobal.source).toBe('ml');
    // 无 org 上下文/无模型 → 确定性基线（§33 不静默跨租户共享）。
    const cold = new EmpiricalDurationPredictionProvider();
    const fallback = await cold.predictTaskDuration({ taskId: 't3', taskType: 'carry' });
    expect(fallback.source).toBe('deterministic');
    expect(fallback.source).toBe('deterministic');
  });
});
