/**
 * batchRestoreLogic.ts — 批量恢复设备能力的纯逻辑（NO-23a）。
 *
 * 背景（现场可用性，原则 1/10）：一次检修常常同时影响**多台**设备（同一批外骨骼
 * 助力模块、同一批吊具）。逐台打开抽屉、逐台填理由、逐台申请审批，现场会退化成
 * "能少恢复一台就少一台"。后端（NO-21a）已支持一张审批覆盖一批设备，本文件为
 * 批量界面提供**分组、选择、结果汇总**三件纯函数：
 *
 *   · 分组：从世界模型快照里找出"被人为停用"的能力，按能力聚合成可恢复批次；
 *   · 结果汇总：区分 全部成功 / 部分成功 / 全部失败（原则 6：部分执行必须明说），
 *     并明确"失败项未消耗审批额度，可直接重试"（这是服务端事务语义，不是猜测）；
 *   · 失败文案：把服务端的稳定错误码翻译成现场能照做的下一步，未知错误如实透出。
 *
 * 这里**不做**任何放行判定：高风险能力恢复始终以服务端闸门为准（原则 4）。
 */
import type { WorldStateSnapshot } from '@shared/scheduler';
import { capabilityRiskLevel, type DeviceCapabilityRiskLevel } from '@shared/device-capability';
import { formatCapabilityRisk, describeRestoreRejection } from './devicesLogic';

/** 批次中的一台设备（含停用留痕：谁/何时/为什么）。 */
export interface BatchRestoreDevice {
  deviceId: string;
  name: string;
  /** 数据质量（STALE/UNKNOWN 如实展示：停用事实来自台账，但设备数据可能不新鲜）。 */
  dataQuality: 'FRESH' | 'STALE' | 'UNKNOWN' | null;
  /** 已停用天数（无法计算 → null，不猜）。 */
  disabledDays: number | null;
  operator: string | null;
  reason: string | null;
  at: string | null;
}

/** 一组"同能力、多设备"的待恢复批次。 */
export interface BatchRestoreGroup {
  capability: string;
  risk: DeviceCapabilityRiskLevel | null;
  riskLabel: string;
  /** 高风险能力的恢复需安全管理员审批（与服务端 `deviceCapabilityChangeNeedsApproval` 同口径）。 */
  requiresApproval: boolean;
  devices: BatchRestoreDevice[];
}

export interface GroupRestoreOptions {
  nowMs?: number;
}

/** 停用天数：与设备抽屉同一算法（devicesLogic.disabledDaysFor 的等价内联，避免循环依赖）。 */
function disabledDaysFrom(at: string | null, nowMs: number): number | null {
  if (!at) return null;
  const startedMs = new Date(at).getTime();
  if (!Number.isFinite(startedMs)) return null;
  const days = Math.floor((nowMs - startedMs) / 86_400_000);
  return days >= 0 ? days : null;
}

/**
 * 从快照分组出"可批量恢复"的能力批次。
 *
 * 规则（每条都对应一个现场问题）：
 *   · 只收 `disabledCapabilities`（人工停用）——设备**没有**该能力不是"待恢复"；
 *   · 缺业务设备号（deviceId）的设备无法调恢复 API，单独计数如实告知（数据缺口）；
 *   · 高风险批次排前面：它们既更需要审批、也更需要优先处置；
 *   · 同批次内按"停用最久"优先：避免设备被悄悄永久排除在派工之外。
 */
export function groupRestorableCapabilities(
  snapshot: WorldStateSnapshot | null | undefined,
  options: GroupRestoreOptions = {},
): { groups: BatchRestoreGroup[]; missingDeviceIdCount: number } {
  const nowMs = options.nowMs ?? Date.now();
  const devices = Array.isArray(snapshot?.devices) ? snapshot!.devices : [];
  const byCapability = new Map<string, BatchRestoreDevice[]>();
  let missingDeviceIdCount = 0;

  for (const device of devices) {
    const disabled = Array.isArray(device.disabledCapabilities) ? device.disabledCapabilities : [];
    if (disabled.length === 0) continue;
    const businessId = (device.deviceId ?? '').trim();
    if (!businessId) {
      // 数据缺口：没有业务设备号的设备无法通过状态 API 恢复，必须如实计数
      missingDeviceIdCount += disabled.length;
      continue;
    }
    const lifecycle = Array.isArray(device.disabledCapabilityLifecycle)
      ? device.disabledCapabilityLifecycle
      : [];
    for (const capability of disabled) {
      const trace = lifecycle.find((entry) => entry?.name === capability) ?? null;
      const entry: BatchRestoreDevice = {
        deviceId: businessId,
        // 快照的设备项用 workerName/deviceModel 描述（没有统一的 name 字段）
        name: device.workerName?.trim() || device.deviceModel?.trim() || businessId,
        dataQuality: device.dataQuality ?? null,
        disabledDays: disabledDaysFrom(trace?.at ?? null, nowMs),
        operator: trace?.operator ?? null,
        reason: trace?.reason ?? null,
        at: trace?.at ?? null,
      };
      const list = byCapability.get(capability);
      if (list) list.push(entry);
      else byCapability.set(capability, [entry]);
    }
  }

  const groups: BatchRestoreGroup[] = [...byCapability.entries()].map(([capability, list]) => {
    const risk = capabilityRiskLevel(capability);
    return {
      capability,
      risk,
      riskLabel: formatCapabilityRisk(risk),
      requiresApproval: risk === 'high',
      devices: [...list].sort((a, b) => {
        const daysA = a.disabledDays ?? -1;
        const daysB = b.disabledDays ?? -1;
        if (daysA !== daysB) return daysB - daysA;
        return a.deviceId.localeCompare(b.deviceId);
      }),
    };
  });

  groups.sort((a, b) => {
    if (a.requiresApproval !== b.requiresApproval) return a.requiresApproval ? -1 : 1;
    if (a.devices.length !== b.devices.length) return b.devices.length - a.devices.length;
    return a.capability.localeCompare(b.capability);
  });

  return { groups, missingDeviceIdCount };
}

/** 单台设备的恢复结果（由调用方填入 API 返回或错误）。 */
export interface BatchRestoreResult {
  deviceId: string;
  ok: boolean;
  /** 失败原因（现场可读；成功时为 null）。 */
  message: string | null;
  /** 服务端返回的状态码（成功 200；便于对账）。 */
  status?: number | null;
}

/**
 * 汇总一次批量执行的结果。
 *
 * 关键语义（原则 6/7）：部分成功必须**明说**，并指出失败项"未消耗审批额度、
 * 可直接重试"——服务端把授权消耗放在与能力写入同一事务里（NO-22a），
 * 因此失败的设备不会烧掉它那一份授权。
 */
export function summarizeRestoreOutcome(results: readonly BatchRestoreResult[]): {
  total: number;
  succeeded: number;
  failed: number;
  partial: boolean;
  allFailed: boolean;
  label: string;
  failures: BatchRestoreResult[];
} {
  const total = results.length;
  const failures = results.filter((r) => !r.ok);
  const succeeded = total - failures.length;
  const failed = failures.length;
  const partial = succeeded > 0 && failed > 0;
  const allFailed = total > 0 && succeeded === 0;
  const label =
    total === 0
      ? '没有需要恢复的设备'
      : allFailed
        ? `全部失败（${failed} 台）：设备能力未发生变化，请按失败原因处理后重试`
        : partial
          ? `部分成功：成功 ${succeeded} 台 / 失败 ${failed} 台；失败项未消耗审批额度，可直接重试`
          : `全部成功（${succeeded} 台）`;
  return { total, succeeded, failed, partial, allFailed, label, failures };
}

/**
 * 把单台失败翻译成现场可读文案。
 *
 * 审批类拒绝复用设备抽屉的同一实现（`describeRestoreRejection`：无审批/已过期/
 * 已消耗 → 各自的下一步）；其余错误如实透出服务端 message；什么都没有时明确
 * 说"未返回原因"，不编一个原因。
 */
export function describeBatchRestoreFailure(err: unknown): string {
  const rejection = describeRestoreRejection(err);
  if (rejection.nextStep) return rejection.nextStep;
  // 优先用**服务端**给的业务原因（比 axios 的 "Request failed with status code 500" 有用得多），
  // 再退回传输层 message；两者都没有才如实说"未返回原因"，不编一个原因。
  const serverMessages: string[] = [];
  const transportMessages: string[] = [];
  if (typeof err === 'string') serverMessages.push(err);
  if (err && typeof err === 'object') {
    const anyErr = err as { message?: unknown; response?: { data?: unknown } };
    const data = anyErr.response?.data as
      | { message?: unknown; error?: { message?: unknown } }
      | undefined;
    if (typeof data?.message === 'string') serverMessages.push(data.message);
    if (typeof data?.error?.message === 'string') serverMessages.push(data.error.message);
    if (typeof anyErr.message === 'string') transportMessages.push(anyErr.message);
  }
  const text = [...serverMessages, ...transportMessages].find((candidate) => candidate.trim().length > 0);
  return text?.trim() || '失败原因未返回（请查看服务端日志或稍后重试）';
}

/** 审批对象描述用的设备名单：排序去重（与服务端指纹构造同一口径）。 */
export function sortedDeviceIds(deviceIds: readonly string[]): string[] {
  return [...new Set(deviceIds.map((id) => String(id).trim()).filter(Boolean))].sort();
}
