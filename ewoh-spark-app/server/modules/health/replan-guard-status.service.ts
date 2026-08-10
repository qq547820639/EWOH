import { Injectable } from '@nestjs/common';

/** 跨实例 replan 守卫（advisory lock）能力状态（readiness 上报用，纯内存）。 */
export interface ReplanGuardStatus {
  state: 'ok' | 'degraded';
  /** 最近一次降级时刻（ISO）。 */
  lastDegradationAt?: string;
  /** 最近一次降级原因。 */
  reason?: string;
}

/**
 * P1-6（§六）：replan 跨实例守卫（advisory lock）能力降级状态持有（内存，无表）。
 *
 * ReplanCoordinatorService 在守卫执行异常（advisory-lock 查询抛错/结果形状异常）时
 * 调用 recordDegradation() 记录最近一次降级时刻与原因；HealthController 经
 * GET /health/ready 将其暴露为 checks.scheduler.replanGuard: 'degraded'|'ok'。
 * 纯进程内状态（单实例观测；多实例各自上报，由监控聚合）。
 */
@Injectable()
export class ReplanGuardStatusService {
  private lastDegradationAt: string | null = null;
  private lastDegradationReason: string | null = null;

  /** 记录一次守卫降级（幂等覆盖：保留最近一次）。 */
  recordDegradation(reason: string, at: Date = new Date()): void {
    this.lastDegradationAt = at.toISOString();
    this.lastDegradationReason = reason;
  }

  /** 当前守卫能力状态（供 readiness 上报）。 */
  getStatus(): ReplanGuardStatus {
    if (!this.lastDegradationAt) {
      return { state: 'ok' };
    }
    return {
      state: 'degraded',
      lastDegradationAt: this.lastDegradationAt,
      reason: this.lastDegradationReason ?? undefined,
    };
  }
}
