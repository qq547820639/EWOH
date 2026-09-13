/* 前后端共享契约 —— 多模态感知融合（Perception Fusion，NO-56a，§5 感知融合层）。
 *
 * 实现 `docs/architecture/embodied_factory.md` §5 的融合公式与五条可解释规则：
 *   人员状态 = f( UWB位置, 外骨骼IMU姿态, 视觉骨架, 工位语义, 任务上下文 )
 *   1. UWB 与视觉同工位 → 高置信；
 *   2. UWB 与视觉不一致 → **产生冲突记录**（冲突详情 + 各源置信度），不静默丢弃；
 *   3. 摄像头不可用但外骨骼 IMU 与工位签到正常 → 继续推断并**降低置信度**；
 *   4. 任一源缺失 → 降级融合（置信度按缺失源权重下降），**不中断输出**；
 *   5. 低置信度**不向上游生成强建议**（这里落成机器可读的 `strongAdviceAllowed`）。
 *
 * 三条诚实边界（原则 5/7）：
 *   · **置信度是"可解释的加权"，不是标定概率**：它是"可用源权重和 / 应有源权重和"，
 *     随缺失源下降；页面/上游必须能读到权重依据（`confidence.basis`），不许当成概率用；
 *   · **缺失/过期/不可信一律显式**：观测进入 `confidence.excludedSources`（stale/untrusted）
 *     或 `confidence.missingSources`（该源本窗口没有任何观测），绝不用默认值/0 顶替；
 *   · **不猜**：坐标解析不到工位就是 `stationId=null`（附距离与半径依据），
 *     视觉 track 没绑定到人也如实进 `unmatched`，不按"最像的人"分配。
 */

export const PERCEPTION_SOURCES = [
  /** UWB/Wi-Fi/视觉融合定位（位置主源）。 */
  'uwb',
  /** 外骨骼 IMU（姿态与动作主源）。 */
  'exo_imu',
  /** 视觉骨架/检测（姿态交叉验证与遮挡场景补充）。 */
  'vision',
  /** 工位语义（坐标 → 工位；签到/占用）。 */
  'station_semantics',
  /** 任务上下文（当前任务期望工位/动作，作为先验约束）。 */
  'task_context',
  /**
   * 环境传感（温度/振动/噪声/空气质量，`ewoh_environment`）。
   *
   * 用于**区域级**融合（主体 = 环境观测绑定的实体/工位）：同一区域多台环境传感器
   * 报同一通道时就构成"同类多源交叉验证"——一致才算 consistent，不一致即冲突，
   * 只有一台传感器时只能算 partial（没有第二个独立源确认）。
   */
  'env_sensor',
] as const;
export type PerceptionSource = (typeof PERCEPTION_SOURCES)[number];

export const PERCEPTION_DIMENSIONS = [
  'position',
  'posture',
  'action',
  'station_presence',
  /** 环境通道（温度/振动/噪声/空气质量）；值放在 `value.ambient`，通道名在 value.channel。 */
  'ambient',
] as const;
export type PerceptionDimension = (typeof PERCEPTION_DIMENSIONS)[number];

export const PERCEPTION_QUALITIES = ['good', 'degraded', 'invalid'] as const;
export type PerceptionQuality = (typeof PERCEPTION_QUALITIES)[number];

export const PERCEPTION_AGREEMENTS = ['consistent', 'partial', 'conflict', 'insufficient'] as const;
export type PerceptionAgreement = (typeof PERCEPTION_AGREEMENTS)[number];

export const PERCEPTION_CONFIDENCE_LEVELS = ['high', 'medium', 'low', 'unknown'] as const;
export type PerceptionConfidenceLevel = (typeof PERCEPTION_CONFIDENCE_LEVELS)[number];

/** 未上报置信度时的惩罚因子（有观测但不知其可信度 ≠ 完全可信）。 */
export const UNKNOWN_SOURCE_CONFIDENCE_FACTOR = 0.6;
/** 源质量因子（invalid 直接排除，不参与加权）。 */
export const QUALITY_FACTORS: Readonly<Record<string, number>> = { good: 1, degraded: 0.6 };
/** 置信度分级门槛（对"可用源权重和 / 应有源权重和"）。 */
export const CONFIDENCE_LEVEL_THRESHOLDS = { high: 0.75, medium: 0.5 } as const;
/** 姿态冲突容差：外骨骼俯仰 ≥ 该角度视为"弯腰/前倾"，视觉动作若为 standing 则冲突。 */
export const POSTURE_BEND_DEG = 45;

/* ── 外骨骼关节角 → 动作（NO-59a：动作维度的第二个独立源）────────────────
 *
 * 为什么需要：动作维度此前**只有视觉一个源**（模型给的 `detections[].action` 字符串），
 * 而 `ewoh_telemetry.joint_angles` 一直被摄入、被 SELECT、却从未参与融合。
 * 这里把关节角确定性地映射成**封闭词表**里的动作，使"动作"具备两个独立源：
 * 外骨骼（IMU 关节角，实测）与视觉（模型输出），两者不一致即记冲突（各源都保留）。
 *
 * 诚实边界（原则 7）：
 *   · 只做阈值几何判定，**不做步态/行走识别**——关节角不足以区分"行走/搬运/静止"，
 *     这类结论需要步态周期/动作频率，缺失时返回 null + 明确原因（不猜）；
 *   · 关键角缺失或非数值 → null + 原因，绝不默认成 standing。
 */
export const EXO_ACTION_KNEE_SQUAT_DEG = 60;
export const EXO_ACTION_KNEE_KNEEL_DEG = 45;
export const EXO_ACTION_KNEE_ASYMMETRY_DEG = 25;
export const EXO_ACTION_UPRIGHT_PITCH_DEG = 15;
export const EXO_ACTION_KNEE_STANDING_MAX_DEG = 30;

export const EXO_DERIVED_ACTIONS = ['standing', 'bending', 'squatting', 'kneeling'] as const;
export type ExoDerivedAction = (typeof EXO_DERIVED_ACTIONS)[number];

/** 关节角别名（厂商/边缘命名差异；只登记含义确定的写法）。 */
export const EXO_JOINT_ALIASES: Readonly<Record<'left_knee' | 'right_knee', readonly string[]>> = {
  left_knee: ['left_knee', 'knee_left', 'l_knee', 'knee_l', 'left_knee_deg'],
  right_knee: ['right_knee', 'knee_right', 'r_knee', 'knee_r', 'right_knee_deg'],
};

/** 动作词表 → 是否"直立"。用于两个独立动作源的交叉验证（未知动作不参与判定）。 */
export const UPRIGHT_ACTIONS: readonly string[] = ['standing', 'stand', 'upright', '立姿', '站立'];
export const NON_UPRIGHT_ACTIONS: readonly string[] = [
  'bending', 'bend', 'squatting', 'squat', 'kneeling', 'kneel', 'crouching', 'crouch',
  'lying', 'sitting', 'sit', '弯腰', '下蹲', '跪姿', '坐姿',
];

export interface ExoActionDerivation {
  /** 派生动作（封闭词表）；null = 无法判定（见 reason）。 */
  action: ExoDerivedAction | null;
  /** 可解释依据（用了哪些角、各自数值、命中的阈值）。 */
  basis: string;
  /** 判定不了时的原因。 */
  reason: string | null;
}

function jointAngleOf(jointAngles: Record<string, unknown> | null | undefined, names: readonly string[]): number | null {
  if (!jointAngles || typeof jointAngles !== 'object') return null;
  const entries = Object.entries(jointAngles);
  for (const name of names) {
    const hit = entries.find(([key]) => key.trim().toLowerCase() === name);
    if (!hit) continue;
    const value = Number(hit[1]);
    if (!Number.isFinite(value)) return null;
    return value;
  }
  return null;
}

/**
 * 外骨骼关节角（+ 躯干俯仰）→ 动作（纯函数；确定性；封闭词表）。
 *
 * 判定顺序（先"更确定的姿态"，再直立，最后无法判定）：
 *   1. 双膝都 ≥ 60° → squatting；
 *   2. 双膝差 ≥ 25° 且较大侧 ≥ 45° → kneeling（单膝跪姿）；
 *   3. 躯干俯仰 ≥ 45° → bending（弯腰；与视觉动作词冲突规则同阈值）；
 *   4. 俯仰已知且 < 15°、双膝 < 30° → standing；
 *   5. 其余（中间态、缺角、无俯仰）→ null + 原因（**行走无法由关节角判定**）。
 */
export function deriveExoAction(
  jointAngles: Record<string, unknown> | null | undefined,
  pitchDeg: number | null | undefined,
): ExoActionDerivation {
  const leftKnee = jointAngleOf(jointAngles, EXO_JOINT_ALIASES.left_knee);
  const rightKnee = jointAngleOf(jointAngles, EXO_JOINT_ALIASES.right_knee);
  // 注意：不能用 `Number(pitchDeg)` 一把梭——`Number(null) === 0` 会把"俯仰未知"变成
  // "俯仰 0°"（正是原则 7 禁止的"缺失被伪造成确定事实"；实测该 bug 让缺俯仰的输入被判成 standing）。
  const pitchInput = pitchDeg as unknown;
  const rawPitch = pitchInput === null || pitchInput === undefined
    || (typeof pitchInput === 'string' && pitchInput.trim() === '')
    ? null
    : Number(pitchInput);
  const pitch = rawPitch !== null && Number.isFinite(rawPitch) ? rawPitch : null;
  const knees = [leftKnee, rightKnee].filter((v): v is number => v !== null);
  if (knees.length === 0) {
    return {
      action: null,
      basis: '无膝角可用',
      reason: '缺少膝角（left_knee/right_knee 都不可用）→ 不判定动作（不猜；行走还需步态周期，关节角不足以判定）',
    };
  }
  const minKnee = Math.min(...knees);
  const maxKnee = Math.max(...knees);
  const basisAngles = `膝角 L=${leftKnee ?? '未知'} / R=${rightKnee ?? '未知'}，躯干俯仰=${pitch ?? '未知'}`;

  if (knees.length === 2 && minKnee >= EXO_ACTION_KNEE_SQUAT_DEG) {
    return { action: 'squatting', basis: `${basisAngles} → 双膝 ≥ ${EXO_ACTION_KNEE_SQUAT_DEG}°`, reason: null };
  }
  if (knees.length === 2 && Math.abs(leftKnee! - rightKnee!) >= EXO_ACTION_KNEE_ASYMMETRY_DEG && maxKnee >= EXO_ACTION_KNEE_KNEEL_DEG) {
    return {
      action: 'kneeling',
      basis: `${basisAngles} → 双膝差 ≥ ${EXO_ACTION_KNEE_ASYMMETRY_DEG}° 且较大侧 ≥ ${EXO_ACTION_KNEE_KNEEL_DEG}°`,
      reason: null,
    };
  }
  if (pitch !== null && pitch >= POSTURE_BEND_DEG) {
    return { action: 'bending', basis: `${basisAngles} → 俯仰 ≥ ${POSTURE_BEND_DEG}°`, reason: null };
  }
  if (pitch !== null && pitch < EXO_ACTION_UPRIGHT_PITCH_DEG && maxKnee < EXO_ACTION_KNEE_STANDING_MAX_DEG) {
    return {
      action: 'standing',
      basis: `${basisAngles} → 俯仰 < ${EXO_ACTION_UPRIGHT_PITCH_DEG}° 且膝角 < ${EXO_ACTION_KNEE_STANDING_MAX_DEG}°`,
      reason: null,
    };
  }
  return {
    action: null,
    basis: basisAngles,
    reason:
      `关节角/俯仰落在中间态（膝 ${minKnee}~${maxKnee}°${pitch === null ? '，俯仰未知' : `，俯仰 ${pitch}°`}）`
      + '：不足以判定动作（行走/搬运需步态周期与动作频率）→ 不猜',
  };
}

/** 动作是否"直立"（未知动作返回 null = 不参与交叉验证）。 */
export function uprightnessOf(action: string | null | undefined): boolean | null {
  const value = String(action ?? '').trim().toLowerCase();
  if (value === '') return null;
  if (UPRIGHT_ACTIONS.some((a) => a.toLowerCase() === value)) return true;
  if (NON_UPRIGHT_ACTIONS.some((a) => a.toLowerCase() === value)) return false;
  return null;
}
/** 位置一致性容差（米）：两个源坐标差在容差内视为同位置。 */
export const POSITION_TOLERANCE_M = 2.5;
/** 环境通道的"关注阈值"（只报事实：超了就在结论里标出来，不替现场判定是否停机）。 */
export const AMBIENT_WATCH_THRESHOLDS: Readonly<Record<string, number>> = {
  temperature: 35,
  vibration: 8,
  noise: 85,
  air_quality: 150,
};
/** 环境通道单位（展示口径；未知通道不编单位）。 */
export const AMBIENT_UNITS: Readonly<Record<string, string>> = {
  temperature: '°C',
  vibration: 'mm/s',
  noise: 'dB',
  air_quality: 'index',
};
/** 同一通道多传感器一致性容差（相对值：max-min <= 该比例×均值即视为一致）。 */
export const AMBIENT_AGREEMENT_TOLERANCE = 0.2;

export interface FusionSourcePolicy {
  source: PerceptionSource;
  /** 基础权重（可解释加权，不是概率）。 */
  baseWeight: number;
  /** 证据有效期：超过即视为 stale（不参与融合，但显式登记）。 */
  ttlMs: number;
  /** 该源能提供的维度。 */
  dimensions: readonly PerceptionDimension[];
}

/**
 * 默认源策略（登记表；调用方可覆盖，但覆盖必须显式传入并在记录里可见）。
 *
 * 权重口径：位置主源（uwb）最高；姿态主源（exo_imu）次之；视觉用于交叉验证；
 * 工位语义与任务上下文是"语义/先验"而非测量，权重最低。
 */
export const DEFAULT_SOURCE_POLICIES: readonly FusionSourcePolicy[] = [
  { source: 'uwb', baseWeight: 0.35, ttlMs: 60_000, dimensions: ['position', 'station_presence'] },
  { source: 'exo_imu', baseWeight: 0.3, ttlMs: 120_000, dimensions: ['posture', 'action'] },
  { source: 'vision', baseWeight: 0.2, ttlMs: 60_000, dimensions: ['posture', 'action', 'station_presence'] },
  { source: 'station_semantics', baseWeight: 0.1, ttlMs: 300_000, dimensions: ['station_presence'] },
  { source: 'task_context', baseWeight: 0.05, ttlMs: 900_000, dimensions: ['station_presence', 'action'] },
  // 环境源：区域级融合的主力（同类多源交叉验证）；权重高于上下文、低于直接测量人员状态的源。
  { source: 'env_sensor', baseWeight: 0.25, ttlMs: 120_000, dimensions: ['ambient'] },
];

/**
 * 主体类型与"应有源"：**按主体类型判定缺失**，不把所有源一刀切当成应有。
 *
 * 实测教训（2026-09-12）：把 `env_sensor` 加进全局应有源后，人员级融合永远"缺环境源"
 * → 全部降级、高置信永远达不到（与之前把 station_semantics/task_context 当缺失源同一类错）。
 * 人员状态与环境通道是两套证据面：人员看 UWB/外骨骼/视觉/工位/任务；区域看环境/视觉/工位。
 */
export const PERSON_EXPECTED_SOURCES: readonly PerceptionSource[] = [
  'uwb', 'exo_imu', 'vision', 'station_semantics', 'task_context',
];
export const AREA_EXPECTED_SOURCES: readonly PerceptionSource[] = [
  'env_sensor', 'vision', 'station_semantics',
];

export type PerceptionSubjectKind = 'person' | 'area' | 'unknown';

/** 从主体 id 前缀推断主体类型（`person:` / `station:` / `workstation:` / `area:` / `zone:`）。 */
export function inferSubjectKind(subjectId: string): PerceptionSubjectKind {
  const id = String(subjectId ?? '').trim().toLowerCase();
  if (id.startsWith('person:') || id.startsWith('worker:')) return 'person';
  if (
    id.startsWith('station:') || id.startsWith('workstation:')
    || id.startsWith('area:') || id.startsWith('zone:') || id.startsWith('workshop:')
  ) return 'area';
  return 'unknown';
}

export interface PerceptionObservationValue {
  /** 环境通道名（temperature/vibration/noise/air_quality）。 */
  channel?: string | null;
  /** 环境通道读数（单位随通道：°C / mm·s⁻¹ / dB / 指数）。 */
  ambient?: number | null;
  x?: number | null;
  y?: number | null;
  z?: number | null;
  stationId?: string | null;
  pitchDeg?: number | null;
  action?: string | null;
  present?: boolean | null;
}

export interface PerceptionObservation {
  source: PerceptionSource;
  /** 硬件/证据 id（设备号、相机号、任务号）——"这条结论来自哪台设备"必须可追。 */
  sourceId: string;
  dimension: PerceptionDimension;
  observedAt: string;
  quality: PerceptionQuality;
  /** 0..1；null = 该源未上报置信度（不当作 1）。 */
  confidence: number | null;
  value: PerceptionObservationValue;
  /** 该观测如何归属到本主体（track_id / wearer_binding / nearest_station…）。 */
  matchedBy?: string | null;
}

export interface FusePerceptionInput {
  subjectId: string;
  /** 显式主体类型；缺省按 id 前缀推断（见 inferSubjectKind）。 */
  subjectKind?: PerceptionSubjectKind;
  windowStart: string;
  windowEnd: string;
  now: string;
  observations: PerceptionObservation[];
  /** 定位坐标 → 工位（由服务层用空间实体算；null = 未解析，不猜）。 */
  stationFromLocation?: { stationId: string; distanceM: number; radiusM: number; basis: string } | null;
  /** 任务上下文（当前任务期望工位/动作）。 */
  taskContext?: { stationId: string | null; expectedAction: string | null; basis: string } | null;
  /** 覆盖默认源策略（显式传入才生效）。 */
  policies?: readonly FusionSourcePolicy[];
  /** 一致性半径（米），默认 POSITION_TOLERANCE_M。 */
  positionToleranceM?: number;
}

export interface ExcludedObservation {
  source: string;
  sourceId: string;
  dimension: string;
  status: 'stale' | 'untrusted' | 'dimension_mismatch';
  reason: string;
}

export interface PerceptionConflict {
  dimension: string;
  severity: 'low' | 'medium' | 'high';
  participants: Array<{ source: string; sourceId: string; value: string }>;
  detail: string;
}

/**
 * 建议门控摘要（**给上游消费用**）：规则引擎/候选引擎据此决定"这条结论能不能生成强建议"。
 *
 * 为什么单独抽出来：融合快照字段很多，上游只需要一个布尔 + 原因 + 依据；
 * 让上游自己解析快照会导致"每个调用方各写一套判定"（这个仓库反复踩的口径分裂）。
 */
export interface PerceptionAdviceGate {
  strongAdviceAllowed: boolean;
  level: string;
  agreement: string;
  /** 不允许时的原因（必填；允许时为 null）。 */
  reason: string | null;
  fusedAt: string;
  basis: string;
}

/** 从融合结果构造建议门控（纯函数；与 validateFusedPerception 同口径）。 */
export function perceptionAdviceGate(fused: FusedPerception): PerceptionAdviceGate {
  const allowed = fused.strongAdviceAllowed === true;
  const reason = allowed
    ? null
    : `感知融合不许强建议：一致性 ${fused.agreement} / 置信度 ${fused.confidence.level}`
      + (fused.conflicts.length > 0 ? ` / 冲突 ${fused.conflicts.length} 条` : '')
      + `（${fused.confidence.basis}）`;
  return {
    strongAdviceAllowed: allowed,
    level: fused.confidence.level,
    agreement: fused.agreement,
    reason,
    fusedAt: fused.fusedAt,
    basis: `window ${fused.windowStart}~${fused.windowEnd}；规则留痕 ${fused.ruleTrace.filter((r) => r.fired).length} 条命中`,
  };
}

export interface FusedPerception {
  subjectId: string;
  windowStart: string;
  windowEnd: string;
  fusedAt: string;
  agreement: PerceptionAgreement;
  position: { x: number | null; y: number | null; z: number | null; stationId: string | null; basis: string[] } | null;
  posture: { pitchDeg: number | null; action: string | null; basis: string[] } | null;
  station: { stationId: string | null; basis: string; sources: string[] } | null;
  /**
   * 环境通道结论（区域级融合；每个通道单独判定多源一致性）。
   * 只有一台传感器报某通道 → `agreement='partial'`（无交叉验证，不吹成"一致"）。
   */
  ambient: Array<{
    channel: string;
    agreement: 'consistent' | 'conflict' | 'single_source';
    sensors: Array<{ sourceId: string; value: number; quality: string }>;
    /** 一致时给出的代表值（多源均值）；冲突时为 null（不取平均掩盖分歧）。 */
    value: number | null;
    spread: number | null;
    unit: string | null;
    /** 是否超过登记的关注阈值（如高温 35°C）——只报事实，不替现场下结论。 */
    exceedsWatchThreshold: boolean;
  }> | null;
  confidence: {
    level: PerceptionConfidenceLevel;
    /** 可用源权重和 / 应有源权重和；null = 无可用源（不给分，不显示成 0%）。 */
    score: number | null;
    basis: string;
    usableSources: string[];
    degraded: boolean;
    missingSources: string[];
    excludedSources: ExcludedObservation[];
    unknownConfidenceSources: string[];
  };
  conflicts: PerceptionConflict[];
  /** 五条视觉规则逐条留痕（哪条命中、依据是什么）。 */
  ruleTrace: Array<{ rule: string; fired: boolean; detail: string }>;
  /** 低置信度/有冲突 → 上游不得据此生成强建议（原则 5/7）。 */
  strongAdviceAllowed: boolean;
  notes: string[];
}

const SOURCE_SET: ReadonlySet<string> = new Set(PERCEPTION_SOURCES);
const DIMENSION_SET: ReadonlySet<string> = new Set(PERCEPTION_DIMENSIONS);
const QUALITY_SET: ReadonlySet<string> = new Set(PERCEPTION_QUALITIES);
const AGREEMENT_SET: ReadonlySet<string> = new Set(PERCEPTION_AGREEMENTS);
const LEVEL_SET: ReadonlySet<string> = new Set(PERCEPTION_CONFIDENCE_LEVELS);

function isIso(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Date.parse(value));
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 融合快照号（确定性）：`FUSE-<主体>-<窗口桶起点毫秒>`——同窗口重复扫描幂等。 */
export function perceptionFusionId(subjectId: string, windowEndIso: string, bucketMs: number): string {
  const safeSubject = String(subjectId ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_.:-]/g, '_')
    .slice(0, 80) || 'unknown';
  const end = Date.parse(windowEndIso);
  const bucket = Number.isFinite(bucketMs) && bucketMs > 0 ? Math.trunc(bucketMs) : 300_000;
  const start = Number.isFinite(end) ? Math.floor(end / bucket) * bucket : 0;
  return `FUSE-${safeSubject}-${start}`.slice(0, 180);
}

/** 校验融合快照；返回错误码列表（空 = 合法）。fail-closed。 */
export function validateFusedPerception(record: unknown): string[] {
  if (record == null || typeof record !== 'object' || Array.isArray(record)) {
    return ['record_must_be_object'];
  }
  const r = record as Record<string, unknown>;
  for (const field of ['subjectId', 'windowStart', 'windowEnd', 'fusedAt', 'agreement', 'confidence', 'conflicts', 'ruleTrace', 'strongAdviceAllowed']) {
    if (!(field in r)) return [`missing_field:${field}`];
  }
  if (typeof r.subjectId !== 'string' || r.subjectId.trim() === '') return ['bad_subject_id'];
  if (!isIso(r.windowStart) || !isIso(r.windowEnd) || !isIso(r.fusedAt)) return ['bad_window'];
  if (Date.parse(String(r.windowStart)) > Date.parse(String(r.windowEnd))) return ['window_start_after_end'];
  if (!AGREEMENT_SET.has(String(r.agreement))) return ['unknown_agreement'];
  if (!Array.isArray(r.conflicts)) return ['bad_conflicts'];
  if (!Array.isArray(r.ruleTrace) || r.ruleTrace.length === 0) return ['missing_rule_trace'];
  if (typeof r.strongAdviceAllowed !== 'boolean') return ['bad_strong_advice_flag'];
  const confidence = r.confidence as Record<string, unknown>;
  if (confidence == null || typeof confidence !== 'object' || Array.isArray(confidence)) {
    return ['bad_confidence'];
  }
  if (!LEVEL_SET.has(String(confidence.level))) return ['unknown_confidence_level'];
  const score = confidence.score;
  if (score !== null && (typeof score !== 'number' || Number.isNaN(score) || score < 0 || score > 1)) {
    return ['bad_confidence_score'];
  }
  // 无可用源 → 必须是 unknown 且不给分（不许显示成 0%）。
  if (!Array.isArray(confidence.usableSources)) return ['bad_usable_sources'];
  if (confidence.usableSources.length === 0) {
    if (String(confidence.level) !== 'unknown') return ['no_source_requires_unknown_level'];
    if (score !== null) return ['no_source_requires_null_score'];
  }
  if (!Array.isArray(confidence.missingSources)) return ['bad_missing_sources'];
  if (!Array.isArray(confidence.excludedSources)) return ['bad_excluded_sources'];
  // 缺证据的结论不许允许强建议（原则 5/7）。
  if (r.strongAdviceAllowed === true) {
    if (String(r.agreement) === 'insufficient' || String(r.agreement) === 'conflict') {
      return ['strong_advice_not_allowed_with_insufficient_or_conflict'];
    }
    if (String(confidence.level) === 'low' || String(confidence.level) === 'unknown') {
      return ['strong_advice_not_allowed_at_low_confidence'];
    }
    if (Array.isArray(r.conflicts) && r.conflicts.length > 0) {
      return ['strong_advice_not_allowed_with_conflicts'];
    }
  }
  return [];
}

/* ── 融合算法（纯函数，可解释）────────────────────────────────────────── */

interface EvaluatedObservation {
  observation: PerceptionObservation;
  policy: FusionSourcePolicy;
  status: 'usable' | 'stale' | 'untrusted' | 'dimension_mismatch';
  ageMs: number;
  qualityFactor: number;
  freshnessFactor: number;
  confidenceFactor: number;
}

function evaluate(
  observation: PerceptionObservation,
  policies: readonly FusionSourcePolicy[],
  nowMs: number,
): EvaluatedObservation {
  const policy = policies.find((p) => p.source === observation.source)
    ?? { source: observation.source, baseWeight: 0, ttlMs: 0, dimensions: [] };
  const observedMs = Date.parse(observation.observedAt);
  const ageMs = Number.isFinite(observedMs) ? Math.max(0, nowMs - observedMs) : Number.POSITIVE_INFINITY;
  const base: EvaluatedObservation = {
    observation,
    policy,
    status: 'usable',
    ageMs,
    qualityFactor: QUALITY_FACTORS[observation.quality] ?? 0,
    freshnessFactor: 1,
    confidenceFactor: observation.confidence == null
      ? UNKNOWN_SOURCE_CONFIDENCE_FACTOR
      : Math.min(1, Math.max(0, observation.confidence)),
  };
  if (observation.quality === 'invalid') return { ...base, status: 'untrusted' };
  if (policy.dimensions.length > 0 && !policy.dimensions.includes(observation.dimension)) {
    return { ...base, status: 'dimension_mismatch' };
  }
  if (!Number.isFinite(observedMs)) return { ...base, status: 'stale' };
  if (ageMs > policy.ttlMs) return { ...base, status: 'stale' };
  // 新鲜度：越接近 TTL 末段惩罚越大（最多砍一半），口径可解释。
  const freshnessFactor = policy.ttlMs > 0 ? 1 - (ageMs / policy.ttlMs) * 0.5 : 1;
  return { ...base, freshnessFactor: Math.max(0.5, Math.min(1, freshnessFactor)), status: 'usable' };
}

function stationSignals(evaluated: EvaluatedObservation[]): Array<{ source: string; sourceId: string; stationId: string }> {
  const out: Array<{ source: string; sourceId: string; stationId: string }> = [];
  for (const item of evaluated) {
    if (item.status !== 'usable') continue;
    const stationId = String(item.observation.value.stationId ?? '').trim();
    if (stationId !== '') out.push({ source: item.observation.source, sourceId: item.observation.sourceId, stationId });
  }
  return out;
}

function actionSignals(evaluated: EvaluatedObservation[]): Array<{ source: string; sourceId: string; action: string }> {
  const out: Array<{ source: string; sourceId: string; action: string }> = [];
  for (const item of evaluated) {
    if (item.status !== 'usable') continue;
    const action = String(item.observation.value.action ?? '').trim();
    if (action !== '') out.push({ source: item.observation.source, sourceId: item.observation.sourceId, action });
  }
  return out;
}

/**
 * 多源融合（纯函数；同输入必得同输出）。
 *
 * 输出**永远不为 null**（规则 4：任一源缺失也要输出，只是降级），
 * 但"没有可用源"时 `confidence.level='unknown'`、`score=null`、`agreement='insufficient'`
 * 且 `strongAdviceAllowed=false`——这比给一个看起来很确定的空结论诚实。
 */
/**
 * 环境通道聚合：同一通道的多台传感器做**同类多源交叉验证**。
 *
 * 一台传感器 → `single_source`（明确"没有第二个独立源确认"，不写成 consistent）；
 * 多台一致（极差 ≤ 容差×均值）→ `consistent` 并给出代表值（均值）；
 * 多台不一致 → `conflict`，代表值置 null（**不取平均掩盖分歧**），保留全部读数。
 */
export function summarizeAmbientChannels(
  observations: ReadonlyArray<{ sourceId: string; channel: string; value: number; quality: string }>,
): NonNullable<FusedPerception['ambient']> {
  const byChannel = new Map<string, Array<{ sourceId: string; value: number; quality: string }>>();
  for (const item of observations) {
    const list = byChannel.get(item.channel) ?? [];
    list.push({ sourceId: item.sourceId, value: item.value, quality: item.quality });
    byChannel.set(item.channel, list);
  }
  const out: NonNullable<FusedPerception['ambient']> = [];
  for (const [channel, sensors] of [...byChannel.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const values = sensors.map((sensor) => sensor.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const spread = Math.round((max - min) * 1000) / 1000;
    const consistent = sensors.length > 1
      && spread <= Math.abs(mean) * AMBIENT_AGREEMENT_TOLERANCE + 1e-9;
    const threshold = AMBIENT_WATCH_THRESHOLDS[channel];
    out.push({
      channel,
      agreement: sensors.length === 1 ? 'single_source' : consistent ? 'consistent' : 'conflict',
      sensors,
      value: sensors.length === 1 || consistent ? Math.round(mean * 1000) / 1000 : null,
      spread: sensors.length > 1 ? spread : null,
      unit: AMBIENT_UNITS[channel] ?? null,
      exceedsWatchThreshold: threshold !== undefined && max >= threshold,
    });
  }
  return out;
}

/* ── 视觉骨架 → 躯干俯仰（NO-58c：多模态源策略扩展）───────────────────────
 *
 * 为什么需要：视觉此前只贡献"有人/工位/动作字符串"，姿态维度只有外骨骼 IMU 一个源 →
 * 规则 2 的"姿态冲突"只能拿**角度 vs 动作词**比（`pitch>=45° 且 action 含 stand`），
 * 既依赖模型的英文动作词表，也没有第二个独立角度源可交叉验证。
 * 这里把摄像头骨架（`detections[].skeleton`，`observe.pose` 能力的载荷）确定性地
 * 换算成**躯干相对竖直方向的夹角**，使姿态维度具备"两个独立角度源"。
 *
 * 诚实边界（原则 7）：
 *   · 只做几何换算，不做姿态分类、不推断动作、不猜缺失关键点；
 *   · 四要点（双肩 + 双髋）缺任一个、或置信度低于门槛 → `pitchDeg=null` + 明确 `reason`；
 *   · 关键点来源不同（COCO 序号 / 命名）都支持，但**认不出就如实说认不出**。
 */

/** 关键点最低置信度：低于该值视为"没看到这个关节"（不参与几何换算）。 */
export const VISION_KEYPOINT_MIN_SCORE = 0.3;

/** 姿态交叉验证容差（度）：两个独立角度源差值 ≥ 该值即冲突（不静默取一个）。 */
export const POSTURE_PITCH_DISAGREEMENT_DEG = 30;

/** 关键点名别名（COCO-17 序号 + 常见命名；只登记能确定含义的写法）。 */
export const VISION_TRUNK_KEYPOINTS: Readonly<Record<'left_shoulder' | 'right_shoulder' | 'left_hip' | 'right_hip', readonly string[]>> = {
  left_shoulder: ['left_shoulder', 'shoulder_left', 'l_shoulder', 'leftshoulder', '5'],
  right_shoulder: ['right_shoulder', 'shoulder_right', 'r_shoulder', 'rightshoulder', '6'],
  left_hip: ['left_hip', 'hip_left', 'l_hip', 'lefthip', '11'],
  right_hip: ['right_hip', 'hip_right', 'r_hip', 'righthip', '12'],
};

export interface VisionTrunkPitch {
  /** 躯干相对竖直方向的夹角（度；0=直立，90=水平）；null = 算不出来（见 reason）。 */
  pitchDeg: number | null;
  /** 可解释依据（用了哪些关键点、各自坐标与置信度）。 */
  basis: string;
  /** 算不出来时的原因（算不出来必须给原因，不许静默 null）。 */
  reason: string | null;
}

type SkeletonInput = Record<string, unknown> | null | undefined;

function keypointAt(skeleton: SkeletonInput, names: readonly string[]):
  { name: string; x: number; y: number; score: number } | null {
  if (!skeleton || typeof skeleton !== 'object') return null;
  const entries = Object.entries(skeleton as Record<string, unknown>);
  for (const name of names) {
    const hit = entries.find(([key]) => key.trim().toLowerCase() === name);
    if (!hit) continue;
    const raw = hit[1];
    if (!Array.isArray(raw) || raw.length < 2) return null;
    const x = Number(raw[0]);
    const y = Number(raw[1]);
    // score 缺省：坐标可信度未知 → 按最低门槛处理（不当作 1）。
    const score = raw.length >= 3 ? Number(raw[2]) : VISION_KEYPOINT_MIN_SCORE;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(score)) return null;
    return { name: hit[0], x, y, score };
  }
  return null;
}

/**
 * 视觉骨架 → 躯干俯仰角（纯几何；确定性）。
 *
 * 取双肩中点与双髋中点连成的躯干向量，计算它与竖直方向的夹角：
 * `pitch = atan2(|dx|, |dy|)`（图像坐标 y 向下，直立时肩在髋上方 → |dy| 主导）。
 */
export function deriveVisionTrunkPitch(skeleton: SkeletonInput): VisionTrunkPitch {
  const parts = {
    left_shoulder: keypointAt(skeleton, VISION_TRUNK_KEYPOINTS.left_shoulder),
    right_shoulder: keypointAt(skeleton, VISION_TRUNK_KEYPOINTS.right_shoulder),
    left_hip: keypointAt(skeleton, VISION_TRUNK_KEYPOINTS.left_hip),
    right_hip: keypointAt(skeleton, VISION_TRUNK_KEYPOINTS.right_hip),
  };
  const missing: string[] = [];
  const lowScore: string[] = [];
  for (const [role, point] of Object.entries(parts)) {
    if (!point) {
      missing.push(role);
      continue;
    }
    if (point.score < VISION_KEYPOINT_MIN_SCORE) lowScore.push(`${role}(${point.score})`);
  }
  if (missing.length > 0 || lowScore.length > 0) {
    return {
      pitchDeg: null,
      basis: '骨架缺要点：不换算角度（不猜）',
      reason:
        (missing.length > 0 ? `缺少关键点 ${missing.join('、')}` : '')
        + (missing.length > 0 && lowScore.length > 0 ? '；' : '')
        + (lowScore.length > 0 ? `关键点置信度低于 ${VISION_KEYPOINT_MIN_SCORE}：${lowScore.join('、')}` : ''),
    };
  }
  const shoulderMid = {
    x: (parts.left_shoulder!.x + parts.right_shoulder!.x) / 2,
    y: (parts.left_shoulder!.y + parts.right_shoulder!.y) / 2,
  };
  const hipMid = {
    x: (parts.left_hip!.x + parts.right_hip!.x) / 2,
    y: (parts.left_hip!.y + parts.right_hip!.y) / 2,
  };
  const dx = shoulderMid.x - hipMid.x;
  const dy = shoulderMid.y - hipMid.y;
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) {
    return {
      pitchDeg: null,
      basis: `肩中点 (${shoulderMid.x},${shoulderMid.y}) 与髋中点 (${hipMid.x},${hipMid.y}) 重合`,
      reason: '肩髋中点重合：躯干向量退化，角度无定义（不猜）',
    };
  }
  const pitchDeg = Math.round((Math.atan2(Math.abs(dx), Math.abs(dy)) * 180) / Math.PI * 10) / 10;
  return {
    pitchDeg,
    basis:
      `肩中点 (${shoulderMid.x},${shoulderMid.y}) → 髋中点 (${hipMid.x},${hipMid.y})；`
      + `要点 ${Object.values(parts).map((p) => `${p!.name}=${p!.score}`).join(' / ')}`,
    reason: null,
  };
}

export function fusePerception(input: FusePerceptionInput): FusedPerception {
  const policies = input.policies && input.policies.length > 0 ? input.policies : DEFAULT_SOURCE_POLICIES;
  const nowMs = Date.parse(input.now);
  const tolerance = num(input.positionToleranceM) ?? POSITION_TOLERANCE_M;
  const evaluated = (input.observations ?? []).map((observation) => evaluate(observation, policies, nowMs));
  const usable = evaluated.filter((item) => item.status === 'usable');
  const excluded: ExcludedObservation[] = evaluated
    .filter((item) => item.status !== 'usable')
    .map((item) => ({
      source: item.observation.source,
      sourceId: item.observation.sourceId,
      dimension: item.observation.dimension,
      status: item.status as ExcludedObservation['status'],
      reason:
        item.status === 'stale'
          ? `证据过期：${Math.round(item.ageMs / 1000)}s > TTL ${Math.round(item.policy.ttlMs / 1000)}s（不参与融合）`
          : item.status === 'untrusted'
            ? `数据质量 invalid：摄入侧已判定不可信（不参与融合）`
            : `维度不属于该源：${item.observation.dimension} 不在 ${item.policy.source} 支持的 [${item.policy.dimensions.join(',')}]`,
    }));

  /**
   * 上下文事实（工位映射 / 任务上下文）以入参形式给出而不是观测帧：
   * 它们是"当前状态的派生"，只要其所依赖的定位观测可用，就计入**已提供源**并参与加权。
   * 不这样做的话，每个主体都会被永久标记为"缺失 station_semantics/task_context"，
   * 置信度被虚假地压到 medium 以下（2026-09-12 实测：规则 1 的"高置信"永远达不到）。
   */
  const locationUsable = usable.some((item) => item.observation.dimension === 'position');
  const contextSources = {
    station_semantics: Boolean(input.stationFromLocation) && locationUsable,
    task_context: Boolean(input.taskContext),
  } as const;
  const usableSources = [
    ...new Set(usable.map((item) => item.observation.source)),
    ...Object.entries(contextSources).filter(([, ok]) => ok).map(([source]) => source),
  ];
  const observedSources = new Set([
    ...evaluated.map((item) => item.observation.source),
    ...Object.entries(contextSources).filter(([, ok]) => ok).map(([source]) => source),
  ]);
  const subjectKind = input.subjectKind ?? inferSubjectKind(input.subjectId);
  const expectedSources = (subjectKind === 'person'
    ? PERSON_EXPECTED_SOURCES
    : subjectKind === 'area'
      ? AREA_EXPECTED_SOURCES
      : policies.filter((p) => p.baseWeight > 0).map((p) => p.source)
  ).filter((source) => policies.some((p) => p.source === source && p.baseWeight > 0));
  const missingSources = expectedSources.filter((source) => !observedSources.has(source));

  // ── 位置/工位 ───────────────────────────────────────────────────────
  const positionObs = usable.filter((item) => item.observation.dimension === 'position');
  const uwbPosition = positionObs.find((item) => item.observation.source === 'uwb') ?? positionObs[0];
  const position = uwbPosition
    ? {
        x: num(uwbPosition.observation.value.x),
        y: num(uwbPosition.observation.value.y),
        z: num(uwbPosition.observation.value.z),
        stationId: input.stationFromLocation?.stationId ?? null,
        basis: [
          `${uwbPosition.observation.source}:${uwbPosition.observation.sourceId}@${uwbPosition.observation.observedAt}`,
          ...(input.stationFromLocation
            ? [`station:${input.stationFromLocation.basis}（距离 ${input.stationFromLocation.distanceM}m / 半径 ${input.stationFromLocation.radiusM}m）`]
            : ['station:未解析（不猜）']),
        ],
      }
    : null;

  // ── 任务上下文/工位语义 作为额外的工位信号 ─────────────────────────
  const signals = stationSignals(usable);
  if (input.taskContext?.stationId) {
    signals.push({ source: 'task_context', sourceId: input.taskContext.basis, stationId: input.taskContext.stationId });
  }
  if (input.stationFromLocation?.stationId) {
    signals.push({ source: 'station_semantics', sourceId: input.stationFromLocation.basis, stationId: input.stationFromLocation.stationId });
  }
  const distinctStations = [...new Set(signals.map((s) => s.stationId))];
  const station = signals.length === 0
    ? null
    : {
        stationId: distinctStations.length === 1 ? distinctStations[0] : null,
        basis: signals.map((s) => `${s.source}:${s.stationId}`).join(' · '),
        sources: [...new Set(signals.map((s) => s.source))],
      };

  // ── 姿态/动作 ──────────────────────────────────────────────────────
  const postureObs = usable.filter((item) => item.observation.dimension === 'posture');
  const primaryPosture = postureObs.find((item) => item.observation.source === 'exo_imu') ?? postureObs[0];
  const actions = actionSignals(usable);
  const posture = primaryPosture
    ? {
        pitchDeg: num(primaryPosture.observation.value.pitchDeg),
        action: primaryPosture.observation.value.action
          ?? actions.find((a) => a.source === primaryPosture.observation.source)?.action
          ?? null,
        basis: [
          `${primaryPosture.observation.source}:${primaryPosture.observation.sourceId}@${primaryPosture.observation.observedAt}`,
        ],
      }
    : null;

  // ── 环境通道（区域级同类多源交叉验证）──────────────────────────────
  const ambientObservations = usable
    .filter((item) => item.observation.dimension === 'ambient')
    .map((item) => ({
      source: item.observation.source,
      sourceId: item.observation.sourceId,
      channel: String(item.observation.value.channel ?? ''),
      value: num(item.observation.value.ambient),
      quality: item.observation.quality,
    }))
    .flatMap((item) => (
      item.channel !== '' && item.value !== null
        ? [{ sourceId: item.sourceId, channel: item.channel, value: item.value, quality: item.quality }]
        : []
    ));
  const ambient = ambientObservations.length > 0 ? summarizeAmbientChannels(ambientObservations) : null;

  // ── 冲突（规则 2：不静默丢弃）───────────────────────────────────────
  const conflicts: PerceptionConflict[] = [];
  for (const channel of ambient ?? []) {
    if (channel.agreement !== 'conflict') continue;
    conflicts.push({
      dimension: `ambient:${channel.channel}`,
      severity: 'medium',
      participants: channel.sensors.map((sensor) => ({
        source: 'env_sensor',
        sourceId: sensor.sourceId,
        value: String(sensor.value),
      })),
      detail: `环境通道 ${channel.channel} 多源不一致（极差 ${channel.spread}${channel.unit ?? ''}）：各传感器读数都保留，代表值置空`,
    });
  }
  if (distinctStations.length > 1) {
    const severity: PerceptionConflict['severity'] =
      signals.some((s) => s.source === 'uwb') && signals.some((s) => s.source === 'vision')
        ? 'high'
        : signals.some((s) => s.source === 'task_context')
          ? 'medium'
          : 'medium';
    conflicts.push({
      dimension: 'station_presence',
      severity,
      participants: signals.map((s) => ({ source: s.source, sourceId: s.sourceId, value: s.stationId })),
      detail: `工位结论不一致（${distinctStations.join(' vs ')}）：各源都保留，不静默丢弃；请现场核实`,
    });
  }
  const exoPitch = num(primaryPosture?.observation.value.pitchDeg);
  const visionAction = actions.find((a) => a.source === 'vision');
  // NO-58c：视觉骨架换算出的躯干角（第二个**独立角度源**）——两个角度源差值超容差即冲突。
  const visionPitchObs = postureObs.find(
    (item) => item.observation.source === 'vision' && num(item.observation.value.pitchDeg) !== null,
  );
  const visionPitch = num(visionPitchObs?.observation.value.pitchDeg);
  if (
    exoPitch !== null
    && primaryPosture?.observation.source === 'exo_imu'
    && visionPitch !== null
    && Math.abs(exoPitch - visionPitch) >= POSTURE_PITCH_DISAGREEMENT_DEG
  ) {
    conflicts.push({
      dimension: 'posture',
      severity: 'medium',
      participants: [
        { source: 'exo_imu', sourceId: primaryPosture.observation.sourceId, value: `pitch=${exoPitch}` },
        { source: 'vision', sourceId: visionPitchObs!.observation.sourceId, value: `pitch=${visionPitch}` },
      ],
      detail:
        `姿态角度冲突：外骨骼俯仰 ${exoPitch}° vs 视觉骨架 ${visionPitch}°`
        + `（差值 ≥ ${POSTURE_PITCH_DISAGREEMENT_DEG}°）：两个独立角度源不一致，都保留、请现场核实`,
    });
  }
  // NO-59a：动作维度交叉验证（外骨骼关节角派生 vs 视觉模型动作词）——两个独立源。
  // 只在两边都能判"直立/非直立"且结论相反时记冲突；未知动作词不参与（不猜）。
  const exoAction = actions.find((a) => a.source === 'exo_imu');
  if (exoAction && visionAction) {
    const exoUpright = uprightnessOf(exoAction.action);
    const visionUpright = uprightnessOf(visionAction.action);
    if (exoUpright !== null && visionUpright !== null && exoUpright !== visionUpright) {
      conflicts.push({
        dimension: 'action',
        severity: 'medium',
        participants: [
          { source: 'exo_imu', sourceId: exoAction.sourceId, value: exoAction.action },
          { source: 'vision', sourceId: visionAction.sourceId, value: visionAction.action },
        ],
        detail:
          `动作冲突：外骨骼（关节角）判定 ${exoAction.action}，视觉判定 ${visionAction.action}`
          + '：两个独立动作源结论相反，都保留、请现场核实',
      });
    }
  }
  if (
    exoPitch !== null
    && visionAction
    && exoPitch >= POSTURE_BEND_DEG
    && visionAction.action.toLowerCase().includes('stand')
  ) {
    conflicts.push({
      dimension: 'posture',
      severity: 'medium',
      participants: [
        { source: 'exo_imu', sourceId: primaryPosture!.observation.sourceId, value: `pitch=${exoPitch}` },
        { source: 'vision', sourceId: visionAction.sourceId, value: visionAction.action },
      ],
      detail: `姿态冲突：外骨骼俯仰 ${exoPitch}°（≥${POSTURE_BEND_DEG}° 视为弯腰/前倾），视觉判定为 ${visionAction.action}`,
    });
  }

  // ── 置信度（可解释加权；不是概率）───────────────────────────────────
  const expectedWeight = expectedSources.reduce(
    (sum, source) => sum + (policies.find((p) => p.source === source)?.baseWeight ?? 0),
    0,
  );
  // 置信度 = **可用源**权重和 / 应有源权重和（契约口径是"源"，不是"观测"）。
  // 2026-09-12（NO-59a）修正：此前按观测累加 → 同一源报 3 个维度就拿 3 倍权重
  // （视觉报 station/action/posture 时权重被算 3 次），置信度被结构性抬高、且
  // `Math.min(1, …)` 会把这种膨胀掩盖成"高置信"。现在每个源只计一次，
  // 源内多维度取**该源最好的那份证据**的因子（并如实写进 basis）。
  const weightBySource = new Map<string, { factor: number; dimensions: Set<string> }>();
  for (const item of usable) {
    const source = item.observation.source;
    const factor = item.qualityFactor * item.freshnessFactor * item.confidenceFactor;
    const entry = weightBySource.get(source) ?? { factor: 0, dimensions: new Set<string>() };
    entry.factor = Math.max(entry.factor, factor);
    entry.dimensions.add(item.observation.dimension);
    weightBySource.set(source, entry);
  }
  const usableWeight = [...weightBySource.entries()].reduce((sum, [source, entry]) => {
    const weight = policies.find((p) => p.source === source)?.baseWeight ?? 0;
    return sum + weight * entry.factor;
  }, 0) + Object.entries(contextSources).reduce((sum, [source, ok]) => {
    if (!ok) return sum;
    const weight = policies.find((p) => p.source === source)?.baseWeight ?? 0;
    // 上下文事实：质量 good、新鲜度 1（它是"当前状态"，不是历史帧）、源置信度按 1 计
    // ——但它的**推导依据**（定位/任务号）已写进 confidence.basis 与 station.basis。
    return sum + weight;
  }, 0);
  const score = usable.length === 0 || expectedWeight <= 0
    ? null
    : Math.round(Math.min(1, usableWeight / expectedWeight) * 1000) / 1000;
  const level: PerceptionConfidenceLevel =
    score === null
      ? 'unknown'
      : score >= CONFIDENCE_LEVEL_THRESHOLDS.high
        ? 'high'
        : score >= CONFIDENCE_LEVEL_THRESHOLDS.medium
          ? 'medium'
          : 'low';
  const degraded = missingSources.length > 0 || excluded.length > 0;
  const unknownConfidenceSources = [...new Set(
    usable.filter((item) => item.observation.confidence == null).map((item) => item.observation.source),
  )];

  // ── 一致性结论 ─────────────────────────────────────────────────────
  // `consistent` 要求**交叉验证成立**（§5 规则 1：UWB 与视觉同工位）；
  // 视觉缺失时即使 UWB 与工位语义一致，也只能算 `partial`——没有第二个独立源确认，
  // 说"一致"就过头了（规则 3 的"继续推断但降低置信度"正是这个语义）。
  const crossValidated =
    distinctStations.length === 1
    && signals.some((s) => s.source === 'vision')
    && signals.some((s) => s.source === 'uwb');
  const ambientCrossValidated = (ambient ?? []).some((channel) => channel.agreement === 'consistent');
  const agreement: PerceptionAgreement =
    usable.length === 0
      ? 'insufficient'
      : conflicts.length > 0
        ? 'conflict'
        : crossValidated || ambientCrossValidated
          ? 'consistent'
          : signals.length === 0 && posture === null && (ambient ?? []).length === 0
            ? 'insufficient'
            : 'partial';

  // ── 规则留痕（§5 五条）────────────────────────────────────────────
  const cameraMissing = missingSources.includes('vision');
  const exoUsable = usableSources.includes('exo_imu');
  const stationSignalUsable = signals.length > 0;
  const ruleTrace = [
    {
      rule: 'rule1_uwb_vision_same_station',
      fired: crossValidated,
      detail: (distinctStations.length === 1
        ? `工位一致：${distinctStations[0]}（${signals.map((s) => s.source).join('+')}）`
          + (crossValidated ? '' : '——但缺 UWB/视觉交叉验证，只算部分一致')
        : `工位信号 ${signals.length} 个 / 不同工位 ${distinctStations.length} 个`)
        + (ambientCrossValidated
          ? `；环境通道交叉验证通过（${(ambient ?? []).filter((c) => c.agreement === 'consistent').map((c) => c.channel).join('、')}）`
          : ''),
    },
    {
      rule: 'rule2_conflict_recorded',
      fired: conflicts.length > 0,
      detail: conflicts.length > 0 ? `冲突 ${conflicts.length} 条（已记录详情，未丢弃任何源）` : '无冲突',
    },
    {
      rule: 'rule3_camera_down_degrade',
      fired: cameraMissing && exoUsable && stationSignalUsable,
      detail: cameraMissing
        ? `视觉缺失：外骨骼${exoUsable ? '可用' : '不可用'} / 工位信号${stationSignalUsable ? '可用' : '不可用'} → 继续推断并降级`
        : '视觉可用（未触发降级规则）',
    },
    {
      rule: 'rule4_missing_source_degrade',
      fired: missingSources.length > 0 || excluded.length > 0,
      detail: `缺失源 [${missingSources.join(',') || '无'}] / 排除证据 ${excluded.length} 条 → 置信度按缺失权重下降`,
    },
    {
      rule: 'rule5_no_strong_advice_at_low_confidence',
      fired: !(level === 'high' || level === 'medium') || conflicts.length > 0,
      detail: `置信度 ${level}${conflicts.length > 0 ? ' + 存在冲突' : ''} → 上游不得据此生成强建议`,
    },
  ];
  const strongAdviceAllowed =
    (level === 'high' || level === 'medium') && conflicts.length === 0 && agreement !== 'insufficient';

  const notes: string[] = [];
  if (missingSources.length > 0) notes.push(`缺失源：${missingSources.join('、')}（本窗口没有任何观测）`);
  if (excluded.length > 0) notes.push(`被排除证据 ${excluded.length} 条（过期/不可信/维度不符，逐条见 excludedSources）`);
  if (cameraMissing) notes.push('摄像头不可用：已按规则 3 降级继续推断，置信度相应下降');
  if (unknownConfidenceSources.length > 0) {
    notes.push(`以下源未上报置信度，已按 ${UNKNOWN_SOURCE_CONFIDENCE_FACTOR} 惩罚：${unknownConfidenceSources.join('、')}`);
  }
  if (station === null && signals.length > 0) notes.push('工位信号互相矛盾 → 工位结论置空（不取第一个，也不投票）');
  if (station === null && signals.length === 0) notes.push('没有任何工位信号 → 工位未知（不猜）');
  if (input.taskContext === null || input.taskContext === undefined) notes.push('无在飞任务上下文：先验缺失');
  for (const channel of ambient ?? []) {
    if (channel.exceedsWatchThreshold) {
      notes.push(
        `环境 ${channel.channel} 达到/超过关注阈值 ${AMBIENT_WATCH_THRESHOLDS[channel.channel]}${channel.unit ?? ''}`
        + `（当前 ${channel.value ?? '多源不一致，见冲突明细'}）：这是事实提示，是否停工由现场按规程决定`,
      );
    }
    if (channel.agreement === 'single_source') {
      notes.push(`环境 ${channel.channel} 只有一台传感器（无第二个独立源确认，只算部分一致）`);
    }
  }

  return {
    subjectId: input.subjectId,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    fusedAt: input.now,
    agreement,
    position,
    posture,
    station,
    ambient,
    confidence: {
      level,
      score,
      basis:
        `可用源 [${usableSources.join(',') || '无'}] 权重和 ${Math.round(usableWeight * 1000) / 1000}`
        + ` / 应有 ${Math.round(expectedWeight * 1000) / 1000}`
        + '（**每源只计一次**：源内多维度取最好证据的 质量×新鲜度×源置信度 系数'
        + `；维度数 ${[...weightBySource.values()].reduce((n, e) => n + e.dimensions.size, 0)}；`
        + '工位/任务上下文按当前状态计入；这是可解释加权，不是概率）',
      usableSources,
      degraded,
      missingSources,
      excludedSources: excluded,
      unknownConfidenceSources,
    },
    conflicts,
    ruleTrace,
    strongAdviceAllowed,
    notes,
  };
}
