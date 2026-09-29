import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { ewohSchedulingPlanAssignment } from '@server/database/schema';

/**
 * `ewoh_scheduling_plan_assignment.status` 的具名写入口（V279，试点模块化第二轮）。
 *
 * 形状铁律（V278 实测换来，勿改回"一个通用入口＋参数化 status"）：仓内两道测量都按
 * "字面量＋窗口"认守卫——`scripts/audit-state-machine-roles.js` 的词表只认 `status: '字面量'`
 * （其 :250），守卫只认 `.where(` 之后 26 行窗口内的字面状态谓词（其 :353-372）；
 * `scripts/chain-baseline/status-write-guard-census.cjs` 只认状态列出现在谓词调用的第一实参位
 * 且在 `.where` 子树内（其 :91-109）。把写入值或谓词搬出这些位置，测量会把它读成"看不见"，
 * 而"看不见"在棘轮上长得像"变好了"（V278 曾把 `identity-only` 从 2 降成 1，实为读空）。
 * ⇒ 每个转移写字面状态值，谓词一律内联在 `.where(and(...))` 里。
 *
 * 为什么本表可以收口而 plan 表不行：主线9 的 `WRITER_DRIFT_TARGETS`（:206-209）只含
 * `ewohSchedulePlan` 与 `ewohControlCommand`，不含本表 ⇒ 写点能从 3 个 service（HEAD 实测 5 处／3 文件）搬进本文件
 * 而不与共享门禁的"按文件枚举位点"基线打架。
 */

/** 9 值词表（shared/scheduler.ts:100-109；DDL 无 CHECK，standalone_006_scheduling.sql:72）。 */
export type AssignmentStatus =
  | 'proposed'
  | 'approved'
  | 'dispatched'
  | 'acknowledged'
  | 'executing'
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'cancelled';

type Row = typeof ewohSchedulingPlanAssignment.$inferSelect;

/**
 * 审批级联：把"本方案已被批准"这一决策**投影**到该方案的全部分配行
 * （形状与收口前 `plan.service.ts:466` 逐字相同）。
 *
 * 刻意不带行级来源态谓词，且这不是漏加：本处的正确性由同一事务内的方案级 CAS 提供——
 * `approvePlan` 只允许 `draft|shadow|proposed` 的方案进入（`plan.service.ts:364-369`），
 * 方案行的行锁把针对同一方案的其它分配写者串行化在外，而分配行入库初值恒为 `proposed`
 * （milp-scheduling-solver.ts:629、cp-sat-scheduling-solver.ts:1097、
 * rule-based-scheduling-solver.ts:394、heuristic-scheduling-solver.ts:1531、
 * decision-projection.ts:137/587）。⇒ 在可达状态集合上"加不加 `inArray(status,['proposed'])`"等价；
 * 加它属行为变更，须连同"0 命中怎么办"一起裁（今天无人检查命中数），故本函数只把
 * "这是投影、不是逐条迁移"这一事实写进函数名与签名。
 *
 * 测量口径（V280 实测）：org 两个分支各写成一条**字面 UPDATE**（V279 那版是三元表达式 ⇒
 * `status-write-guard-census` 读成 `dynamic-where`，即"看不见"）。拆开后可见代价是写点数
 * 5→7，读数收益是这 4 条投影语句全部从"看不见"变成 `identity-only`（守卫强度=无来源态谓词，
 * 与语义一致：尺子看见了整条 WHERE，确认里面没有来源态列谓词）。
 * 两条分支与拆分前逐字同形：带租户 = planId AND orgId，legacy 无租户 = 只有 planId——
 * **任何一条都不是无 WHERE 的整表写**（常驻用例 `scheduling-assignment.lifecycle.spec.ts` 钉住）。
 * 若日后有人把两分支收回成一个三元、或往投影里加 `status` 守卫，常驻用例会红。
 */
export async function projectAssignmentsApproved(
  db: PostgresJsDatabase,
  input: { planId: string; orgId: string | null },
): Promise<void> {
  if (input.orgId == null) {
    await db
      .update(ewohSchedulingPlanAssignment)
      .set({ status: 'approved' })
      .where(eq(ewohSchedulingPlanAssignment.planId, input.planId));
    return;
  }
  await db
    .update(ewohSchedulingPlanAssignment)
    .set({ status: 'approved' })
    .where(
      and(
        eq(ewohSchedulingPlanAssignment.planId, input.planId),
        eq(ewohSchedulingPlanAssignment.orgId, input.orgId),
      ),
    );
}

/**
 * 拒绝级联：与 `projectAssignmentsApproved` 同为投影写法与同样的方案级前提
 * （`rejectPlan` 的门禁同样是 draft/shadow/proposed，`plan.service.ts:782`），目标态 `cancelled`。
 * 形状与收口前 `plan.service.ts:819` 逐字相同；org 两分支的拆法与测量口径见上一个函数。
 */
export async function projectAssignmentsCancelled(
  db: PostgresJsDatabase,
  input: { planId: string; orgId: string | null },
): Promise<void> {
  if (input.orgId == null) {
    await db
      .update(ewohSchedulingPlanAssignment)
      .set({ status: 'cancelled' })
      .where(eq(ewohSchedulingPlanAssignment.planId, input.planId));
    return;
  }
  await db
    .update(ewohSchedulingPlanAssignment)
    .set({ status: 'cancelled' })
    .where(
      and(
        eq(ewohSchedulingPlanAssignment.planId, input.planId),
        eq(ewohSchedulingPlanAssignment.orgId, input.orgId),
      ),
    );
}

/**
 * 取消/回滚的逐条 CAS（收口前 `plan.service.ts:914`）：`assignmentId + status` 双谓词，
 * 无 org 条件（沿原样）。0 命中 ⇒ 返回空数组，由调用方把该条转入 irreversible——**不抛断**。
 */
export async function cancelAssignmentByCAS(
  db: PostgresJsDatabase,
  input: { assignmentId: string; fromStatus: string },
): Promise<Row[]> {
  return db
    .update(ewohSchedulingPlanAssignment)
    .set({ status: 'cancelled' })
    .where(
      and(
        eq(ewohSchedulingPlanAssignment.assignmentId, input.assignmentId),
        eq(ewohSchedulingPlanAssignment.status, input.fromStatus),
      ),
    )
    .returning();
}

/**
 * 派工逐条 CAS（收口前 `dispatch-coordinator.service.ts:659`）：
 * `assignmentId + org + status + version` 四谓词，version 由读到的行自增 1。
 * org 条件仍由调用方给（`assignmentOrgCond` 是变量 ⇒ 静态尺把本处标 `partial`，与收口前同一读数）；
 * 变量本身的类型是 `SQL | undefined`（与 `plan-tenant-guard.ts:63`、`world-state.service.ts:85` 同一写法），
 * 不再是 `unknown` + `as never`——那对组合会让编译期对这里能塞进来的东西没有任何约束。
 * 0 命中 ⇒ 返回空数组，`ASSIGNMENT_CONCURRENT_UPDATE` 归调用方。
 */
export async function dispatchAssignmentByCAS(
  db: PostgresJsDatabase,
  input: {
    assignmentId: string;
    orgCondition: SQL | undefined;
    fromStatus: string;
    expectedVersion: number;
  },
): Promise<Array<{ id: string }>> {
  return db
    .update(ewohSchedulingPlanAssignment)
    .set({ status: 'dispatched', version: input.expectedVersion + 1 })
    .where(
      and(
        eq(ewohSchedulingPlanAssignment.assignmentId, input.assignmentId),
        input.orgCondition,
        eq(ewohSchedulingPlanAssignment.status, input.fromStatus),
        eq(ewohSchedulingPlanAssignment.version, input.expectedVersion),
      ),
    )
    .returning({ id: ewohSchedulingPlanAssignment.id });
}

/**
 * 回执推进逐条 CAS（收口前 `execution-receipt-application.service.ts:141`）：
 * `id + orgId + status` 三谓词，version 走列自增表达式。0 命中 ⇒ 空数组，
 * `ASSIGNMENT_STATE_CONFLICT` 归调用方。
 */
/**
 * 回执推进逐条 CAS（收口前 `execution-receipt-application.service.ts:141`）：
 * `id + orgId + status` 三谓词，version 走列自增表达式。0 命中 ⇒ 空数组，
 * `ASSIGNMENT_STATE_CONFLICT` 归调用方。
 *
 * V286：目标态从 `input.toStatus` 收成**封闭的字面分支**。原因不是风格——`status-target-states`
 * 的目标态集合轴只认 set 侧字面量，参数化那版被如实记成「非字面量 1 处（不入集合）」，
 * 于是 assignment 能被回执写成哪些态在度量里是空的（V285 读码定案，代价先数清：
 * 生产调用点 1 处、spec 调用点 2 处，值域就是调用方那张封闭映射里的 5 个态）。
 * 形状代价如实记：本文件可见写点 7→11 条（`status-write-guard-census` 的分母随之涨，
 * 守卫档仍是 state-guard——谓词一字未动）。
 *
 * 语义未动的部分：来源态谓词 `eq(status, input.fromStatus)` 保持绑定参数，**不**改成字面集合。
 * 把来源态也字面化会替回执腿新增"某些转移不再可达"的判定（0 命中 ⇒ 抛
 * `ASSIGNMENT_STATE_CONFLICT`），那是行为变更，得连同"上游那些守卫怎么收"一起裁，不在本轮夹带。
 *
 * default 抛错是唯一一处语义收紧，且按可达性说是空集：调用方
 * `execution-receipt-application.service.ts:111-112` 的映射只会产出这 5 个值，
 * 词表里另外 4 个（proposed/approved/acknowledged/blocked）从来不是回执目标；
 * 该映射取不到值时调用方在 :114 已经先抛 `INVALID_EXECUTION_STATUS`。
 * 常驻用例钉住封闭性（`__tests__/scheduling-assignment.lifecycle.spec.ts` 两支仍断
 * `patch.status === 'executing'`，V286 另加一支：给非回执目标态必须抛且一条 UPDATE 都不发）。
 */
export async function advanceAssignmentByCAS(
  db: PostgresJsDatabase,
  input: {
    id: string;
    orgId: string;
    fromStatus: string;
    toStatus: AssignmentStatus;
  },
): Promise<Row[]> {
  // 谓词一律内联写在 .where(and(...)) 里，不外提成语句片段变量：外提会让
  // status-write-guard-census 读不到"状态列在谓词第一实参位"，又把可见写点变回看不见。
  switch (input.toStatus) {
    case 'dispatched':
      return db
        .update(ewohSchedulingPlanAssignment)
        .set({
          status: 'dispatched',
          version: sql`${ewohSchedulingPlanAssignment.version} + 1`,
        })
        .where(
          and(
            eq(ewohSchedulingPlanAssignment.id, input.id),
            eq(ewohSchedulingPlanAssignment.orgId, input.orgId),
            eq(ewohSchedulingPlanAssignment.status, input.fromStatus),
          ),
        )
        .returning();
    case 'executing':
      return db
        .update(ewohSchedulingPlanAssignment)
        .set({
          status: 'executing',
          version: sql`${ewohSchedulingPlanAssignment.version} + 1`,
        })
        .where(
          and(
            eq(ewohSchedulingPlanAssignment.id, input.id),
            eq(ewohSchedulingPlanAssignment.orgId, input.orgId),
            eq(ewohSchedulingPlanAssignment.status, input.fromStatus),
          ),
        )
        .returning();
    case 'completed':
      return db
        .update(ewohSchedulingPlanAssignment)
        .set({
          status: 'completed',
          version: sql`${ewohSchedulingPlanAssignment.version} + 1`,
        })
        .where(
          and(
            eq(ewohSchedulingPlanAssignment.id, input.id),
            eq(ewohSchedulingPlanAssignment.orgId, input.orgId),
            eq(ewohSchedulingPlanAssignment.status, input.fromStatus),
          ),
        )
        .returning();
    case 'failed':
      return db
        .update(ewohSchedulingPlanAssignment)
        .set({
          status: 'failed',
          version: sql`${ewohSchedulingPlanAssignment.version} + 1`,
        })
        .where(
          and(
            eq(ewohSchedulingPlanAssignment.id, input.id),
            eq(ewohSchedulingPlanAssignment.orgId, input.orgId),
            eq(ewohSchedulingPlanAssignment.status, input.fromStatus),
          ),
        )
        .returning();
    case 'cancelled':
      return db
        .update(ewohSchedulingPlanAssignment)
        .set({
          status: 'cancelled',
          version: sql`${ewohSchedulingPlanAssignment.version} + 1`,
        })
        .where(
          and(
            eq(ewohSchedulingPlanAssignment.id, input.id),
            eq(ewohSchedulingPlanAssignment.orgId, input.orgId),
            eq(ewohSchedulingPlanAssignment.status, input.fromStatus),
          ),
        )
        .returning();
    default:
      throw new Error(
        `ASSIGNMENT_RECEIPT_TARGET_NOT_ALLOWED: ${input.toStatus satisfies AssignmentStatus}`,
      );
  }
}
