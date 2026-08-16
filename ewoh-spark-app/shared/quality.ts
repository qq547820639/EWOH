/* 前后端共享契约 - Canonical Quality Finding Model（ADR-010 / NO-05a）。
 *
 * 权威契约：contracts/quality/quality.schema.json + test-vectors.json。
 * 语义与 src/edge_platform/contracts/quality.py 逐项一致（共享向量约束）。
 */

import { isCanonicalIdentity } from './identity';
import { DomainContractError, normalizeSeverity } from './risk';

export const QUALITY_FINDING_TYPES = [
  'defect', 'dimension_out_of_tolerance', 'nonconformance',
  'material_mismatch', 'process_deviation',
] as const;
export type QualityFindingType = (typeof QUALITY_FINDING_TYPES)[number];

export const QUALITY_LIFECYCLE = ['open', 'under_review', 'dispositioned', 'closed'] as const;
export type QualityStatus = (typeof QUALITY_LIFECYCLE)[number];

export const QUALITY_DISPOSITIONS = ['accept', 'rework', 'scrap', 'return'] as const;
export type QualityDisposition = (typeof QUALITY_DISPOSITIONS)[number];

const TYPE_SET: ReadonlySet<string> = new Set(QUALITY_FINDING_TYPES);
const DISPOSITION_SET: ReadonlySet<string> = new Set(QUALITY_DISPOSITIONS);
const TRANSITIONS: ReadonlySet<string> = new Set([
  'open->under_review',
  'under_review->dispositioned',
  'dispositioned->closed',
]);

export function isQualityFindingType(value: string): value is QualityFindingType {
  return TYPE_SET.has(value);
}

export function isQualityDisposition(value: string): value is QualityDisposition {
  return DISPOSITION_SET.has(value);
}

export function isQualityStatus(value: string): value is QualityStatus {
  return (QUALITY_LIFECYCLE as readonly string[]).includes(value);
}

export function qualityTransitionAllowed(from: string, to: string): boolean {
  if (!isQualityStatus(from) || !isQualityStatus(to)) return false;
  return TRANSITIONS.has(`${from}->${to}`);
}

/** 校验 QualityFinding 记录；返回错误码列表（空 = 合法）。fail-closed。 */
export function validateQualityFinding(record: unknown): string[] {
  if (record == null || typeof record !== 'object' || Array.isArray(record)) {
    return ['record_must_be_object'];
  }
  const r = record as Record<string, unknown>;
  for (const field of ['findingId', 'findingType', 'severity', 'status']) {
    if (!(field in r)) return [`missing_field:${field}`];
  }
  if (typeof r.findingId !== 'string' || r.findingId === '') return ['bad_finding_id'];
  if (!TYPE_SET.has(String(r.findingType))) return ['unknown_finding_type'];
  if (typeof r.severity !== 'string') return ['unknown_severity'];
  try {
    normalizeSeverity(r.severity);
  } catch {
    return ['unknown_severity'];
  }
  const status = String(r.status);
  if (!isQualityStatus(status)) return ['unknown_status'];
  const links = r.links ?? [];
  if (!Array.isArray(links)) return ['bad_links'];
  for (const link of links) {
    if (typeof link !== 'string' || !isCanonicalIdentity(link)) return ['bad_link'];
  }
  const disposition = r.disposition;
  if (status === 'dispositioned') {
    if (disposition == null) return ['disposition_required'];
    if (!DISPOSITION_SET.has(String(disposition))) return ['unknown_disposition'];
  } else if (disposition != null && !DISPOSITION_SET.has(String(disposition))) {
    return ['unknown_disposition'];
  }
  return [];
}

/**
 * NO-05d / ADR-011：质量发现 → 调度视图（QualityFindingProjection）。
 * ResourceProjectionService 将活跃发现（status ∈ {open, under_review}）按 links
 * 中 station/device/person 规范身份附着到资源投影；EligibilityService 对
 * critical/high 发现 fail-closed 拒派（*_quality_blocked，人审经 dispositioned/
 * closed 解除）。medium/low 仅事实可见（不封锁）。severity 为归一化 Canonical
 * Risk 阶梯。
 */
export interface QualityFindingProjection {
  findingId: string;
  findingType: string;
  severity: string;
  status: string;
  disposition: string | null;
  links: string[];
  detectedAt: string;
}

/** NO-05d：参与调度封锁的活跃质量状态（处置终态不参与）。 */
export const ACTIVE_QUALITY_STATUSES: ReadonlySet<string> = new Set([
  'open',
  'under_review',
]);

/** NO-05d：触发硬封锁的严重度（critical/high；medium/low 仅事实可见）。 */
export const QUALITY_BLOCK_SEVERITIES: ReadonlySet<string> = new Set([
  'critical',
  'high',
]);

/** NO-05d：links 中可映射为调度资源（封锁落点）的身份 kind。 */
export const QUALITY_RESOURCE_LINK_KINDS: ReadonlySet<string> = new Set([
  'station',
  'device',
  'person',
]);

/**
 * NO-05d（ADR-011）：critical/high 活跃发现触发硬封锁；medium/low 仅事实可见；
 * 未知严重度按封锁处理（fail-closed，不把未知当作安全）并经 onUnknown 留痕。
 */
export function qualityFindingsBlockDispatch(
  findings: QualityFindingProjection[] | null | undefined,
  onUnknown?: (findingId: string, severity: string) => void,
): boolean {
  if (!findings || findings.length === 0) return false;
  return findings.some((f) => {
    try {
      return QUALITY_BLOCK_SEVERITIES.has(normalizeSeverity(f.severity));
    } catch {
      onUnknown?.(f.findingId, f.severity);
      return true;
    }
  });
}
