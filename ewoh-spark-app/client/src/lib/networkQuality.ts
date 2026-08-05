/**
 * Network-quality heuristics for the mobile workbench (Task 6 requirement 7).
 *
 * The workbench must distinguish "online but slow" (weak network) from clean
 * online/offline so users can be told their queue may sync slowly. We combine
 * the Network Information API (`navigator.connection`) when present with a
 * latency heuristic fallback. All functions are pure and injectable so the
 * thresholds are unit-testable in the node environment.
 */

export type NetworkQuality = 'offline' | 'slow' | 'fast';

/** Online; not slow. */
export const SLOW_DOWNLINK_MBPS = 1.5;
/** Latency sample (ms) at/above which we treat the link as weak. */
export const SLOW_LATENCY_MS = 800;

/** Values exposed by `NetworkInformation.effectiveType`. */
const SLOW_EFFECTIVE_TYPES = new Set(['slow-2g', '2g', '3g']);

export interface ConnectionLike {
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
  saveData?: boolean;
}

/**
 * Classifies a link from the Network Information API. `undefined` inputs mean
 * "no signal" and map to `fast` (optimistic) so the app never over-warns.
 */
export function classifyConnection(connection?: ConnectionLike): NetworkQuality {
  if (!connection) {
    return 'fast';
  }
  if (connection.saveData) {
    return 'slow';
  }
  if (connection.effectiveType && SLOW_EFFECTIVE_TYPES.has(connection.effectiveType)) {
    return 'slow';
  }
  const downlink = Number(connection.downlink);
  if (Number.isFinite(downlink) && downlink < SLOW_DOWNLINK_MBPS) {
    return 'slow';
  }
  const rtt = Number(connection.rtt);
  if (Number.isFinite(rtt) && rtt >= SLOW_LATENCY_MS) {
    return 'slow';
  }
  return 'fast';
}

/** Latency heuristic: a single round-trip sample in ms mapped to a quality. */
export function classifyLatency(sampleMs: number): NetworkQuality {
  if (sampleMs < 0 || !Number.isFinite(sampleMs)) {
    return 'fast';
  }
  return sampleMs >= SLOW_LATENCY_MS ? 'slow' : 'fast';
}

/**
 * Combines navigator state with a connection signal into a single quality.
 * `online` comes from `navigator.onLine`; `connection` from the Network
 * Information API (optional); `latencyMs` an optional latency sample.
 */
export function resolveNetworkQuality(
  online: boolean,
  connection?: ConnectionLike,
  latencyMs?: number,
): NetworkQuality {
  if (!online) {
    return 'offline';
  }
  if (connection) {
    const fromConnection = classifyConnection(connection);
    if (fromConnection === 'slow') {
      return 'slow';
    }
  }
  if (latencyMs !== undefined && classifyLatency(latencyMs) === 'slow') {
    return 'slow';
  }
  return 'fast';
}