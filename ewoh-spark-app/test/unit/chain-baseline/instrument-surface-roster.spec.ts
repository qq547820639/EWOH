/**
 * 量具执行面的分母必须由 Makefile 现抽（V347，SRFCS-01 ＝ SURFACERO-01 的常驻位点）。
 *
 * 存在理由：V197／V198／V215 三次记下"新量具没进那份手写名单 ⇒ 对执行面读数整件隐身"，
 * V346 第四次复发——`chain-baseline-ledger-gap` 建好后复跑该尺，读数仍是「目标 38／无人跑 33」，
 * 输出里连它的名字都没有；现算 Makefile 有 60 个 `chain-baseline-*`、名单里只有 37 个。
 * 本用例钉的是**改成默认纳入之后**的三件事：真语料上分母必须把前缀目标收全且无交叉、
 * 豁免表掏空分母/两张表互相矛盾/桶不闭合三种形状都必须开火而合规侧必须沉默、
 * 取不到 Makefile 必须落"不可判"而不是"零个量具"（空集与干净同形是老病）。
 */
import * as fs from 'fs';
import * as path from 'path';

const REPO = path.resolve(__dirname, '../../../..');
const surface = require(path.join(REPO, 'scripts/chain-baseline/instrument-surface.cjs'));

const H = (o: Record<string, string>) => new Map(Object.entries(o));
const S = (a: string[]) => new Set(a);

describe('量具执行面分母现抽机检（SRFCS-01）', () => {
  it('SRFCS-01 真树上每个 chain-baseline-* 目标要么在分母要么被逐条豁免，两向不得交叉也不得留问题', () => {
    const A = surface.analyze(REPO);
    expect(A.unreadable).toBeUndefined();
    const c = A.cls;
    expect(c.prefixAll.length).toBeGreaterThanOrEqual(60);      // 分母自证：解析面塌了后面全是永真
    expect(c.denom.length).toBeGreaterThan(38);                // 必须比 V346 那张手工名单大（漏的 23 件被收回）
    const union = new Set([...c.denom.filter((t: string) => t.startsWith('chain-baseline-')), ...c.exemptPresent]);
    expect(union.size).toBe(c.prefixAll.length);
    expect(c.denom.filter((t: string) => c.exemptPresent.includes(t))).toEqual([]);
    expect(c.problems).toEqual([]);
    // 本轮之前隐身的那件、以及这把尺自己，都得在"无人跑"里被点名
    const dead = A.rows.filter((r: any) => r.plane === 'none').map((r: any) => r.target);
    expect(dead).toContain('chain-baseline-ledger-gap');
    expect(dead).toContain('chain-baseline-instrument-surface');
  });

  it('SRFCS-01 判据形状：豁免掏空/两头挂/归错表/入口失效/桶不闭合都开火，合规侧与全豁免侧沉默', () => {
    const NONE: Record<string, string> = {};
    // ① 把一把真尺子（help 带度量词）塞进豁免表 ⇒ 必须判"豁免吞量具"
    const eat = surface.classify(['chain-baseline-consistency', 'chain-baseline-up'],
      H({ 'chain-baseline-consistency': '一致性自检：四处对账 ＋ 判据自测', 'chain-baseline-up': '建/复用一次性 PostgreSQL' }),
      S(['chain-baseline-consistency', 'chain-baseline-up']), { 'chain-baseline-consistency': '误豁免' }, NONE);
    expect(eat.problems.some((p: string) => p.startsWith('豁免吞量具'))).toBe(true);
    // ② 生命周期 help（无度量词）被豁免 ⇒ 不得开火（假阳性面为零）
    const clean = surface.classify(['chain-baseline-verify'],
      H({ 'chain-baseline-verify': '一键重放链级基线：7 场景 ＋ 边界用例' }),
      S(['chain-baseline-verify']), { 'chain-baseline-verify': '重放执行体' }, NONE);
    expect(clean.problems).toEqual([]);
    // ③ 两张表互相矛盾 ⇒ 两头挂；EXTRA 里塞带前缀的名字 ⇒ 归错表；EXTRA 指向不存在的目标 ⇒ 已失效
    expect(surface.classify(['chain-baseline-a'], H({ 'chain-baseline-a': '量具 A' }), S(['chain-baseline-a', 'zz']),
      { zz: '说是生命周期' }, { zz: '又当入口' }).problems.some((p: string) => p.startsWith('两头挂'))).toBe(true);
    expect(surface.classify(['chain-baseline-a'], H({ 'chain-baseline-a': '量具 A' }), S(['chain-baseline-a', 'chain-baseline-b']),
      NONE, { 'chain-baseline-b': '放错表' }).problems.some((p: string) => p.startsWith('归错表'))).toBe(true);
    expect(surface.classify(['chain-baseline-a'], H({ 'chain-baseline-a': '量具 A' }), S(['chain-baseline-a']),
      NONE, { gone: '已改名' }).problems.some((p: string) => p.startsWith('前缀外入口已失效'))).toBe(true);
    // ④ 新增前缀目标不必改任何表就自动进分母（隐身在这里翻面）
    const before = surface.classify(['chain-baseline-a'], H({ 'chain-baseline-a': '量具 A' }), S(['chain-baseline-a']), NONE, NONE);
    const after = surface.classify(['chain-baseline-a', 'chain-baseline-new'],
      H({ 'chain-baseline-a': '量具 A', 'chain-baseline-new': '新量具：判据自测' }), S(['chain-baseline-a', 'chain-baseline-new']), NONE, NONE);
    expect(before.denom.length).toBe(1);
    expect(after.denom).toContain('chain-baseline-new');
    // ⑤ 桶闭合：加和不等于分母、或分母里有重名，都必须报错
    expect(surface.bucketCheck([{ target: 'a', plane: 'workflow' }, { target: 'b', plane: 'none' }], 2)).toEqual([]);
    expect(surface.bucketCheck([{ target: 'a', plane: 'workflow' }], 2).length).toBe(1);
    expect(surface.bucketCheck([{ target: 'a', plane: 'workflow' }, { target: 'a', plane: 'none' }], 2).length).toBe(1);
  });

  it('SRFCS-01 不可判：Makefile 取不到时报不可判，不得折算成"零个量具、全部干净"', () => {
    const A = surface.analyze(path.join(REPO, 'zzz-no-such-dir'));
    expect(typeof A.unreadable).toBe('string');
    expect(A.rows).toBeUndefined();
    expect(fs.existsSync(path.join(REPO, 'Makefile'))).toBe(true);   // 反证：不是环境缺件导致的假不可判
  });
});
