/**
 * NO-56b 改进行动项逾期 worker 的间隔解析回归（V147）。
 *
 * 真实缺陷：原实现 `Number(env ?? 默认)` 对非法值不设防，而 Node 把 `setInterval(fn, NaN)`
 * 当成 **1ms**（本机实测：`scripts/chain-baseline/worker-shutdown-probe.cjs` D 案，
 * 120ms 窗口内回调 96 次）⇒ 一次配置手误就把"30 分钟巡检一次"变成每毫秒扫库的热循环。
 * 同族的 `control-delivery-backlog.worker.ts` 早已把这条写成 `backlogIntervalMs`，
 * 本文件把同一纪律补到最后一个还裸着 `Number(env)` 的站点上。
 */
import { ImprovementActionOverdueWorkerService, overdueIntervalMs } from './improvement-action-overdue.worker';

const KEY = 'IMPROVEMENT_ACTION_OVERDUE_WORKER_INTERVAL_MS';

describe('overdueIntervalMs（逾期巡检间隔 env 解析）', () => {
  it('WK-01 缺失/空白 → 默认 30 分钟', () => {
    expect(overdueIntervalMs({})).toBe(1_800_000);
    expect(overdueIntervalMs({ [KEY]: '   ' })).toBe(1_800_000);
  });

  it('WK-02 合法正数 → 取整生效', () => {
    expect(overdueIntervalMs({ [KEY]: '60000' })).toBe(60_000);
    expect(overdueIntervalMs({ [KEY]: '1500.9' })).toBe(1500);
  });

  it('WK-03 非法值（表达式/负数/0/Infinity/NaN 词）→ 回退默认并留痕，绝不把 NaN 交给 setInterval', () => {
    const warnings: string[] = [];
    for (const bad of ['30*60_000', '-5', '0', 'Infinity', 'abc']) {
      const ms = overdueIntervalMs({ [KEY]: bad }, 1_800_000, (m) => warnings.push(m));
      expect(Number.isFinite(ms) && ms >= 1).toBe(true);
      expect(ms).toBe(1_800_000);
    }
    expect(warnings).toHaveLength(5);
    expect(warnings[0]).toContain(`非法 ${KEY} "30*60_000"`);
  });

  it('WK-04 启动路径确实把解析后的值交给 setInterval（不是把 env 原值递过去）', () => {
    const prev = process.env[KEY];
    process.env[KEY] = 'abc';
    const real = global.setInterval;
    const delays: unknown[] = [];
    global.setInterval = ((fn: () => void, ms: unknown, ...rest: unknown[]) => {
      delays.push(ms);
      return real(fn as never, ms as never, ...(rest as never[]));
    }) as unknown as typeof setInterval;
    try {
      new ImprovementActionOverdueWorkerService({} as never, {} as never, {} as never).onModuleInit();
    } finally {
      global.setInterval = real;
      if (prev === undefined) delete process.env[KEY];
      else process.env[KEY] = prev;
    }
    expect(delays).toHaveLength(1);
    expect(Number.isFinite(delays[0]) && (delays[0] as number) >= 1).toBe(true);
  });
});
