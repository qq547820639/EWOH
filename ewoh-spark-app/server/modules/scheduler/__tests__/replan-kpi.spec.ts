/* Incremental Replan V2 / M04：6 项 Replan KPI 聚合（08 §8）。
 *
 * 覆盖：KpiService.aggregate 的 stability 扩展字段（affectedAssignmentRatio /
 * unchangedAssignmentRate / scheduleChurn / replanDuration / replanTriggerCount /
 * replanSuppressedCount），含 M02 风暴守卫抑制计数接入。
 */
/// <reference types="jest" />
import { KpiService } from '../kpi.service';
import { SchedulerMetricsService } from '../scheduler-metrics.service';
import type { SchedulerKpiSnapshot } from '@shared/api.interface';

function makeKpiService(opts: {
  runs?: Array<{ triggerType: string | null; status: string; createdAt: Date }>;
  metrics?: SchedulerMetricsService;
}) {
  const db = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue(opts.runs ?? []),
      }),
    }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        onConflictDoUpdate: jest.fn().mockResolvedValue([]),
      }),
    }),
  };
  const executionService = {
    listAll: jest.fn().mockResolvedValue([]),
  };
  const feedbackService = {
    deriveKpis: jest.fn().mockResolvedValue({
      replanCount: 0,
      fallbackRate: null,
      solverRuntimeMs: null,
      conflictRate: null,
    }),
  };
  const conflictService = {
    listConflicts: jest.fn().mockResolvedValue({ conflicts: [] }),
  };
  const svc = new KpiService(
    db as never,
    executionService as never,
    feedbackService as never,
    conflictService as never,
    opts.metrics,
  );
  return { svc, db };
}

describe('M04 Replan KPI 聚合', () => {
  it('6 项 stability 扩展字段聚合正确（run 窗口 + metrics 计数）', async () => {
    const metrics = new SchedulerMetricsService();
    metrics.recordReplanTrigger();
    metrics.recordReplanTrigger();
    metrics.recordReplanSuppressed();
    metrics.recordReplanSuppressed();
    metrics.recordReplanSuppressed();
    metrics.recordReplanPersistMs(1200);
    metrics.recordAffectedAssignmentRatio(0.4);
    metrics.recordUnchangedAssignmentRate(0.8);
    metrics.recordPlanChurn(5);

    const { svc } = makeKpiService({
      runs: [
        { triggerType: 'DEVICE_OFFLINE', status: 'succeeded', createdAt: new Date() },
        { triggerType: 'MANUAL', status: 'succeeded', createdAt: new Date() },
        { triggerType: 'RESERVATION_CONFLICT', status: 'succeeded', createdAt: new Date() },
      ],
      metrics,
    });

    const kpi = await svc.aggregate({ persist: false });
    expect(kpi.stability).toMatchObject({
      // replanTriggerCount = 非 MANUAL run 数（DEVICE_OFFLINE + RESERVATION_CONFLICT）。
      replanTriggerCount: 2,
      // 风暴守卫抑制计数（M02 recordReplanSuppressed ×3）。
      replanSuppressedCount: 3,
      // metrics gauge 透传。
      affectedAssignmentRatio: 0.4,
      unchangedAssignmentRate: 0.8,
      scheduleChurn: 5,
      replanDuration: 1200,
    });
  });

  it('无 metrics 服务/无 run 时扩展字段为 null 或 0（不伪造）', async () => {
    const { svc } = makeKpiService({ runs: [] });
    const kpi = await svc.aggregate({ persist: false });
    expect(kpi.stability.replanTriggerCount).toBe(0);
    expect(kpi.stability.replanSuppressedCount).toBeNull();
    expect(kpi.stability.affectedAssignmentRatio).toBeNull();
    expect(kpi.stability.unchangedAssignmentRate).toBeNull();
    expect(kpi.stability.scheduleChurn).toBeNull();
    expect(kpi.stability.replanDuration).toBeNull();
  });

  it('stability 字段全量存在且类型正确（SchedulerKpiSnapshot 兼容）', async () => {
    const { svc } = makeKpiService({ runs: [] });
    const kpi: SchedulerKpiSnapshot = await svc.aggregate({ persist: false });
    expect(typeof kpi.stability.replanCount).toBe('number');
    expect('affectedAssignmentRatio' in kpi.stability).toBe(true);
    expect('unchangedAssignmentRate' in kpi.stability).toBe(true);
    expect('scheduleChurn' in kpi.stability).toBe(true);
    expect('replanDuration' in kpi.stability).toBe(true);
    expect('replanTriggerCount' in kpi.stability).toBe(true);
    expect('replanSuppressedCount' in kpi.stability).toBe(true);
  });
});
