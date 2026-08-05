import {
  classifyConnection,
  classifyLatency,
  resolveNetworkQuality,
  SLOW_DOWNLINK_MBPS,
  SLOW_LATENCY_MS,
} from './networkQuality';

describe('networkQuality', () => {
  describe('classifyConnection', () => {
    it('treats missing signal as fast (optimistic)', () => {
      expect(classifyConnection()).toBe('fast');
    });

    it('flags saveData as slow', () => {
      expect(classifyConnection({ saveData: true })).toBe('slow');
    });

    it('flags slow effective types', () => {
      for (const type of ['slow-2g', '2g', '3g']) {
        expect(classifyConnection({ effectiveType: type })).toBe('slow');
      }
      expect(classifyConnection({ effectiveType: '4g' })).toBe('fast');
      expect(classifyConnection({ effectiveType: 'wifi' })).toBe('fast');
    });

    it('flags low downlink as slow', () => {
      expect(
        classifyConnection({ downlink: SLOW_DOWNLINK_MBPS - 0.5 }),
      ).toBe('slow');
      expect(
        classifyConnection({ downlink: SLOW_DOWNLINK_MBPS + 1 }),
      ).toBe('fast');
    });

    it('flags high RTT as slow', () => {
      expect(classifyConnection({ rtt: SLOW_LATENCY_MS })).toBe('slow');
      expect(classifyConnection({ rtt: SLOW_LATENCY_MS - 100 })).toBe('fast');
    });
  });

  describe('classifyLatency', () => {
    it('maps latency samples to quality', () => {
      expect(classifyLatency(SLOW_LATENCY_MS)).toBe('slow');
      expect(classifyLatency(SLOW_LATENCY_MS - 1)).toBe('fast');
    });

    it('treats invalid samples as fast', () => {
      expect(classifyLatency(-1)).toBe('fast');
      expect(classifyLatency(Number.NaN)).toBe('fast');
      expect(classifyLatency(Number.POSITIVE_INFINITY)).toBe('fast');
    });
  });

  describe('resolveNetworkQuality', () => {
    it('is offline when the device reports offline', () => {
      expect(
        resolveNetworkQuality(false, { effectiveType: '4g' }, 10),
      ).toBe('offline');
    });

    it('is slow when the connection signal is slow', () => {
      expect(
        resolveNetworkQuality(true, { effectiveType: '3g' }, 10),
      ).toBe('slow');
    });

    it('is slow when a latency sample is slow', () => {
      expect(
        resolveNetworkQuality(true, undefined, SLOW_LATENCY_MS),
      ).toBe('slow');
    });

    it('is fast when everything looks healthy', () => {
      expect(
        resolveNetworkQuality(true, { effectiveType: '4g', downlink: 10 }, 40),
      ).toBe('fast');
      expect(resolveNetworkQuality(true)).toBe('fast');
    });
  });
});