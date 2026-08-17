/* CP-SAT 熔断器（Phase 2 / P2-T4）。
 *
 * 纯状态机（无外部依赖、时间可注入）：连续失败达阈值 → OPEN（熔断，跳过 worker）；
 * 冷却期满 → HALF_OPEN（放行一次探测）；探测成功 → CLOSED（复位）。
 * 用于防止对不可用/异常的 CP-SAT worker 反复打请求（浪费资源 + 每次求解等满超时）。
 */

export interface CpSatCircuitBreakerConfig {
  /** 连续失败次数达到该阈值即熔断（OPEN）。缺省 5。 */
  failureThreshold?: number;
  /** 熔断后冷却时长（ms），期满进入 HALF_OPEN 允许一次探测。缺省 60_000。 */
  resetTimeoutMs?: number;
}

export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class CpSatCircuitBreaker {
  private state: CircuitBreakerState = 'CLOSED';
  private consecutiveFailures = 0;
  private openedAtMs = 0;
  /**
   * R2-SCH-020（2026-08-17）：HALF_OPEN 并发探测限制——冷却期满放行第一个
   * 探测后，探测结果未决期间其余调用一律视为 OPEN（旧实现 HALF_OPEN 分支
   * 无限额，冷却期满后多个并发请求同时放行探测，可能对不可用 worker 放大流量）。
   */
  private probeInFlight = false;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;

  constructor(config: CpSatCircuitBreakerConfig = {}) {
    this.failureThreshold = config.failureThreshold ?? 5;
    this.resetTimeoutMs = config.resetTimeoutMs ?? 60_000;
  }

  /**
   * 当前是否应跳过 CP-SAT（OPEN 且冷却未满）。调用时若冷却期满会触发
   * OPEN→HALF_OPEN 并放行一次探测；HALF_OPEN 探测未决期间其余调用视为 OPEN。
   */
  isOpen(nowMs = Date.now()): boolean {
    if (this.state === 'OPEN') {
      if (nowMs - this.openedAtMs >= this.resetTimeoutMs) {
        this.state = 'HALF_OPEN';
        this.probeInFlight = true;
        return false;
      }
      return true;
    }
    if (this.state === 'HALF_OPEN') {
      return this.probeInFlight;
    }
    return false;
  }

  /** 记录一次成功（worker 正常响应），复位熔断。 */
  recordSuccess(): void {
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
    this.probeInFlight = false;
  }

  /** 记录一次失败（worker 不可达/畸形等），累计并可能触发熔断。 */
  recordFailure(nowMs = Date.now()): void {
    this.consecutiveFailures += 1;
    this.probeInFlight = false;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.state = 'OPEN';
      this.openedAtMs = nowMs;
    }
  }

  /** 仅供可观测/测试：暴露当前状态与连续失败计数。 */
  snapshot(): { state: CircuitBreakerState; consecutiveFailures: number } {
    return { state: this.state, consecutiveFailures: this.consecutiveFailures };
  }
}
