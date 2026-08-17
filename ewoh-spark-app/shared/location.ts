/* 前后端共享契约 - Canonical Location Model（ADR-007 / NO-02c）。
 *
 * 权威契约：contracts/location/location.schema.json + contracts/location/test-vectors.json。
 * 语义与 src/edge_platform/contracts/location.py 逐项一致（共享向量约束）：
 * 空间类型封闭注册表（v1 21 类）；FACTORY_CARTESIAN（米制 +X 东 +Y 北 +Z 上，
 * yaw 自北顺时针 [0,360)）；WGS84 lat∈[-90,90]/lng∈[-180,180]；
 * UNKNOWN=无坐标可用（禁止携带坐标值）。
 */

export const SPATIAL_KINDS = [
  'factory',
  'building',
  'floor',
  'area',
  'workshop',
  'production_line',
  'zone',
  'workstation',
  'station',
  'dock',
  'warehouse_location',
  'route',
  'restricted_zone',
  'device',
  'person',
  'task',
  'camera',
  'sensor',
  'uwb_station',
  'charging_area',
  'staging_area',
] as const;
export type SpatialKind = (typeof SPATIAL_KINDS)[number];

export const COORDINATE_TYPES = ['FACTORY_CARTESIAN', 'WGS84', 'UNKNOWN'] as const;
export type CoordinateType = (typeof COORDINATE_TYPES)[number];

export interface LocationRecord {
  coordinateType: CoordinateType;
  x?: number | null;
  y?: number | null;
  z?: number | null;
  yawDeg?: number | null;
  confidence?: number | null;
}

const SPATIAL_KIND_SET: ReadonlySet<string> = new Set(SPATIAL_KINDS);

export function isValidSpatialKind(value: string): value is SpatialKind {
  return SPATIAL_KIND_SET.has(value);
}

export function validateLocationRecord(record: unknown): string[] {
  if (record == null || typeof record !== 'object' || Array.isArray(record)) {
    return ['record_must_be_object'];
  }
  const rec = record as Record<string, unknown>;
  const coordinateType = rec.coordinateType;
  if (typeof coordinateType !== 'string' || !(COORDINATE_TYPES as readonly string[]).includes(coordinateType)) {
    return ['bad_coordinate'];
  }

  const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const hasCoord = [rec.x, rec.y, rec.z, rec.yawDeg].some((v) => v != null);
  if (coordinateType === 'UNKNOWN') {
    return hasCoord ? ['bad_coordinate'] : [];
  }

  const errors: string[] = [];
  if (coordinateType === 'WGS84') {
    // SH-014：x/y 任一缺失即早返单条 bad_coordinate（对齐 Python 早返语义，
    // 不再产生两条重复错误码）。
    if (rec.x == null || rec.y == null) return ['bad_coordinate'];
    if (!isNumber(rec.x) || rec.x < -90 || rec.x > 90) errors.push('bad_coordinate');
    if (!isNumber(rec.y) || rec.y < -180 || rec.y > 180) errors.push('bad_coordinate');
  } else {
    for (const key of ['x', 'y', 'z']) {
      const value = rec[key];
      if (value != null && !isNumber(value)) errors.push('bad_coordinate');
    }
  }
  if (rec.yawDeg != null && (!isNumber(rec.yawDeg) || rec.yawDeg < 0 || rec.yawDeg >= 360)) {
    errors.push('bad_coordinate');
  }
  if (rec.confidence != null && (!isNumber(rec.confidence) || rec.confidence < 0 || rec.confidence > 1)) {
    errors.push('bad_coordinate');
  }
  return errors;
}
