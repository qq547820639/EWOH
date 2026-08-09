/* Phase 3 / P3-T2 前端：SSE 实时数据源纯函数核心。
 *
 * 从 useSchedulerStream 抽出的纯决策函数（node 环境可测，无 DOM 依赖）：
 * - sequence 单调守卫：sse / resync / poll 三源之间防止回退；
 * - 缺口检测：跳号 → 无法安全增量续接 → 需要全量 resync；
 * - 轮询兜底决策：SSE 连续错误达到阈值 → 切换轮询。
 * React Hook（useSchedulerStream / useCommandMapSchedulerState）组合这些纯函数。
 */

export type RealtimeSource = 'sse' | 'resync' | 'poll';

export interface SequenceDecision {
  /** 是否接受该 sequence（false = 回退/重复，直接丢弃）。 */
  accept: boolean;
  /** 是否检测到缺口（需全量 resync）。 */
  gap: boolean;
  /** 更新后的 lastSequence。 */
  lastSequence: number;
}

/**
 * 单调 sequence 守卫 + 缺口检测（三源防回退）。
 * - seq <= last → 重复/回退，丢弃；
 * - seq === last + 1 → 正常增量；
 * - seq > last + 1 → 缺口（跳号），需要全量 resync；
 * - last === 0（首次/基线）→ 接受任意 seq（新基线）。
 */
export function nextSequence(prev: number, seq: number): SequenceDecision {
  if (!Number.isFinite(seq) || seq < 0) {
    return { accept: false, gap: false, lastSequence: prev };
  }
  if (seq <= prev) {
    return { accept: false, gap: false, lastSequence: prev };
  }
  const gap = prev > 0 && seq > prev + 1;
  return { accept: true, gap, lastSequence: seq };
}

/**
 * resync 事件/全量重建后重置续传游标（以服务器权威 currentSequence 为新基线）。
 * 返回新的 lastSequence；缺口内事件由全量重拉恢复，不猜测。
 */
export function resyncBaseline(prev: number, currentSequence: number): number {
  return Number.isFinite(currentSequence) && currentSequence >= 0
    ? currentSequence
    : prev;
}

/**
 * SSE 断开后的降级决策：
 * - 连续错误达到 maxConsecutiveErrors → 切换到轮询兜底（polling=true）；
 * - 未达到阈值 → 保持 error 状态等待重连；
 * - 任一轮询期间都继续按 reconnectInterval 尝试重连 SSE，成功后切回实时。
 */
export function nextStreamState(params: {
  consecutiveErrors: number;
  maxConsecutiveErrors: number;
  currentlyPolling: boolean;
}): { status: 'polling' | 'error'; shouldStartPolling: boolean } {
  const reached =
    params.consecutiveErrors >= params.maxConsecutiveErrors ||
    params.currentlyPolling;
  if (reached) {
    return { status: 'polling', shouldStartPolling: !params.currentlyPolling };
  }
  return { status: 'error', shouldStartPolling: false };
}

/**
 * 三源单调防回退合并器：给定上一来源的 lastSequence 与本次观察到的 sequence，
 * 返回是否可安全应用到 store（sse 增量 / resync 全量 / poll 全量）。
 * - resync / poll 为全量源：以其 currentSequence 为新基线（允许大于或等于，不允许回退）；
 * - sse 为增量源：必须严格 +1 或落入 gap→resync。
 */
export function mergeSourceSequence(
  source: RealtimeSource,
  prev: number,
  observed: number,
): SequenceDecision {
  if (source === 'resync' || source === 'poll') {
    if (observed <= prev) {
      // 全量源不得让游标回退（服务器重启降序属异常，保守丢弃）。
      return { accept: false, gap: false, lastSequence: prev };
    }
    return { accept: true, gap: false, lastSequence: observed };
  }
  return nextSequence(prev, observed);
}
