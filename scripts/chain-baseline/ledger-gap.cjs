#!/usr/bin/env node
/* ledger-gap（V346）：审计覆盖账本 ↔ 磁盘现扫 的双向差集尺。

   只回答一个问题：**账本与「现在磁盘上该审的总体」差多少件、往哪个方向差，
   以及账本里有没有把审阅状态写在旧内容上的行。**
   它补的是既有 `stats`／`report` 结构上看不见的那一面：
     · `inspectCoverage()` 的分母是**现扫总体**（`files.map(...)`），账本多出来的行只进 `missing` 一个方向；
     · 磁盘有而账本没有的文件被并进 `unreviewed` 那一桶——「从未入账」与「入账了但没审完」读起来同一个数；
     · 没有任何一处把「账本行数 ↔ 现扫总数」并排核，也没有门禁跑过这个工具（Makefile／CI 零命中）。

   现扫总体一律向 `scripts/audit-file-ledger.js paths` 这个只读子命令取（同一条枚举器、两个消费者）；
   本文件不自己遍历目录——另写一份枚举器，两边读数一旦不一致，本次读数即作废。
   第二道自证：同一条枚举器的 `stats` 子命令给出的 `total`／`missing` 必须与本报告合（`reconcile`）。

   用法：node scripts/chain-baseline/ledger-gap.cjs [--self-test|--json]
   退码：0 一致｜2 分叉（任一方向或形状不为零）｜3 不可判（取不到现扫／读不到账本／取不到第二消费者）。
   夹具用环境变量覆盖：EWOH_LEDGER_FILE／EWOH_LEDGER_TOOL（只给 --self-test 用）。
*/
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const LEDGER = process.env.EWOH_LEDGER_FILE || path.join(ROOT, 'docs/audit/current/file-ledger.jsonl');
const TOOL = process.env.EWOH_LEDGER_TOOL || path.join(ROOT, 'scripts/audit-file-ledger.js');
const REPORT = path.join(ROOT, 'docs/audit/current/coverage-report.md');

/** 纯函数：两份名单进，三向差集出。判据与取数分离，注入才测得到判据本身。 */
function gapOf(activeFiles, ledgerRows) {
  const A = new Set(activeFiles);
  const L = new Set(ledgerRows.map((r) => r.path));
  const inter = [...A].filter((p) => L.has(p));
  const unledgered = [...A].filter((p) => !L.has(p)).sort();
  const ghost = [...L].filter((p) => !A.has(p)).sort();
  const staleReview = ledgerRows
    .filter((r) => r.reviewed === true && r.reviewed_sha256 && r.reviewed_sha256 !== r.content_sha256)
    .map((r) => r.path).sort();
  const dup = ledgerRows.length - L.size;
  const population = new Set([...A, ...L]).size;
  const bad = unledgered.length + ghost.length + staleReview.length + dup;
  return {
    active: A.size, ledgerRows: ledgerRows.length, ledgerPaths: L.size, inter: inter.length,
    unledgered, ghost, staleReview, dup, population,
    verdict: bad ? '分叉' : '一致',
  };
}

/** 第二消费者自证：同一条枚举器的 `stats` 行必须与本报告的 total／missing 合（两个消费者分叉＝读数作废）。 */
function reconcile(g, stats) {
  const out = [];
  if (!stats) return ['取不到 stats 行'];
  if (stats.total !== g.active) out.push(`现扫总数两消费者不合：paths=${g.active} vs stats total=${stats.total}`);
  if (stats.missing !== g.ghost.length) out.push(`幽灵行数两消费者不合：本尺=${g.ghost.length} vs stats missing=${stats.missing}`);
  return out;
}

function parseStats(text) {
  const m = String(text).match(/total=(\d+) reviewed=(\d+) unreviewed=(\d+) missing=(\d+)/);
  if (!m) return null;
  return { total: Number(m[1]), reviewed: Number(m[2]), unreviewed: Number(m[3]), missing: Number(m[4]) };
}

function readLedgerRows(file) {
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    rows.push(JSON.parse(t));
  }
  return rows;
}

function sh(args) {
  return cp.execFileSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
}

function run() {
  const problems = [];
  const notes = [];
  let active;
  try {
    active = JSON.parse(sh([TOOL, 'paths']));
    if (!Array.isArray(active.files)) throw new Error('paths 子命令没返回 files 数组');
  } catch (e) {
    return { rc: 3, problems: [`不可判：取不到现扫总体（${String(e.message).split('\n')[0]}）`], notes, data: null };
  }
  if (!fs.existsSync(LEDGER)) {
    return { rc: 3, problems: [`不可判：账本文件读不到 ${path.relative(ROOT, LEDGER)}`], notes, data: null };
  }
  let rows;
  try {
    rows = readLedgerRows(LEDGER);
  } catch (e) {
    return { rc: 3, problems: [`不可判：账本有行解析不了（${String(e.message).split('\n')[0]}）`], notes, data: null };
  }
  const g = gapOf(active.files, rows);
  if (active.active !== g.active) problems.push(`枚举器自报 active=${active.active} 与 files 长度 ${g.active} 不等`);
  let stats = null;
  try {
    stats = parseStats(sh([TOOL, 'stats']));
  } catch (e) { /* 交给下面的两消费者自证统一处理 */ }
  const rec = reconcile(g, stats);
  notes.push(`现扫 ${g.active}｜账本行 ${g.ledgerRows}（唯一路径 ${g.ledgerPaths}）｜交集 ${g.inter}｜并集（分母）${g.population}`);
  notes.push(`未入账 ${g.unledgered.length}｜幽灵行 ${g.ghost.length}｜审阅写在旧内容上 ${g.staleReview.length}｜重复行 ${g.dup}`);
  const dist = {};
  for (const p of g.unledgered) {
    const k = p.split('/').slice(0, 2).join('/');
    dist[k] = (dist[k] || 0) + 1;
  }
  const top = Object.entries(dist).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (top.length) notes.push('未入账按目录分布（前 8 组）：' + top.map(([k, v]) => `${k} ${v}`).join(' ｜ '));
  if (g.unledgered.length) notes.push('未入账样本 10 条：' + g.unledgered.slice(0, 10).join(' '));
  if (g.ghost.length) { notes.push('幽灵行样本：' + g.ghost.slice(0, 10).join(' ')); problems.push(`账本有 ${g.ghost.length} 行指向磁盘上已不存在的文件`); }
  if (g.staleReview.length) { notes.push('旧内容审阅样本：' + g.staleReview.slice(0, 10).join(' ')); problems.push(`${g.staleReview.length} 行把 reviewed 写在 reviewed_sha256≠content_sha256 上`); }
  if (g.dup) problems.push(`账本里有 ${g.dup} 条重复路径`);
  if (g.unledgered.length) problems.push(`磁盘现扫有 ${g.unledgered.length} 件不在账本里（它们在报告里只表现为 unreviewed，看不出「从未入账」）`);
  if (stats) notes.push(`第二消费者 stats：total=${stats.total} reviewed=${stats.reviewed} unreviewed=${stats.unreviewed} missing=${stats.missing}`);
  for (const r of rec) problems.push('两消费者不合：' + r);
  const age = (f) => (fs.existsSync(f) ? fs.statSync(f).mtime.toISOString() : '（无）');
  notes.push(`账本 mtime ${age(LEDGER)}｜报告 mtime ${age(REPORT)}（两份产物的生成时刻，只作上下文，不参与判决）`);
  if (!problems.length && !stats) problems.push('两消费者不合：取不到 stats 行');
  const rc = problems.length ? 2 : (stats ? 0 : 3);
  notes.push(`判决：${problems.length ? '分叉' : (stats ? '一致' : '不可判')}`);
  return { rc, problems, notes, data: g };
}

/** 自测：注入必须真的改变判决；合规侧必须沉默；取不到一律第三态，不折算成任何一侧。 */
function selfTest() {
  const cases = [];
  const t = (name, fn) => cases.push({ name, fn });
  const R = (p, extra) => Object.assign({ path: p, reviewed: false, reviewed_sha256: null, content_sha256: 'x' }, extra || {});

  t('注入①：磁盘有而账本没有 ⇒ 必须点名未入账并判分叉', () => {
    const g = gapOf(['a.ts', 'b.ts'], [R('a.ts')]);
    return g.unledgered.length === 1 && g.unledgered[0] === 'b.ts' && g.verdict === '分叉';
  });
  t('注入②：账本有而磁盘没有 ⇒ 必须点名幽灵行（与 stats 的 missing 同义，两个消费者要能对上）', () => {
    const g = gapOf(['a.ts'], [R('a.ts'), R('gone.ts')]);
    return g.ghost.length === 1 && g.ghost[0] === 'gone.ts' && g.verdict === '分叉';
  });
  t('注入③：reviewed 写在旧内容上 ⇒ 必须单独点名，不并入未入账', () => {
    const g = gapOf(['a.ts'], [R('a.ts', { reviewed: true, reviewed_sha256: 'old', content_sha256: 'new' })]);
    return g.staleReview.length === 1 && !g.unledgered.length && !g.ghost.length && g.verdict === '分叉';
  });
  t('对照④：完全同步的一份 ⇒ 三向全零且必须判"一致"（假阳性面为零）', () => {
    const g = gapOf(['a.ts', 'b.ts'], [R('a.ts', { reviewed: true, reviewed_sha256: 'x' }), R('b.ts')]);
    return g.verdict === '一致' && !g.unledgered.length && !g.ghost.length && !g.staleReview.length && !g.dup;
  });
  t('对照⑤：未入账与幽灵行**数量相等**时不得互相抵消（"净零"读法会把两个方向都藏掉）', () => {
    const g = gapOf(['a.ts', 'new1.ts', 'new2.ts'], [R('a.ts'), R('old1.ts'), R('old2.ts')]);
    return g.unledgered.length === 2 && g.ghost.length === 2 && g.verdict === '分叉';
  });
  t('注入⑥：同一路径两行 ⇒ 必须判重复行，分母仍按唯一路径算（行数不得冒充分母）', () => {
    const g = gapOf(['a.ts'], [R('a.ts'), R('a.ts')]);
    return g.dup === 1 && g.ledgerPaths === 1 && g.ledgerRows === 2 && g.population === 1 && g.verdict === '分叉';
  });
  t('注入⑦：第二消费者给的 total 与本尺不合 ⇒ 必须报"两消费者不合"（枚举器分叉时读数作废，不许静默）', () => {
    const g = gapOf(['a.ts'], [R('a.ts')]);
    return reconcile(g, { total: 999, reviewed: 0, unreviewed: 1, missing: 0 }).length === 1
      && reconcile(g, { total: 1, reviewed: 0, unreviewed: 1, missing: 0 }).length === 0;
  });
  t('注入⑦之二：missing 与本尺幽灵行不合 ⇒ 同样必须点名；解析不到 stats 行必须判"取不到"而不是"合"', () => {
    const g = gapOf(['a.ts'], [R('a.ts'), R('gone.ts')]);
    return reconcile(g, { total: 1, reviewed: 0, unreviewed: 1, missing: 7 }).length === 1
      && reconcile(g, null).length === 1 && parseStats('乱七八糟') === null;
  });
  t('真语料⑧：两条消费者在现树上必须逐字对上（total↔现扫、missing↔幽灵行），否则本尺与工具不可互相引用', () => {
    const r = run();
    if (r.rc === 3) return false;
    const line = r.notes.find((n) => n.startsWith('第二消费者 stats'));
    if (!line) return false;
    const s = parseStats(line);
    return s && s.total === r.data.active && s.missing === r.data.ghost.length;
  });
  t('不可判⑨：取不到现扫（枚举器路径不存在）⇒ 必须退 3 且不得读成"一致"或"分叉"', () => withEnv({ EWOH_LEDGER_TOOL: path.join(ROOT, 'zzz-not-a-real-tool.js') }, (m) => {
    const r = m.run();
    return r.rc === 3 && String(r.problems[0]).startsWith('不可判');
  }));
  t('不可判⑩：账本文件读不到 ⇒ 必须退 3（空账本不得冒充"一致"）', () => withEnv({ EWOH_LEDGER_FILE: path.join(ROOT, 'zzz-no-ledger.jsonl') }, (m) => m.run().rc === 3));

  let ok = 0;
  for (const c of cases) {
    let pass = false;
    try { pass = c.fn() === true; } catch (e) { c.err = e.message; }
    console.log(`  ${pass ? '✅' : '❌'} ${c.name}${pass ? '' : '（' + (c.err || '条件不满足') + '）'}`);
    if (pass) ok += 1;
  }
  console.log(`  （ledger-gap 判据自测 ${ok}/${cases.length} 条，条数由本脚本自报：未入账/幽灵行/旧内容审阅三向开火 ＋ 合规对照 ＋ 等量不抵消 ＋ 重复行 ＋ 两消费者不合两支 ＋ 真语料对上 ＋ 两支不可判）`);
  return ok === cases.length ? 0 : 1;
}

// 不可判那两支要测真 CLI：环境变量在模块加载时被读成常量，故重开一份模块实例。
function withEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) { saved[k] = process.env[k]; process.env[k] = overrides[k]; }
  delete require.cache[require.resolve(__filename)];
  let out;
  try { out = fn(require(__filename)); } finally {
    for (const k of Object.keys(overrides)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    delete require.cache[require.resolve(__filename)];
  }
  return out;
}

if (require.main === module) {
  if (process.argv.includes('--self-test')) process.exitCode = selfTest();
  else {
    const r = run();
    for (const n of r.notes) console.log(`  · ${n}`);
    for (const p of r.problems) console.log(`  ✗ ${p}`);
    if (process.argv.includes('--json')) console.log(JSON.stringify(r.data));
    console.log(r.rc === 3 ? '⚠️ 不可判（绝不折算成"一致"）' : (r.rc ? `❌ ${r.problems.length} 项分叉` : '✅ 账本与现扫双向一致'));
    process.exitCode = r.rc;
  }
} else {
  module.exports = { gapOf, reconcile, parseStats, run };
}
