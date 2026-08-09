/* P0-6：ROUTE_BLOCKED / ROUTE_CONGESTED 影响范围（edge → task 反查）。
 *
 * 背景：旧实现 `candidates.filter(t => t.zoneId === entityId)` 用 zoneId（空间区域）
 * 匹配 route graph edgeId（路由边）——两套 ID 体系，ROUTE_BLOCKED 永远圈不中任务。
 *
 * 修复：世界状态快照携带 `routeEdgeTaskIndex`（edgeId → taskIds，由
 * node.stationId ↔ task.stationId 推导）；影响分析据此圈定**真正使用该边**的任务。
 */
/// <reference types="jest" />
import { ImpactAnalyzer, type ImpactEvent } from '../impact-analyzer';
import type { WorldStateSnapshot } from '@shared/api.interface';

function buildSnapshot(): WorldStateSnapshot {
  return {
    snapshotVersion: 'WS-P0-6',
    ts: new Date().toISOString(),
    worldVersion: 1,
    entityVersions: {},
    reservations: [],
    persons: [],
    tasks: [
      {
        id: 'tA',
        title: 'tA',
        taskType: 'work',
        priority: 'medium',
        status: 'pending',
        assigneeId: null,
        deviceId: null,
        stationId: 'S1', // 任务 A 在 S1——edge E1 连接 S1
        zoneId: 'Z1',
        planStart: null,
        planEnd: null,
        progress: 0,
        predecessorIds: [],
        requiredSkills: ['work'],
        requiredCertifications: [],
      },
      {
        id: 'tB',
        title: 'tB',
        taskType: 'work',
        priority: 'medium',
        status: 'pending',
        assigneeId: null,
        deviceId: null,
        stationId: 'S2', // 任务 B 在 S2——不用 edge E1
        zoneId: 'Z2',
        planStart: null,
        planEnd: null,
        progress: 0,
        predecessorIds: [],
        requiredSkills: ['work'],
        requiredCertifications: [],
      },
    ],
    devices: [],
    stations: [
      { id: 'S1', name: 'S1', x: 0, y: 0, capacity: 1 },
      { id: 'S2', name: 'S2', x: 5, y: 0, capacity: 1 },
    ],
    backlog: [],
    events: [],
    routeStatus: [{ edgeId: 'E1', status: 'blocked', riskLevel: 'high' }],
    forbiddenZones: [],
    lockedAssignments: [],
    // world-state 构建时从 node.stationId ↔ task.stationId 推导：
    // E1 连接 S1（tA），不连接 S2（tB）。
    routeEdgeTaskIndex: { E1: ['tA'] },
  };
}

describe('P0-6: route edge 影响范围', () => {
  const analyzer = new ImpactAnalyzer();

  it('ROUTE_BLOCKED：只圈出使用该 edge 的任务（tA 受影响，tB 不受）', () => {
    const result = analyzer.analyze(buildSnapshot(), {
      eventType: 'ROUTE_BLOCKED',
      entityId: 'E1',
    } as ImpactEvent);
    expect(result.affectedTaskIds).toContain('tA');
    expect(result.affectedTaskIds).not.toContain('tB');
  });

  it('ROUTE_CONGESTED：同样通过 edge → task 反查（tA 受影响，tB 不受）', () => {
    const result = analyzer.analyze(buildSnapshot(), {
      eventType: 'ROUTE_CONGESTED',
      entityId: 'E1',
    } as ImpactEvent);
    expect(result.affectedTaskIds).toContain('tA');
    expect(result.affectedTaskIds).not.toContain('tB');
  });

  it('其他 edge（E2）不在索引 → 无已知受影响任务（fail-safe，不误伤全部）', () => {
    const snapshot = {
      ...buildSnapshot(),
      routeEdgeTaskIndex: { E1: ['tA'] },
    };
    const result = analyzer.analyze(snapshot, {
      eventType: 'ROUTE_BLOCKED',
      entityId: 'E2',
    } as ImpactEvent);
    expect(result.affectedTaskIds).not.toContain('tA');
    expect(result.affectedTaskIds).not.toContain('tB');
  });

  it('旧快照无 routeEdgeTaskIndex → 不影响其他类型事件（PERSON_UNAVAILABLE 仍按 assignee 圈定）', () => {
    const snapshot = buildSnapshot();
    delete (snapshot as { routeEdgeTaskIndex?: unknown }).routeEdgeTaskIndex;
    // 加一个 assignee 匹配：tB.assigneeId = 'pX'，PERSON_UNAVAILABLE 事件应圈中 tB。
    snapshot.tasks = snapshot.tasks.map((t) =>
      t.id === 'tB' ? { ...t, assigneeId: 'pX' } : t,
    );
    const result = analyzer.analyze(snapshot, {
      eventType: 'PERSON_UNAVAILABLE',
      entityId: 'pX',
    } as ImpactEvent);
    expect(result.affectedTaskIds).toContain('tB');
    expect(result.affectedTaskIds).not.toContain('tA');
  });
});
