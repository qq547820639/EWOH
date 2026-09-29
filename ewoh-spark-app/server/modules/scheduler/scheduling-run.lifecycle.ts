import { and, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { ewohSchedulingRun } from '@server/database/schema';

/** 闭合阶段：只进日志，不参与判定（0 行命中时要能说出"是在哪一步丢的"）。 */
export type SchedulingRunClosureStage = 'suppressed' | 'persisted' | 'failed';

export interface SchedulingRunClosureInput {
  runId: string;
  /** 租户归属：`org_id` 自 standalone_057 起 NOT NULL，且唯一键是 (org_id, run_id)。 */
  orgId: string | null | undefined;
  patch: Record<string, unknown>;
  stage: SchedulingRunClosureStage;
}

export interface RunClosureLogger {
  error: (message: string) => unknown;
}

/**
 * `ewoh_scheduling_run.status` 的**唯一写入口**（试点模块化调整，V59）。
 *
 * 为什么这条边界要立起来（都是实测，不是审美）：
 * - 建 run 的是 `trigger.service`（INSERT `queued`），闭合 run 的原来有**两个所有者**：
 *   `replan-coordinator`（走 closeRun：带 org 谓词 + 命中检查）与
 *   `scheduler-run-orchestrator`（两处裸 UPDATE：无 org 谓词、不检查命中）。
 *   同一个终态列两套安全性质，弱的那一侧就是"run 永停 queued 且无痕"的入口。
 * - 隔离面：`standalone_057` 把 `run_id` 的单列 UNIQUE 换成了 `(org_id, run_id)`
 *   复合唯一（实测 `pg_indexes` 里只剩 `uq_ewoh_scheduling_run_org_run_id`），
 *   所以**裸 `where run_id` 不再天然安全**——跨租户命中今天靠 id 生成器不撞号 + RLS
 *   兜着，而不是靠约束。加上 org 谓词把这件事从"概率"变成"谓词"。
 * - `org_id` NOT NULL（实测 `information_schema`）⇒ 加谓词不会把历史行从"能闭合"
 *   变成"0 命中"，这一点是原先登记 F-09b 时设的数据前提，现已核实。
 *
 * 语义保持：命中与否用返回布尔告知调用方，0 命中**只报错不抛断**——
 * 闭合失败不该把已经算完的方案判废（与 coordinator 原 closeRun 一致）。
 */
export async function closeSchedulingRun(
  db: PostgresJsDatabase,
  input: SchedulingRunClosureInput,
  logger: RunClosureLogger,
): Promise<boolean> {
  const org = String(input.orgId ?? '').trim();
  if (!org) {
    // 缺租户归属时不写：宁可留下「未闭合」这条错误，也不发出一条无界 UPDATE。
    logger.error(
      `run ${input.runId} 闭合被拒（stage=${input.stage}）：缺少租户归属，`
      + '无 org 谓词的 run 状态写入等价于跨租户 UPDATE',
    );
    return false;
  }
  const rows = await db
    .update(ewohSchedulingRun)
    .set(input.patch as never)
    .where(
      and(
        eq(ewohSchedulingRun.runId, input.runId),
        eq(ewohSchedulingRun.orgId, org),
      ),
    )
    .returning({ runId: ewohSchedulingRun.runId });
  if (!rows || rows.length === 0) {
    logger.error(
      `run ${input.runId} 闭合未命中（stage=${input.stage}, org=${org}）`
      + '：run 仍停在 queued，需按 runId 核对租户谓词与行是否存在',
    );
    return false;
  }
  return true;
}
