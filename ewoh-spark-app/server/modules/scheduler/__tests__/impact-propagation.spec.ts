/* Incremental Replan V2 / M01：impact-propagation 确定性传播（08 §3）。
 *
 * 覆盖：确定性、停止条件（深度/数量截断）、核心不变量（无关任务不入 movable）、
 * 传播链（DEVICE_OFFLINE→task→person→zone、ROUTE_BLOCKED 经 routeEdgeTaskIndex）、
 * frozen 不入 movable。
 */
/// <reference types="jest" />
import { propagateImpact } from '../impact-propagation';
import type { ReplanImpact, WorldStateSnapshot } from '@shared/api.interface';

/** 构造一个最小但完整的快照（风格同 impact-analyzer-route-edge.spec.ts）。 */
function buildSnapshot(overrides: Partial<WorldStateSnapshot> = {}): WorldStateSnapshot {
  return {
    snapshotVersion: 'WS-M01',
    ts: '2026-08-10T00:00:00.000Z',
    worldVersion: 1,
    entityVersions: {},
    reservations: [],
    persons: [],
    tasks: [],
    devices: [],
    stations: [],
    backlog: [],
    events: [],
    routeStatus: [],
    forbiddenZones: [],
    lockedAssignments: [],
    ...overrides,
  };
}

interface TaskSeed {
  id: string;
  status?: string;
  assigneeId?: string | null;
  deviceId?: string | null;
  stationId?: string | null;
  zoneId?: string | null;
  predecessorIds?: string[];
}

function task(seed: TaskSeed) {
  return {
    id: seed.id,
    title: seed.id,
    taskType: 'work',
    priority: 'medium',
    status: seed.status ?? 'pending',
    assigneeId: seed.assigneeId ?? null,
    deviceId: seed.deviceId ?? null,
    stationId: seed.stationId ?? null,
    zoneId: seed.zoneId ?? null,
    planStart: null,
    planEnd: null,
    progress: 0,
    predecessorIds: seed.predecessorIds ?? [],
    requiredSkills: ['work'],
    requiredCertifications: [],
  };
}

function seed(overrides: Partial<ReplanImpact> = {}): ReplanImpact {
  return {
    triggerType: 'DEVICE_OFFLINE',
    triggerIds: [],
    affectedTaskIds: [],
    affectedResourceIds: [],
    affectedPersonIds: [],
    affectedDeviceIds: [],
    affectedStationIds: [],
    affectedZoneIds: [],
    frozenAssignmentIds: [],
    movableAssignmentIds: [],
    reasons: [],
    snapshotVersion: 'WS-M01',
    baselinePlanVersion: null,
    ...overrides,
  };
}

describe('M01 impact-propagation', () => {
  describe('确定性', () => {
    it('同 snapshot+seed 两次传播结果 deep-equal', () => {
      const snapshot = buildSnapshot({
        tasks: [
          task({ id: 'T1', deviceId: 'D-1', assigneeId: 'P-1', zoneId: 'Z-1' }),
          task({ id: 'T2', assigneeId: 'P-1', zoneId: 'Z-1', predecessorIds: ['T1'] }),
          task({ id: 'T3', zoneId: 'Z-2' }),
        ],
      });
      const input = seed({
        triggerType: 'DEVICE_OFFLINE',
        triggerIds: ['D-1'],
        affectedDeviceIds: ['D-1'],
      });
      const first = propagateImpact(snapshot, input);
      const second = propagateImpact(snapshot, input);
      expect(second).toEqual(first);
    });
  });

  describe('停止条件', () => {
    it('predecessor 链超过 maxPropagationDepth 截断', () => {
      // 链：T1 → T2 → T3 → T4 → T5（T1 为源，其余逐级 predecessor）
      const snapshot = buildSnapshot({
        tasks: [
          task({ id: 'T1', deviceId: 'D-1' }),
          task({ id: 'T2', predecessorIds: ['T1'] }),
          task({ id: 'T3', predecessorIds: ['T2'] }),
          task({ id: 'T4', predecessorIds: ['T3'] }),
          task({ id: 'T5', predecessorIds: ['T4'] }),
        ],
      });
      const input = seed({
        triggerType: 'DEVICE_OFFLINE',
        triggerIds: ['D-1'],
        affectedDeviceIds: ['D-1'],
      });
      // depth=2：T1(资源命中) + T2,T3（2 级闭包），T4/T5 被截断。
      const result = propagateImpact(snapshot, input, { maxPropagationDepth: 2 });
      expect(result.affectedTaskIds).toContain('T1');
      expect(result.affectedTaskIds).toContain('T2');
      expect(result.affectedTaskIds).toContain('T3');
      expect(result.affectedTaskIds).not.toContain('T4');
      expect(result.affectedTaskIds).not.toContain('T5');
    });

    it('任务数超 maxAffectedTasks 截断', () => {
      const tasks = [
        task({ id: 'T1', deviceId: 'D-1' }),
        task({ id: 'T2', zoneId: 'Z-1' }),
        task({ id: 'T3', zoneId: 'Z-1' }),
        task({ id: 'T4', zoneId: 'Z-1' }),
        task({ id: 'T5', zoneId: 'Z-1' }),
      ];
      const snapshot = buildSnapshot({ tasks });
      const input = seed({
        triggerType: 'DEVICE_OFFLINE',
        triggerIds: ['D-1'],
        affectedDeviceIds: ['D-1'],
      });
      const result = propagateImpact(snapshot, input, { maxAffectedTasks: 3 });
      expect(result.affectedTaskIds.length).toBeLessThanOrEqual(3);
    });
  });

  describe('核心不变量', () => {
    it('无影响理由的 assignment 不进入 movableAssignmentIds', () => {
      const snapshot = buildSnapshot({
        tasks: [
          task({ id: 'T1', deviceId: 'D-1' }),
          // 无关任务：不使用 D-1，无共同 person/zone/station/predecessor。
          task({ id: 'UNRELATED', zoneId: 'Z-9' }),
        ],
      });
      const input = seed({
        triggerType: 'DEVICE_OFFLINE',
        triggerIds: ['D-1'],
        affectedDeviceIds: ['D-1'],
      });
      const result = propagateImpact(snapshot, input);
      expect(result.movableAssignmentIds).toContain('T1');
      expect(result.movableAssignmentIds).not.toContain('UNRELATED');
      expect(result.affectedTaskIds).not.toContain('UNRELATED');
    });
  });

  describe('传播链', () => {
    it('DEVICE_OFFLINE → task → deviceBinding person → person 的 assignee 任务 → zone', () => {
      const snapshot = buildSnapshot({
        tasks: [
          // D-1 离线：T1 直接用 D-1；T2 由 P-1 负责（deviceBinding D-1→P-1 派生自 T1）；
          // T3 在 Z-1（D-1 所在 zone）；T4 完全无关。
          task({ id: 'T1', deviceId: 'D-1', assigneeId: 'P-1', zoneId: 'Z-1' }),
          task({ id: 'T2', assigneeId: 'P-1', zoneId: 'Z-2' }),
          task({ id: 'T3', zoneId: 'Z-1' }),
          task({ id: 'T4', zoneId: 'Z-9' }),
        ],
      });
      const input = seed({
        triggerType: 'DEVICE_OFFLINE',
        triggerIds: ['D-1'],
        affectedDeviceIds: ['D-1'],
      });
      const result = propagateImpact(snapshot, input);
      // 逐跳验证：device → T1；deviceBinding person P-1 → T2；zone Z-1 → T3。
      expect(result.affectedDeviceIds).toContain('D-1');
      expect(result.affectedTaskIds).toContain('T1');
      expect(result.affectedPersonIds).toContain('P-1');
      expect(result.affectedTaskIds).toContain('T2');
      expect(result.affectedZoneIds).toContain('Z-1');
      expect(result.affectedTaskIds).toContain('T3');
      expect(result.affectedTaskIds).not.toContain('T4');
    });

    it('ROUTE_BLOCKED 经 routeEdgeTaskIndex 圈定任务', () => {
      const snapshot = buildSnapshot({
        tasks: [
          task({ id: 'T1', stationId: 'S1', zoneId: 'Z-1' }),
          task({ id: 'T2', stationId: 'S2', zoneId: 'Z-2' }),
        ],
        routeEdgeTaskIndex: { 'E-1': ['T1'] },
      });
      const input = seed({
        triggerType: 'ROUTE_BLOCKED',
        triggerIds: ['E-1'],
        affectedZoneIds: [],
      });
      const result = propagateImpact(snapshot, input);
      expect(result.affectedTaskIds).toContain('T1');
      expect(result.affectedTaskIds).not.toContain('T2');
    });
  });

  describe('frozen 不入 movable', () => {
    it('executing/locked 任务即使受影响也在 frozenAssignmentIds 而非 movable', () => {
      const snapshot = buildSnapshot({
        tasks: [
          task({ id: 'T_EXEC', deviceId: 'D-1', status: 'executing' }),
          task({ id: 'T_LOCKED', deviceId: 'D-1' }),
          task({ id: 'T_PENDING', deviceId: 'D-1' }),
        ],
        lockedAssignments: [{ taskId: 'T_LOCKED', personId: null, deviceId: null, stationId: null }],
      });
      const input = seed({
        triggerType: 'DEVICE_OFFLINE',
        triggerIds: ['D-1'],
        affectedDeviceIds: ['D-1'],
      });
      const result = propagateImpact(snapshot, input);
      // 三者均受影响。
      expect(result.affectedTaskIds).toContain('T_EXEC');
      expect(result.affectedTaskIds).toContain('T_LOCKED');
      expect(result.affectedTaskIds).toContain('T_PENDING');
      // 冻结划分：executing + locked 在 frozenAssignmentIds。
      expect(result.frozenAssignmentIds).toContain('T_EXEC');
      expect(result.frozenAssignmentIds).toContain('T_LOCKED');
      // movable 只含 pending 可调度任务。
      expect(result.movableAssignmentIds).toContain('T_PENDING');
      expect(result.movableAssignmentIds).not.toContain('T_EXEC');
      expect(result.movableAssignmentIds).not.toContain('T_LOCKED');
    });
  });
});
