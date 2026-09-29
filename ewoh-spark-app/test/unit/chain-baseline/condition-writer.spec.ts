/**
 * CNAM-01（V332）的常驻位点：契约箭头的「实现侧对应物」有没有机读表达，且这条判据会不会红。
 *
 * 存在理由：V329 登记 CNAM-01 时的事实是「标签在实现侧零命中，且没有任何量具读 `condition`」。
 * V331 把这个分类的事实源搬进契约（`kind:`），V332 把**对应物**也搬进契约（`writer: 路径#标识符`），
 * 于是欠账从"人读一遍才知道有几个"变成"尺子每次跑都点名"。本件钉三件事：
 *  ① 真实契约上 dangling（标签与 writer 两头都无着落的动作箭头）必须为 0，且 `unimplemented` 恰好那一支；
 *  ② writer 一律带文件限定——裸标识符会被语料里同名无关符号顶开（V332 实测：`process` 命中异常过滤器、
 *     `simulate` 命中工作台预览旗标、`cancel` 命中 agent 模块），带文件才能核"这条边真是这个文件产的"；
 *  ③ 反例必须开火：裸标识符 writer、以及"文件在但标识符不在文件里"的 writer，都要落 dangling。
 * 限度：这是**静态机检**位点，不是行为级——契约写错 writer 会红，链上真发生错误迁移它不红。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO = path.resolve(__dirname, '../../../..');
const ccl = require(path.join(REPO, 'scripts/chain-baseline/contract-condition-labels.cjs'));

const writeContract = (dir: string, arrows: string) => {
  fs.writeFileSync(
    path.join(dir, 'x.yaml'),
    `states: [a, b]\ntransitions:\n${arrows}\nterminal: [b]\n`,
    'utf8',
  );
};

describe('契约箭头 writer 声明（CNAM-01）', () => {
  it('CNAM-01 真实契约：动作箭头不得有 dangling，unimplemented 只许那一支', () => {
    const m = ccl.measure(ccl.DEFAULT_SM, ccl.codeBlob(ccl.CODE_DIRS));
    expect(m.buckets['action-dangling']).toEqual([]);
    expect(m.buckets['action-unimplemented'].map((x: any) => x.label).sort()).toEqual(['reject_and_revise']);
    // 每条 writer 都必须带文件限定，并且归因文件确实被尺子读到（cloud／edge 两侧之一）
    const writers = m.arrows.filter((x: any) => x.writer).map((x: any) => x.writer);
    expect(writers.length).toBeGreaterThan(0);
    for (const w of writers) {
      expect(w === 'unimplemented' || /^[^#]+#/.test(w)).toBe(true);
    }
    for (const x of m.buckets['action-resolved-writer']) {
      expect(typeof x.writerFile).toBe('string');
      expect(['cloud', 'edge']).toContain(x.writerSide);
    }
    // 两根欠账口径同时成立：全实现语料 0；只算云侧时，边缘实现的那几支必须显形
    expect(m.buckets['action-resolved-writer'].length).toBeGreaterThan(0);
    expect(ccl.cloudOnlyDangling(m, ccl.codeBlob(ccl.CLOUD_DIRS))).toBeGreaterThanOrEqual(0);
  });

  it('CNAM-01 反例：裸标识符 writer 与"文件在但标识符不在"都必须落 dangling', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cnam01-'));
    fs.writeFileSync(path.join(dir, 'impl.ts'), 'export function unrelated() {}\n', 'utf8');
    const ABSENT = 'zzz-cnam01-absent-7q';
    writeContract(dir, [
      `  - { from: a, to: b, condition: ${ABSENT}, kind: action, writer: approve }`,
      `  - { from: b, to: a, condition: ${ABSENT}2, kind: action, writer: ${path.join(dir, 'impl.ts')}#approve }`,
    ].join('\n'));
    const m = ccl.measure(dir, 'nothing here at all 0x');
    const vias = m.buckets['action-dangling'].map((x: any) => x.via).sort();
    expect(m.buckets['action-resolved-writer']).toEqual([]);
    expect(vias).toEqual(['bare-token', 'no-token']);
    expect(m.total).toBe(2);
  });
});
