/**
 * persistThrottled 节流语义（NO-90a）。
 *
 * 契约：距最近快照不足 minIntervalMs → 不落（返回 false，不刷爆 kpi 表）；
 * 超过 → 聚合并落（返回 true）。聚合失败 → 抛出（调用方 catch，不影响闸门）。
 */
import { KpiService } from '../kpi.service';

const ORG = '00000000-0000-4000-8000-000000000001';

describe('persistThrottled 节流语义（NO-90a，override 注入）', () => {
  function makeService(opts: { latestAt?: Date }) {
    const persist = jest.fn().mockResolvedValue(undefined);
    const aggregate = jest.fn().mockResolvedValue({
      periodStart: 'p', periodEnd: 'e',
      delivery: { onTimeRate: 0.9, completionRate: 1, latenessP50Ms: 0, latenessP95Ms: 0, latenessMaxMs: 0 },
      stability: {}, dataQuality: {},
    });
    const service = new KpiService({} as never, {} as never, {} as never, {} as never);
    (service as unknown as { latestRawMetaOverride: Promise<{ createdAt: Date } | null> }).latestRawMetaOverride =
      Promise.resolve(opts.latestAt ? { createdAt: opts.latestAt } : null);
    (service as unknown as { aggregate: unknown }).aggregate = aggregate;
    (service as unknown as { persist: unknown }).persist = persist;
    return { service, persist, aggregate };
  }

  it('窗口内 → 不落（false；不调用 aggregate/persist）', async () => {
    const { service, persist, aggregate } = makeService({ latestAt: new Date(Date.now() - 60_000) });
    const persisted = await service.persistThrottled(ORG, 5 * 60_000);
    expect(persisted).toBe(false);
    expect(aggregate).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it('超窗 → 落（true；aggregate + persist 各一次）', async () => {
    const { service, persist, aggregate } = makeService({ latestAt: new Date(Date.now() - 10 * 60_000) });
    const persisted = await service.persistThrottled(ORG, 5 * 60_000);
    expect(persisted).toBe(true);
    expect(aggregate).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('无历史快照（首次）→ 落（true）', async () => {
    const { service, persist } = makeService({});
    const persisted = await service.persistThrottled(ORG, 5 * 60_000);
    expect(persisted).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
  });
});

