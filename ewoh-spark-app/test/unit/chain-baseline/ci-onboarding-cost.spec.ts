/**
 * 接线代价量具的清单来源（CCOST-01 的常驻位点，V348）。
 *
 * 存在理由：V347 把量具执行面的分母从手写名单翻成 Makefile 现抽，那张 `INSTRUMENTS` 表整张删掉，
 * 而 `chain-baseline-ci-cost` 还在用正则抓它 ⇒ 当场「解析不到 INSTRUMENTS」拒出数（实测 rc=2）。
 * 拒得响亮是对的，但**改一份真值的形状时没人数列过它的消费者**——这件量具既不在 CI、也不在收尾主线里，
 * 于是断了一轮才被发现。本用例钉两件事：名单必须与执行面尺的分母同源；旧形状再出现必须出不了数。
 */
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const REPO = path.resolve(__dirname, '../../../..');
const cost = require(path.join(REPO, 'scripts/chain-baseline/ci-onboarding-cost.cjs'));
const surfacePath = path.join(REPO, 'scripts/chain-baseline/instrument-surface.cjs');

describe('接线代价量具的清单来源机检（CCOST-01）', () => {
  it('CCOST-01 真树上代价量具的名单必须与执行面尺的分母逐字相同，且两件新量具都在', () => {
    const names = cost.instrumentList();
    const denom = require(surfacePath).analyze(REPO).rows.map((r) => r.target);
    expect(names).toEqual(denom);
    // 分母自证：名单塌成空表时上面两句会同时"成立"，所以先钉量级
    expect(names.length).toBeGreaterThanOrEqual(50);
    expect(names).toContain('chain-baseline-instrument-surface');
    expect(names).toContain('chain-baseline-ledger-gap');
  });

  it('CCOST-01 旧形状（只剩 INSTRUMENTS 数组、无 analyze）必须出不了数，小分母与指空路径也一样', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccost-spec-'));
    try {
      const oldShape = path.join(tmp, 'old-shape.cjs');
      const many = Array.from({ length: 11 }, (_, i) => `'t${i}'`).join(',');
      fs.writeFileSync(oldShape, `const INSTRUMENTS = [${many}];\nmodule.exports = { INSTRUMENTS };\n`);
      expect(() => cost.instrumentList(oldShape)).toThrow(/没有导出 analyze/);
      const tiny = path.join(tmp, 'tiny-shape.cjs');
      fs.writeFileSync(tiny, "module.exports = { analyze: () => ({ rows: [{target:'a'},{target:'b'},{target:'c'}] }) };\n");
      expect(() => cost.instrumentList(tiny)).toThrow(/分母不成立/);
      expect(() => cost.instrumentList(path.join(tmp, 'not-here.cjs'))).toThrow(/读不到执行面尺/);
      // 合规侧必须不抛（否则上面三条是永真的拒）
      expect(() => cost.instrumentList(surfacePath, REPO)).not.toThrow();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
