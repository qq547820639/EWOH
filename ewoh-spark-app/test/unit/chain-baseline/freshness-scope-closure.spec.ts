/**
 * COV-01 的常驻位点：重放新鲜度覆盖集里那个 `spec-dep` 桶（沿 import 闭包收"重放真正载入的文件"）。
 *
 * 存在理由：V320 量出覆盖集只按目录桶＋CHAIN_SPECS 名单收，`test/helpers/` 里被常驻 spec import 的共用件
 * 一个都不在集内 ⇒ 改坏它，stamp 照样判「逐一相同」。V321 补了这个桶，但**量具自己的 --self-test 不算位点**
 * （fix-sites 的 V116 判据），所以从测试面把桶的形状钉住：谁把闭包退回"按目录收"或整条删掉，这里就红。
 *
 * 两支都是**差分**（同一棵合成树上跑两次 collectScope，比桶的差集），不读真仓库的树 ⇒
 * 不把用例绑在别人的工作树状态上（先例：recorder-preflight.spec.ts 头部那条教训）。
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO = path.resolve(__dirname, '../../../..');
const SCRIPT = 'scripts/chain-baseline/replay-freshness.cjs';

type Scope = {
  error?: string;
  files: { rel: string; bucket: string }[];
  specDeps: { rel: string; bucket: string; pulledBy: string }[];
  depsCoveredElsewhere: number;
  unresolved: unknown[];
};

/** 用真尺子（同一份码，喂一棵合成树）取覆盖集，避免在测试里重抄解析规则。 */
function scopeOf(dir: string): Scope {
  const out = execFileSync('node', [
    '-e',
    `const {collectScope}=require(${JSON.stringify(path.join(REPO, SCRIPT))});`
    + `const s=collectScope(${JSON.stringify(dir)});console.log(JSON.stringify({`
    + 'files:s.files,specDeps:s.specDeps||[],depsCoveredElsewhere:s.depsCoveredElsewhere||0,'
    + 'unresolved:s.unresolved||[],error:s.error||null}))',
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(out.trim()) as Scope;
}

function fixture(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ewoh-cov01-${name}-`));
  const w = (rel: string, text: string) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  };
  w('scripts/chain-baseline/verify.sh',
    'SCENARIOS=""\n[ -n "${SCENARIOS// /}" ] || SCENARIOS="golden wave control-actuator receipt edge"\n'
    // 名单不少于 5 个是尺子自己的前提（少于 5 它判"判据不完整"，不给分母）——夹具得满足前提而不是绕判据
    + 'CHAIN_SPECS="alpha-beta \\\ngamma-delta epsilon-zeta eta-theta iota-kappa"\n');
  w('ewoh-spark-app/package.json', JSON.stringify({
    scripts: {
      'e2e:golden': 'node test/e2e/golden-path-verify.mjs', 'e2e:wave': 'node test/e2e/wave.mjs',
      'e2e:control-actuator': 'node test/e2e/loop.mjs', 'e2e:receipt': 'node test/e2e/rc.mjs',
      'e2e:edge': 'node test/e2e/edge.mjs',
    },
  }));
  w('ewoh-spark-app/test/e2e/alpha-beta.e2e.spec.ts',
    "import { h } from '../helpers/pulled';\nit('a', () => expect(h).toBe(1));\n");
  w('ewoh-spark-app/test/e2e/gamma-delta.e2e.spec.ts', "it('g', () => {});\n");
  w('ewoh-spark-app/test/e2e/epsilon-zeta.e2e.spec.ts', "it('e', () => {});\n");
  w('ewoh-spark-app/test/e2e/eta-theta.e2e.spec.ts', "it('t', () => {});\n");
  w('ewoh-spark-app/test/e2e/iota-kappa.e2e.spec.ts', "it('i', () => {});\n");
  w('ewoh-spark-app/test/helpers/pulled.ts', "export const h = 1;\nexport * from './pulled-deep';\n");
  w('ewoh-spark-app/test/helpers/pulled-deep.ts', 'export const d = 2;\n');
  w('ewoh-spark-app/test/helpers/only-unit.ts', 'export const u = 3;\n');
  w('ewoh-spark-app/server/main.ts', 'export const x = 1;\n');
  w('ewoh-spark-app/test/e2e/golden-path-verify.mjs', 'console.log(1);\n');
  w('ewoh-spark-app/test/e2e/wave.mjs', 'console.log(2);\n');
  w('ewoh-spark-app/test/e2e/loop.mjs', 'console.log(3);\n');
  w('ewoh-spark-app/test/e2e/rc.mjs', 'console.log(4);\n');
  w('ewoh-spark-app/test/e2e/edge.mjs', 'console.log(5);\n');
  w('Makefile', 'chain-baseline-verify:\n\tbash x\n');
  return root;
}

describe('重放覆盖集的 spec-dep 桶（COV-01）', () => {
  it('COV-01 被常驻 spec 沿 import 可达的 test/helpers 文件必须进覆盖集（两跳也算）', () => {
    const s = scopeOf(fixture('pulled'));
    expect(s.error).toBeFalsy();
    const inScope = new Set(s.files.map((f) => f.rel));
    expect(inScope.has('ewoh-spark-app/test/helpers/pulled.ts')).toBe(true);
    expect(inScope.has('ewoh-spark-app/test/helpers/pulled-deep.ts')).toBe(true);
    // 桶里还记着是谁把它拉进来的（归属可查，不是一句"大概相关"）
    const rec = s.specDeps.find((d) => d.rel.endsWith('pulled.ts'));
    expect(rec?.pulledBy).toBe('ewoh-spark-app/test/e2e/alpha-beta.e2e.spec.ts');
  });

  it('COV-01 反向：同目录里没人 import 的文件不得进覆盖集（"按目录补"那一档必须被拒）', () => {
    const withImport = scopeOf(fixture('with'));
    expect(withImport.files.some((f) => f.rel.endsWith('only-unit.ts'))).toBe(false);
    // 把那条 import 去掉，桶里连被 import 的那两个都不该出现——证明分母真由 import 决定
    const dir = fixture('without');
    fs.writeFileSync(path.join(dir, 'ewoh-spark-app/test/e2e/alpha-beta.e2e.spec.ts'), "it('a', () => {});\n");
    const bare = scopeOf(dir);
    expect(bare.specDeps.length).toBe(0);
    expect(bare.files.length).toBe(withImport.files.length - 2);
  });
});
