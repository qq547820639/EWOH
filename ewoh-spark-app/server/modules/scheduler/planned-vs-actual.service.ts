import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, desc, eq, gte } from 'drizzle-orm';
import { ewohSchedulingExecution } from '@server/database/schema';
import {
  summarizePlannedVsActual,
  type PlannedVsActualRow,
  type PlannedVsActualSummary,
} from '@shared/planned-vs-actual';
import type { OrgContext } from '../shared/org-context.interceptor';

/**
 * 预计 vs 实际 对账服务（NO-57b，§7 反馈腿）。
 *
 * 读 `ewoh_scheduling_execution`（计划/实际时间戳 + 偏差类型），按共享纯函数给出
 * **可复盘口径**：可比覆盖率、绝对偏差的中位/均值/P90、超时与提前计数、按原因分类的不可比行、
 * 以及偏差类型分布。样本不足时**不给比率**（`null` + notes），缺失不当 0。
 *
 * 只读：不改执行事实，也不写"偏差记忆"表——事实表本身就是记忆，这里给的是口径。
 */
@Injectable()
export class PlannedVsActualService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  async summarize(
    actor?: OrgContext,
    options: { windowDays?: number; limit?: number } = {},
  ): Promise<PlannedVsActualSummary> {
    const orgId = actor?.primaryOrgId?.trim();
    if (!orgId) {
      throw new BadRequestException('org 上下文缺失：预计/实际对账必须带租户上下文');
    }
    const windowDays = Number.isFinite(options.windowDays)
      ? Math.min(Math.max(Math.trunc(Number(options.windowDays)), 1), 365)
      : 30;
    const limit = Number.isFinite(options.limit)
      ? Math.min(Math.max(Math.trunc(Number(options.limit)), 1), 2000)
      : 500;
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
    const rows = await this.db
      .select({
        assignmentId: ewohSchedulingExecution.assignmentId,
        taskId: ewohSchedulingExecution.taskId,
        planId: ewohSchedulingExecution.planId,
        plannedStartAt: ewohSchedulingExecution.plannedStartAt,
        plannedEndAt: ewohSchedulingExecution.plannedEndAt,
        actualStartAt: ewohSchedulingExecution.actualStartAt,
        actualEndAt: ewohSchedulingExecution.actualEndAt,
        deviationType: ewohSchedulingExecution.deviationType,
        status: ewohSchedulingExecution.status,
      })
      .from(ewohSchedulingExecution)
      .where(and(eq(ewohSchedulingExecution.orgId, orgId), gte(ewohSchedulingExecution.createdAt, since)))
      .orderBy(desc(ewohSchedulingExecution.createdAt))
      .limit(limit);

    const mapped: PlannedVsActualRow[] = rows.map((row) => ({
      assignmentId: String(row.assignmentId ?? ''),
      taskId: row.taskId ?? null,
      planId: row.planId ?? null,
      plannedMs:
        row.plannedStartAt && row.plannedEndAt
          ? row.plannedEndAt.getTime() - row.plannedStartAt.getTime()
          : null,
      actualMs:
        row.actualStartAt && row.actualEndAt
          ? row.actualEndAt.getTime() - row.actualStartAt.getTime()
          : null,
      deviationType: row.deviationType ?? null,
      status: row.status ?? null,
    }));
    const summary = summarizePlannedVsActual(mapped, { windowDays, now: new Date().toISOString() });
    if (rows.length >= limit) {
      summary.notes.push(`执行行读取触顶（${limit} 行）：统计只覆盖窗口内最近 ${limit} 行（不是全体）`);
    }
    return summary;
  }
}
