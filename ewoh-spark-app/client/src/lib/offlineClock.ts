/**
 * Device clock-skew handling (Task 6 requirement 5).
 *
 * The offline vault timestamps items with the device clock. If the device clock
 * is far ahead of or behind the server, those timestamps (retry scheduling,
 * last-sync freshness, TTL expiry) become misleading. These pure helpers let the
 * app detect a skewed clock and shift local timestamps onto the server's time
 * base so retry/expiry/freshness decisions stay correct across devices.
 */

/** Max tolerable clock skew (ms) before we flag the device clock as skewed. */
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Difference between the server clock and the client clock (server - client). */
export function serverTimeOffsetMs(clientNowMs: number, serverNowMs: number): number {
  return serverNowMs - clientNowMs;
}

/** True when the device clock deviates from the server beyond `maxSkewMs`. */
export function isClockSkewed(
  clientNowMs: number,
  serverNowMs: number,
  maxSkewMs: number = MAX_CLOCK_SKEW_MS,
): boolean {
  return Math.abs(serverTimeOffsetMs(clientNowMs, serverNowMs)) > maxSkewMs;
}

/**
 * Adjusts a client-produced timestamp onto the server's time base using a known
 * offset. Returns milliseconds; callers format as needed.
 */
export function adjustClientTime(clientNowMs: number, offsetMs: number): number {
  return clientNowMs + offsetMs;
}