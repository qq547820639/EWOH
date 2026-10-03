import { DISPLAY_TIME_OPTS, DISPLAY_TIME_OPTS_MONTH_DAY } from './intl';

describe('DISPLAY_TIME_OPTS', () => {
  const sample = new Date('2026-10-03T10:47:49Z');

  // 这些断言是「行为零变更」的锚点：常量必须与原内联字面量完全等价。
  // 若有人改了时区或制式，本组用例会失败并指出行为变更。
  it('与原内联字面量在 toLocaleString 下输出一致', () => {
    expect(sample.toLocaleString('zh-CN', DISPLAY_TIME_OPTS)).toBe(
      sample.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
    );
  });

  it('与原内联字面量在 toLocaleTimeString 下一致', () => {
    expect(sample.toLocaleTimeString('zh-CN', DISPLAY_TIME_OPTS)).toBe(
      sample.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
    );
  });

  it('与原内联字面量在 toLocaleDateString 下一致', () => {
    expect(sample.toLocaleDateString('zh-CN', DISPLAY_TIME_OPTS)).toBe(
      sample.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
    );
  });

  it('与「仅属性顺序不同」的变体一致（那 1 处历史写法）', () => {
    expect(sample.toLocaleString('zh-CN', DISPLAY_TIME_OPTS)).toBe(
      sample.toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }),
    );
  });

  it('固定上海时区：UTC 时刻显示为 +08:00 的墙上时间', () => {
    // 2026-10-03T10:47:49Z === 2026-10-03 18:47:49 (UTC+8)
    const out = sample.toLocaleString('zh-CN', DISPLAY_TIME_OPTS);
    expect(out).toContain('18:47');
    expect(out).not.toContain('10:47');
  });

  it('24 小时制：13 点显示为 13 而非 01（12 小时制会致工业场景歧义）', () => {
    const afternoon = new Date('2026-10-03T05:00:00Z'); // 13:00 +08:00
    const out = afternoon.toLocaleTimeString('zh-CN', DISPLAY_TIME_OPTS);
    expect(out).toContain('13:00');
  });

  it('跨时区输入显示结果恒定（不随运行环境 TZ 变化）', () => {
    // 同一时刻，无论宿主 TZ 如何，展示的墙上时间应一致
    const out = sample.toLocaleString('zh-CN', DISPLAY_TIME_OPTS);
    expect(out).toContain('18:47');
  });

  it('保留字面量类型，可直接用于 Intl 方法签名', () => {
    // 编译期即可断言类型正确：不是 Record<string, unknown>，而是具体字面量类型
    const opts: { readonly timeZone: 'Asia/Shanghai'; readonly hour12: false } = DISPLAY_TIME_OPTS;
    expect(opts.timeZone).toBe('Asia/Shanghai');
  });
});

describe('DISPLAY_TIME_OPTS_MONTH_DAY', () => {
  const sample = new Date('2026-10-03T10:47:49Z');

  it('与原内联字面量输出一致（列表/面板的月日时分格式）', () => {
    expect(sample.toLocaleString('zh-CN', DISPLAY_TIME_OPTS_MONTH_DAY)).toBe(
      sample.toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }),
    );
  });

  it('不显示年份（与完整格式的关键差异）', () => {
    const out = sample.toLocaleString('zh-CN', DISPLAY_TIME_OPTS_MONTH_DAY);
    expect(out).not.toContain('2026');
    expect(out).toContain('10');
    expect(out).toContain('03');
  });

  it('与 DISPLAY_TIME_OPTS 输出不同（两套配置不可互换）', () => {
    expect(sample.toLocaleString('zh-CN', DISPLAY_TIME_OPTS_MONTH_DAY)).not.toBe(
      sample.toLocaleString('zh-CN', DISPLAY_TIME_OPTS),
    );
  });

  it('同样固定上海时区与 24 小时制', () => {
    const out = sample.toLocaleString('zh-CN', DISPLAY_TIME_OPTS_MONTH_DAY);
    expect(out).toContain('18:47');
  });
});
