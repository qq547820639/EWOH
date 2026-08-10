/* Task 5 / PredictionProvider（shadow only）测试。
 *
 * 覆盖：
 *   1. 接口契约：DeterministicPredictionProvider 实现全部 6 个预测方法 + isAvailable +
 *      confidenceThreshold，且每个方法返回 { value, modelVersion, confidence, source }。
 *   2. 确定性重放：同一输入 → 同一输出。
 *   3. 回退行为：不可用或低置信度时回退确定性基线。
 *   4. Shadow no-write：确定性 provider 无 DB 依赖，调用预测不触碰任何数据库。
 */
/// <reference types="jest" />
import {
  DeterministicPredictionProvider,
  resolvePrediction,
  DETERMINISTIC_MODEL_VERSION,
  DETERMINISTIC_SOURCE,
  DEFAULT_CONFIDENCE,
  DEFAULT_CONFIDENCE_THRESHOLD,
  type PredictionResult,
  type PredictionProvider,
} from '../prediction/prediction-provider';

/** 构造一个可控的 fake provider（用于回退行为测试，不写 DB）。 */
function makeFakeProvider(overrides?: {
  available?: boolean;
  result?: PredictionResult;
  threshold?: number;
}): PredictionProvider {
  const available = overrides?.available ?? true;
  const result =
    overrides?.result ??
    ({ value: 999, modelVersion: 'fake-v1', confidence: 0.99, source: 'ml' } satisfies PredictionResult);
  const threshold = overrides?.threshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  return {
    predictTaskDuration: () => Promise.resolve(result),
    predictTravelTime: () => Promise.resolve(result),
    predictBatteryConsumption: () => Promise.resolve(result),
    predictStationQueueTime: () => Promise.resolve(result),
    predictExecutionRisk: () => Promise.resolve(result),
    predictFatigueRisk: () => Promise.resolve(result),
    isAvailable: () => Promise.resolve(available),
    confidenceThreshold: () => threshold,
  };
}

describe('PredictionProvider (shadow only)', () => {
  const provider = new DeterministicPredictionProvider();

  describe('接口契约', () => {
    it('实现全部 6 个预测方法 + isAvailable + confidenceThreshold', async () => {
      expect(typeof provider.predictTaskDuration).toBe('function');
      expect(typeof provider.predictTravelTime).toBe('function');
      expect(typeof provider.predictBatteryConsumption).toBe('function');
      expect(typeof provider.predictStationQueueTime).toBe('function');
      expect(typeof provider.predictExecutionRisk).toBe('function');
      expect(typeof provider.predictFatigueRisk).toBe('function');
      expect(typeof provider.isAvailable).toBe('function');
      expect(typeof provider.confidenceThreshold).toBe('function');
      expect(await provider.isAvailable()).toBe(true);
      expect(provider.confidenceThreshold()).toBe(DEFAULT_CONFIDENCE_THRESHOLD);
    });

    it('每个方法返回 { value, modelVersion, confidence, source }', async () => {
      const calls: Array<Promise<PredictionResult>> = [
        provider.predictTaskDuration({}),
        provider.predictTravelTime({}, {}),
        provider.predictBatteryConsumption({}),
        provider.predictStationQueueTime({}),
        provider.predictExecutionRisk({}),
        provider.predictFatigueRisk({}),
      ];
      for (const p of calls) {
        const r = await p;
        expect(r).toHaveProperty('value');
        expect(r).toHaveProperty('modelVersion');
        expect(r).toHaveProperty('confidence');
        expect(r).toHaveProperty('source');
        expect(typeof r.value).toBe('number');
        expect(typeof r.modelVersion).toBe('string');
        expect(typeof r.confidence).toBe('number');
        expect(typeof r.source).toBe('string');
      }
    });

    it('确定性 baseline 版本/来源/置信度固定', async () => {
      const r = await provider.predictTaskDuration({});
      expect(r.modelVersion).toBe(DETERMINISTIC_MODEL_VERSION);
      expect(r.source).toBe(DETERMINISTIC_SOURCE);
      expect(r.confidence).toBe(DEFAULT_CONFIDENCE);
    });
  });

  describe('确定性重放', () => {
    it('同一输入 → 同一输出', async () => {
      const args = { taskId: 't1', durationMs: 1_800_000 };
      const a = await provider.predictTaskDuration(args);
      const b = await provider.predictTaskDuration(args);
      expect(a).toEqual(b);
    });

    it('传入 durationMs 时以其为确定性基线值', async () => {
      const r = await provider.predictTaskDuration({ durationMs: 7_000 });
      expect(r.value).toBe(7_000);
    });

    it('缺省时长使用固定默认值（30min）', async () => {
      const r = await provider.predictTaskDuration({});
      expect(r.value).toBe(30 * 60 * 1000);
    });
  });

  describe('回退行为', () => {
    const baseline = new DeterministicPredictionProvider();

    it('低置信度预测 → 回退到确定性基线', async () => {
      const lowConfidence = makeFakeProvider({
        available: true,
        result: { value: 999, modelVersion: 'ml-v1', confidence: 0.1, source: 'ml' },
      });
      const r = await resolvePrediction(
        lowConfidence,
        () => lowConfidence.predictTaskDuration({}),
        () => baseline.predictTaskDuration({}),
      );
      expect(r.source).toBe(DETERMINISTIC_SOURCE);
      expect(r.value).toBe(30 * 60 * 1000);
    });

    it('不可用 provider → 回退到确定性基线', async () => {
      const unavailable = makeFakeProvider({
        available: false,
        result: { value: 999, modelVersion: 'ml-v1', confidence: 0.99, source: 'ml' },
      });
      const r = await resolvePrediction(
        unavailable,
        () => unavailable.predictExecutionRisk({}),
        () => baseline.predictExecutionRisk({}),
      );
      expect(r.source).toBe(DETERMINISTIC_SOURCE);
    });

    it('高置信度且可用 → 采用预测值', async () => {
      const good = makeFakeProvider({
        available: true,
        result: { value: 123, modelVersion: 'ml-v1', confidence: 0.99, source: 'ml' },
      });
      const r = await resolvePrediction(
        good,
        () => good.predictExecutionRisk({}),
        () => baseline.predictExecutionRisk({}),
      );
      expect(r.value).toBe(123);
      expect(r.source).toBe('ml');
    });
  });

  describe('Shadow no-write', () => {
    it('确定性 provider 无 DB 依赖且调用预测不写任何数据', async () => {
      const providerStr = provider.constructor.toString();
      // 结构性断言：构造函数体与所有方法体均不引用 DB／write／insert 等副作用。
      expect(providerStr).not.toMatch(/db|database|insert|update\(|delete\(/i);
      await provider.predictTaskDuration({});
      await provider.predictTravelTime({}, {});
      await provider.predictBatteryConsumption({});
      await provider.predictStationQueueTime({});
      await provider.predictExecutionRisk({});
      await provider.predictFatigueRisk({});
      // 方法均为纯函数式返回，无状态变更：再次调用仍幂等。
      const a = await provider.predictExecutionRisk({});
      const b = await provider.predictExecutionRisk({});
      expect(a).toEqual(b);
    });
  });
});