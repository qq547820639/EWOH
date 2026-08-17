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
 * 降级自动恢复 TTL（NEST-443）：最近一次降级超过该窗口且无新降级信号时，
 * 守卫能力视为已恢复（advisory lock 瞬时故障不应把 readiness 永久钉死在
 * degraded 直到重启）。
 */
const DEGRADATION_TTL_MS = 5 * 60 * 1000;

/**
 * P1-6（§六）：replan 跨实例守卫（advisory lock）能力降级状态持有（内存，无表）。
 *
 * ReplanCoordinatorService 在守卫执行异常（advisory-lock 查询抛错/结果形状异常）时
 * 调用 recordDegradation() 记录最近一次降级时刻与原因；HealthController 经
 * GET /health/ready 将其暴露为 checks.scheduler.replanGuard: 'degraded'|'ok'。
 * 纯进程内状态（单实例观测；多实例各自上报，由监控聚合）。
 * NEST-443：降级态带 TTL 自动恢复（持续故障由 ReplanCoordinator 周期重打信号）。
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

  /** 守卫成功执行一次：清除降级态（显式恢复信号优先于 TTL）。 */
  recordRecovery(at: Date = new Date()): void {
    if (this.lastDegradationAt && at.getTime() - Date.parse(this.lastDegradationAt) >= 0) {
      this.lastDegradationAt = null;
      this.lastDegradationReason = null;
    }
  }

  /** 当前守卫能力状态（供 readiness 上报；TTL 过期自动恢复 ok）。 */
  getStatus(now: Date = new Date()): ReplanGuardStatus {
    if (!this.lastDegradationAt) {
      return { state: 'ok' };
    }
    const expired = now.getTime() - Date.parse(this.lastDegradationAt) > DEGRADATION_TTL_MS;
    if (expired) {
      // NEST-443：TTL 过期自动恢复（保留 lastDegradationAt 供追溯）。
      return { state: 'ok', lastDegradationAt: this.lastDegradationAt };
    }
    return {
      state: 'degraded',
      lastDegradationAt: this.lastDegradationAt,
      reason: this.lastDegradationReason ?? undefined,
    };
  }
}
