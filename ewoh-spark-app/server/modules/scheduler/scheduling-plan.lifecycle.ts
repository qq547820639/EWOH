import { and, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { ewohSchedulePlan } from '@server/database/schema';

/** 允许进入 `dispatched` 的前置状态：正统轨 `approved`、legacy confirm 轨 `confirmed`。 */
export type PlanDispatchSource = 'approved' | 'confirmed';

export interface PlanDispatchInput {
  planId: string;
  /** CAS 前置状态：由调用方按自己所在的轨道给出，本函数不替它选。 */
  fromStatus: PlanDispatchSource;
}

/**
 * `ewoh_schedule_plan.status='dispatched'` 的唯一写入口（试点模块化调整，V79）。
 *
 * 立这条边界的依据都是实测计数（见基线文档 §5.3z / §七 V78–V79）：
 * - 全仓生产代码里把方案改成 `dispatched` 的 UPDATE 只有两处，且形状完全相同
 *   （`where plan_id AND status=<前置>` + 0 命中转 409）：
 *   `dispatch-coordinator.service.ts` 与 `gamification.service.ts` 的派工旁路。
 *   两处重复 = 两条要各自维护的并发守卫；收进一处后写者数 2→1。
 * - 2026-08-28 的决策项 1 裁决 B 已把旁路的 `approved` 轨委托给正统 `dispatchPlanV2`，
 *   因此这里**不**合并两条业务轨道的语义：`approved` 与 `confirmed` 仍由各自调用方声明，
 *   本函数只负责"怎么写"，不负责"谁有权进 dispatched"（后者是 F-11 未决的批准词表问题）。
 * - 刻意**不加 org 谓词**：两处历史写者都没有，而派工前调用链已跑 `assertPlanTenantVisible`
 *   （反枚举 404）；在这里补 org 谓词会改变"全局管理员跨租户派工"的现有行为，
 *   那属于 F-06 登记剩余的纵深防御项，需另案裁决，不在本样本主张内。
 *
 * 语义保持：返回是否命中，0 命中**不抛断**——对外的错误文案归调用方
 * （`PLAN_CONCURRENT_DISPATCH` / 旁路的 "concurrently dispatched or no longer confirmed"）。
 *
 * 【V278 回退说明】V278 曾把本函数改成委托给通用入口 `transitionPlanStatus`
 * （`.set({ status: input.toStatus })` + 谓词先进数组），实测与两道既有测量打架、故退回原形状：
 * ① 共享门禁 主线9（`scripts/audit-state-machine-roles.js`）的词表判定只认 `status: '字面量'`
 *   （其 `:250`），谓词守卫判定只看 `.where(` 之后 26 行窗口内的字面 `eq/inArray(x.status)`
 *   （其 `:353-369`），且位点基线按**文件**枚举（其 `:290-301`）——参数化写入同时打红它 5 项；
 * ② 手工量具 `status-write-guard-census.cjs` 的三处已知答案校准要求本文件读作 `state-guard`，
 *   委托版被它读成 `dynamic-where`（实测 rc=1，取证 tmp/v278-census.log）。
 * 结论：在现有门禁形状下，"把写点搬进通用入口" measurably 与"守卫可被机读"互斥，
 * 收口形态需要另行设计（见 §5.3ly 与 V279 简报）。
 */
export async function markPlanDispatched(
  db: PostgresJsDatabase,
  input: PlanDispatchInput,
): Promise<boolean> {
  const rows = await db
    .update(ewohSchedulePlan)
    .set({ status: 'dispatched' })
    .where(
      and(
        eq(ewohSchedulePlan.planId, input.planId),
        eq(ewohSchedulePlan.status, input.fromStatus),
      ),
    )
    .returning({ id: ewohSchedulePlan.id });
  return rows.length > 0;
}
