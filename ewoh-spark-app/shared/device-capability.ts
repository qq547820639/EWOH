/* 设备能力词表（2026-09-10，能力模型落地）。
 *
 * 背景：DDL 里早有 `ewoh_device_capability`（含 `UNIQUE (org_id, device_id,
 * capability_key)`），但**没有任何 ORM 映射、没有写入方**（实测 0 行）——
 * 世界模型因此只知道"有这台设备"，不知道"它能观测/执行什么"。调度、约束校验、
 * AI 解释都缺这一层事实（决策原则 3：优先建设统一世界模型、事件模型、能力模型）。
 *
 * 设计原则：
 *  - 能力 = **可验证的观测/执行维度**，不是营销标签；每类设备只声明它确实产出的事实；
 *  - 词表内键有中文名，**未登记键原样展示**（不隐藏、不猜含义）；
 *  - 能力声明是**幂等**的（同 (org, device, key) 只一行），由摄入路径自动登记，
 *    人工可在设备详情里看到；删除/停用走 `status`，不物理删除（审计留痕）。
 *
 * 跨运行地对应：边缘侧实际产出的字段见
 * `src/edge_platform/edge/modeling/sensor_frames.py`；两侧不得各自发明第三套名字。
 */

export const DEVICE_CAPABILITY_MODES = ['observation', 'execution', 'interaction'] as const;

/**
 * 能力的安全相关等级（NO-19a，契约 `capabilityRiskLevels`）。
 *
 * 为什么需要：放宽能力要求的建议此前只报"能多出几个候选"，把"放宽吊装能力"与
 * "放宽温度观测"说成同一件事。执行边界必须有边界——高风险能力（直接作用于人体或
 * 吊装载荷）的放宽必须由安全负责人确认，调度员不得单独决定（原则 4/6）。
 * - high：直接作用于人体或吊装载荷（exo-lift / interact.assist / crane / forklift）
 * - medium：有执行动作但风险可控，或"观测人员"涉及隐私
 * - low：设备自身状态与环境量、普通作业资格
 */
export const DEVICE_CAPABILITY_RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type DeviceCapabilityRiskLevel = (typeof DEVICE_CAPABILITY_RISK_LEVELS)[number];

export type DeviceCapabilityMode = (typeof DEVICE_CAPABILITY_MODES)[number];

export interface DeviceCapabilitySpec {
  /** 能力名（= 权威契约 `CapabilityRecord.name`，开放词表但必须显式登记）。 */
  key: string;
  /**
   * 权威契约（ADR-043 `contracts/capability/capability.schema.json`）的 `kind`：
   * 设备能力 = `device_capability`，外骨骼能力 = `exo_capability`。
   * 2026-09-10 对齐：本模块初版自造了 `observation`/`interaction` 当 kind，
   * 与既有 Canonical Capability Model 不一致（同一概念两套词表）——已修正，
   * 观测/交互语义降级为 `mode` 子属性（kind 只表达"谁的能力"）。
   */
  kind: 'device_capability' | 'exo_capability';
  /** 权威契约的 `providerType`。 */
  providerType: 'device' | 'exo';
  /** 能力形态（观测 / 交互）：权威契约没有该维度，作为子属性显式保留。 */
  mode: DeviceCapabilityMode;
  /** 安全相关等级（见 DEVICE_CAPABILITY_RISK_LEVELS 注释）。 */
  risk: DeviceCapabilityRiskLevel;
  /** 中文名（UI/文档共用；未登记键没有中文名，UI 原样显示 key）。 */
  label: string;
  /** 该能力产出的事实字段（来自哪个统一帧字段；用于"来源可追溯"）。 */
  fields: readonly string[];
}

/** 能力键 → 规格（唯一事实源；新增能力必须先在此登记）。 */
export const DEVICE_CAPABILITY_SPECS: Readonly<Record<string, DeviceCapabilitySpec>> = {
  // ---- 环境传感器（device_capability / device）----
  'observe.temperature': { key: 'observe.temperature', kind: 'device_capability', providerType: 'device', mode: 'observation', label: '环境温度', fields: ['temperature'], risk: 'low' },
  'observe.vibration': { key: 'observe.vibration', kind: 'device_capability', providerType: 'device', mode: 'observation', label: '振动', fields: ['vibration'], risk: 'low' },
  'observe.noise': { key: 'observe.noise', kind: 'device_capability', providerType: 'device', mode: 'observation', label: '噪声', fields: ['noise'], risk: 'low' },
  'observe.air_quality': { key: 'observe.air_quality', kind: 'device_capability', providerType: 'device', mode: 'observation', label: '空气质量(PM2.5)', fields: ['air_quality'], risk: 'low' },
  // ---- 摄像头 ----
  'observe.person_detection': { key: 'observe.person_detection', kind: 'device_capability', providerType: 'device', mode: 'observation', label: '人员检测', fields: ['detections[].track_id', 'detections[].confidence'], risk: 'medium' },
  'observe.pose': { key: 'observe.pose', kind: 'device_capability', providerType: 'device', mode: 'observation', label: '姿态骨架', fields: ['detections[].skeleton'], risk: 'medium' },
  'observe.action': { key: 'observe.action', kind: 'device_capability', providerType: 'device', mode: 'observation', label: '动作识别', fields: ['detections[].action'], risk: 'medium' },
  // ---- 定位标签 ----
  'observe.position': { key: 'observe.position', kind: 'device_capability', providerType: 'device', mode: 'observation', label: '人员/资产位置', fields: ['x', 'y', 'z', 'confidence'], risk: 'medium' },
  // ---- 外骨骼（exo_capability / exo）----
  'observe.load': { key: 'observe.load', kind: 'exo_capability', providerType: 'exo', mode: 'observation', label: '负荷/力矩', fields: ['load.cumulative_load_score', 'load.torque_nm'], risk: 'low' },
  'observe.battery': { key: 'observe.battery', kind: 'exo_capability', providerType: 'exo', mode: 'observation', label: '电量', fields: ['device.battery_pct'], risk: 'low' },
  'observe.wearer': { key: 'observe.wearer', kind: 'exo_capability', providerType: 'exo', mode: 'observation', label: '佩戴人员', fields: ['worker_id'], risk: 'medium' },
  'interact.assist': { key: 'interact.assist', kind: 'exo_capability', providerType: 'exo', mode: 'interaction', label: '助力交互', fields: ['load.assist_level'], risk: 'high' },
  // --- 执行类能力（2026-09-11 登记：此前只在调度侧型号白名单里，词表外 → 不可校验、不可人工停用） ---
  'exo-lift': { key: 'exo-lift', kind: 'exo_capability', providerType: 'exo', mode: 'execution', label: '助力提升', fields: [], risk: 'high' },
  'exo-lite': { key: 'exo-lite', kind: 'exo_capability', providerType: 'exo', mode: 'execution', label: '轻量助力', fields: [], risk: 'medium' },
  'vacuum': { key: 'vacuum', kind: 'device_capability', providerType: 'device', mode: 'execution', label: '吸尘作业', fields: [], risk: 'medium' },
  'crane': { key: 'crane', kind: 'device_capability', providerType: 'device', mode: 'execution', label: '吊装作业', fields: [], risk: 'high' },
  // --- NO-59b：执行机构（AGV/PLC）能力 ---
  // 执行类能力不产出观测列（与 exo-lift/vacuum/crane 同约定）：搬运过程的
  // 位置/电量/故障由观测能力 observe.actuator_state 负责；执行能力只表达'能让设备做什么'。
  'transport.move': { key: 'transport.move', kind: 'device_capability', providerType: 'device', mode: 'execution', label: '搬运移动', fields: [], risk: 'high' },
  'observe.actuator_state': { key: 'observe.actuator_state', kind: 'device_capability', providerType: 'device', mode: 'observation', label: '执行机构状态', fields: ['state', 'battery_pct', 'fault_code'], risk: 'low' },
};

/** 设备类别 → 能力键（与 `shared/device-category.ts` 词表一一对应）。 */
export const CAPABILITIES_BY_CATEGORY: Readonly<Record<string, readonly string[]>> = {
  environment_sensor: ['observe.temperature', 'observe.vibration', 'observe.noise', 'observe.air_quality'],
  camera: ['observe.person_detection', 'observe.pose', 'observe.action'],
  location_tag: ['observe.position'],
  exoskeleton: ['observe.load', 'observe.battery', 'observe.wearer', 'interact.assist'],
  // AGV/PLC：可搬运（执行，高危：会动起来 → 命令必须带平台授权号）、上报自身状态与位置。
  agv: ['transport.move', 'observe.actuator_state', 'observe.position'],
  // 未知类别**不声明任何能力**：宁可能力为空，也不猜"它大概能看什么"。
  unknown: [],
};

/** 取某类别应声明的能力键（未登记类别 → 空列表，显式无能力）。 */
export function capabilitiesForCategory(category: string | null | undefined): readonly string[] {
  if (!category) return [];
  return CAPABILITIES_BY_CATEGORY[category] ?? [];
}

/** 能力展示名：词表内用中文名，未登记键原样返回（不隐藏、不猜）。 */
export function formatCapability(key: string): string {
  return DEVICE_CAPABILITY_SPECS[key]?.label ?? key;
}

/** 未登记能力键（UI/运维可据此发现"设备报了词表外的能力"）。 */
/**
 * 能力的安全相关等级（未登记能力名返回 null：**不猜**——未知能力既不能当低风险，
 * 也不能当高风险，调用方必须显式处理"未知"）。
 */
export function capabilityRiskLevel(name: string): DeviceCapabilityRiskLevel | null {
  return DEVICE_CAPABILITY_SPECS[name]?.risk ?? null;
}

/** 该能力是否属于高风险（放宽要求需安全负责人确认）。未知能力返回 false 但调用方应提示未知。 */
export function isHighRiskCapability(name: string): boolean {
  return capabilityRiskLevel(name) === 'high';
}

export function isRegisteredCapability(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(DEVICE_CAPABILITY_SPECS, key);
}

/** 本模块登记的全部能力名（= 权威契约 knownValues 的登记集合，测试锁定）。 */
export const DEVICE_CAPABILITY_NAMES: readonly string[] = Object.keys(DEVICE_CAPABILITY_SPECS).sort();

/**
 * 权威契约 subject 形状：`^[a-z0-9_]+:.+$`（前缀语义由 identity 域深校验）。
 * 设备 → `device:<deviceId>`；外骨骼 → `exo:<deviceId>`。
 */
export function capabilitySubject(deviceId: string, category: string | null | undefined): string {
  const prefix = category === 'exoskeleton' ? 'exo' : 'device';
  // 契约 pattern 只约束**前缀**必须小写（`^[a-z0-9_]+:.+$`），值部分保留原样：
  // 设备号是业务标识（大小写敏感，如 ENV-SIM-AbC），整体 toLowerCase 会把它
  // 悄悄折叠成另一个身份（并可能让两个设备号相撞）——身份不得被"归一化"改写。
  const value = String(deviceId ?? '').trim();
  return `${prefix}:${value}`;
}

/** 确定性 capabilityId（幂等重放同 id；前缀满足契约 pattern）。 */
export function capabilityIdFor(deviceId: string, category: string | null | undefined, name: string): string {
  return `cap:${capabilitySubject(deviceId, category)}:${name}`;
}

/**
 * 构造权威 `CapabilityRecord`（ADR-043）。
 *
 * 用途：写入台账前用 `validateCapability` 校验（fail-closed）——设备能力台账
 * 必须与 Canonical Capability Model 逐字段一致，不能是"另一套能力表"。
 * `evidence` 记录该能力的来源帧字段（可追溯）。
 */
export function toCapabilityRecord(params: {
  deviceId: string;
  category: string | null | undefined;
  name: string;
  mode: DeviceCapabilityMode;
  label: string;
  fields: readonly string[];
  grantedAt: string;
}): {
  capabilityId: string;
  kind: 'device_capability' | 'exo_capability';
  name: string;
  providerType: 'device' | 'exo';
  subject: string;
  grantedAt: string;
  evidence: string[];
  auditTrail: boolean;
} {
  const isExo = params.category === 'exoskeleton';
  return {
    capabilityId: capabilityIdFor(params.deviceId, params.category, params.name),
    kind: isExo ? 'exo_capability' : 'device_capability',
    name: params.name,
    providerType: isExo ? 'exo' : 'device',
    subject: capabilitySubject(params.deviceId, params.category),
    grantedAt: params.grantedAt,
    evidence: [...params.fields],
    auditTrail: true,
  };
}
