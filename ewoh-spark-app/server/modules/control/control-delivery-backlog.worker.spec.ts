/**
 * NO-68a 巡检 worker 的间隔解析回归。
 *
 * 真实缺陷（对抗式自查复现）：原实现 `Number(env ?? 默认)` 对非法值不设防——
 * `setInterval(fn, NaN)` 在 Node 里被当作 **1ms**（Node 会把非数字/小于 1 的
 * delay 归一为 1），一次配置手误就把"10 分钟巡检一次"变成每毫秒扫库的热循环。
 * 纪律与 `ingest.guard.ts` 的 `readPositiveInt` 同源：非法配置回退默认并留痕。
 */
import { backlogIntervalMs } from './control-delivery-backlog.worker';

describe('backlogIntervalMs（巡检间隔 env 解析）', () => {
  it('缺失/空白 → 默认 10 分钟', () => {
    expect(backlogIntervalMs({})).toBe(600_000);
    expect(backlogIntervalMs({ CONTROL_BACKLOG_WORKER_INTERVAL_MS: '   ' })).toBe(600_000);
  });

  it('合法正整数 → 取整生效', () => {
    expect(backlogIntervalMs({ CONTROL_BACKLOG_WORKER_INTERVAL_MS: '60000' })).toBe(60_000);
    expect(backlogIntervalMs({ CONTROL_BACKLOG_WORKER_INTERVAL_MS: '1500.9' })).toBe(1500);
  });

  it('非法值（NaN/负数/表达式）→ 回退默认并留痕，绝不变成 1ms 热循环', () => {
    const warnings: string[] = [];
    const onInvalid = (message: string) => warnings.push(message);
    for (const bad of ['abc', '-5', '10*60_000', 'Infinity']) {
      expect(backlogIntervalMs({ CONTROL_BACKLOG_WORKER_INTERVAL_MS: bad }, 600_000, onInvalid)).toBe(600_000);
    }
    expect(warnings).toHaveLength(4);
    expect(warnings[0]).toContain('非法 CONTROL_BACKLOG_WORKER_INTERVAL_MS');
  });
});
