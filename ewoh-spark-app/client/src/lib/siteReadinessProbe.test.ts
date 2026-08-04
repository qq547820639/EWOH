import { runSiteReadinessProbe, probeBackendConnectivity } from './siteReadinessProbe';

describe('siteReadinessProbe', () => {
  it('runs a synchronous probe with six probe checks', () => {
    const probe = runSiteReadinessProbe();
    expect(probe.checks).toHaveLength(6);
    expect(probe.checks.every((c) => c.source === 'probe')).toBe(true);
    expect(typeof probe.online).toBe('boolean');
    expect(probe.runsAt).toBeTruthy();
  });

  it('reports backend reachable on 200', async () => {
    const fetchImpl = (async () =>
      ({ ok: true, status: 200 }) as Response) as typeof fetch;
    const result = await probeBackendConnectivity(fetchImpl, 'https://example.test');
    expect(result.reachable).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('reports backend unreachable on error', async () => {
    const fetchImpl = (async () => {
      throw new Error('network down');
    }) as typeof fetch;
    const result = await probeBackendConnectivity(fetchImpl, 'https://example.test');
    expect(result.reachable).toBe(false);
    expect(result.error).toContain('network down');
  });
});