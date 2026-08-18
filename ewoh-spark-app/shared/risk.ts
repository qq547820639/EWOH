/* 前后端共享契约 - Canonical Risk Model（ADR-007 / NO-02c）。
 *
 * 权威契约：contracts/risk/risk.schema.json + contracts/risk/test-vectors.json。
 * 语义与 src/edge_platform/contracts/risk.py 逐项一致（共享向量约束）：
 * critical>high>medium>low；legacy L1→critical/L2→high/L3→medium；
 * 生命周期 open→acknowledged→resolving→resolved→closed（resolving/resolved→open 复开）；
 * category 封闭注册表；未知值 fail-closed 拒绝。
 */

export const RISK_SEVERITY_LADDER = ['critical', 'high', 'medium', 'low'] as const;
export type RiskSeverity = (typeof RISK_SEVERITY_LADDER)[number];

export const RISK_LEGACY_SEVERITY_MAP: Readonly<Record<string, RiskSeverity>> = {
  L1: 'critical',
  L2: 'high',
  L3: 'medium',
};

export const RISK_LIFECYCLE = ['open', 'acknowledged', 'resolving', 'resolved', 'closed'] as const;
export type RiskStatus = (typeof RISK_LIFECYCLE)[number];

export const RISK_CATEGORIES = [
  'posture',
  'load',
  'battery',
  'offline',
  'sensor_degraded',
  'time_sync',
  'packet_loss',
  'action_anomaly',
  'quality',
  'equipment',
  'environment',
  'other',
] as const;
export type RiskCategory = (typeof RISK_CATEGORIES)[number];

const RISK_CATEGORY_SET: ReadonlySet<string> = new Set(RISK_CATEGORIES);

const RISK_TRANSITIONS: ReadonlySet<string> = new Set([
  'open->acknowledged',
  'acknowledged->resolving',
  'resolving->resolved',
  'resolved->closed',
  'resolving->open',
  'resolved->open',
]);

export class DomainContractError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DomainContractError';
    this.code = code;
  }
}

/** 归一化严重度：规范值直通；legacy L1/L2/L3 → 规范；未知拒绝（fail-closed）。 */
export function normalizeSeverity(value: string): RiskSeverity {
  if ((RISK_SEVERITY_LADDER as readonly string[]).includes(value)) {
    return value as RiskSeverity;
  }
  const mapped = RISK_LEGACY_SEVERITY_MAP[value];
  if (mapped) return mapped;
  throw new DomainContractError('unknown_severity', `未知严重度（非规范值亦非 legacy L1-L3）: ${JSON.stringify(value)}`);
}

/** 事件写入侧显式未知严重度（ADR-027 决策 1：无风险判定绝不伪装成 normal）。 */
export const EVENT_SEVERITY_UNKNOWN = 'unknown';

/**
 * 事件域风险严重度集合（审计 B7，2026-08-19）。
 * ewoh_event 存量行用 legacy 词表（事件域语义：L1=info、L2=high、L3=critical，
 * 见 MES 检验/游戏化反馈写入），新写入统一 canonical（ADR-027：critical/high/
 * medium/low）。安全封锁（world-state）与优先级加权（priority-engine）两处
 * 消费必须同时受理两套词表——否则 ingest 上报的 canonical critical/high
 * 安全事件不触发封锁（原缺陷）。L1/low/unknown 为非风险档。
 * 注意：与 RISK_LEGACY_SEVERITY_MAP（风险域 L1→critical）语义不同，勿混用。
 */
export const EVENT_RISKY_SEVERITIES: ReadonlySet<string> = new Set([
  'critical',
  'high',
  'medium',
  'L2',
  'L3',
]);

/** 事件严重度是否为风险档（安全封锁 / 优先级加权共用判定）。 */
export function isEventSeverityRisky(severity: string | null | undefined): boolean {
  return severity != null && EVENT_RISKY_SEVERITIES.has(severity);
}

/**
 * 事件严重度入口归一化（ADR-027 决策 3）：规范值直通；legacy L1→critical /
 * L2→high / L3→medium；其余 → 显式 'unknown'（事件写入不因严重度未知而
 * 丢弃其他事实，但绝不静默伪装——与 normalizeSeverity 的 fail-closed
 * 语义分工：域契约校验拒绝、事件事实落账显式标记）。
 */
export function normalizeEventSeverity(value: string): string {
  if ((RISK_SEVERITY_LADDER as readonly string[]).includes(value)) {
    return value;
  }
  const mapped = RISK_LEGACY_SEVERITY_MAP[value];
  if (mapped) return mapped;
  return EVENT_SEVERITY_UNKNOWN;
}

/** 严重度等级（越大越严重）。 */
export function severityRank(value: string): number {
  return RISK_SEVERITY_LADDER.length - RISK_SEVERITY_LADDER.indexOf(normalizeSeverity(value));
}

export function severityHigherThan(a: string, b: string): boolean {
  return severityRank(a) > severityRank(b);
}

export function isValidRiskCategory(value: string): value is RiskCategory {
  return RISK_CATEGORY_SET.has(value);
}

export function requireRiskCategory(value: string): RiskCategory {
  if (!RISK_CATEGORY_SET.has(value)) {
    throw new DomainContractError('unknown_category', `category 不在注册表: ${JSON.stringify(value)}`);
  }
  return value as RiskCategory;
}

export function isRiskStatus(value: string): value is RiskStatus {
  return (RISK_LIFECYCLE as readonly string[]).includes(value);
}

export function riskTransitionAllowed(from: string, to: string): boolean {
  if (!isRiskStatus(from) || !isRiskStatus(to)) return false;
  return RISK_TRANSITIONS.has(`${from}->${to}`);
}
