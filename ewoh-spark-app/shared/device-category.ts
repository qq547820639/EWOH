/* 设备类别词表（2026-09-10，感知层纳入设备台账）。
 *
 * 为什么需要：`ewoh_device` 早有 `device_category` 列（001 DDL），但**没有任何
 * 代码写它**（实测：dev 库 8 行全为 NULL，TS/seed/前端均无引用）。结果平台设备
 * 台账只认识外骨骼——环境传感器、摄像头、UWB 定位标签即使把数据送进平台，
 * 设备页/在线率/新鲜度也看不到它们（感知层在 UI 上不存在）。
 *
 * 词表刻意保持**与生产方一一对应**，不做"大而全"的猜测：
 *  - `exoskeleton`       ← 外骨骼摄入（/api/ingest/exoskeleton）
 *  - `environment_sensor`← 环境传感器（/api/ingest/environment）
 *  - `camera`            ← 摄像头（/api/ingest/camera）
 *  - `location_tag`      ← 定位标签（/api/ingest/location）
 *  - `agv`               ← 执行机构（/api/ingest/actuator；边缘 actuator 适配器上行）
 * 未识别的取值一律归一为 `unknown`（**显式未知**，绝不猜一个相近类别），
 * 前端必须把它显示为"未知类别"而不是某个具体类别。
 *
 * 跨运行地对应：边缘侧 `src/edge_platform/edge/modeling/sensor_frames.py` 的
 * `FRAME_KIND_*` 是同一批类别的边缘口径（kind → 本词表的映射见
 * `INGEST_CATEGORY_BY_KIND`），两侧不得各自发明第三套名字。
 */

export const DEVICE_CATEGORIES = [
  'exoskeleton',
  'environment_sensor',
  'camera',
  'location_tag',
  // NO-59b：执行机构（AGV/PLC）。愿景的执行层此前在设备台账里**不存在**——
  // 平台能下发控制命令、却看不见"执行机构"这类设备本身。
  'agv',
] as const;

export type DeviceCategory = (typeof DEVICE_CATEGORIES)[number];

/** 显式未知类别（列可为 NULL/历史值无法识别时使用；不是"默认类别"）。 */
export const DEVICE_CATEGORY_UNKNOWN = 'unknown';

const CATEGORY_SET: ReadonlySet<string> = new Set(DEVICE_CATEGORIES);

/** 是否为词表内类别（用于写入校验；未知值必须被调用方显式处理）。 */
export function isKnownDeviceCategory(value: unknown): value is DeviceCategory {
  return typeof value === 'string' && CATEGORY_SET.has(value);
}

/**
 * 归一化设备类别：词表内直通，其余（含 null/空/历史脏值）→ `unknown`。
 * 读取路径用它保证前端永远拿到可判定的类别，而不是 undefined 静默当默认。
 */
export function normalizeDeviceCategory(value: unknown): DeviceCategory | typeof DEVICE_CATEGORY_UNKNOWN {
  return isKnownDeviceCategory(value) ? value : DEVICE_CATEGORY_UNKNOWN;
}

/**
 * 摄入 kind → 设备类别（唯一映射点）。
 * 边缘 `FRAME_KIND_*`：exoskeleton / environment / camera / location。
 */
export const INGEST_CATEGORY_BY_KIND: Readonly<Record<string, DeviceCategory>> = {
  exoskeleton: 'exoskeleton',
  environment: 'environment_sensor',
  camera: 'camera',
  location: 'location_tag',
  actuator: 'agv',
};

/** 中文展示名（服务端日志/文档可用；前端另有本地化表，保持同值）。 */
export const DEVICE_CATEGORY_LABELS: Readonly<Record<string, string>> = {
  exoskeleton: '外骨骼',
  environment_sensor: '环境传感器',
  camera: '摄像头',
  location_tag: '定位标签',
  agv: '执行机构（AGV/PLC）',
  [DEVICE_CATEGORY_UNKNOWN]: '未知类别',
};
