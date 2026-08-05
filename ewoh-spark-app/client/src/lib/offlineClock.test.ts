import {
  adjustClientTime,
  isClockSkewed,
  MAX_CLOCK_SKEW_MS,
  serverTimeOffsetMs,
} from './offlineClock';

describe('offlineClock', () => {
  it('computes the server-vs-client time offset', () => {
    expect(serverTimeOffsetMs(1000, 2000)).toBe(1000);
    expect(serverTimeOffsetMs(2000, 1000)).toBe(-1000);
    expect(serverTimeOffsetMs(1000, 1000)).toBe(0);
  });

  it('flags a clock only when the skew exceeds the tolerance', () => {
    const client = 1_000_000;
    // Server ahead by 6 min → skewed.
    expect(isClockSkewed(client, client + 6 * 60_000)).toBe(true);
    // Server behind by 6 min → skewed.
    expect(isClockSkewed(client, client - 6 * 60_000)).toBe(true);
    // Within tolerance → not skewed.
    expect(isClockSkewed(client, client + 60_000)).toBe(false);
    expect(isClockSkewed(client, client)).toBe(false);
    expect(MAX_CLOCK_SKEW_MS).toBe(5 * 60 * 1000);
  });

  it('adjusts client timestamps onto the server time base', () => {
    // Server is 2h ahead; a client timestamp of 1000 maps to 1000 + 7200000.
    const offset = serverTimeOffsetMs(1000, 1000 + 2 * 3600_000);
    expect(adjustClientTime(1000, offset)).toBe(1000 + 2 * 3600_000);
  });
});