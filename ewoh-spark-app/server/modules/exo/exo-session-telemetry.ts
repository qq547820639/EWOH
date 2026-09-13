/**
 * NO-41a：佩戴事实的**双源交叉校验**（人工声明的会话 × 设备遥测）。
 *
 * 为什么需要它：外骨骼会话是**人工声明**（谁戴了哪台），而遥测里本来就有"当时是谁在戴"
 * 这一路证据（`observe.wearer` 的 `worker_id`）。只有一条声明时，平台无法回答现场最常见的
 * 两类问题：
 *   · 会话说 A 在戴、遥测显示是 B（谁在说真话？）——单侧采信就是伪造事实（原则 7）；
 *   · 会话还开着、遥测显示设备早已无活动（人走了没收工）——这正是调度被"佩戴中"占住的根因。
 *
 * 判定口径（**证据不足绝不升级为结论**）：
 *   · `no_telemetry`      ：窗口内没有任何遥测帧 = 无佐证（**不是**"没在戴"）；
 *   · `stale_telemetry`   ：有帧但已超新鲜窗口 = 证据过期，不下结论；
 *   · `wearer_mismatch`   ：帧上报了佩戴人且与会话佩戴者**不是同一个人**（最强冲突，需人核实）；
 *   · `consistent`        ：帧上报的佩戴人就是会话佩戴者（同一个人，两源一致）；
 *   · `activity_only`     ：帧**没上报佩戴人**，但指标显示设备在动作（有人用，但无法确认是谁）；
 *   · `inactive_suspect`  ：帧没上报佩戴人且指标全静（**疑似**未佩戴/已离岗——用词必须是"疑似"）。
 */
import { normalizePersonRef } from '@shared/identity';

/** 遥测新鲜窗口：超过该时长视为"证据过期"（默认 5 分钟）。 */
export const EXO_TELEMETRY_FRESH_MS = 5 * 60_000;

/** 判为"设备在动作"的活动阈值（load_score / assist_level / 角速度任一超过即算有活动）。 */
export const EXO_TELEMETRY_ACTIVITY_THRESHOLD = 0.05;

/** 角速度活动阈值（度/秒；站立微动也常 > 0.5，故取稍高值）。 */
export const EXO_TELEMETRY_ANGULAR_THRESHOLD_DPS = 1;

export const EXO_TELEMETRY_VERDICTS = [
  'consistent',
  'wearer_mismatch',
  'activity_only',
  'inactive_suspect',
  'stale_telemetry',
  'no_telemetry',
] as const;
export type ExoTelemetryVerdict = (typeof EXO_TELEMETRY_VERDICTS)[number];

export interface ExoTelemetryEvidence {
  ts: string;
  workerId: string | null;
  loadScore: number | null;
  assistLevel: number | null;
  angularVelocityDps: number | null;
  sourceType: string | null;
  dataQuality: string | null;
}

export interface ExoTelemetryConsistency {
  verdict: ExoTelemetryVerdict;
  /** 面向现场的一句话结论（含证据与"为什么不下结论"）。 */
  reason: string;
  /** 需要人核实的严重冲突（佩戴人不符 / 疑似未佩戴）。 */
  needsHumanCheck: boolean;
  sessionPersonRef: string | null;
  telemetryWorkerRef: string | null;
  evidenceAgeMs: number | null;
  evidence: ExoTelemetryEvidence | null;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 判定一次"会话 ↔ 遥测"的一致性（纯函数；服务端接口与测试共用）。
 *
 * `nowMs` 由调用方给出（可复现）；`evidence` 为该设备窗口内**最近一帧**（无则 null）。
 */
export function classifyExoTelemetryConsistency(
  input: {
    session: { sessionId: string; personId: string | null; exoId: string | null };
    evidence: ExoTelemetryEvidence | null;
  },
  options: { nowMs?: number; freshMs?: number; activityThreshold?: number; angularThresholdDps?: number } = {},
): ExoTelemetryConsistency {
  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  const freshMs = Number.isFinite(options.freshMs) ? Math.max(0, Number(options.freshMs)) : EXO_TELEMETRY_FRESH_MS;
  const activityThreshold = Number.isFinite(options.activityThreshold)
    ? Number(options.activityThreshold)
    : EXO_TELEMETRY_ACTIVITY_THRESHOLD;
  const angularThreshold = Number.isFinite(options.angularThresholdDps)
    ? Number(options.angularThresholdDps)
    : EXO_TELEMETRY_ANGULAR_THRESHOLD_DPS;

  const sessionPersonRef = normalizePersonRef(input.session.personId ?? null);
  const base = {
    sessionPersonRef,
    telemetryWorkerRef: normalizePersonRef(input.evidence?.workerId ?? null),
    evidenceAgeMs: null as number | null,
    evidence: input.evidence ?? null,
  };

  if (!input.evidence) {
    return {
      ...base,
      verdict: 'no_telemetry',
      reason: '该设备在新鲜窗口内没有任何遥测帧：无佐证（不等于"没有佩戴"，请检查采集链路）',
      needsHumanCheck: false,
    };
  }

  const tsMs = Date.parse(input.evidence.ts);
  const evidenceAgeMs = Number.isFinite(tsMs) ? Math.max(0, nowMs - tsMs) : null;
  if (evidenceAgeMs === null) {
    return {
      ...base,
      verdict: 'stale_telemetry',
      reason: `最近遥测帧的时间无法解析（原值 ${input.evidence.ts}）：证据不可用，不下结论`,
      needsHumanCheck: false,
    };
  }
  if (evidenceAgeMs > freshMs) {
    return {
      ...base,
      evidenceAgeMs,
      verdict: 'stale_telemetry',
      reason: `最近遥测帧已过期（${Math.round(evidenceAgeMs / 60_000)} 分钟前，新鲜窗口 ${Math.round(freshMs / 60_000)} 分钟）：证据过期，不下结论`,
      needsHumanCheck: false,
    };
  }

  const telemetryWorkerRef = base.telemetryWorkerRef;
  if (telemetryWorkerRef) {
    if (sessionPersonRef && telemetryWorkerRef === sessionPersonRef) {
      return {
        ...base,
        evidenceAgeMs,
        verdict: 'consistent',
        reason: `遥测上报的佩戴人与会话一致（${telemetryWorkerRef}），最近一帧 ${Math.round(evidenceAgeMs / 1000)} 秒前`,
        needsHumanCheck: false,
      };
    }
    return {
      ...base,
      evidenceAgeMs,
      verdict: 'wearer_mismatch',
      reason: `遥测上报的佩戴人是 ${telemetryWorkerRef}，而会话记录的是 ${sessionPersonRef ?? '（未记录）'}：`
        + '两源不一致，请现场核实（平台不替任何一方下结论）',
      needsHumanCheck: true,
    };
  }

  const loadScore = finiteOrNull(input.evidence.loadScore);
  const assistLevel = finiteOrNull(input.evidence.assistLevel);
  const angular = finiteOrNull(input.evidence.angularVelocityDps);
  const active =
    (loadScore !== null && loadScore > activityThreshold) ||
    (assistLevel !== null && assistLevel > activityThreshold) ||
    (angular !== null && Math.abs(angular) > angularThreshold);
  if (active) {
    return {
      ...base,
      evidenceAgeMs,
      verdict: 'activity_only',
      reason: '遥测显示设备在动作，但该帧未上报佩戴人：只能证明"有人在用"，无法确认是谁',
      needsHumanCheck: false,
    };
  }
  return {
    ...base,
    evidenceAgeMs,
    verdict: 'inactive_suspect',
    reason: '遥测帧未上报佩戴人，且指标全静（负荷/助力/角速度均低于阈值）：**疑似**未佩戴或已离岗，请核实是否需要收工',
    needsHumanCheck: true,
  };
}
