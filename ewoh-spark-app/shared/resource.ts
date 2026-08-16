/* 前后端共享契约 - Canonical Resource Model（ADR-007 / NO-02c）。
 *
 * 权威契约：contracts/resource/resource.schema.json + contracts/resource/test-vectors.json。
 * 语义与 src/edge_platform/contracts/resource.py 逐项一致（共享向量约束）：
 * 六态 + UNKNOWN；dataQuality FRESH|STALE|UNKNOWN；source AUTHORITATIVE|DERIVED；
 * 可用性判定确定性 fail-closed：仅 AVAILABLE ∧ FRESH 视为可用。
 */

import { DomainContractError } from './risk';

export const RESOURCE_STATUSES = [
  'AVAILABLE',
  'RESERVED',
  'BUSY',
  'DEGRADED',
  'OFFLINE',
  'MAINTENANCE',
  'UNKNOWN',
] as const;
export type ResourceStatus = (typeof RESOURCE_STATUSES)[number];

export const RESOURCE_DATA_QUALITIES = ['FRESH', 'STALE', 'UNKNOWN'] as const;
export type ResourceDataQuality = (typeof RESOURCE_DATA_QUALITIES)[number];

export const RESOURCE_SOURCES = ['AUTHORITATIVE', 'DERIVED'] as const;
export type ResourceSource = (typeof RESOURCE_SOURCES)[number];

export const RESOURCE_TYPES = ['person', 'device', 'station', 'tool', 'material', 'vehicle'] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

const RESOURCE_STATUS_SET: ReadonlySet<string> = new Set(RESOURCE_STATUSES);
const RESOURCE_QUALITY_SET: ReadonlySet<string> = new Set(RESOURCE_DATA_QUALITIES);
const RESOURCE_TYPE_SET: ReadonlySet<string> = new Set(RESOURCE_TYPES);

const UNAVAILABLE_REASON: Readonly<Record<string, string>> = {
  RESERVED: 'reserved',
  BUSY: 'busy',
  DEGRADED: 'degraded',
  OFFLINE: 'offline',
  MAINTENANCE: 'maintenance',
  UNKNOWN: 'unknown_status',
};

export interface AvailabilityResult {
  available: boolean;
  reason: string | null;
}

export function isResourceStatus(value: string): value is ResourceStatus {
  return RESOURCE_STATUS_SET.has(value);
}

export function requireResourceStatus(value: string): ResourceStatus {
  if (!RESOURCE_STATUS_SET.has(value)) {
    throw new DomainContractError('unknown_status', `资源状态不在注册表: ${JSON.stringify(value)}`);
  }
  return value as ResourceStatus;
}

export function isResourceDataQuality(value: string): value is ResourceDataQuality {
  return RESOURCE_QUALITY_SET.has(value);
}

export function isResourceType(value: string): value is ResourceType {
  return RESOURCE_TYPE_SET.has(value);
}

/** 确定性可用性判定（契约规则）：仅 AVAILABLE ∧ FRESH 可用；非法值 fail-closed 抛错。 */
export function evaluateAvailability(status: string, dataQuality: string): AvailabilityResult {
  requireResourceStatus(status);
  if (!RESOURCE_QUALITY_SET.has(dataQuality)) {
    throw new DomainContractError('unknown_data_quality', `dataQuality 不在注册表: ${JSON.stringify(dataQuality)}`);
  }
  if (status === 'AVAILABLE') {
    if (dataQuality === 'FRESH') return { available: true, reason: null };
    // STALE/UNKNOWN：契约 fail-closed 规则（与 scheduler.ts 既有注释一致）
    return { available: false, reason: 'stale_data' };
  }
  return { available: false, reason: UNAVAILABLE_REASON[status] ?? 'unknown_status' };
}
