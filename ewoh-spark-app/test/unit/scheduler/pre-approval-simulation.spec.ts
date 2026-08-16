/* pre-approval-simulation.spec.ts — 审批前布局仿真参数推导（纯函数，NO-12s/ADR-042）。 */
import { buildPlanLayoutParameters } from '../../../server/modules/scheduler/pre-approval-simulation';

describe('buildPlanLayoutParameters（方案→人员移动图→layout 仿真参数）', () => {
  const STATIONS = [
    { id: 'ST-1', x: 0, y: 0 },
    { id: 'ST-2', x: 30, y: 40 },
    { id: 'ST-3', x: 60, y: 0 },
  ];

  it('按人员/plannedStart 排序生成顺序移动边（trips=1）', () => {
    const params = buildPlanLayoutParameters([
      { personId: 'P-1', stationId: 'ST-2', plannedStart: '2026-08-16T09:00:00Z' },
      { personId: 'P-1', stationId: 'ST-1', plannedStart: '2026-08-16T08:00:00Z' },
      { personId: 'P-1', stationId: 'ST-3', plannedStart: '2026-08-16T10:00:00Z' },
    ], STATIONS);
    expect(params).not.toBeNull();
    expect(params?.moves).toEqual([
      { fromStationId: 'ST-1', toStationId: 'ST-2', trips: 1 },
      { fromStationId: 'ST-2', toStationId: 'ST-3', trips: 1 },
    ]);
    expect(params?.stations.map((s) => s.stationId).sort()).toEqual(['ST-1', 'ST-2', 'ST-3']);
  });

  it('相邻同工位不产生移动边', () => {
    const params = buildPlanLayoutParameters([
      { personId: 'P-1', stationId: 'ST-1', plannedStart: '2026-08-16T08:00:00Z' },
      { personId: 'P-1', stationId: 'ST-1', plannedStart: '2026-08-16T09:00:00Z' },
      { personId: 'P-1', stationId: 'ST-2', plannedStart: '2026-08-16T10:00:00Z' },
    ], STATIONS);
    expect(params?.moves).toEqual([
      { fromStationId: 'ST-1', toStationId: 'ST-2', trips: 1 },
    ]);
  });

  it('多人分组独立推导（人员间不串链）', () => {
    const params = buildPlanLayoutParameters([
      { personId: 'P-1', stationId: 'ST-1', plannedStart: '2026-08-16T08:00:00Z' },
      { personId: 'P-1', stationId: 'ST-2', plannedStart: '2026-08-16T09:00:00Z' },
      { personId: 'P-2', stationId: 'ST-3', plannedStart: '2026-08-16T08:00:00Z' },
      { personId: 'P-2', stationId: 'ST-1', plannedStart: '2026-08-16T09:00:00Z' },
    ], STATIONS);
    expect(params?.moves).toEqual([
      { fromStationId: 'ST-1', toStationId: 'ST-2', trips: 1 },
      { fromStationId: 'ST-3', toStationId: 'ST-1', trips: 1 },
    ]);
  });

  it('无多工位移动链 → null（调用方显式 skip，不伪造仿真）', () => {
    expect(buildPlanLayoutParameters([], STATIONS)).toBeNull();
    expect(buildPlanLayoutParameters([
      { personId: 'P-1', stationId: 'ST-1', plannedStart: '2026-08-16T08:00:00Z' },
    ], STATIONS)).toBeNull();
  });

  it('缺 plannedStart/personId/stationId 的分配显式跳过计数', () => {
    const params = buildPlanLayoutParameters([
      { personId: 'P-1', stationId: 'ST-1', plannedStart: null },
      { personId: null, stationId: 'ST-2', plannedStart: '2026-08-16T09:00:00Z' },
      { personId: 'P-2', stationId: null, plannedStart: '2026-08-16T09:00:00Z' },
      { personId: 'P-3', stationId: 'ST-1', plannedStart: '2026-08-16T08:00:00Z' },
      { personId: 'P-3', stationId: 'ST-2', plannedStart: '2026-08-16T09:00:00Z' },
    ], STATIONS);
    expect(params?.skippedAssignments).toBe(3);
    expect(params?.moves).toHaveLength(1);
  });

  it('工位缺坐标（x/y null）→ 相关边显式跳过并计数（不伪造坐标）', () => {
    const params = buildPlanLayoutParameters([
      { personId: 'P-1', stationId: 'ST-1', plannedStart: '2026-08-16T08:00:00Z' },
      { personId: 'P-1', stationId: 'ST-2', plannedStart: '2026-08-16T09:00:00Z' },
      { personId: 'P-2', stationId: 'ST-2', plannedStart: '2026-08-16T08:00:00Z' },
      { personId: 'P-2', stationId: 'ST-9', plannedStart: '2026-08-16T09:00:00Z' },
    ], [
      ...STATIONS,
      { id: 'ST-9', x: null, y: null },
    ]);
    expect(params?.missingCoordinateMoves).toBe(1);
    expect(params?.moves).toEqual([
      { fromStationId: 'ST-1', toStationId: 'ST-2', trips: 1 },
    ]);
  });

  it('全部移动边缺坐标 → null（无可评估移动图）', () => {
    const params = buildPlanLayoutParameters([
      { personId: 'P-1', stationId: 'ST-9', plannedStart: '2026-08-16T08:00:00Z' },
      { personId: 'P-1', stationId: 'ST-10', plannedStart: '2026-08-16T09:00:00Z' },
    ], [
      { id: 'ST-9', x: null, y: null },
      { id: 'ST-10', x: null, y: null },
    ]);
    expect(params).toBeNull();
  });
});
