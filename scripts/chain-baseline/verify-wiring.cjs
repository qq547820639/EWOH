#!/usr/bin/env node
'use strict';

/**
 * 只回答一个问题：一键重放 A 段那句「verify N/N PASS」里，每一条 PASS 是不是真的
 * 落到了一条**从库里读出断言字段**的分支上——还是被 runner 末尾的 apply/rollback
 * 兜底分支当成迁移跑掉了（那会打印 `completed for schema`、退出码 0，被 A 段记成 PASS）。
 *
 * 为什么需要它（V220）：A 段的分母来自 `EXECUTE_COMMANDS`，**不是**来自"这条命令做了断言"。
 * `db/runner/run_migrations.js` 的 verify 有三个登记面（表驱动 `SIMPLE_VERIFY_COMMANDS`、
 * 显式 `command === '--verify-…'` 分支、末尾 `which` 兜底映射），三者不同步时的表现并不相同：
 * 兜底映射里**有**键 ⇒ 静默 PASS（看不见）；**没有**键 ⇒ `ERROR No migration file mapped` 而红
 * （2026-09-12 NO-58 就是这一形）。所以"接线齐不齐"必须按形状分档，不能只看退出码。
 *
 * 用法：
 *   node scripts/chain-baseline/verify-wiring.cjs --self-test   # 判据自测（条数自报）
 *   node scripts/chain-baseline/verify-wiring.cjs               # 真语料静态普查
 *   node scripts/chain-baseline/verify-wiring.cjs --runner <p>   # 普查任一 runner 文本
 *   node scripts/chain-baseline/verify-wiring.cjs --inject      # 覆盖树注入反证（需隔离集群）
 *
 * 读数纪律：`hole` 是"会被静默记成 PASS 的形状"，不等于"今天已经在静默"——今天是否静默
 * 由 `wired-*` 与 `hole` 的比值给出；`unwired` 既不并成 ok 也不并成 hole。
 * 本件是**只出读数**的试点量具，未接进共享门禁主线（接不接见登记册 GATE-27）。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repo = path.resolve(__dirname, '..', '..');
const REAL_RUNNER = path.join(repo, 'db/runner/run_migrations.js');
const args = process.argv.slice(2);

/** 从一个 runner 源文件解出四张清单。分母单独 require（清单是运行期真值，正则只判形状）。 */
function shapes(file) {
  const src = fs.readFileSync(file, 'utf8');
  const slice = (start, end) => {
    const i = src.indexOf(start);
    if (i < 0) return '';
    const j = end ? src.indexOf(end, i) : -1;
    return src.slice(i, j > i ? j : src.length);
  };
  const quoted = (text, re) => [...text.matchAll(re)].map((m) => m[1]);
  // 表驱动行的值是数组、兜底映射行的值是字符串——用值形状区分两张清单，不靠行首锚点
  // （判据自测的合成夹具里两者都可能与 `{` 同行，锚点会让夹具解不出来）。
  const simple = new Set(quoted(
    slice('const SIMPLE_VERIFY_COMMANDS = {', 'const COMPLEX_VERIFY_COMMANDS'),
    /'(--verify[^']*)'\s*:\s*\[/g,
  ));
  const complex = new Set(quoted(slice('const COMPLEX_VERIFY_COMMANDS = [', '];'), /'(--verify[^']*)'/g));
  const branches = new Set(quoted(src, /command === '(--verify[^']*)'/g));
  const fallback = new Set(quoted(src.slice(src.indexOf('    const which = {')), /'(--verify[^']*)'\s*:\s*'/g));
  return { simple, complex, branches, fallback };
}

function denominator(file) {
  delete require.cache[require.resolve(file)];
  const mod = require(file);
  return [...mod.EXECUTE_COMMANDS].filter((c) => c.startsWith('--verify-standalone'));
}

/** 逐命令定档：wired-simple／wired-branch／hole（只在兜底映射）／unwired（谁都不在）。 */
function classify(cmds, sh) {
  const buckets = { 'wired-simple': [], 'wired-branch': [], hole: [], unwired: [] };
  const both = [];
  for (const c of cmds) {
    if (sh.simple.has(c)) buckets['wired-simple'].push(c);
    else if (sh.branches.has(c)) buckets['wired-branch'].push(c);
    else if (sh.fallback.has(c)) buckets.hole.push(c);
    else buckets.unwired.push(c);
    if (sh.fallback.has(c) && (sh.simple.has(c) || sh.branches.has(c))) both.push(c);
  }
  return { buckets, both };
}

function census(file) {
  const cmds = denominator(file);
  const sh = shapes(file);
  const { buckets, both } = classify(cmds, sh);
  const sum = Object.values(buckets).reduce((a, b) => a + b.length, 0);
  if (cmds.length === 0) {
    console.error('[作废] 分母为 0：没有解出任何 --verify-standalone 命令，不能读成"全部已接线"');
    process.exit(2);
  }
  if (sum !== cmds.length) {
    console.error(`[作废] Σ各档 ${sum} ≠ 分母 ${cmds.length}`);
    process.exit(2);
  }
  return { cmds, buckets, both };
}

function printCensus(label, { cmds, buckets, both }) {
  console.log(`\n[${label}] 分母（EXECUTE_COMMANDS 里的 --verify-standalone*）= ${cmds.length}`);
  for (const [k, v] of Object.entries(buckets)) console.log(`  ${k.padEnd(13)} ${v.length}`);
  console.log(`  双写（兜底映射里也有键，但被前面的分支接住＝潜伏面） ${both.length}`);
  if (buckets.hole.length) console.log(`  hole 点名：${buckets.hole.join(' ')}`);
  if (buckets.unwired.length) console.log(`  unwired 点名：${buckets.unwired.join(' ')}`);
  if (both.length) console.log(`  潜伏面点名：${both.join(' ')}`);
}

// ---------------------------------------------------------------- 判据自测
function selfTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vwt-'));
  // 夹具命令名必须与真判据的分母筛选同形（--verify-standalone*），否则测的是"名字起错了"
  // 而不是判据本身（V220 首跑就是这么把自己判成"分母为 0"的）。
  const A = '--verify-standalone-fxa';
  const B = '--verify-standalone-fxb';
  const mk = (name, execList, body) => {
    const p = path.join(dir, `${name}.cjs`);
    fs.writeFileSync(p, `module.exports={EXECUTE_COMMANDS:new Set([${execList.map((c) => JSON.stringify(c)).join(',')}])};\n${body}\n`);
    return p;
  };
  const cases = [];
  const t = (name, ok) => cases.push({ name, ok });

  const hole = mk('hole', [A], `
const SIMPLE_VERIFY_COMMANDS = { '${B}': ['x','y','z'] };
const COMPLEX_VERIFY_COMMANDS = ['${A}'];
    const which = { '${A}': 'a_verify' };
`);
  let r = census(hole);
  t('正对照 1：命令只在兜底映射里 ⇒ 必须判 hole（不许读成已接线）',
    r.buckets.hole.length === 1 && r.buckets['wired-simple'].length === 0);

  const wired = mk('wired', [A], `
const SIMPLE_VERIFY_COMMANDS = { '${A}': ['x','y','z'] };
const COMPLEX_VERIFY_COMMANDS = [];
    const which = { '--apply-a': 'a' };
`);
  r = census(wired);
  t('反对照 1：表驱动接住 ⇒ 不得判 hole', r.buckets.hole.length === 0 && r.buckets['wired-simple'].length === 1);

  const branch = mk('branch', [A], `
const SIMPLE_VERIFY_COMMANDS = {};
const COMPLEX_VERIFY_COMMANDS = ['${A}'];
function _fx(command) { if (command === '${A}') { return; } }
    const which = { '--apply-a': 'a' };
`);
  r = census(branch);
  t('反对照 2：显式分支接住 ⇒ 判 wired-branch 而不是 hole',
    r.buckets['wired-branch'].length === 1 && r.buckets.hole.length === 0);

  const none = mk('none', [A], `
const SIMPLE_VERIFY_COMMANDS = {};
const COMPLEX_VERIFY_COMMANDS = [];
    const which = { '--apply-a': 'a' };
`);
  r = census(none);
  t('反对照 3：谁都不在 ⇒ 只能单列 unwired（既不并成 ok 也不并成 hole）',
    r.buckets.unwired.length === 1 && r.buckets.hole.length === 0);

  const both = mk('both', [A], `
const SIMPLE_VERIFY_COMMANDS = { '${A}': ['x','y','z'] };
const COMPLEX_VERIFY_COMMANDS = [];
    const which = { '${A}': 'a_verify' };
`);
  r = census(both);
  t('双写照料：表驱动＋兜底映射都有 ⇒ 计一次 wired-simple，另记潜伏面 1 处（不得重复计数）',
    r.buckets['wired-simple'].length === 1 && r.both.length === 1
    && Object.values(r.buckets).reduce((a, b) => a + b.length, 0) === 1);

  const empty = mk('empty', [], 'const SIMPLE_VERIFY_COMMANDS = {};');
  const rr = spawnSync(process.execPath, [path.join(repo, 'scripts/chain-baseline/verify-wiring.cjs'), '--census-file', empty], { encoding: 'utf8' });
  t('反对照 4：分母为 0 ⇒ 必须非零退出且不许打"全部已接线"（静默为空与干净同形的那一形）',
    rr.status !== 0 && /分母为 0/.test(`${rr.stdout}${rr.stderr}`));

  const real = census(REAL_RUNNER);
  t('真语料不变量：今天 104 条里 hole 必须为 0（>0 就说明 A 段已经在静默记 PASS，读数要重新定性）',
    real.buckets.hole.length === 0);

  fs.rmSync(dir, { recursive: true, force: true });
  const bad = cases.filter((x) => !x.ok);
  for (const c of cases) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`);
  console.log(`判据自测 ${cases.length - bad.length}/${cases.length} 通过`);
  process.exit(bad.length ? 1 : 0);
}

// ---------------------------------------------------------------- 注入反证
const PRISTINE = fs.readFileSync(REAL_RUNNER, 'utf8');
const TREE = path.join(repo, 'tmp/chain-baseline/verify-wiring-overlay');

function restoreTree() {
  fs.writeFileSync(path.join(TREE, 'db/runner/run_migrations.js'), PRISTINE);
  const mig = path.join(TREE, 'db/migrations/standalone_001_schema.sql');
  if (fs.existsSync(`${mig}.bak`)) {
    fs.copyFileSync(`${mig}.bak`, mig);
    fs.unlinkSync(`${mig}.bak`);
  }
}

function patchRunner(from, to) {
  const p = path.join(TREE, 'db/runner/run_migrations.js');
  const src = fs.readFileSync(p, 'utf8');
  const n = src.split(from).length - 1;
  if (n !== 1) throw new Error(`注入锚点命中 ${n} 次（需要 1）：${from.slice(0, 50)}`);
  fs.writeFileSync(p, src.replace(from, to));
}

function buildTree() {
  fs.rmSync(TREE, { recursive: true, force: true });
  fs.mkdirSync(path.join(TREE, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(TREE, 'ewoh-spark-app'), { recursive: true });
  fs.cpSync(path.join(repo, 'db'), path.join(TREE, 'db'), { recursive: true });
  fs.copyFileSync(path.join(repo, 'scripts/migration-fresh-chain-check.js'), path.join(TREE, 'scripts/migration-fresh-chain-check.js'));
  fs.copyFileSync(path.join(repo, 'ewoh-spark-app/package.json'), path.join(TREE, 'ewoh-spark-app/package.json'));
  fs.symlinkSync(path.join(repo, 'ewoh-spark-app/node_modules'), path.join(TREE, 'ewoh-spark-app/node_modules'));
}

function runChecker(extra, env) {
  const r = spawnSync(process.execPath, [path.join(TREE, 'scripts/migration-fresh-chain-check.js'), ...extra], {
    cwd: TREE,
    encoding: 'utf8',
    env: env || process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { rc: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

function inject() {
  const keepUrl = process.env.V220_KEEP_URL || process.env.EWOH_KEEP_URL || '';
  if (!/ewoh_chain_check_\d+/.test(keepUrl) || !/127\.0\.0\.1|localhost/.test(keepUrl)) {
    console.error('[拒绝] 注入档需要一个本轮自建的临时库：EWOH_KEEP_URL=…/ewoh_chain_check_<pid>（绝不允许指到链基线库）');
    process.exit(2);
  }
  if (!process.env.EWOH_PG_URL && !process.env.EWOH_DATABASE_URL) {
    console.error('[拒绝] 缺少 EWOH_PG_URL（隔离集群 owner 连接串）');
    process.exit(2);
  }
  buildTree();
  restoreTree();
  const cases = [];
  const t = (name, ok, detail) => cases.push({ name, ok, detail });
  const bl = (name, lines) => {
    const p = path.join(TREE, name);
    fs.writeFileSync(p, `${lines.join('\n')}\n`);
    return p;
  };

  let a = runChecker([]);
  t('A 控制档：覆盖树不注入必须与主仓 A 段同形（rc=0 且 104/104）',
    a.rc === 0 && /verify 104\/104 PASS/.test(a.out), `rc=${a.rc}`);

  patchRunner("'standalone_event_dedup_verify', 'standalone_036_verified'",
    "'standalone_event_dedup_verify', 'standalone_036_verified_INJECT'");
  let b = runChecker([]);
  t('B 注入回归（断言字段名改到库里不存在）：rc=1 且打 REGRESSION',
    b.rc === 1 && /REGRESSION\s+--verify-standalone-event-dedup/.test(b.out) && !/BASELINE\s+--verify-standalone-event-dedup/.test(b.out), `rc=${b.rc}`);
  t('B 注入回归：计数变 103/104 且只有这一条红（分母没被动过）',
    /verify 103\/104 PASS/.test(b.out) && (b.out.match(/REGRESSION/g) || []).length === 1);
  let bstat = census(path.join(TREE, 'db/runner/run_migrations.js'));
  t('B 静态面：okField 写错这一形**不是**接线洞（分支还在）⇒ hole 必须为 0，别把两回事混成一件',
    bstat.buckets.hole.length === 0);

  let c = runChecker(['--baseline', bl('baseline-c.txt', ['--verify-standalone-event-dedup'])]);
  t('C 基线吸收：同一条红登记后 rc=0 且打 BASELINE（这就是"基线只许缩小"这条纪律没有机器拦的证据）',
    c.rc === 0 && /BASELINE\s+--verify-standalone-event-dedup/.test(c.out) && /已知基线失败 1/.test(c.out), `rc=${c.rc}`);
  restoreTree();

  let d = runChecker(['--baseline', bl('baseline-d.txt', ['--verify-standalone-event-dedup'])]);
  t('D FIXED 只提示不红：把一条今天通过的命令塞进基线 ⇒ rc=0、打 FIXED、计数仍 104/104（GATE-06 那一问的实测）',
    d.rc === 0 && /FIXED\s+--verify-standalone-event-dedup/.test(d.out) && /verify 104\/104 PASS/.test(d.out) && /已知基线失败 1/.test(d.out), `rc=${d.rc}`);

  const mig = path.join(TREE, 'db/migrations/standalone_001_schema.sql');
  fs.copyFileSync(mig, `${mig}.bak`);
  fs.appendFileSync(mig, '\nSELECT * FROM vwt_no_such_table;\n');
  let e = runChecker([]);
  t('E apply 断链：rc=1 且明说 apply FAIL、没有把 verify 记成绿',
    e.rc === 1 && /apply FAIL/.test(e.out) && !/verify \d+\/\d+ PASS/.test(e.out), `rc=${e.rc}`);
  restoreTree();

  patchRunner("  '--verify-standalone-workbench-query-indexes': ['standalone_workbench_query_indexes_verify', 'standalone_103_verified', 'standalone_103 workbench query indexes (delayed-order composite + ILIKE trgm GIN)'],\n", '');
  let f1 = spawnSync(process.execPath,
    [path.join(TREE, 'db/runner/run_migrations.js'), '--verify-standalone-workbench-query-indexes'], {
      cwd: TREE,
      encoding: 'utf8',
      env: { ...process.env, EWOH_DATABASE_URL: keepUrl, EWOH_ALLOW_DDL: '1' },
    });
  let f1out = `${f1.stdout || ''}${f1.stderr || ''}`;
  t('F 静默形状：从表驱动删掉一行（兜底映射仍有键）⇒ 该命令退出码 0、输出 completed for schema 而不是 VERIFY OK',
    f1.status === 0 && /completed for schema/.test(f1out) && !/VERIFY OK/.test(f1out), `rc=${f1.status}`);
  let f = runChecker([]);
  t('F 静默形状：整条 A 段仍报 104/104 PASS 且 rc=0（少了一条断言，A 段读数看不出来）',
    f.rc === 0 && /verify 104\/104 PASS/.test(f.out), `rc=${f.rc}`);
  let fstat = census(path.join(TREE, 'db/runner/run_migrations.js'));
  t('F 静态面：同一份被改的 runner 必须由本件静态判出 hole=1（判据与注入互相咬合，不然自测不算数）',
    fstat.buckets.hole.length === 1 && fstat.buckets.hole[0] === '--verify-standalone-workbench-query-indexes');
  restoreTree();

  const bad = cases.filter((x) => !x.ok);
  for (const c2 of cases) console.log(`${c2.ok ? 'PASS' : 'FAIL'}  ${c2.name}${c2.ok ? '' : ` [${c2.detail}]`}`);
  console.log(`注入反证 ${cases.length - bad.length}/${cases.length} 通过`);
  process.exit(bad.length ? 1 : 0);
}

// ---------------------------------------------------------------- 入口
if (args.includes('--self-test')) selfTest();
if (args.includes('--inject')) inject();

const cf = args.indexOf('--census-file');
const target = cf >= 0 && args[cf + 1] ? path.resolve(args[cf + 1]) : REAL_RUNNER;
printCensus(path.relative(repo, target), census(target));
console.log('\n读数只回答"接线齐不齐"，不证明每条 verify 的 SQL 不是恒真（后者要逐条做库侧变异，见登记册 §5.3bl／V119）。');
