/* decision-ledger.ts — 方案决策台账追加单一实现（ADR-062 决策 2 / §31）。
 *
 * decision_records_json 读-追加-回写（无 CAS——调用方保证幂等/事务语义）：
 *  - plan.service（ADR-057 审批追加）；
 *  - dispatch-coordinator（ADR-060/061 派工预占/派工追加）；
 *  - replan-coordinator（ADR-062 重排追加）。
 * 三处消费同一实现，行为逐字一致（§31 不维护多份手写定义）。
 */
import type { PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { ewohSchedulePlan } from '@server/database/schema';
import { eq } from 'drizzle-orm';
import type { DecisionRecord } from '@shared/decision';

/** 读方案现有决策记录（NULL/非数组 → 空数组，存量未投影行兼容）。 */
export async function readPlanDecisionRecords(
  db: PostgresJsDatabase,
  planId: string,
): Promise<Array<Record<string, unknown>>> {
  const rows = await db
    .select()
    .from(ewohSchedulePlan)
    .where(eq(ewohSchedulePlan.planId, planId))
    .limit(1);
  const existing = (rows[0]?.decisionRecordsJson ?? []) as unknown;
  return Array.isArray(existing) ? (existing as Array<Record<string, unknown>>) : [];
}

/** 读-追加-回写（单次 UPDATE；records 为空时跳过写）。 */
export async function appendPlanDecisionRecords(
  db: PostgresJsDatabase,
  planId: string,
  records: DecisionRecord[],
): Promise<void> {
  if (records.length === 0) return;
  const existing = await readPlanDecisionRecords(db, planId);
  await db
    .update(ewohSchedulePlan)
    .set({
      decisionRecordsJson: [...existing, ...records] as unknown as Record<string, unknown>[],
    })
    .where(eq(ewohSchedulePlan.planId, planId));
}
