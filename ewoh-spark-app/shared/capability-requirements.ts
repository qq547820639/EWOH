/**
 * 任务能力要求的规范化与可匹配性提示（纯函数，API 与前端共用）。
 *
 * 为什么需要（2026-09-11 审计）：`ewoh_production_task.required_device_capabilities` /
 * `required_station_capabilities` 两列**没有任何 API 写入口**——只有种子与直连库能写。
 * 于是"能力模型"在真实作业里用不起来：调度按 `requiredDeviceCapabilities ⊆
 * device.capabilities` 匹配，但没人能把要求写进任务（本轮 e2e 只能直连数据库构造）。
 *
 * 口径（与契约一致）：
 * - 能力名是**开放词表**（`contracts/capability` knownValues 只登记"平台已知值"）：
 *   未登记名**不阻断**写入（工厂自定义能力天然存在），但必须显式提示——
 *   否则会得到"永远匹配不到任何设备"的任务，而现场不知道原因（原则 7）。
 * - 形状/长度/数量非法一律拒绝（不猜、不截断）：调度匹配语义依赖精确字符串。
 */

/** 单任务能力要求条数上限（防滥用；正常任务远小于此）。 */
export const MAX_TASK_CAPABILITY_REQUIREMENTS = 32;

/** 单个能力名长度上限（与台账 capability_key 列宽一致）。 */
export const MAX_CAPABILITY_NAME_LENGTH = 64;

export interface NormalizedCapabilityList {
  /** 规范化后的能力名（去空白、去空项、按首次出现顺序去重）。 */
  names: string[];
  /** 非法输入的可读原因（非空即应拒绝写入，fail-closed）。 */
  errors: string[];
}

/**
 * 规范化能力名列表（不猜、不截断、不静默丢项）。
 *
 * 接受 `undefined`/`null`（表示"不改动/无要求" → 空列表）；其它非数组一律报错。
 */
export function normalizeCapabilityList(
  input: unknown,
  label: string,
  max = MAX_TASK_CAPABILITY_REQUIREMENTS,
): NormalizedCapabilityList {
  if (input === undefined || input === null) return { names: [], errors: [] };
  if (!Array.isArray(input)) {
    return { names: [], errors: [`${label} 必须是字符串数组`] };
  }
  const errors: string[] = [];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of input.entries()) {
    if (typeof raw !== 'string') {
      errors.push(`${label}[${index}] 不是字符串（能力名必须精确，拒绝隐式转换）`);
      continue;
    }
    const name = raw.trim();
    if (name.length === 0) continue;
    if (name.length > MAX_CAPABILITY_NAME_LENGTH) {
      errors.push(`${label}[${index}] 超过 ${MAX_CAPABILITY_NAME_LENGTH} 字符（列宽上限）`);
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  if (names.length > max) {
    errors.push(`${label} 最多 ${max} 项（当前 ${names.length} 项）`);
  }
  return { names, errors };
}

export interface CapabilityRequirementWarning {
  /** 触发的检查项（便于测试与前端分类展示）。 */
  code: 'unregistered_capability' | 'unmatchable_capability';
  name: string;
  message: string;
}

/**
 * 生成"当前无法匹配"的显式提示（不阻断写入）。
 *
 * @param names 规范化后的能力名
 * @param isMatchable 该名称当前是否可能被匹配到（设备能力：是否在能力词表内；
 *                    工位能力：本租户工位是否声明过该能力）
 * @param label 面向现场的字段名（如"设备能力要求"）
 */
export function describeCapabilityWarnings(
  names: readonly string[],
  isMatchable: (name: string) => boolean,
  label: string,
): CapabilityRequirementWarning[] {
  const warnings: CapabilityRequirementWarning[] = [];
  for (const name of names) {
    if (isMatchable(name)) continue;
    warnings.push({
      code: 'unmatchable_capability',
      name,
      message: `${label}「${name}」当前没有任何资源声明该能力：除非后续有设备/工位登记它，否则该任务不会匹配到资源`,
    });
  }
  return warnings;
}

/**
 * 设备能力要求的提示口径：词表外名称额外标注"未登记"（与台账/契约同一口径）。
 * 词表内名称不提示（它是平台已知能力，匹配与否取决于设备是否声明）。
 */
export function describeDeviceCapabilityWarnings(
  names: readonly string[],
  isRegistered: (name: string) => boolean,
  /** 词表内的已知名称（用于笔误提示；缺省则不给笔误提示）。 */
  knownNames: readonly string[] = [],
): CapabilityRequirementWarning[] {
  const warnings: CapabilityRequirementWarning[] = [];
  for (const name of names) {
    if (isRegistered(name)) continue;
    const similar = knownNames.length > 0 ? suggestSimilarCapabilityNames(name, knownNames) : [];
    warnings.push({
      code: 'unregistered_capability',
      name,
      message:
        `设备能力「${name}」不在能力词表内（开放词表允许自定义，但需由设备显式声明才能匹配）` +
        (similar.length > 0 ? `；疑似笔误：是否指 ${similar.join(' / ')}？` : ''),
    });
  }
  return warnings;
}

// ── NO-18a：能力名笔误检测 ──────────────────────────────────────────────────

/** 名称归一化（比较用）：小写、去掉分隔符差异（`exo_lift` ≡ `exo-lift` ≡ `exolift`）。 */
function normalizeForMatch(name: string): string {
  return name.trim().toLowerCase().replace(/[\s._-]+/g, '');
}

/** Levenshtein 距离（小字符串，直接 DP；不引依赖）。 */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const curr = [i, ...Array.from({ length: b.length }, () => 0)];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[b.length];
}

/**
 * 在已知名称里找"疑似笔误"的候选（按相似度升序）。
 *
 * 为什么需要：能力名是**精确字符串匹配**，`exo_lift` 与 `exo-lift` 在系统看来是两个
 * 完全不同的能力——任务会永远匹配不到资源，而现场很难意识到是拼写问题。
 * 这里只**提示**（不自动改写）：命名是现场语义，平台不替现场决定。
 */
export function suggestSimilarCapabilityNames(
  input: string,
  knownNames: readonly string[],
  maxDistance = 2,
  limit = 3,
): string[] {
  const target = normalizeForMatch(input);
  if (target.length === 0) return [];
  const raw = input.trim();
  // 精确命中的已知名称不是笔误（调用方只对"未登记/不匹配"的名称做提示；
  // 大小写不一致仍会提示——平台匹配是大小写敏感的，`Exo-Lift` 确实匹配不到）。
  if (knownNames.includes(raw)) return [];
  const scored = knownNames
    .map((name) => ({ name, distance: editDistance(target, normalizeForMatch(name)) }))
    // 只排除**完全相同**的名称；归一化后距离 0（`exo_lift` ≡ `exo-lift`）恰恰是最强的
    // 笔误信号，必须给出建议（早先按 distance>0 过滤把这类漏掉了）。
    .filter((entry) => entry.name !== raw && entry.distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name));
  return scored.slice(0, limit).map((entry) => entry.name);
}

/**
 * 把"未登记/无法匹配"的能力名补齐为带笔误提示的文案。
 * 有相近名称 → "是否指 X？"；没有 → 保持原提示（不编造猜测）。
 */
export function describeUnknownCapabilityName(
  name: string,
  knownNames: readonly string[],
  label: string,
): string {
  const similar = suggestSimilarCapabilityNames(name, knownNames);
  const base = `${label}「${name}」`;
  if (similar.length === 0) return base;
  return `${base}（疑似笔误：是否指 ${similar.join(' / ')}？）`;
}

// ── NO-20a：高风险能力"放宽"的审批闸门 ──────────────────────────────────────

/** 审批实体类型（与 `APPROVAL_ROLE_POLICY` 登记项一致，由安全管理员审批）。 */
export const CAPABILITY_RELAXATION_APPROVAL_ENTITY_TYPE = 'task_capability_change';

/**
 * 找出本次变更中"被放宽"的高风险能力（原本要求、变更后不再要求）。
 *
 * 语义：**增加**高风险要求是收紧（更安全），不需要审批；**去掉**高风险要求会放宽
 * 谁可以承接该任务——这正是原则 4/6 要求人工确认/审批的动作。
 * 只回答"哪些高风险能力被放宽"这一事实，不做任何自动补偿。
 */
export function highRiskCapabilitiesBeingRelaxed(
  previous: readonly string[],
  next: readonly string[],
  isHighRisk: (name: string) => boolean,
): string[] {
  const nextSet = new Set(next);
  return [...new Set(previous.filter((name) => !nextSet.has(name) && isHighRisk(name)))].sort();
}

/** 审批对象描述（复用既有 ObjectDescriptor 形状；metrics 值只支持字符串/数字）。 */
export interface CapabilityRelaxationApprovalSubject {
  objectType: string;
  objectId: string;
  title: string;
  summary: string;
  metrics: Record<string, string>;
}

/**
 * 构造审批对象描述（写入审批实例的 subject，供审批人判断 + 供落地时核对）。
 *
 * `metrics` 里必须留下**可逐字核对**的变更指纹（排序后拼接）：落地时用它确认
 * "被批准的就是要执行的那次变更"，避免拿一个无关/范围更大的审批去放宽别的要求。
 */
export function buildCapabilityRelaxationApprovalSubject(input: {
  taskId: string;
  taskTitle?: string | null;
  relaxedHighRisk: readonly string[];
  resultingDeviceCapabilities: readonly string[];
  resultingStationCapabilities?: readonly string[];
}): CapabilityRelaxationApprovalSubject {
  const relaxed = [...input.relaxedHighRisk].sort();
  const resultingDevice = [...input.resultingDeviceCapabilities].sort();
  const resultingStation = [...(input.resultingStationCapabilities ?? [])].sort();
  return {
    objectType: CAPABILITY_RELAXATION_APPROVAL_ENTITY_TYPE,
    objectId: input.taskId,
    title: `放宽高风险能力要求：${relaxed.join('、')}`,
    summary:
      `任务 ${input.taskTitle?.trim() || input.taskId} 申请放宽高风险能力 ${relaxed.join('、')}；` +
      `变更后设备能力要求 = ${resultingDevice.length > 0 ? resultingDevice.join('、') : '（无）'}`,
    metrics: {
      relaxedHighRiskCapabilities: relaxed.join(','),
      resultingDeviceCapabilities: resultingDevice.join(','),
      resultingStationCapabilities: resultingStation.join(','),
    },
  };
}

/** 审批记录中需要核对的字段（避免把审批服务整个依赖进来）。 */
export interface ApprovalRecordForRelaxation {
  status?: string | null;
  evidence?: unknown;
  steps?: Array<{ status?: string | null }> | null;
  /**
   * NO-22a：审批**通过**时间（ISO）。高风险执行边界授权必须有时效——
   * "上个月批的那次检修"不能成为今天的放行凭证。
   */
  approvedAt?: string | null;
}

/**
 * NO-22a：高风险执行边界审批的有效期。
 *
 * 为什么是 24 小时：这类审批描述的是**那一次**现场条件（"助力模块已检修完成"、
 * "吊具已探伤合格"）。跨班次之后设备状态、人员、作业面都可能已变，旧审批不再代表
 * 当前事实；24 小时足够覆盖一个完整的维护/检修窗口 + 交接班。
 * 不做成"永久有效"，是因为永久授权会在无人复核的情况下悄悄退化成默认放行。
 */
export const CAPABILITY_APPROVAL_VALIDITY_MS = 24 * 60 * 60 * 1000;

/**
 * 审批记录的通用核对（NO-21a 任务侧"放宽" 与 设备侧"恢复"共用；NO-22a 增加时效）。
 *
 * 逐条核对，任一条不满足都必须拒绝（绝不放行）：
 *   1. 审批状态 = approved（且没有仍处于 pending 的步骤）；
 *   2. **审批通过时间在有效期内**（缺失/不可解析 → 同样拒绝：无法判断时效的凭证
 *      不得被当成有效凭证，原则 7）；
 *   3. 审批类型与对象一致；
 *   4. 变更指纹 `metrics` 逐字一致（避免拿一个范围更大/无关的审批去落地别的变更）。
 */
export function verifyApprovalFingerprint(
  approval: ApprovalRecordForRelaxation | null,
  expected: {
    entityType: string;
    entityId: string;
    metrics: Record<string, string>;
    /** 面向现场的对象描述（错误信息里用，如"本任务"/"该设备能力"）。 */
    subjectLabel?: string;
    /** 当前时间（测试可注入；默认 Date.now()）。 */
    nowMs?: number;
    /** 有效期覆盖（默认 CAPABILITY_APPROVAL_VALIDITY_MS）。 */
    validityMs?: number;
  },
): { ok: boolean; reason?: string; approvedAt?: string; expiresAt?: string } {
  const label = expected.subjectLabel ?? '本对象';
  if (!approval) return { ok: false, reason: '审批实例不存在或不属于当前租户' };
  if (String(approval.status ?? '') !== 'approved') {
    return { ok: false, reason: `审批尚未通过（当前状态 ${String(approval.status ?? 'unknown')}）` };
  }
  const pendingSteps = (approval.steps ?? []).filter((s) => String(s?.status ?? '') === 'pending');
  if (pendingSteps.length > 0) {
    return { ok: false, reason: `审批仍有 ${pendingSteps.length} 个步骤未完成` };
  }
  const freshness = verifyApprovalFreshness(approval, {
    nowMs: expected.nowMs,
    validityMs: expected.validityMs,
  });
  if (!freshness.ok) return freshness;
  const approvedAtMs = Date.parse(String(freshness.approvedAt));
  const evidence = (approval.evidence ?? {}) as Record<string, unknown>;
  const entityType = String(evidence.entityType ?? '');
  const entityId = String(evidence.entityId ?? '');
  if (entityType !== expected.entityType) {
    return { ok: false, reason: `审批类型不符（${entityType || '未提供'}）` };
  }
  if (entityId !== expected.entityId) {
    return { ok: false, reason: `审批对象不是${label}（${entityId || '未提供'}）` };
  }
  const subject = (evidence.subject ?? {}) as Record<string, unknown>;
  const metrics = (subject.metrics ?? {}) as Record<string, unknown>;
  // 指纹键 → 现场可读名（错误信息要让现场知道"差在哪一条"）
  const metricLabels: Record<string, string> = {
    relaxedHighRiskCapabilities: '被放宽的高风险能力',
    resultingDeviceCapabilities: '目标设备能力要求',
    resultingStationCapabilities: '目标工位能力要求',
    capabilityKey: '能力名',
    deviceIds: '获批设备名单',
  };
  for (const [key, value] of Object.entries(expected.metrics)) {
    const actual = String(metrics[key] ?? '');
    if (actual !== value) {
      return {
        ok: false,
        reason:
          `审批记录与本次变更不一致：${metricLabels[key] ?? key}` +
          `（审批 ${actual || '未记录'}；本次 ${value || '空'}）`,
      };
    }
  }
  return { ok: true, approvedAt: freshness.approvedAt, expiresAt: freshness.expiresAt };
}

/**
 * NO-31a：**审批时效校验**（从 `verifyApprovalFingerprint` 抽出，供所有闸门复用）。
 *
 * 控制类审批（`control_request`）没有能力指纹，但同样必须有时效——一张半年前批的
 * "允许下发这条高危指令"不该在今天仍然有效。抽出来的意义是：任何新闸门都只需要
 * 调用它，而不是各自复制一段时间比较（复制就会出现口径漂移）。
 */
export function verifyApprovalFreshness(
  approval: ApprovalRecordForRelaxation | null,
  options: { nowMs?: number; validityMs?: number } = {},
): { ok: boolean; reason?: string; approvedAt?: string; expiresAt?: string } {
  if (!approval) return { ok: false, reason: '审批实例不存在或不属于当前租户' };
  const approvedAtRaw = String(approval.approvedAt ?? '').trim();
  const approvedAtMs = approvedAtRaw ? Date.parse(approvedAtRaw) : Number.NaN;
  if (!approvedAtRaw || !Number.isFinite(approvedAtMs)) {
    return { ok: false, reason: '审批缺少通过时间（无法判断时效），请重新审批后再操作' };
  }
  const validityMs = options.validityMs ?? CAPABILITY_APPROVAL_VALIDITY_MS;
  const nowMs = options.nowMs ?? Date.now();
  const expiresAtMs = approvedAtMs + validityMs;
  if (nowMs > expiresAtMs) {
    return {
      ok: false,
      reason:
        `审批已超出有效期（通过于 ${new Date(approvedAtMs).toISOString()}，` +
        `有效期 ${Math.round(validityMs / 3_600_000)} 小时）：现场条件可能已变化，请重新审批`,
    };
  }
  return {
    ok: true,
    approvedAt: new Date(approvedAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

/**
 * 校验"这个审批是否正好批准了本次放宽"。
 *
 * 逐条核对（任一条不满足都必须拒绝，绝不放行）：
 *   1. 审批状态 = approved（且没有仍处于 pending 的步骤）；
 *   2. 审批对象 = 本任务（entityType/entityId 一致）；
 *   3. 变更指纹逐字一致（被放宽的高风险能力集合 + 变更后的能力要求）。
 */
export function verifyCapabilityRelaxationApproval(
  approval: ApprovalRecordForRelaxation | null,
  expected: {
    taskId: string;
    relaxedHighRisk: readonly string[];
    resultingDeviceCapabilities: readonly string[];
    resultingStationCapabilities?: readonly string[];
    nowMs?: number;
    validityMs?: number;
  },
): { ok: boolean; reason?: string; approvedAt?: string; expiresAt?: string } {
  return verifyApprovalFingerprint(approval, {
    entityType: CAPABILITY_RELAXATION_APPROVAL_ENTITY_TYPE,
    entityId: expected.taskId,
    subjectLabel: '本任务',
    nowMs: expected.nowMs,
    validityMs: expected.validityMs,
    metrics: {
      relaxedHighRiskCapabilities: [...expected.relaxedHighRisk].sort().join(','),
      resultingDeviceCapabilities: [...expected.resultingDeviceCapabilities].sort().join(','),
      resultingStationCapabilities: [...(expected.resultingStationCapabilities ?? [])].sort().join(','),
    },
  });
}

// ── NO-21a：设备侧"高风险能力恢复"的审批闸门（与任务侧同一口径） ──────────────

/** 设备能力变更审批实体类型（与 `APPROVAL_ROLE_POLICY` 登记项一致）。 */
export const DEVICE_CAPABILITY_CHANGE_APPROVAL_ENTITY_TYPE = 'device_capability_change';

/**
 * 该动作是否需要审批（与服务端判定同一实现，前端用它提前提示）。
 *
 * 口径（与任务侧对称）：
 *   · **恢复**高风险能力（把 crane/exo-lift/interact.assist 放回可用集）= 让设备重新
 *     具备高风险作业资格 → **需要安全负责人审批**（设备重新投运是安全决定）；
 *   · 停用能力 = 收紧（设备更不可用）→ 不需要审批，避免给保守动作加流程；
 *   · 低/中风险能力或未登记等级 → 由人工理由留痕即可。
 */
export function deviceCapabilityChangeNeedsApproval(params: {
  targetStatus: 'active' | 'disabled';
  previousStatus: 'active' | 'disabled';
  risk: 'low' | 'medium' | 'high' | null;
}): boolean {
  return params.targetStatus === 'active' && params.previousStatus !== 'active' && params.risk === 'high';
}

/** 构建设备能力恢复审批的对象描述与指纹（entityId 用 `capability:<能力名>`）。 */
export function buildCapabilityRestoreApprovalSubject(input: {
  capabilityKey: string;
  deviceIds: readonly string[];
  reason?: string | null;
}): CapabilityRelaxationApprovalSubject & { objectType: string } {
  const deviceIds = [...new Set(input.deviceIds.map((d) => String(d).trim()).filter(Boolean))].sort();
  return {
    objectType: DEVICE_CAPABILITY_CHANGE_APPROVAL_ENTITY_TYPE,
    objectId: `capability:${input.capabilityKey}`,
    title: `恢复高风险能力：${input.capabilityKey}（${deviceIds.length} 台设备）`,
    summary:
      `申请恢复高风险能力 ${input.capabilityKey}（设备重新具备该作业资格）：` +
      `${deviceIds.join('、') || '（未指定设备）'}` +
      (input.reason ? `；理由：${input.reason}` : ''),
    metrics: {
      capabilityKey: input.capabilityKey,
      deviceIds: deviceIds.join(','),
    },
  };
}

/**
 * 校验"这个审批是否正好批准了本次设备能力恢复"。
 *
 * 审批可以覆盖**一批设备**（一次维护动作授权多台恢复），因此核对的是
 * "该设备在获批名单内 + 能力名一致"，而不是逐台审批——批量审批在语义上更贴近
 * 现场维护作业（"这批设备的 exo-lift 修好后放行"）。
 */
export function verifyCapabilityRestoreApproval(
  approval: ApprovalRecordForRelaxation | null,
  expected: { capabilityKey: string; deviceId: string; nowMs?: number; validityMs?: number },
): { ok: boolean; reason?: string; approvedAt?: string; expiresAt?: string } {
  const evidence = (approval?.evidence ?? {}) as Record<string, unknown>;
  const subject = (evidence.subject ?? {}) as Record<string, unknown>;
  const metrics = (subject.metrics ?? {}) as Record<string, unknown>;
  const approvedDeviceIds = String(metrics.deviceIds ?? '')
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean);
  const base = verifyApprovalFingerprint(approval, {
    entityType: DEVICE_CAPABILITY_CHANGE_APPROVAL_ENTITY_TYPE,
    entityId: `capability:${expected.capabilityKey}`,
    subjectLabel: '该设备能力',
    nowMs: expected.nowMs,
    validityMs: expected.validityMs,
    metrics: { capabilityKey: expected.capabilityKey },
  });
  if (!base.ok) return base;
  if (!approvedDeviceIds.includes(expected.deviceId)) {
    return {
      ok: false,
      reason: `该设备不在获批名单内（获批 ${approvedDeviceIds.join('、') || '（空）'}；本次 ${expected.deviceId}）`,
    };
  }
  return base;
}

/**
 * NO-22a：授权凭证的消耗键（一次授权对同一对象只能用一次）。
 *
 * 为什么需要它：`metrics.deviceIds` 描述的是"这批设备这次可以恢复"。如果审批号能被
 * 反复使用，等于把一次有时效的现场决定变成一张长期通行证——设备再次被停用（新的
 * 故障/新的理由）后，旧审批依然"有效"，而它描述的现场条件早已不同。
 * 语义：**每个 (审批, 对象) 组合消耗一次**；批量审批仍可逐台落地（每台各消耗一次）。
 */
export function buildApprovalUsageKey(input: { capabilityKey: string; deviceId: string }): string {
  return `capability:${input.capabilityKey}|device:${input.deviceId}`;
}

/** 任务侧放宽的消耗键（一个任务是同一个对象）。 */
export function buildTaskApprovalUsageKey(taskId: string): string {
  return `task:${taskId}`;
}

/**
 * NO-22a：审批时效文案（前端展示"还能不能用"）。
 *
 * 与后端同一常量（`CAPABILITY_APPROVAL_VALIDITY_MS`）；这里只做展示与提前提示，
 * **不代替后端判定**（放行始终以服务端校验为准）。
 */
export function describeCapabilityApprovalFreshness(
  approvedAt: string | null | undefined,
  nowMs: number = Date.now(),
): { valid: boolean; label: string } {
  const approvedMs = approvedAt ? Date.parse(approvedAt) : Number.NaN;
  if (!approvedAt || !Number.isFinite(approvedMs)) {
    return { valid: false, label: '缺少通过时间（无法判断时效）' };
  }
  const expiresMs = approvedMs + CAPABILITY_APPROVAL_VALIDITY_MS;
  if (nowMs > expiresMs) {
    return {
      valid: false,
      label: `审批已过期（通过于 ${formatApprovalTime(approvedMs)}，有效期 24 小时）`,
    };
  }
  const hoursLeft = Math.max(0, Math.round((expiresMs - nowMs) / 3_600_000));
  return {
    valid: true,
    label: `审批通过于 ${formatApprovalTime(approvedMs)}，剩余有效期约 ${hoursLeft} 小时`,
  };
}

/** 本地可读时间（yyyy/M/d HH:mm）；不引第三方日期库，避免又一处口径漂移。 */
function formatApprovalTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
