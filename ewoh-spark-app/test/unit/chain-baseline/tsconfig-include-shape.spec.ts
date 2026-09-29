/**
 * tsconfig 的 `include` 是否真的纳得到文件（V344，TSCINC-01 的常驻位点）。
 *
 * 存在理由：`ewoh-spark-app/scripts/tsconfig.benchmark.json` 把三条 glob 按包根写、文件却住在
 * `scripts/` 下 ⇒ 作为 project 消费时输入集为空（`tsc -p` 报 TS18003），而它声明的 paths 反倒被
 * ts-node 照用——"这份档管哪些文件"这句话从来没有生效过，且没有任何机器读者看得见。
 * 本用例钉两件事：①真树上**不许再出现**整批落空的 tsconfig（有人改回去就红）；
 * ②那把判据本身有牙（合成的死形状必须被认出来，且指到文件的 glob 不得被误判）。
 */
import * as fs from 'fs';
import * as path from 'path';

const REPO = path.resolve(__dirname, '../../../..');
const sync = require(path.join(REPO, 'scripts/chain-baseline/alias-table-sync.cjs'));
const existsAny = (p: string) => { try { fs.statSync(p); return true; } catch { return false; } };
const dirOf = (rel: string) => path.dirname(path.join(REPO, rel));

const judgeReal = () => sync.judgeIncludes(
  sync.collectSurfaces(REPO, require(path.join(REPO, 'ewoh-spark-app/node_modules/typescript'))).surfaces,
  dirOf, existsAny);

describe('tsconfig include 落空机检（TSCINC-01）', () => {
  it('TSCINC-01 真树上不得有"include 整批相对自身目录落空"的 tsconfig', () => {
    const rows = judgeReal();
    const reds = rows.filter((r: any) => String(r.verdict).startsWith('红'));
    expect(reds.map((r: any) => `${r.rel}｜${r.why}`)).toEqual([]);
    // 分母自证：这条断言只数了 tsconfig 面，读到 0 个面时它自己就是空的、永真 ⇒ 必须挡住
    expect(rows.length).toBeGreaterThanOrEqual(6);
  });

  it('TSCINC-01 判据本身要开火：死形状必须判红，活形状与"指到文件的 glob"不得判红', () => {
    const os = require('os');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inshape-'));
    const w = (rel: string, txt: string) => {
      const p = path.join(root, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, txt);
    };
    try {
      w('app/server/keep.ts', 'export const k = 1;\n');
      w('app/sub/playwright.config.ts', 'export const pw = 1;\n');
      // 文件住在 app/sub/ 下，glob 却按 app/ 写 ⇒ 三条全落空（TSCINC-01 原形状）
      w('app/sub/tsconfig.dead.json', JSON.stringify({ include: ['scripts/**/*', 'server/**/*', 'shared/**/*'] }));
      w('app/sub/tsconfig.live.json', JSON.stringify({ include: ['**/*.ts', '../server/**/*.ts'] }));
      w('app/sub/tsconfig.file.json', JSON.stringify({ include: ['playwright.config.ts'] }));
      const one = (rel: string) => sync.judgeIncludes([sync.tsSurfaceFrom(root, rel)],
        (r: string) => path.dirname(path.join(root, r)), existsAny)[0];
      expect(one('app/sub/tsconfig.dead.json').verdict.startsWith('红')).toBe(true);
      expect(one('app/sub/tsconfig.live.json').verdict).toBe('已核对');
      // 存在性判据必须"文件也算"：把 include 写成一个个文件名是合规形状
      expect(one('app/sub/tsconfig.file.json').verdict).toBe('已核对');
      // 原子判据也要能单独用（常驻用例与量具判的是同一件事，不许两套实现）
      expect(sync.deadIncludeGlobs(path.join(root, 'app/sub'), ['server/**/*'], existsAny))
        .toEqual(['server/**/*']);
      expect(sync.deadIncludeGlobs(path.join(root, 'app/sub'), ['**/*.ts'], existsAny)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
