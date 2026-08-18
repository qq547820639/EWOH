/* spatialPointIndex.spec — 叠加层坐标源统一（审计 A1/A2，2026-08-19）。
 *
 * 锁定行为：
 * - 索引按 entityId / 裸 id / 规范前缀（person:/device:/station:）双向查找；
 * - alignSnapshotToSpatial：snapshot 坐标被空间实体坐标覆盖（漂移修正），
 *   一致时返回原引用（memo 稳定）；
 * - alignRouteGraphToSpatial：node.stationId 可解析时以空间坐标替换 node.x/y；
 * - remapPlanCompareVmToSpatial：entry before/after 点按 id 重解析。
 */
import type { RouteGraph, SpatialEntity } from '@shared/api.interface';
import type { PlanCompareMapVM } from './vm/planCompareVM';
import {
  alignRouteGraphToSpatial,
  alignSnapshotToSpatial,
  buildSpatialPointIndex,
  remapPlanCompareVmToSpatial,
} from './spatialPointIndex';

const entities: SpatialEntity[] = [
  { entityId: 'WS-01', entityType: 'workstation', name: '工位1', x: 100, y: 200, bboxW: 80, bboxH: 60, status: 'active', sourceType: 'seed', confidence: 1, version: 1 } as SpatialEntity,
  { entityId: 'person:P1', entityType: 'person', name: '人员1', x: 150, y: 250, bboxW: 8, bboxH: 8, status: 'active', sourceType: 'seed', confidence: 1, version: 1 } as SpatialEntity,
  { entityId: 'EXO-001', entityType: 'device', name: '设备1', x: 62, y: 720, bboxW: 12, bboxH: 12, status: 'online', sourceType: 'seed', confidence: 1, version: 1 } as SpatialEntity,
];

describe('buildSpatialPointIndex（A2：坐标源统一）', () => {
  const pointOf = buildSpatialPointIndex(entities);
  it('按 entityId 精确查找', () => {
    expect(pointOf('WS-01')).toEqual({ x: 100, y: 200 });
    expect(pointOf('person:P1')).toEqual({ x: 150, y: 250 });
  });
  it('裸 id 与规范前缀双向查找', () => {
    expect(pointOf('P1')).toEqual({ x: 150, y: 250 });
    expect(pointOf('station:WS-01')).toEqual({ x: 100, y: 200 });
    expect(pointOf('device:EXO-001')).toEqual({ x: 62, y: 720 });
    expect(pointOf('person:WS-01')).toBeNull();
  });
  it('未命中/空 id 返回 null', () => {
    expect(pointOf('nope')).toBeNull();
    expect(pointOf('')).toBeNull();
  });
});

describe('alignSnapshotToSpatial（A2：snapshot 坐标对齐）', () => {
  it('旧布局坐标被空间实体坐标覆盖（persons 裸 id / devices entityId 前缀 / stations 直查）', () => {
    const snapshot = {
      persons: [{ id: 'P1', entityId: 'person:P1', x: 500, y: 585 }],
      devices: [{ id: 'EXO-001', entityId: 'device:EXO-001', x: 150, y: 585 }],
      stations: [{ id: 'WS-01', entityId: 'station:WS-01', x: 500, y: 150 }],
    };
    const aligned = alignSnapshotToSpatial(snapshot, buildSpatialPointIndex(entities));
    expect(aligned.persons[0].x).toBe(150);
    expect(aligned.persons[0].y).toBe(250);
    expect(aligned.devices[0].x).toBe(62);
    expect(aligned.devices[0].y).toBe(720);
    expect(aligned.stations[0].x).toBe(100);
    expect(aligned.stations[0].y).toBe(200);
  });
  it('坐标一致时返回原引用（memo 稳定）', () => {
    const snapshot = {
      persons: [{ id: 'P1', entityId: 'person:P1', x: 150, y: 250 }],
      devices: [{ id: 'EXO-001', entityId: 'device:EXO-001', x: 62, y: 720 }],
      stations: [{ id: 'WS-01', entityId: 'station:WS-01', x: 100, y: 200 }],
    };
    expect(alignSnapshotToSpatial(snapshot, buildSpatialPointIndex(entities))).toBe(snapshot);
  });
  it('无匹配实体时保留原坐标（不伪造、不丢弃）', () => {
    const snapshot = {
      persons: [{ id: 'PX', entityId: 'person:PX', x: 7, y: 8 }],
      devices: [],
      stations: [],
    };
    const aligned = alignSnapshotToSpatial(snapshot, buildSpatialPointIndex(entities));
    expect(aligned.persons[0].x).toBe(7);
    expect(aligned.persons[0].y).toBe(8);
  });
});

describe('alignRouteGraphToSpatial（A2：路由节点对齐）', () => {
  const graph: RouteGraph = {
    nodes: [
      { nodeId: 'n1', nodeType: null, x: 500, y: 150, floor: null, stationId: 'WS-01', zoneId: null },
      { nodeId: 'n2', nodeType: null, x: 300, y: 300, floor: null, stationId: null, zoneId: null },
    ],
    edges: [],
  };
  it('stationId 可解析的节点用空间坐标替换', () => {
    const aligned = alignRouteGraphToSpatial(graph, buildSpatialPointIndex(entities));
    expect(aligned.nodes[0].x).toBe(100);
    expect(aligned.nodes[0].y).toBe(200);
    expect(aligned.nodes[1].x).toBe(300);
  });
  it('全部命中一致时返回原引用', () => {
    const same: RouteGraph = {
      nodes: [{ nodeId: 'n1', nodeType: null, x: 100, y: 200, floor: null, stationId: 'WS-01', zoneId: null }],
      edges: [],
    };
    expect(alignRouteGraphToSpatial(same, buildSpatialPointIndex(entities))).toBe(same);
  });
});

describe('remapPlanCompareVmToSpatial（A2：Compare VM 对齐）', () => {
  it('before/after 点按 stationId/personId 重解析', () => {
    const vm: PlanCompareMapVM = {
      mode: 'DIFF',
      entries: [
        {
          taskId: 't1',
          changeTypes: ['PERSON_CHANGED'],
          reasons: [],
          before: { personId: null, deviceId: null, stationId: 'WS-01', plannedStart: null, point: { x: 500, y: 150 } },
          after: { personId: 'P1', deviceId: null, stationId: null, plannedStart: null, point: { x: 500, y: 585 } },
        },
      ],
      unchangedTaskIds: [],
      addedCount: 0,
      removedCount: 0,
      changedCount: 1,
      churn: 1,
      changeTypeCounts: {},
      missingCoordinates: [],
    };
    const aligned = remapPlanCompareVmToSpatial(vm, buildSpatialPointIndex(entities));
    expect(aligned?.entries[0].before?.point).toEqual({ x: 100, y: 200 });
    expect(aligned?.entries[0].after?.point).toEqual({ x: 150, y: 250 });
  });
  it('null VM 返回 null', () => {
    expect(remapPlanCompareVmToSpatial(null, buildSpatialPointIndex(entities))).toBeNull();
  });
});
