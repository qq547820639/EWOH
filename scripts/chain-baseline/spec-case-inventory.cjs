#!/usr/bin/env node
/**
 * 链级 spec 的「用例存量」对账 + 断言强度普查（V110 常驻入口）。
 *
 * 要回答的是目标里那句"测试是否真正覆盖了这些边界"，分两层：
 *  ① 存量对账（判决）：静态写下的用例数 ↔ 运行日志里真正注册并跑到的用例数。
 *     这里有一个 jest 的天然盲区：`describe.skip(…)` 块里的 `it(` **不进** `Tests:` 汇总行，
 *     所以 `assert_no_skips`（读汇总行的判据）对它完全失明——一条被永久跳过的用例既不会红，
 *     也不会出现在 skipped 计数里。本轮实测到 20 个链级 spec 共 64 个静态 `it(`，
 *     运行时 63 条，差的 1 条正是 `scheduling-plan-dispatch-tenant-cas` 里
 *     `if (!e2eConfig) describe.skip(…)` 的占位用例（配置在场时不注册 ⇒ 合法）。
 *     本脚色就是把这个"合法/不合法"的判定固化成可重跑入口，而不是每次靠人再读一遍文件。
 *  ② 断言强度普查（只报形状，不下结论）：断言总数、只打 HTTP 状态码的、打到库内事实的、
 *     含前提断言的、含反向对照的、做故障注入的。判据形状能骗人——同一条 `toBe(status)`
 *     在故障注入用例里恰恰是关键断言——所以这一层**不参与退出码**。
 *
 * 退出码：0 对账一致；1 存在偏差（缺失/不可判的静默 skip/数量对不上）；3 输入不可判
 *        （CHAIN_SPECS 解析失败、日志缺失、日志自身汇总行与逐条标记不一致 ⇒ 先修仪器再谈结论）。
 * 用法：node scripts/chain-baseline/spec-case-inventory.cjs [--census] [--self-test] [--json]
 *      测试夹具用 --verify/--specs/--logs 覆盖（--self-test 全靠它们，绝不碰真实产物）。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.cwd();
const ANSI = /\x1b\[[0-9;]*m/g;

function argv(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const FLAGS = new Set(process.argv.slice(2));

// ── 输入解析 ────────────────────────────────────────────────────────────────
function chainSpecs(verifyPath) {
  const txt = fs.readFileSync(verifyPath, 'utf8');
  const hits = [...txt.matchAll(/CHAIN_SPECS="([\s\S]*?)"/g)];
  if (hits.length === 0) throw new Error(`${verifyPath} 里没有 CHAIN_SPECS`);
  // 取最长的一份：`CHAIN_SPECS=""` 的初始化行会先被短匹配命中（matrix-check 同规）
  const best = hits.map((m) => m[1]).sort((a, b) => b.length - a.length)[0];
  const list = best.replace(/\\\s*\n/g, ' ').split(/\s+/).filter(Boolean);
  if (list.length < 5) throw new Error(`CHAIN_SPECS 只解析出 ${list.length} 个名字，疑似截断`);
  return list;
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

/** 找出所有 skip 块 / skip 用例，并按"是否被 if 守卫"分类。 */
function skipStructure(src) {
  const lines = stripComments(src).split('\n');
  const blocks = []; // {kind, conditional, from, to}
  for (let i = 0; i < lines.length; i += 1) {
    const L = lines[i];
    const m = L.match(/\bdescribe\.(skip|todo)\s*\(/);
    if (!m) continue;
    const ind = indentOf(L);
    let conditional = false;
    for (let j = i - 1; j >= Math.max(0, i - 12); j -= 1) {
      const P = lines[j];
      if (!P.trim()) continue;
      if (indentOf(P) <= ind && /^\s*(\}\s*)?if\s*\(/.test(P)) { conditional = true; break; }
      if (indentOf(P) < ind && !/^\s*[})\]]/.test(P)) break;
    }
    // 块尾：找同一缩进的收尾 `});`
    let to = i;
    let depth = 0;
    for (let k = i; k < lines.length; k += 1) {
      depth += (lines[k].match(/\{/g) || []).length - (lines[k].match(/\}/g) || []).length;
      if (depth <= 0 && k > i) { to = k; break; }
      to = k;
    }
    blocks.push({ kind: 'describe.skip', conditional, from: i, to });
  }
  const loud = [...stripComments(src).matchAll(/\b(it|test)\.(skip|todo)\b/g)].length;
  return { blocks, loud, lines: stripComments(src).split('\n') };
}

function countCases(src) {
  const clean = stripComments(src);
  const total = [...clean.matchAll(/^\s*(?:it|test)\s*\(\s*['"`]/gm)].length;
  const each = [...clean.matchAll(/^\s*(?:it|test)\.each\s*\(/gm)].length;
  return { total, each };
}

/** 静态用例里"被 describe.skip 块遮住"的条数（jest 不注册 ⇒ 汇总行看不见）。 */
function silentCases(fileLines, blocks) {
  const hidden = new Set();
  blocks.forEach((b) => {
    for (let i = b.from; i <= b.to; i += 1) hidden.add(i);
  });
  let n = 0;
  fileLines.forEach((L, i) => {
    if (/^\s*(?:it|test)\s*\(\s*['"`]/.test(L) && hidden.has(i)) n += 1;
  });
  return n;
}

// ── 运行日志解析 ────────────────────────────────────────────────────────────
function parseLog(logPath) {
  const raw = fs.readFileSync(logPath, 'utf8').replace(ANSI, '');
  const lines = raw.split('\n');
  const per = {};
  let cur = null;
  let loud = 0;
  const marks = { pass: 0, fail: 0, skip: 0, todo: 0 };
  for (const L of lines) {
    const h = L.match(/^(?:PASS|FAIL)\s+\S*?([a-z0-9][a-z0-9-]*)\.e2e\.spec\.ts/);
    if (h) {
      // 同一套件在日志里会出现**两次**：跑动时一次、末尾失败汇总里再一次（V112 实测：
      // `ewoh-http` 因此被清零，报成"实到 0 条 ⇒ 这一格没有位点"的假缺陷）。
      // ⇒ 只登记键，绝不重置已数到的标记。
      cur = h[1];
      if (!(cur in per)) per[cur] = 0;
      continue;
    }
    const t = L.match(/^\s*(✓|✕|○|✎)\s+\S/);
    if (!t || cur === null) continue;
    if (t[1] === '✓') { marks.pass += 1; per[cur] += 1; }
    else if (t[1] === '✕') { marks.fail += 1; per[cur] += 1; }
    else if (t[1] === '○') { marks.skip += 1; loud += 1; }
    else { marks.todo += 1; loud += 1; }
  }
  const sumLine = lines.filter((l) => l.startsWith('Tests:')).pop() || '';
  const num = (word) => {
    const m = sumLine.match(new RegExp(`(\\d+)\\s+${word}`));
    return m ? Number(m[1]) : undefined;
  };
  return {
    file: path.basename(logPath),
    per,
    suites: Object.keys(per).length,
    marks,
    loud,
    summary: sumLine.trim(),
    total: num('total'),
    passed: num('passed'),
    skipped: num('skipped') || 0,
    todo: num('todo') || 0,
  };
}

// ── 主判据 ──────────────────────────────────────────────────────────────────
function reconcile(opts) {
  const problems = [];
  const notes = [];
  let specs;
  if (opts.all) {
    // V112：CI 的判定面是 jest testMatch（目录全量），不是试点的 CHAIN_SPECS。
    // 对账要能对着那张清单做，否则"CI 在跑却没人核"的差集永远算不出来。
    if (!fs.existsSync(opts.specs)) return { rc: 3, problems: [`不可判：目录不存在 ${opts.specs}`], notes: [], rows: [] };
    specs = fs.readdirSync(opts.specs).filter((f) => f.endsWith('.e2e.spec.ts'))
      .map((f) => f.replace(/\.e2e\.spec\.ts$/, ''));
    if (specs.length < 5) return { rc: 3, problems: [`不可判：目录里只有 ${specs.length} 个 spec，疑似读错目录`], notes: [], rows: [] };
    notes.push(`清单来源=目录全量（--specs-all）：${specs.length} 个 spec —— 与 CI 的 jest testMatch 同口径`);
  } else {
    try {
      specs = chainSpecs(opts.verify);
    } catch (e) {
      return { rc: 3, problems: [`CHAIN_SPECS 不可判：${e.message}`], notes: [], rows: [] };
    }
  }
  const logs = opts.logs.map(parseLog);
  for (const lg of logs) {
    const seen = lg.marks.pass + lg.marks.fail + lg.marks.skip + lg.marks.todo;
    if (!lg.summary || lg.total === undefined) {
      return { rc: 3, problems: [`${lg.file}: 没有可解析的 Tests: 汇总行（先修仪器）`], notes: [], rows: [] };
    }
    if (seen !== lg.total) {
      return {
        rc: 3,
        problems: [`${lg.file}: 逐条标记合计 ${seen} ≠ 汇总行 total ${lg.total} ⇒ 日志不完整或解析失效，不作判决`],
        notes: [],
        rows: [],
      };
    }
    if (lg.suites !== specs.length) {
      problems.push(`${lg.file}: 日志内套件 ${lg.suites} 个 ≠ CHAIN_SPECS ${specs.length} 个（有 spec 没跑到或反之）`);
    }
  }

  const rows = [];
  for (const name of specs) {
    const file = path.join(opts.specs, `${name}.e2e.spec.ts`);
    if (!fs.existsSync(file)) {
      problems.push(`${name}: 清单里有、磁盘上没有（spec 文件缺失 ⇒ 这一格等于没有位点）`);
      continue;
    }
    const src = fs.readFileSync(file, 'utf8');
    const { total, each } = countCases(src);
    const st = skipStructure(src);
    const silent = silentCases(st.lines, st.blocks);
    const unconditional = st.blocks.filter((b) => !b.conditional);
    const runtime = logs.map((lg) => (name in lg.per ? lg.per[name] : undefined));
    rows.push({ name, static: total, each, silent, loudSkip: st.loud, blocks: st.blocks.length, runtime });

    if (each > 0) problems.push(`${name}: 含 it.each(${each}) ⇒ 静态数不等于运行时数，本判据不可对它下结论`);
    for (const b of unconditional) {
      problems.push(`${name}:${b.from + 1} describe.skip 没有被 if 守卫 ⇒ 永久跳过，jest 汇总行不会报 skipped（判据看不见）`);
    }
    if (st.blocks.length !== unconditional.length) {
      notes.push(`${name}: ${st.blocks.length - unconditional.length} 处条件式 skip 占位（配置在场时不注册，合法）`);
    }
    logs.forEach((lg) => {
      const r = lg.per[name];
      if (r === undefined) { problems.push(`${name}: ${lg.file} 里没有这条套件的用例标记`); return; }
      if (total - silent !== r) {
        problems.push(`${name}: 静态可注册 ${total - silent}（共 ${total}，静默遮住 ${silent}）≠ ${lg.file} 实到 ${r}`);
      }
      if (r === 0) problems.push(`${name}: ${lg.file} 实到 0 条 ⇒ 这一格没有位点`);
    });
  }

  // 两份日志（D 与 D2）跑的是同一份清单 ⇒ 逐套件计数必须一致
  if (logs.length === 2 && !opts.all) {
    for (const name of specs) {
      if (logs[0].per[name] !== undefined && logs[0].per[name] !== logs[1].per[name]) {
        problems.push(`${name}: D 段 ${logs[0].per[name]} 条 vs D2 段 ${logs[1].per[name]} 条（同一清单同一环境，不该不等）`);
      }
    }
  }
  return { rc: problems.length ? 1 : 0, problems, notes, rows, logs, specs };
}

// ── 普查（只报形状） ────────────────────────────────────────────────────────
function census(opts) {
  const specs = chainSpecs(opts.verify);
  const rows = specs.map((name) => {
    const file = path.join(opts.specs, `${name}.e2e.spec.ts`);
    if (!fs.existsSync(file)) return { name, missing: true };
    const src = fs.readFileSync(file, 'utf8');
    const n = (re) => [...src.matchAll(re)].length;
    const expects = n(/\bexpect\(/g);
    const statusOnly = n(/\bexpect\([^)]*\.status\)/g);
    const dbFacts = n(/\bexpect\([\s\S]{0,120}?(?:owner`|select |\.from\(|query)/g)
      + n(/\bconst\s+\w+\s*=\s*await owner`[\s\S]{0,400}?expect\(/g);
    return {
      name,
      expects, statusOnly, dbFacts,
      premise: n(/前提|premise|否则.*空断言|vacuous/gi),
      control: n(/反向控制|对照|control case|power|reverse control/gi),
      fault: n(/RAISE EXCEPTION|CREATE TRIGGER|pg_sleep|DROP TRIGGER/g),
      weak: expects > 0 && statusOnly / expects > 0.5 && dbFacts === 0,
    };
  }).filter((r) => !r.missing);
  const tot = (k) => rows.reduce((a, r) => a + r[k], 0);
  console.log(`· 断言 ${tot('expects')}｜只打 HTTP 状态码 ${tot('statusOnly')}｜打到库内事实 ${tot('dbFacts')}`);
  console.log(`· 含"前提"字样 ${rows.filter((r) => r.premise).length} 个文件｜含"反向控制/对照" ${rows.filter((r) => r.control).length} 个｜做故障注入 ${rows.filter((r) => r.fault).length} 个`);
  const weak = rows.filter((r) => r.weak);
  console.log(`· 弱嫌疑（状态码占比 >50% 且库内断言 0）${weak.length} 个：${weak.map((r) => `${r.name}(${r.statusOnly}/${r.expects})`).join(', ') || '—'}`);
  console.log('  （只报形状，不参与退出码：同一条 toBe(status) 在故障注入用例里恰恰是关键断言）');
  return rows;
}

// ── 判据自测：注入必须改变判决 ──────────────────────────────────────────────
function selfTest() {
  const os = require('node:os');
  const fsx = require('node:fs');
  const root = fsx.mkdtempSync(path.join(os.tmpdir(), 'spec-inventory-'));
  const specsDir = path.join(root, 'specs');
  fsx.mkdirSync(specsDir, { recursive: true });

  const baseSpec = `
const e2eConfig = {};
if (!e2eConfig) {
  describe.skip('缺配置', () => {
    it('requires config', () => { expect(1).toBe(1); });
  });
} else {
  describe('真实用例', () => {
    it('甲', async () => { expect(1).toBe(1); });
    it('乙', async () => { expect(1).toBe(1); });
  });
}
`;
  // 注入①用的形状：同一批用例被**没有 if 守卫**的 describe.skip 罩住
  const uncondSpec = `
describe.skip('整块永久跳过（无人守卫）', () => {
  it('甲', async () => { expect(1).toBe(1); });
  it('乙', async () => { expect(1).toBe(1); });
});
`;
  // 夹具用 5 个 spec：CHAIN_SPECS 的"疑似截断"守卫要求 ≥5，自测不得靠绕开守卫来变绿
  const names5 = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
  const fillerSpec = "\ndescribe('单条用例', () => {\n  it('甲', async () => { expect(1).toBe(1); });\n});\n";
  const TOTAL = names5.length + 1; // alpha 2 条 + 其余 4 个各 1 条 = 6
  const baseLog = `${names5.map((n, i) => `PASS test/e2e/${n}.e2e.spec.ts
  ${i === 0 ? '真实用例' : '单条用例'}
    ✓ 甲${i === 0 ? '\n    ✓ 乙' : ''}`).join('\n')}
Tests:       ${TOTAL} passed, ${TOTAL} total
`;
  const write = (p, s) => fsx.writeFileSync(p, s);
  const mk = (mut) => {
    const vp = path.join(root, 'verify.sh');
    const l1 = path.join(root, 'chain-specs.log');
    const l2 = path.join(root, 'chain-specs-requiretx.log');
    const a1 = path.join(specsDir, 'alpha.e2e.spec.ts');
    // 每例都从同一组干净夹具起步 ⇒ 注入之间不残留（V108 的教训：夹具不隔离，注入会互相继承）
    write(vp, `CHAIN_SPECS="${names5.join(' ')}"\n`);
    write(a1, baseSpec);
    names5.slice(1).forEach((n) => write(path.join(specsDir, `${n}.e2e.spec.ts`), fillerSpec));
    write(l1, baseLog);
    write(l2, baseLog);
    if (mut) mut({ vp, l1, l2, a1 });
    return { verify: vp, specs: specsDir, logs: [l1, l2] };
  };

  const results = [];
  const run = (label, opts, wantRc) => {
    const got = reconcile(opts);
    const ok = got.rc === wantRc;
    // 失败时必须能看到**全部**报语：只看第一条曾让我们把"注入没生效"误读成"判据漏网"（V112）
    const why = got.problems.length ? got.problems.join(' ｜ ') : (got.notes.join(' ｜ ') || '—');
    results.push({ label, ok, wantRc, gotRc: got.rc, why });
  };

  run('正向：静态 3 条含 1 条条件式 skip 占位，实到 2 条 ⇒ 通过', mk(), 0);
  // V112 新模式：--specs-all 用目录当清单（CI 的 testMatch 口径），且不做 D/D2 交叉相等
  run('正向·目录全量：以 test/e2e 目录为清单对单份日志 ⇒ 通过',
    Object.assign(mk(), { all: true, logs: [path.join(root, 'chain-specs.log')] }), 0);
  // 注意：注入必须注到**被测模式**上。第一版这里忘了套 all/logs，于是它测的还是 CHAIN_SPECS 模式 ⇒ 假"没抓到"。
  run('注入⑥·重复表头清零（末尾失败汇总重印 FAIL 行）⇒ 不得把实到数当成 0',
    (() => {
      const o = mk();
      const dup = baseLog.replace('Tests:       6 passed, 6 total\n',
        'Tests:       6 passed, 6 total\n') + 'FAIL test/e2e/alpha.e2e.spec.ts\n';
      write(path.join(root, 'chain-specs.log'), dup);
      write(path.join(root, 'chain-specs-requiretx.log'), dup);
      return o;
    })(), 0);
  run('注入⑥·目录全量：目录里新增一个 0 用例、日志里没有对应套件的 spec ⇒ 必须抓到（CI 会 import 它却什么都不跑）',
    (() => {
      write(path.join(specsDir, 'zeta.e2e.spec.ts'), "\ndescribe('空壳', () => {\n});\n");
      return Object.assign(mk(), { all: true, logs: [path.join(root, 'chain-specs.log')] });
    })(), 1);
  run('注入①：无 if 守卫的 describe.skip（判据看不见的永久跳过）⇒ 必须抓到',
    mk(({ a1 }) => write(a1, uncondSpec)), 1);
  run('注入②：清单里的 spec 文件缺失 ⇒ 必须抓到',
    mk(({ vp }) => write(vp, `CHAIN_SPECS="${names5.slice(0, 4).join(' ')} missingone"\n`)), 1);
  run('注入③：静态多一条被运行时条件挡住的用例（既非 skip 也非 describe.skip）⇒ 必须抓到',
    mk(({ a1 }) => write(a1, baseSpec.replace(
      "}\n", "} // x\nif (process.env.NEVER_SET) describe('隐藏块', () => {\n  it('丙', async () => { expect(1).toBe(1); });\n});\n",
    ))), 1);
  run('注入④：日志汇总行与逐条标记不一致 ⇒ 判"不可判"而不是"通过"或"失败"',
    mk(({ l1 }) => write(l1, baseLog.replace(`${TOTAL} total`, '9 total'))), 3);
  run('注入⑤：响亮 skip（○ + 汇总 skipped 自洽）实到少 1 ⇒ 抓到偏差（不冒充通过）',
    mk(({ l1 }) => write(l1, baseLog.replace('    ✓ 乙', '    ○ 乙')
      .replace(`Tests:       ${TOTAL} passed, ${TOTAL} total`,
               `Tests:       ${TOTAL - 1} passed, 1 skipped, ${TOTAL} total`))), 1);

  let bad = 0;
  for (const r of results) {
    if (!r.ok) { bad += 1; console.log(`  ✕ ${r.label}（期望 rc=${r.wantRc} 实得 rc=${r.gotRc}）\n      ↳ 全部报语：${r.why}`); }
    else console.log(`  ✓ ${r.label}\n      ↳ ${r.why}`);
  }
  fs.rmSync(root, { recursive: true, force: true });
  if (bad) { console.log(`用例存量对账判据自测：不通过（${bad} 项）`); process.exitCode = 3; return; }
  const nPos = results.filter((x) => x.wantRc === 0).length;
  console.log(`用例存量对账判据自测：通过（${results.length} 项：${nPos} 正向 + ${results.length - nPos} 注入，`
    + '注入均改变判决；日志自身不一致时判"不可判"而非结论）');
}

// ── 入口 ────────────────────────────────────────────────────────────────────
function main() {
  if (FLAGS.has('--self-test')) { selfTest(); return; }
  const opts = {
    all: FLAGS.has('--specs-all'),
    verify: argv('--verify') || path.join(ROOT, 'scripts/chain-baseline/verify.sh'),
    specs: argv('--specs') || path.join(ROOT, 'ewoh-spark-app/test/e2e'),
    logs: argv('--logs')
      ? argv('--logs').split(',')
      : [`${ROOT}/tmp/chain-baseline/e2e-logs/chain-specs.log`,
         `${ROOT}/tmp/chain-baseline/e2e-logs/chain-specs-requiretx.log`].filter((p) => fs.existsSync(p)),
  };
  if (!opts.logs.length) {
    console.log('不可用：找不到 D 段日志（先跑 make chain-baseline-verify --with-server，或用 --logs 指定）');
    process.exitCode = 3;
    return;
  }
  const r = reconcile(opts);
  const logDesc = (r.logs || []).map((l) => `${l.file}(${l.marks.pass}✓/${l.suites}套件)`).join(' + ');
  console.log(`用例存量对账：清单 ${(r.specs || []).length} 个（${opts.all ? '目录全量=CI testMatch 口径' : 'CHAIN_SPECS'}），日志 ${logDesc}`);
  // 存量对账**不判成败**（那是 jest 退出码与 assert_no_skips 的活），但必须把失败数摆在同一行，
  // 免得 `123✓/28 套件` 被读成"全通过"（V112 实跑就有 1 例失败）。
  (r.logs || []).forEach((lg) => { if (lg.marks.fail) console.log(`  ! ${lg.file}: 有 ${lg.marks.fail} 条失败标记（本判据只核存量，成败看 jest 退出码）`); });
  const silent = (r.rows || []).filter((x) => x.silent > 0);
  if (silent.length) console.log(`  静默占位（jest 汇总行不含）：${silent.map((x) => `${x.name} ${x.silent} 条`).join('，')}`);
  for (const p of r.problems) console.log(`  ✕ ${p}`);
  if (FLAGS.has('--census')) census(opts);
  if (FLAGS.has('--json')) {
    fs.writeFileSync(path.join(ROOT, 'tmp/spec-case-inventory.json'), JSON.stringify({ rows: r.rows, logs: r.logs }, null, 1));
    console.log('  (已写 tmp/spec-case-inventory.json)');
  }
  console.log(r.rc === 0 ? '  ✅ 静态可注册数与运行时实到数逐套件对上，且无"判据看不见的永久跳过"' : `  ❌ 对账不通过（${r.problems.length} 项）`);
  process.exitCode = r.rc;
}

main();
