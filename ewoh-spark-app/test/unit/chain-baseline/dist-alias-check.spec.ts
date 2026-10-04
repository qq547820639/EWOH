/**
 * 服务端产物裸别名检查的常驻位点（V356，ARUN-01）。
 *
 * 存在理由：V353 修的是「陈旧 dist 冒充已重建」——`nest-cli.json deleteOutDir:false` 加 tsc 增量
 * tsbuildinfo 让"每次重建"不保证重新 emit，旧形状的裸 `require("@server/…")` 能活到运行时，
 * 把 C 段后端打成 MODULE_NOT_FOUND。当时那道自检只是 `verify.sh` 里的一行 grep，
 * **jest 覆盖不到 ⇒ 修法没有常驻位点**（登记行里我自己把这一条留成两问之一）。
 * 本轮把判据搬进 `scripts/chain-baseline/dist-alias-check.cjs`，这里 require 它并按四档断言；
 * 尺子自己的 `--self-test` 不算位点（那是合成夹具，看不见 verify.sh 有没有真调用它）。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO = path.resolve(__dirname, '../../../..');
const check = require(path.join(REPO, 'scripts/chain-baseline/dist-alias-check.cjs')).check;

const mk = (rel: string, body: string, root: string) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
};

describe('服务端产物裸别名检查（ARUN-01）', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'arun01-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('ARUN-01 开火：产物里残留裸 @server 别名必须判 dirty、点名该文件并报出扫描分母', () => {
    const dir = path.join(root, 'dist', 'server');
    mk('dist/server/stale.js', 'const s = require("@server/database/schema");\nmodule.exports = s;\n', root);
    mk('dist/server/fine.js', 'const s = require("../../shared/database/schema");\nmodule.exports = s;\n', root);
    const r = check(dir);
    expect(r.verdict).toBe('dirty');
    expect(r.files).toEqual(['stale.js']);
    // 分母自报：判"0 个残留"时得说清扫了几个文件，否则空目录也会报"干净"
    expect(r.scanned).toBe(2);
  });

  it('ARUN-01 假阳性面：相对路径、真包名、以及注释里的 @server 提及都不得开火', () => {
    const dir = path.join(root, 'dist', 'server');
    mk('dist/server/a.js', 'const u = require("node:util");\nmodule.exports = u;\n', root);
    mk('dist/server/b.js', 'const n = require("@nestjs/core");\nmodule.exports = n;\n', root);
    // V356 实测：搬进量具前那行 grep 会把下面这种注释也数进"残留"，是假阳性
    mk(
      'dist/server/c.js',
      '// 旧产物里曾写 require("@server/x")，现已改为相对路径\n/* from "@server/y" 同样是历史说明 */\nmodule.exports = 1;\n',
      root,
    );
    const r = check(dir);
    expect(r.verdict).toBe('clean');
    expect(r.files).toEqual([]);
    expect(r.scanned).toBe(3);
  });

  it('ARUN-01 三态：dist 目录读不到必须判不可判（absent），既不红也不折成"干净"', () => {
    const r = check(path.join(root, 'nope'));
    expect(r.verdict).toBe('absent');
    expect(r.scanned).toBe(0);
    expect(r.files).toEqual([]);
  });

  it('ARUN-01 反向对照：把植入的那行删掉必须回到 clean（证明开火由那一行引起）', () => {
    const dir = path.join(root, 'dist', 'server');
    const p = mk('dist/server/stale.js', 'module.exports = require("@server/x");\n', root);
    expect(check(dir).verdict).toBe('dirty');
    fs.writeFileSync(p, 'module.exports = require("./sibling.js");\n');
    const r = check(dir);
    expect(r.verdict).toBe('clean');
    expect(r.scanned).toBe(1);
  });

  it('ARUN-01 接线：一键重放的 rebuild 档必须真调用这件（否则它只是无人跑的孤儿判据）', () => {
    const sh = fs.readFileSync(path.join(REPO, 'scripts/chain-baseline/verify.sh'), 'utf8');
    // 认的是**调用点**而不是提法：注释里出现文件名不算接线
    const at = sh.indexOf('node "$HERE/dist-alias-check.cjs"');
    expect(at).toBeGreaterThan(-1);
    // 且必须挂在"每次重建"那一档（前面紧贴 EWOH_SKIP_BUILD != 1 的门），不是复用档
    expect(sh.slice(Math.max(0, at - 260), at)).toContain('EWOH_SKIP_BUILD:-0}" != "1"');
    // Makefile 里也得有复算入口，否则人手没法单跑
    const makefile = fs.readFileSync(path.join(REPO, 'Makefile'), 'utf8');
    expect(makefile).toContain('chain-baseline-dist-alias:');
  });
});
