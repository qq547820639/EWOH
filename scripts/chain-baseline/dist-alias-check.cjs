#!/usr/bin/env node
/* 服务端产物里的「裸路径别名」检查器（V356 建，从 verify.sh 的 bash 判据搬进来）。
 * 为什么要有这一件：`nest-cli.json deleteOutDir:false` 加上 tsc 的增量 tsbuildinfo，会让
 * 「重建」不保证重新 emit ⇒ 更早某次构建留下的旧形状（裸 `require("@server/...")`）能一路活到
 * 运行时，把 C 段后端打成 MODULE_NOT_FOUND。V353 的修法是在 rebuild 前整份删 dist，
 * 但那道自检当时只是 verify.sh 里的一行 grep——jest 覆盖不到 ⇒ 本轮把它搬成可 require 的件。
 *
 * 判据：扫描 <dir> 下 **.js**，找 `require("@(server|shared|client)/...")` 或 `from "@…"` 的裸别名；
 * 命中即非零退出并点名文件。三态：目录读不到 ⇒ 不可判（退 3，不折成"干净"）。 */
'use strict';

const fs = require('fs');
const path = require('path');

const BARE_RE = /(?:require\(\s*|from\s+)['"]@(?:server|shared|client)\/[^'"]*['"]/g;

function* walk(dir) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && p.endsWith('.js')) yield p;
  }
}

/** 只留代码行：整行注释与块注释去掉。V356 实测——产物里留着许可头/示例注释时，
 *  文本面出现 `require("@server/x")` 也会被原判据（一行 grep）当成残留，那是假阳性。
 *  限度：只处理**整行**注释与 `/* *\/` 块；行尾注释不剥，含 `//` 的字符串不受影响。 */
function codeOnly(txt) {
  return txt
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//'))
    .join('\n');
}

/** 返回 { verdict, files, scanned, dir } —— verdict ∈ absent | clean | dirty */
function check(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return { verdict: 'absent', files: [], scanned: 0, dir };
  }
  const files = [];
  let scanned = 0;
  for (const f of walk(dir)) {
    scanned += 1;
    let txt;
    try {
      txt = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    if (BARE_RE.test(codeOnly(txt))) {
      BARE_RE.lastIndex = 0;
      files.push(path.relative(dir, f));
    }
    BARE_RE.lastIndex = 0;
  }
  return { verdict: files.length ? 'dirty' : 'clean', files, scanned, dir };
}

// ---------------------------------------------------------------- 判据自测
function selfTest() {
  const os = require('os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-alias-'));
  const mk = (rel, body) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
    return p;
  };
  const cases = [];
  const add = (name, fn) => cases.push([name, fn]);

  // ① 正极：一个裸 require 必须开火并点名该文件
  const dirtyDir = path.join(root, 'dirty', 'server');
  mk('dirty/server/a.js', 'const s = require("@server/database/schema");\nmodule.exports = s;\n');
  mk('dirty/server/b.js', 'const ok = require("./sibling");\nmodule.exports = ok;\n');
  add('开火：有裸别名必须判 dirty 并点名该文件', () => {
    const r = check(dirtyDir);
    if (r.verdict !== 'dirty') throw new Error('verdict=' + r.verdict);
    if (r.files.length !== 1 || r.files[0] !== 'a.js') throw new Error('files=' + JSON.stringify(r.files));
    if (r.scanned !== 2) throw new Error('scanned=' + r.scanned + '（分母自报要=2）');
  });

  // ② 假阳性面 A：正确重写成相对路径的产物不得开火
  const cleanDir = path.join(root, 'clean', 'server');
  mk('clean/server/a.js', 'const s = require("../../shared/database/schema");\nmodule.exports = s;\n');
  mk('clean/server/b.js', 'const u = require("node:util");\nmodule.exports = u;\n');
  add('假阳性面：相对路径与包名导入不得开火', () => {
    const r = check(cleanDir);
    if (r.verdict !== 'clean') throw new Error('verdict=' + r.verdict + ' files=' + JSON.stringify(r.files));
  });

  // ③ 假阳性面 B：注释/字符串里提到 `@server/...` 但不是 require/from 形态，不得开火
  const docDir = path.join(root, 'doc', 'server');
  mk('doc/server/c.js', '// 这里以前写的是 require("@server/x")，现在已改成相对路径\nmodule.exports = 1;\n');
  mk('doc/server/d.js', 'module.exports = "from \\"@server/y\\" 已废弃";\n');
  add('假阳性面：文本面提及（非 require/from 形态）不得开火', () => {
    const r = check(docDir);
    if (r.verdict !== 'clean') throw new Error('verdict=' + r.verdict + ' files=' + JSON.stringify(r.files));
  });

  // ④ 三态：目录不存在必须是 absent（不可判），既不红也不折成"干净"
  add('三态：目录读不到判 absent，不是 clean', () => {
    const r = check(path.join(root, 'nope'));
    if (r.verdict !== 'absent') throw new Error('verdict=' + r.verdict);
    if (r.scanned !== 0) throw new Error('scanned=' + r.scanned);
  });

  // ⑤ 反向对照：把①的植入行删掉，必须从 dirty 回到 clean（证明开火由那一行引起）
  add('反向对照：删掉植入行后必须回到 clean', () => {
    fs.writeFileSync(path.join(dirtyDir, 'a.js'), 'module.exports = require("./b.js");\n');
    const r = check(dirtyDir);
    if (r.verdict !== 'clean') throw new Error('verdict=' + r.verdict + ' files=' + JSON.stringify(r.files));
  });

  let red = 0;
  for (const [name, fn] of cases) {
    try {
      fn();
      console.log('  ✔ ' + name);
    } catch (e) {
      red += 1;
      console.log('  ✗ ' + name + ' —— ' + e.message);
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`dist-alias-check 判据自测 ${cases.length - red}/${cases.length} 通过（条数由本脚本自报）`);
  return red ? 1 : 0;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) process.exit(selfTest());
  const dir = argv.find((a) => !a.startsWith('--'));
  if (!dir) {
    console.error('用法：node dist-alias-check.cjs [--self-test] <dist/server 目录>');
    process.exit(2);
  }
  const r = check(path.resolve(dir));
  if (r.verdict === 'absent') {
    console.log(`裸别名检查不可判：读不到目录 ${r.dir}（不折成"干净"）`);
    process.exit(3);
  }
  if (r.verdict === 'clean') {
    console.log(`裸别名检查通过：${r.scanned} 个 .js 文件里 0 个残留 @server/@shared/@client 裸路径`);
    process.exit(0);
  }
  console.log(`裸别名检查 FAIL：${r.scanned} 个 .js 里 ${r.files.length} 个仍写裸别名 ⇒ 这遍测的不是当前树能跑的形状`);
  for (const f of r.files) console.log('  - ' + f);
  process.exit(1);
}

if (require.main === module) main();
module.exports = { check };
