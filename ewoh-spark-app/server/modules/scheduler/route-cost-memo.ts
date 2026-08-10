/* Run-local deterministic route-cost memo（Task 1 / P0 大规模性能）。
 *
 * 背景：solve() 内联候选路径对 (person × station) 调用 routeCostProvider.estimate。
 * estimate 的路径结果只依赖几何 + route graph（TravelCostService.estimate →
 * calculateRouteBetween(from, to, {personId, taskId})：personId/taskId 仅作元数据；
 * 坐标缺失时 calculateRoute(personId, taskId) 才按实体 id 解析），而
 * 同一 solve() 调用内 route graph 固定不变 → 相同 (from, to) 坐标对的结果必然一致。
 *
 * 因此以"几何点对"为键的 run-local memo 是语义安全的：
 *   - 键 = from.x,from.y|to.x,to.y（两侧坐标齐全且有限）；
 *   - 否则键 = personId|taskId（坐标缺失走实体解析，依赖 id）。
 * memo 必须在每次 solve() 调用内新建（per-solve-call），保证确定性重放。
 * 不可行结果同样缓存（Guard：memoize even infeasible results），
 * 同一 (from,to) 在任务间不再重复触发 A* 或 euclidean 计算。
 */
import type { RouteCost } from './travel-cost.service';

/** 坐标是否可用于几何键（与 TravelCostService.hasCoord 同判据）。 */
function hasCoord(p?: { x: number | null; y: number | null } | null): boolean {
  return (
    p != null &&
    p.x != null &&
    p.y != null &&
    Number.isFinite(p.x) &&
    Number.isFinite(p.y)
  );
}

/** 构造确定性 memo 键：几何点对优先，否则 personId|taskId。 */
export function routeCostMemoKey(
  personId: string,
  taskId: string,
  from?: { x: number | null; y: number | null } | null,
  to?: { x: number | null; y: number | null } | null,
): string {
  if (hasCoord(from) && hasCoord(to)) {
    return `g:${from!.x},${from!.y}|${to!.x},${to!.y}`;
  }
  return `id:${personId}|${taskId}`;
}

/** run-local 路径成本 memo 的最小接口。 */
export interface RouteCostMemo {
  get(
    personId: string,
    taskId: string,
    from?: { x: number | null; y: number | null } | null,
    to?: { x: number | null; y: number | null } | null,
  ): Promise<RouteCost>;
  /** 当前缓存条目数（诊断/测试用）。 */
  size(): number;
}

/** memo 命中统计（仅 benchmark/诊断注入；生产默认 off，零语义影响）。 */
export interface RouteCostMemoStats {
  /** memo 查询总次数。 */
  lookups: number;
  /** 命中缓存（同键已在 cache 内）的次数。 */
  hits: number;
}

export function createRouteCostMemo(
  provider: {
    estimate(
      personId: string,
      taskId: string,
      from?: { x: number | null; y: number | null },
      to?: { x: number | null; y: number | null },
    ): Promise<RouteCost>;
  },
  stats?: RouteCostMemoStats | null,
): RouteCostMemo {
  const cache = new Map<string, Promise<RouteCost>>();
  return {
    get(personId, taskId, from, to) {
      const key = routeCostMemoKey(personId, taskId, from, to);
      let p = cache.get(key);
      if (stats) {
        stats.lookups += 1;
        if (p) stats.hits += 1;
      }
      if (!p) {
        // 缓存 Promise 而非值：并发 await 去重；同键结果必然一致。
        p = provider.estimate(personId, taskId, from, to);
        cache.set(key, p);
      }
      return p;
    },
    size() {
      return cache.size;
    },
  };
}
