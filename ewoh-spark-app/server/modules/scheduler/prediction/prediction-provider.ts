/* Task 5 / PredictionProvider（shadow only）。
 *
 * 影子（shadow-only）语义：
 *   - 预测结果只是调度优化器的『输入参数』，绝不替代 hard constraints，
 *     绝不写生产调度，绝不替换安全决策。
 *   - 确定性基线（DeterministicPredictionProvider）不依赖外部服务、无 DB 依赖、
 *     无随机源 → 同一输入总是同一输出，保证调度可确定性地重放。
 *   - 当预测不可用或置信度低于阈值时，优化器应回退到确定性基线。
 */

/** 预测调用方可能传入的最小结构化语义载荷（避免过度约束，保持接口可演进）。 */
export interface PredictionTask {
  taskId?: string;
  /** 任务类型（如 'patrol' | 'maintenance'），用于确定性基线推导。 */
  taskType?: string;
  /** 任务时长（ms），若提供则作为任务时长预测的确定性基线。 */
  durationMs?: number;
  [key: string]: unknown;
}

export interface PredictionLocation {
  lat?: number;
  lon?: number;
  stationId?: string;
  zoneId?: string;
  [key: string]: unknown;
}

export interface PredictionPerson {
  personId?: string;
  [key: string]: unknown;
}

/** 单个预测结果：值是调度优化器的输入参数，绝不替代 hard constraints。 */
export interface PredictionResult {
  /** 预测值（单位随方法语义：ms / 0..1 等）。 */
  value: number;
  /** 产生该预测的模型版本（确定性 baseline 为固定版本串）。 */
  modelVersion: string;
  /** 置信度 0..1；低于阈值时优化器应回退 baseline。 */
  confidence: number;
  /** 来源：'deterministic' | 'edge' | 'ml' 等。 */
  source: string;
}

/** 感知预测提供者接口（shadow only）：预测只是 Optimizer 的输入。 */
export interface PredictionProvider {
  predictTaskDuration(task: PredictionTask): Promise<PredictionResult>;
  predictTravelTime(from: PredictionLocation, to: PredictionLocation): Promise<PredictionResult>;
  predictBatteryConsumption(task: PredictionTask): Promise<PredictionResult>;
  predictStationQueueTime(station: PredictionLocation): Promise<PredictionResult>;
  predictExecutionRisk(task: PredictionTask): Promise<PredictionResult>;
  predictFatigueRisk(person: PredictionPerson): Promise<PredictionResult>;
  /** 服务是否可用；不可用时优化器使用确定性 baseline。 */
  isAvailable(): Promise<boolean>;
  /** 置信度达标阈值（0..1）。 */
  confidenceThreshold(): number;
}

/** 确定性基线参数（消除 magic numbers）。 */
export const DEFAULT_TASK_DURATION_MS = 30 * 60 * 1000; // 30min
export const DEFAULT_BATTERY_CONSUMPTION = 0.1; // 0..1
export const DEFAULT_STATION_QUEUE_MS = 5 * 60 * 1000; // 5min
export const DEFAULT_EXECUTION_RISK = 0.1; // 0..1
export const DEFAULT_FATIGUE_RISK = 0.1; // 0..1
export const DEFAULT_CONFIDENCE = 0.5;
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.5;
export const DETERMINISTIC_MODEL_VERSION = 'deterministic-v1';
export const DETERMINISTIC_SOURCE = 'deterministic';

/**
 * 确定性基线预测：版本化、不依赖外部服务、可重放。
 *
 * 无 DB 注入、无随机源、无外部调用 → 同一输入恒产生同一输出。
 */
export class DeterministicPredictionProvider implements PredictionProvider {
  predictTaskDuration(task: PredictionTask): Promise<PredictionResult> {
    const value =
      typeof task.durationMs === 'number' && Number.isFinite(task.durationMs) && task.durationMs > 0
        ? task.durationMs
        : DEFAULT_TASK_DURATION_MS;
    return Promise.resolve(this.baseline(value));
  }

  predictTravelTime(from: PredictionLocation, to: PredictionLocation): Promise<PredictionResult> {
    return Promise.resolve(this.baseline(DEFAULT_STATION_QUEUE_MS));
  }

  predictBatteryConsumption(task: PredictionTask): Promise<PredictionResult> {
    return Promise.resolve(this.baseline(DEFAULT_BATTERY_CONSUMPTION));
  }

  predictStationQueueTime(station: PredictionLocation): Promise<PredictionResult> {
    return Promise.resolve(this.baseline(DEFAULT_STATION_QUEUE_MS));
  }

  predictExecutionRisk(task: PredictionTask): Promise<PredictionResult> {
    return Promise.resolve(this.baseline(DEFAULT_EXECUTION_RISK));
  }

  predictFatigueRisk(person: PredictionPerson): Promise<PredictionResult> {
    return Promise.resolve(this.baseline(DEFAULT_FATIGUE_RISK));
  }

  isAvailable(): Promise<boolean> {
    return Promise.resolve(true);
  }

  confidenceThreshold(): number {
    return DEFAULT_CONFIDENCE_THRESHOLD;
  }

  private baseline(value: number): PredictionResult {
    return {
      value,
      modelVersion: DETERMINISTIC_MODEL_VERSION,
      confidence: DEFAULT_CONFIDENCE,
      source: DETERMINISTIC_SOURCE,
    };
  }
}

/**
 * 预测解析辅助函数（shadow-only）：当 provider 可用且置信度达标时采用预测值，
 * 否则回退到确定性基线。不写任何生产调度。
 *
 * @param provider   预测提供者（只需可用性与阈值）。
 * @param invoke     调用真实预测方法（返回本次预测结果）。
 * @param fallback   回退到确定性基线的调用。
 */
export async function resolvePrediction(
  provider: Pick<PredictionProvider, 'isAvailable' | 'confidenceThreshold'>,
  invoke: () => Promise<PredictionResult>,
  fallback: () => Promise<PredictionResult>,
): Promise<PredictionResult> {
  const available = await provider.isAvailable().catch(() => false);
  if (!available) {
    return fallback();
  }
  const threshold = provider.confidenceThreshold();
  const result = await invoke().catch(() => null);
  if (!result || result.confidence < threshold) {
    return fallback();
  }
  return result;
}