/* empirical-duration-prediction-provider.ts — 经验时长预测提供者（NO-13g / ADR-056，§10）。
 *
 * PredictionProvider 实现：时长预测优先真实统计模型（训练自执行反馈），
 * 其余维度与 OOD 情形回退确定性基线（显式 fallback，§33 绝不静默）。
 * 语义边界与既有约定一致：预测只是优化器输入，绝不替代 hard constraints
 * （shadow-only，ADR-056）。
 */
import {
  DEFAULT_TASK_DURATION_MS,
  DeterministicPredictionProvider,
  type PredictionLocation,
  type PredictionPerson,
  type PredictionResult,
  type PredictionTask,
} from './prediction-provider';
import { durationConfidence, durationModelVersion, type DurationModel } from './empirical-duration-model';

export interface OrgModelEntry {
  model: DurationModel;
  registryVersion: number;
  taskTypes: Map<string, { model: DurationModel; registryVersion: number }>;
}

/** 预测提供者注入 token（shadow only）：消费者注入用 @Inject(PREDICTION_PROVIDER)。 */
export const PREDICTION_PROVIDER = 'PREDICTION_PROVIDER';

export class EmpiricalDurationPredictionProvider {
  // NO-13u / ADR-070：模型按 org 键控（租户隔离机器强制；预测必须携带 orgId）。
  private orgModels = new Map<string, OrgModelEntry>();
  private readonly deterministic = new DeterministicPredictionProvider();

  /** 训练/注册表回填后刷新某租户模型（org 作用域：全局 + per-taskType 分组）。 */
  refreshForOrg(
    orgId: string,
    model: DurationModel | null,
    registryVersion: number,
    taskTypeEntries: Map<string, { model: DurationModel; registryVersion: number }> = new Map(),
  ): void {
    if (!orgId?.trim()) return; // 无租户上下文的刷新显式忽略（§15 不静默全局）。
    if (model) {
      this.orgModels.set(orgId, { model, registryVersion, taskTypes: new Map(taskTypeEntries) });
    } else {
      this.orgModels.delete(orgId);
    }
  }

  /** 某租户当前模型（审计/测试读面）。 */
  currentModelsForOrg(orgId: string): { model: DurationModel | null; registryVersion: number } {
    const entry = this.orgModels.get(orgId);
    return entry
      ? { model: entry.model, registryVersion: entry.registryVersion }
      : { model: null, registryVersion: 0 };
  }

  async predictTaskDuration(task: PredictionTask): Promise<PredictionResult> {
    const hasTaskDuration =
      typeof task.durationMs === 'number' && Number.isFinite(task.durationMs) && task.durationMs > 0;
    if (hasTaskDuration) {
      // 任务自带时长 = 任务级真实事实（与确定性基线同语义）：直接采用，不叠加模型。
      return this.deterministic.predictTaskDuration(task);
    }
    // NO-13u / ADR-070：模型 org 键控——缺 orgId → 显式回退确定性基线（§33 不静默跨租户共享）。
    const orgId = typeof task.orgId === 'string' ? task.orgId : undefined;
    const entry = orgId ? this.orgModels.get(orgId) : undefined;
    if (!entry) {
      return this.deterministic.predictTaskDuration(task);
    }
    // 分组优先 → org 全局 → 确定性基线（显式两级回退，source 如实标注）。
    const grouped = task.taskType ? entry.taskTypes.get(task.taskType) : undefined;
    if (grouped) {
      return {
        value: grouped.model.medianMs,
        modelVersion: durationModelVersion(grouped.registryVersion),
        confidence: durationConfidence(grouped.model),
        source: 'ml',
      };
    }
    return {
      value: entry.model.medianMs,
      modelVersion: durationModelVersion(entry.registryVersion),
      confidence: durationConfidence(entry.model),
      source: 'ml',
    };
  }

  predictTravelTime(from: PredictionLocation, to: PredictionLocation): Promise<PredictionResult> {
    return this.deterministic.predictTravelTime(from, to);
  }

  predictBatteryConsumption(task: PredictionTask): Promise<PredictionResult> {
    return this.deterministic.predictBatteryConsumption(task);
  }

  predictStationQueueTime(station: PredictionLocation): Promise<PredictionResult> {
    return this.deterministic.predictStationQueueTime(station);
  }

  predictExecutionRisk(task: PredictionTask): Promise<PredictionResult> {
    return this.deterministic.predictExecutionRisk(task);
  }

  predictFatigueRisk(person: PredictionPerson): Promise<PredictionResult> {
    return this.deterministic.predictFatigueRisk(person);
  }

  isAvailable(): Promise<boolean> {
    return Promise.resolve(true);
  }

  confidenceThreshold(): number {
    return 0.5;
  }

  static readonly FALLBACK_DURATION_MS = DEFAULT_TASK_DURATION_MS;
}
