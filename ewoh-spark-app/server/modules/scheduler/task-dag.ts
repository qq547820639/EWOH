/* 任务依赖 DAG 的传递下游阻塞分析（Phase 1 / P1-1）。
 *
 * 纯函数模块（非 NestJS Service、无副作用）：从 snapshot.tasks 的 predecessorIds
 * 构建依赖 DAG，计算每个任务的「传递下游可达数」——该任务直接或间接阻塞的**去重**任务总数。
 * 用于替代 priority-engine 原先只统计直接反向阻塞（1 跳）的 downstreamCount，
 * 使长链头部任务被正确识别为更关键。
 *
 * 环安全：DFS 访问中守卫（visiting 命中返回空集），保证无无限递归、结果确定且非负。
 * 去重：以 Set 记录每个任务的可达后代集合，避免菱形结构下同一后代经多路径被重复计数。
 */

/** 参与 DAG 分析的任务最小形状（与 WorldStateSnapshot.tasks 的字段兼容）。 */
export interface DagTask {
  id: string;
  predecessorIds: string[];
}

/**
 * 计算每个任务的传递下游可达数（distinct transitive descendant count）。
 * 边方向：task.predecessorIds 中的前驱 p → 当前 task（p 阻塞 task）。
 * 返回 Map<taskId, 可达数>；无后继任务为 0。
 * NEST-122 修复（2026-08-17）：剔除自指边（predecessorIds 含自身 id 的脏数据
 * 常见于导入/合并）——自指会在 DFS 结果集中把任务自身计入 reach（多算 1 且
 * 与「后代=阻塞的他人」语义矛盾）。构建 children 时跳过 pred === t.id。
 */
export function computeBlockingReach(tasks: DagTask[]): Map<string, number> {
  // children[x] = 把 x 作为前驱的直接后继任务集合（x 直接阻塞它们）。
  const children = new Map<string, string[]>();
  const ids: string[] = [];
  for (const t of tasks) {
    ids.push(t.id);
    for (const pred of t.predecessorIds) {
      // NEST-122：自指边不入图（数据卫生守卫，不改变正常 DAG 语义）。
      if (pred === t.id) continue;
      const list = children.get(pred);
      if (list) list.push(t.id);
      else children.set(pred, [t.id]);
    }
  }

  const memo = new Map<string, Set<string>>();
  const visiting = new Set<string>();

  /** 返回 id 的可达后代集合（去重，不含 id 自身）。 */
  const descendants = (id: string): Set<string> => {
    const cached = memo.get(id);
    if (cached) return cached;
    // 环守卫：依赖环内不无限递归，命中返回空集（保守、确定、非负）。
    if (visiting.has(id)) return new Set<string>();

    visiting.add(id);
    const result = new Set<string>();
    for (const child of children.get(id) ?? []) {
      result.add(child);
      for (const d of descendants(child)) result.add(d);
    }
    // NEST-122：环经其他路径把 id 自身带回结果集时剔除（descendants 语义不含自身）。
    result.delete(id);
    visiting.delete(id);

    memo.set(id, result);
    return result;
  };

  const reach = new Map<string, number>();
  for (const id of ids) {
    reach.set(id, descendants(id).size);
  }
  return reach;
}
