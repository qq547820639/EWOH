/* duration-resolution.ts — 经验时长模型 → 求解器时长映射的**共享解析器**。
 *
 * ADR-056 消费侧（2026-09-13）：heuristic 与 MILP 求解器共用同一份"模型时长映射"
 * 解析，保证两族求解器在 durationModelMode='advisory' 下的时长输入**同源同判**
 * （shadow 双跑对比的公平性前提）。判定纪律与 heuristic 内联版本一致：
 * 只接受 source='ml' + 置信度达标 + 有限正值；逐任务回退，绝不猜。
 */
import { Logger } from '@nestjs/common';
import type { EmpiricalDurationPredictionProvider } from './empirical-duration-prediction-provider';
import { TaskLifecycle } from '../task-lifecycle';
import type { SchedulingPolicyConfig, WorldStateSnapshot } from '@shared/api.interface';

export async function resolveDurationModelMap(
  provider: Pick<EmpiricalDurationPredictionProvider, 'predictTaskDuration' | 'confidenceThreshold'>,
  snapshot: WorldStateSnapshot,
  defaultDurationMs: number,
  orgId: string | null,
  logger?: Pick<Logger, 'log'>,
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const threshold = await provider.confidenceThreshold();
  let mlCount = 0;
  let fallbackCount = 0;
  for (const task of snapshot.tasks) {
    if (!TaskLifecycle.isSchedulable(task.status)) continue;
    try {
      const result = await provider.predictTaskDuration({
        taskId: task.id,
        taskType: task.taskType,
        orgId: orgId ?? undefined,
      });
      if (
        result
        && result.source === 'ml'
        && result.confidence >= threshold
        && Number.isFinite(result.value)
        && result.value > 0
      ) {
        map.set(task.id, Math.trunc(result.value));
        mlCount += 1;
        continue;
      }
    } catch {
      // 预测失败：该任务回退默认时长（逐任务回退，不让一个坏任务拖垮整个 run）。
    }
    fallbackCount += 1;
  }
  if (mlCount > 0 || fallbackCount > 0) {
    const message =
      `duration model advisory: tasks=${map.size + fallbackCount} ml=${mlCount} fallback=${fallbackCount}`
      + `${orgId ? ` org=${orgId}` : ''}（默认 ${defaultDurationMs}ms 的任务沿用默认值）`;
    if (logger) logger.log(message);
  }
  return map;
}
