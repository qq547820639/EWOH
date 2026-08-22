/* computeViewBox 布局重设计单测（2026-08-22）：
 * 覆盖 1) FOV/UWB 纳入包围盒；2) 自适应留白；3) 最小画布居中；4) 无感知默认回退。
 * 使用 jest 全局 describe/it/expect（ts-jest 配置，无需导入）。 */
import type { SpatialEntity } from '@shared/api.interface';
import { computeViewBox, type PerceptionExtent } from './factoryMapUtils';

function ent(partial: Partial<SpatialEntity> & Pick<SpatialEntity, 'entityType' | 'x' | 'y'>): SpatialEntity {
  return {
    id: partial.entityId ?? `e-${Math.random()}`,
    entityId: partial.entityId ?? `e-${Math.random()}`,
    parentId: null,
    name: partial.name ?? 'test',
    yaw: 0,
    bboxW: 10,
    bboxH: 10,
    status: 'active',
    sourceType: 'seed',
    confidence: 1,
    version: 1,
    extra: null,
    createdAt: '',
    updatedAt: '',
    ...partial,
  } as SpatialEntity;
}

describe('computeViewBox', () => {
  it('空实体返回 fallback', () => {
    const vb = computeViewBox([]);
    expect(vb).toEqual({ minX: 0, minY: 0, w: 1000, h: 700 });
  });

  it('无感知默认：实体 bbox + 自适应留白；不足最小画布时居中补白', () => {
    const entities = [
      ent({ entityType: 'workshop', x: 100, y: 100, bboxW: 80, bboxH: 60 }),
      ent({ entityType: 'workstation', x: 500, y: 400, bboxW: 24, bboxH: 18 }),
    ];
    const vb = computeViewBox(entities);
    // 实体角点：x ∈ [60, 512], y ∈ [70, 409] -> rawW=452, rawH=339
    // pad = clamp(max(452,339)*0.06=27.1, 40, 160) = 40
    // contentW=532 < MIN_CANVAS_W(600) → w=600，extraW=68 居中；contentH=419<420 → h=420
    expect(vb.w).toBe(600);
    expect(vb.h).toBe(420);
    // 内容居中：minX = acc.minX(60) - pad(40) - extraW/2(34) = -14
    expect(vb.minX).toBeCloseTo(-14, 5);
    // extraH = max(0, 420 - (339+80)) = 1 → minY = 70 - 40 - 0.5 = 29.5
    expect(vb.minY).toBeCloseTo(29.5, 5);
  });

  it('大尺度无感知：自适应留白生效且无需最小画布补白（minX=角点-pad）', () => {
    const entities = [
      ent({ entityType: 'workshop', x: 0, y: 0, bboxW: 80, bboxH: 60 }),
      ent({ entityType: 'workshop', x: 1000, y: 800, bboxW: 80, bboxH: 60 }),
    ];
    const vb = computeViewBox(entities);
    // rawW=1000+40-(0-40)=1080 → pad=clamp(1080*0.06=64.8,40,160)=64.8 → w=1080+129.6>600
    expect(vb.w).toBeGreaterThan(600);
    expect(vb.minX).toBeCloseTo(0 - 40 - 64.8, 3);
  });

  it('摄像头视锥顶点被纳入包围盒（FOV 不再被裁切）', () => {
    const entities = [
      ent({ entityType: 'workstation', x: 200, y: 200, bboxW: 24, bboxH: 18 }),
      // 摄像头朝右（yaw=0），fov=90，range=200 → 右翼顶点约 (200+141, 200+141)=(341,341)
      ent({ entityType: 'camera', x: 200, y: 200, extra: { fov_deg: 90, range: 200 } }),
    ];
    const fovPoints = [{ x: 200, y: 200 }, { x: 341, y: 59 }, { x: 341, y: 341 }];
    const perception: PerceptionExtent = { fovPoints, uwbCircles: [] };
    const vb = computeViewBox(entities, perception);
    // maxX 须覆盖 341（视锥顶点），而非仅实体 bbox 的 212
    expect(vb.minX).toBeLessThanOrEqual(200 - 12);
    expect(vb.minX + vb.w).toBeGreaterThanOrEqual(341);
    expect(vb.minY + vb.h).toBeGreaterThanOrEqual(341);
  });

  it('UWB 覆盖圈（r=150）被纳入包围盒', () => {
    const entities = [ent({ entityType: 'uwb_station', x: 100, y: 100, extra: { coverage_r: 150 } })];
    const perception: PerceptionExtent = { fovPoints: [], uwbCircles: [{ x: 100, y: 100, r: 150 }] };
    const vb = computeViewBox(entities, perception);
    // 半径 150 → 最远点 x=250；bbox 角点 x∈[95,105]；maxX 须 >= 250
    expect(vb.minX + vb.w).toBeGreaterThanOrEqual(250);
    expect(vb.minY + vb.h).toBeGreaterThanOrEqual(250);
  });

  it('小场景被最小画布约束并居中（避免元素过放大/贴边）', () => {
    const entities = [ent({ entityType: 'person', x: 50, y: 50, bboxW: 8, bboxH: 8 })];
    const vb = computeViewBox(entities); // 无感知
    expect(vb.w).toBeGreaterThanOrEqual(600);
    expect(vb.h).toBeGreaterThanOrEqual(420);
    // 内容（x=50, rawW=8）应居中于画布：minX 远离 0 边界（左侧留白显著）
    expect(vb.minX).toBeLessThan(50 - 8 - 100);
  });

  it('大场景 padding 随尺度增长但仍 clamp 到 PAD_MAX', () => {
    const entities = [
      ent({ entityType: 'workshop', x: 0, y: 0, bboxW: 80, bboxH: 60 }),
      ent({ entityType: 'workshop', x: 3000, y: 2000, bboxW: 80, bboxH: 60 }),
    ];
    const vb = computeViewBox(entities);
    const rawW = 3000 + 40 - (0 - 40); // 3080
    const pad = Math.min(160, Math.max(40, rawW * 0.06)); // clamp 160
    expect(pad).toBe(160);
    expect(vb.w).toBeCloseTo(rawW + pad * 2, 4);
  });
});
