/* 设备能力：权威台账读取 + 型号白名单兜底（SSOT helper，Phase 1 / P1-T2；NO-14f）。
 *
 * 背景（docs/scheduler-commandmap-upgrade/01-current-state-review.md §4.1）：
 * world-state 与 resource-projection 两处此前各自按 deviceModel 白名单派生设备能力，
 * 语义不一致。本 helper 收敛唯一的派生兜底逻辑：
 *   - ewoh_device.capabilities 列有值时，两服务一律读列（真实能力）；
 *   - 列无值（旧行/未回填）时，才按型号白名单派生并带 derived 标记。
 */

import { and, eq, inArray } from 'drizzle-orm';
import type { PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { ewohDeviceCapability } from '@server/database/schema';
import { validateCapability, type CapabilityRecord } from '@shared/capability';
import { DEVICE_CAPABILITY_SPECS } from '@shared/device-capability';

/**
 * 设备能力台账（`ewoh_device_capability`）允许出现在设备能力集里的 kind。
 *
 * 权威契约（ADR-043）把外骨骼能力单列为 `exo_capability`，但对调度而言
 * "这台外骨骼能做什么"和"这台设备能做什么"是同一件事（同一 provider 的能力集），
 * 因此两者都收；其它 kind（skill/certification/station_capability）出现在设备
 * 主题下属数据异常，**显式记缺口**而不是静默忽略。
 */
export const DEVICE_CAPABILITY_LEDGER_KINDS: readonly string[] = [
  'device_capability',
  'exo_capability',
];

/** 单台设备的台账能力（名称集 + 契约记录 + 显式缺口 + 人工停用事实）。 */
export interface DeviceCapabilityLedger {
  /** 当前生效能力名（去重有序；供调度 `requiredDeviceCapabilities ⊆ names` 匹配）。 */
  names: string[];
  /** 契约合法记录（含 subject/evidence/providerType，供快照/审计透出）。 */
  records: CapabilityRecord[];
  /** 台账缺口（契约不合法 / kind 异常）：显式留痕，绝不静默丢弃。 */
  issues: string[];
  /**
   * **被人为停用**的能力名（`status='disabled'`）。
   *
   * 为什么要单独保留：调度侧"查不到这个能力"有两种完全不同的原因——
   * 设备本来就没有（缺能力，可能要换设备/加装），或**人把它停了**
   * （可能要复核停用理由/恢复）。缺失 ≠ 停用；只报"缺少设备能力"会让现场
   * 去查一个根本不存在的能力，或反过来把人工决定当成设备故障排查。
   */
  disabledNames: string[];
  /** 停用留痕（谁/何时/为什么），供解释与运维核对；形状不全则为 null（不半截渲染）。 */
  disabledLifecycle: Array<{
    name: string;
    operator: string | null;
    reason: string | null;
    at: string | null;
  }>;
}

/** 台账查询分批上限（避免超长 IN 列表；设备数远超批量时逐批读取）。 */
const LEDGER_DEVICE_BATCH = 200;

/**
 * 读取设备能力台账（租户作用域；**全部状态**都读，按 status 分流）。
 *
 * 注意：这里不再只取 `status='active'`——被人工停用的能力必须作为事实进入世界模型，
 * 否则"能力被停用"会被误报成"设备没有这个能力"（缺失 ≠ 停用，见 `disabledNames`）。
 *
 * 单一事实源：摄入路径写入的 Canonical CapabilityRecord 才是设备能力的权威来源；
 * `ewoh_device.capabilities` 列与型号白名单只是历史兜底（见调用方优先级）。
 * 缺 orgId → 显式缺口并返回空（**绝不跨租户读**）。
 */
export async function loadDeviceCapabilityLedger(
  db: PostgresJsDatabase,
  orgId: string | null | undefined,
  deviceIds: readonly string[],
): Promise<Map<string, DeviceCapabilityLedger>> {
  const result = new Map<string, DeviceCapabilityLedger>();
  const ids = [...new Set(deviceIds.filter((id) => typeof id === 'string' && id !== ''))];
  if (ids.length === 0) return result;
  if (!orgId || !orgId.trim()) {
    for (const id of ids) {
      result.set(id, {
        names: [],
        records: [],
        issues: ['capability_ledger_missing_org'],
        disabledNames: [],
        disabledLifecycle: [],
      });
    }
    return result;
  }
  for (let start = 0; start < ids.length; start += LEDGER_DEVICE_BATCH) {
    const batch = ids.slice(start, start + LEDGER_DEVICE_BATCH);
    const rows = await db
      .select({
        deviceId: ewohDeviceCapability.deviceId,
        capabilityId: ewohDeviceCapability.capabilityId,
        capabilityType: ewohDeviceCapability.capabilityType,
        capabilityKey: ewohDeviceCapability.capabilityKey,
        capabilityValue: ewohDeviceCapability.capabilityValue,
        status: ewohDeviceCapability.status,
        effectiveFrom: ewohDeviceCapability.effectiveFrom,
      })
      .from(ewohDeviceCapability)
      .where(and(
        eq(ewohDeviceCapability.orgId, orgId),
        // 不再只取 active：被人工停用的能力必须作为**事实**进入世界模型
        // （缺失 ≠ 停用）。是否计入可用能力由下方按 status 分流决定。
        inArray(ewohDeviceCapability.deviceId, batch),
      ));
    for (const row of rows) {
      const deviceId = String(row.deviceId);
      const bucket = result.get(deviceId) ?? {
        names: [],
        records: [],
        issues: [],
        disabledNames: [],
        disabledLifecycle: [],
      };
      const value = (row.capabilityValue ?? {}) as Record<string, unknown>;
      const kind = String(row.capabilityType ?? '');
      const name = String(row.capabilityKey ?? '');
      if (!DEVICE_CAPABILITY_LEDGER_KINDS.includes(kind)) {
        // 数据异常（如历史自造 kind）：显式缺口，不进能力集（避免"未登记词表"污染调度）
        bucket.issues.push(`capability_ledger_unexpected_kind:${kind}:${name}`);
        result.set(deviceId, bucket);
        continue;
      }
      const subject =
        typeof value.subject === 'string' && value.subject
          ? value.subject
          : `device:${deviceId}`;
      const record: CapabilityRecord = {
        capabilityId: String(row.capabilityId ?? `cap:${subject}:${name}`),
        kind,
        name,
        providerType:
          typeof value.providerType === 'string' && value.providerType
            ? value.providerType
            : (kind === 'exo_capability' ? 'exo' : 'device'),
        subject,
        grantedAt: row.effectiveFrom ? new Date(row.effectiveFrom as Date).toISOString() : undefined,
        evidence: Array.isArray(value.evidence) ? (value.evidence as string[]).map(String) : [],
        auditTrail: true,
      };
      const errors = validateCapability(record);
      if (errors.length > 0) {
        bucket.issues.push(`capability_ledger_invalid:${errors.join('|')}:${name}`);
        result.set(deviceId, bucket);
        continue;
      }
      const status = String(row.status ?? 'active');
      if (status === 'active') {
        bucket.records.push(record);
        bucket.names.push(name);
      } else {
        // 非 active（人工停用/历史状态）：作为事实保留，但不进可用能力集。
        bucket.disabledNames.push(name);
        const lifecycle = parseLifecycle(value.lifecycle);
        bucket.disabledLifecycle.push({
          name,
          operator: lifecycle?.operator ?? null,
          reason: lifecycle?.reason ?? null,
          at: lifecycle?.at ?? null,
        });
      }
      result.set(deviceId, bucket);
    }
  }
  for (const bucket of result.values()) {
    bucket.names = [...new Set(bucket.names)].sort();
    bucket.records.sort((a, b) => a.name.localeCompare(b.name));
    bucket.disabledNames = [...new Set(bucket.disabledNames)].sort();
    bucket.disabledLifecycle.sort((a, b) => a.name.localeCompare(b.name));
  }
  return result;
}

/** 台账 `capability_value.lifecycle` 的最小解析（形状不全 → null，不半截渲染）。 */
function parseLifecycle(raw: unknown): { operator: string; reason: string; at: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  const operator = typeof rec.operator === 'string' ? rec.operator.trim() : '';
  const reason = typeof rec.reason === 'string' ? rec.reason.trim() : '';
  const at = typeof rec.at === 'string' ? rec.at.trim() : '';
  if (!operator || !reason || !at) return null;
  return { operator, reason, at };
}

/** 设备能力解析结果（唯一语义：台账 > 列 > 型号白名单兜底）。 */
export interface ResolvedDeviceCapabilities {
  /**
   * **执行/交互能力**集（调度 `requiredDeviceCapabilities ⊆ capabilities` 用它）。
   * 语义：这台设备能"做"什么。观测能力不进这里——否则会把
   * `observe.temperature` 之类的事实维度塞进任务匹配语义。
   */
  capabilities: string[];
  /**
   * **观测能力**集（世界模型/AI 用）：设备能"看到"什么（mode='observation'）。
   * 与 capabilities 严格分离：传感器因此不会有任何执行能力（诚实），
   * 但它的观测维度仍对世界模型可见。
   */
  observedCapabilities: string[];
  /**
   * **被人为停用**的能力名（不参与匹配，但必须随世界模型透出）。
   * 供解释区分"设备没有这个能力"与"能力被人停用"，也供运维核对停用决定。
   */
  disabledCapabilities?: string[];
  /** 停用留痕（谁/何时/为什么）；形状不全的项为 null 字段，不半截渲染。 */
  disabledCapabilityLifecycle?: Array<{
    name: string;
    operator: string | null;
    reason: string | null;
    at: string | null;
  }>;
  /** 台账契约记录（仅台账命中时给出；调用方据此透出 subject/evidence）。 */
  capabilityRecords?: CapabilityRecord[];
  /** 台账缺口（显式留痕，调用方必须上报，不得静默）。 */
  capabilityLedgerIssues?: string[];
  /** 是否落到型号白名单兜底（字段来源标记 DERIVED 的依据）。 */
  derivedFromModelWhitelist: boolean;
}

/**
 * 设备能力唯一解析入口（NO-14f）。
 *
 * 优先级（逐级显式，绝不混用）：
 *   1. **权威台账**（`ewoh_device_capability`，摄入路径声明的契约记录，仅 active）
 *   2. `ewoh_device.capabilities` 列（历史/人工登记）
 *   3. 型号白名单派生（兜底，标记 derived）
 *
 * 为什么必须唯一：`resource-projection` 里 `project()` 与 `projectForSnapshot()`
 * 各有一份设备映射，本轮首次接线时只改了一处 → 快照路径仍然读空列，
 * 能力"接了一半"。抽成纯函数后两条路径共用同一语义。
 */
export function resolveDeviceCapabilities(params: {
  ledger?: DeviceCapabilityLedger;
  columnCapabilities: string[];
  deviceModel: string | null;
}): ResolvedDeviceCapabilities {
  const ledger = params.ledger;
  const ledgerNames = ledger?.names ?? [];
  // 台账能力按 mode 拆分：观测 vs 执行/交互。词表外名字保守归入**执行**侧
  // （它可能正是调度要匹配的能力名；宁可保留匹配语义，也不静默剔除）。
  const observedFromLedger = ledgerNames.filter(
    (name) => DEVICE_CAPABILITY_SPECS[name]?.mode === 'observation',
  );
  const executableFromLedger = ledgerNames.filter(
    (name) => DEVICE_CAPABILITY_SPECS[name]?.mode !== 'observation',
  );
  const issues = ledger && ledger.issues.length > 0 ? { capabilityLedgerIssues: ledger.issues } : {};

  // 执行能力合成规则（2026-09-10 两次实测校准）：
  //   1) 台账的观测能力**不得挤掉**执行能力——台账目前只声明观测/交互维度，
  //      若把它当"覆盖"用，外骨骼的 `exo-lift` 会消失，需要助力能力的任务
  //      永远无候选（golden 派工失败）；
  //   2) 但 `ewoh_device.capabilities` 列**非空时是权威声明**：它是操作员显式
  //      登记的执行能力，不能被型号字符串的猜测稀释（安全相关：型号里带 'exo'
  //      的起重机若被加上 `exo-lift`，会被派去干助力的活）。
  // 因此：列非空 → 只用"列 ∪ 台账执行/交互"；列空 → 再用型号白名单兜底。
  const whitelist = deriveDeviceCapabilities(params.deviceModel);
  const columnDeclared = params.columnCapabilities.length > 0;
  const disabled = new Set(ledger?.disabledNames ?? []);
  // 人工停用优先于一切自动来源：型号白名单与列都只是"声明/猜测"，
  // 人明确停用过的能力必须从可用集里**减掉**——否则"停用"会被白名单悄悄加回来，
  // 现场以为已经停用，调度却照旧按该能力派工（2026-09-11 e2e 实测）。
  const executable = [...new Set([
    ...executableFromLedger,
    ...params.columnCapabilities,
    ...(columnDeclared ? [] : whitelist),
  ])].filter((name) => !disabled.has(name)).sort();
  const observed = [...new Set(observedFromLedger)].filter((name) => !disabled.has(name)).sort();
  // 只有白名单**确实贡献了**能力、且台账/列都没贡献时才算"纯派生"。
  // （台账仅含观测能力且型号无白名单时，能力集为空——是"未知"，不是"派生"。）
  const derivedFromWhitelistOnly =
    whitelist.length > 0 && executableFromLedger.length === 0 && params.columnCapabilities.length === 0;

  return {
    capabilities: executable,
    observedCapabilities: observed,
    ...(ledger && ledger.disabledNames.length > 0
      ? {
          disabledCapabilities: ledger.disabledNames,
          disabledCapabilityLifecycle: ledger.disabledLifecycle,
        }
      : {}),
    ...(ledger && ledger.records.length > 0 ? { capabilityRecords: ledger.records } : {}),
    ...issues,
    derivedFromModelWhitelist: derivedFromWhitelistOnly,
  };
}

/** 从设备型号白名单派生能力集合（仅作无列值时的兜底，绝不替代真实列）。
 * 未命中返回空数组（视为无能力声明，不误判）。 */
export function deriveDeviceCapabilities(deviceModel: string | null): string[] {
  const m = (deviceModel ?? '').toLowerCase();
  if (!m) return [];
  const caps: string[] = [];
  if (m.includes('exo') || m.includes('pro') || m.includes('外骨骼')) {
    caps.push('exo-lift');
  }
  if (m.includes('lite')) caps.push('exo-lite');
  if (m.includes('vacuum') || m.includes('吸')) caps.push('vacuum');
  if (m.includes('crane') || m.includes('吊')) caps.push('crane');
  return caps;
}
