#!/usr/bin/env node
/**
 * 一问：试点这 N 件度量/机检量具，在**没有链级基线集群、没有网络**的执行机上，哪些今天就能跑出数？
 *
 * 为什么要问：CI-05（㉔）说"试点量具的 CI 执行面为 0"，但"接进流水线"这件事的代价没人量过——
 * 有多少件需要给 job 加一个 Postgres 服务、多少件只要仓库自身、多少件会静默假绿。
 * 没有这个数，裁决只能凭印象。本轮**只测不改**：不碰任何 CI workflow，不装任何依赖。
 *
 * 清单不手抄：目标名一律**向 `instrument-surface.cjs` 的 analyze() 要**（权威只有一份）。
 * V348（CCOST-01）：这里原先靠正则抓那份文件里的 `const INSTRUMENTS = [...]` 手写名单，
 * 而 V347 把分母改成 Makefile 现抽、那张表整张删掉 ⇒ 本尺当场「解析不到 INSTRUMENTS」拒出数（rc=2）。
 * 拒得响亮是对的（没静默退回空清单），但**改真值形状时没数它的消费者**这一刀归本轮修：
 * 现在取的是执行面尺的分母本体（55 件），不再是一份可与它分叉的第二名单。
 * 分类互斥、五桶数必须对得上（对不上即读数作废）：
 *   ready        无外部依赖，直接出数（rc=0 且输出无失败签名）
 *   needs-db     输出/自报里有连接失败签名 ⇒ 需给 job 配 Postgres 服务
 *   needs-dep    `Cannot find module` 一类 ⇒ 需先装依赖
 *   failed       其余非零/超时 ⇒ 逐条列出，不折算成比例
 *   not-measured 本轮显式跳过的（带理由），**不算任何一桶的证据**
 *
 * 关键判据：**rc=0 不等于可接**——一件"连不上库就打印空表并退 0"的量具会伪装成 ready（V145 同族）。
 * 所以 needs-db 只看输出签名，不看 rc；--self-test 的第一条注入就是"rc=0 但输出含连接失败"。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const SURFACE = path.join(__dirname, 'instrument-surface.cjs');
const PER_TARGET_TIMEOUT_MS = Number(process.env.CI_COST_TIMEOUT_MS || 180_000);

// 本轮显式不跑的重件（理由写出来，不折算进任何桶）
const NOT_MEASURED = {
  'unit-triage': '跑全量后端单测（≈10 分钟级），本轮只量"接线代价"不量用例存量，跳过并如实标注',
  'chain-baseline-negative-control': '它体内会反复注入并跑多条门禁（分钟级），且已在 audit-regression-gates 内常驻，跳过',
};

const DB_SIGNATURES = [
  /connect ECONNREFUSED/i, /Connection closed/i, /verify access/i,
  /no connection could be made/i, /连不上/, /无法连接/, /ECONNREFUSED/,
];
const DEP_SIGNATURES = [/Cannot find module '(?![-.\\/])/];

function instrumentList(surfacePath = SURFACE, root = ROOT) {
  let surface;
  try { surface = require(surfacePath); }
  catch (error) { throw new Error(`读不到执行面尺 ${path.basename(surfacePath)} ⇒ 权威清单缺失，不出数：${error.message}`); }
  if (!surface || typeof surface.analyze !== 'function') {
    throw new Error('执行面尺没有导出 analyze()（V347 起分母由它现抽）⇒ 权威清单缺失，不出数');
  }
  let rows;
  try { rows = surface.analyze(root).rows; }
  catch (error) { throw new Error(`执行面尺 analyze() 在 ${root} 上抛错 ⇒ 不出数：${error.message}`); }
  if (!Array.isArray(rows)) throw new Error('analyze() 没返回 rows 数组 ⇒ 分母不成立，不出数');
  const names = rows.map((r) => r.target);
  if (names.length < 10) throw new Error(`分母只解析到 ${names.length} 件，分母不成立`);
  return names;
}

/** 纯函数：一条运行记录 → 桶。判据只看签名，不看 rc（rc 绿不代表可接）。 */
function classify(rec) {
  if (rec.skipped) return 'not-measured';
  const out = `${rec.stdout || ''}\n${rec.stderr || ''}`;
  if (DB_SIGNATURES.some((re) => re.test(out))) return 'needs-db';
  if (DEP_SIGNATURES.some((re) => re.test(out))) return 'needs-dep';
  if (rec.timedOut) return 'failed';
  if (rec.rc === 0) return 'ready';
  return 'failed';
}

function tally(records) {
  const buckets = { ready: [], 'needs-db': [], 'needs-dep': [], failed: [], 'not-measured': [] };
  for (const r of records) buckets[classify(r)].push(r.target);
  const sum = Object.values(buckets).reduce((n, x) => n + x.length, 0);
  return { buckets, sum, total: records.length };
}

function run(target) {
  const t0 = Date.now();
  const res = spawnSync('make', [target], { cwd: ROOT, encoding: 'utf8', timeout: PER_TARGET_TIMEOUT_MS });
  const timedOut = !!(res.error && /ETIMEDOUT|timed out/i.test(String(res.error.message || res.error)));
  return {
    target,
    rc: timedOut ? null : res.status,
    seconds: Math.round((Date.now() - t0) / 1000),
    timedOut,
    stdout: String(res.stdout || '').slice(-4000),
    stderr: String(res.stderr || '').slice(-2000),
  };
}

function judge(records, buckets, t) {
  const problems = [];
  if (!records.length) problems.push('一条运行记录都没有 ⇒ 本轮不出数');
  if (t.sum !== t.total) problems.push(`分桶对不上：${t.sum} ≠ ${t.total} ⇒ 读数作废`);
  const readyButSlow = records.filter((r) => classify(r) === 'ready' && r.seconds > 120).map((r) => `${r.target}(${r.seconds}s)`);
  if (readyButSlow.length) problems.push(`标为 ready 但单件超 120s，接 CI 前需先确认：${readyButSlow.join(' ; ')}`);
  return { ok: problems.length === 0, problems };
}

function selfTest() {
  const cases = [
    { name: 'C1 rc=0 但输出含 ECONNREFUSED ⇒ 必须判 needs-db（不得当成 ready）', rec: { target: 'x', rc: 0, stdout: 'ERROR: connect ECONNREFUSED 127.0.0.1:55432' }, want: 'needs-db' },
    { name: 'C2 rc=1 且 Cannot find module ⇒ needs-dep', rec: { target: 'y', rc: 2, stderr: "Cannot find module 'postgres'" }, want: 'needs-dep' },
    { name: 'C3 干净记录 ⇒ ready（撤销不开火的正向）', rec: { target: 'z', rc: 0, stdout: '结论：无漂移' }, want: 'ready' },
    { name: 'C4 超时 ⇒ failed（超时不算 ready 也不算 needs-db）', rec: { target: 'w', rc: null, timedOut: true, stdout: '' }, want: 'failed' },
    { name: 'C5 显式跳过 ⇒ not-measured，且不得混进 ready', rec: { target: 'v', skipped: true }, want: 'not-measured' },
  ];
  let bad = 0;
  for (const c of cases) {
    const got = classify(c.rec);
    const ok = got === c.want;
    if (!ok) bad += 1;
    console.log(`  ${ok ? '✔' : '✕'} ${c.name} → ${got}`);
  }
  const empty = judge([], { ready: [], 'needs-db': [], 'needs-dep': [], failed: [], 'not-measured': [] }, { sum: 0, total: 0 });
  const okEmpty = empty.problems.some((p) => p.includes('一条运行记录都没有'));
  if (!okEmpty) bad += 1;
  console.log(`  ${okEmpty ? '✔' : '✕'} C6 空清单 ⇒ 拒出数`);
  const skew = tally([{ target: 'a', rc: 0, stdout: '' }, { target: 'b', skipped: true }]);
  const okSum = skew.sum === skew.total;
  if (!okSum) bad += 1;
  console.log(`  ${okSum ? '✔' : '✕'} C7 分桶恒等式（${skew.sum}=${skew.total}）`);
  /* 清单来源四臂（V348，CCOST-01）。C9 正是本轮真踩的那一刀：执行面尺把分母改成 Makefile 现抽之后，
     本尺还在用正则抓那张已被删掉的手写名单，于是当场拒出数（rc=2）。把它钉成常驻对照——
     「只剩名单、没有 analyze」的文件必须**出不了数**，而不是悄悄从别处再搓一份名单。 */
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccost-'));
  let armCount = 0, armBad = 0;
  try {
    const oldShape = path.join(tmp, 'old-shape.cjs');
    fs.writeFileSync(oldShape, 'const INSTRUMENTS = ['
      + Array.from({ length: 11 }, (_, i) => `'t${i}'`).join(',') + '];\nmodule.exports = { INSTRUMENTS };\n');
    const tinyShape = path.join(tmp, 'tiny-shape.cjs');
    fs.writeFileSync(tinyShape, "module.exports = { analyze: () => ({ rows: [{target:'a'},{target:'b'},{target:'c'}] }) };\n");
    const arms = [
      { name: 'C8 真树上本尺名单必须与执行面尺的分母逐字相同，且 V346/V347 新建的两件都在（隐身即开火）',
        run: () => {
          const n = instrumentList();
          const s = require(SURFACE).analyze(ROOT).rows.map((r) => r.target);
          if (n.join('|') !== s.join('|')) throw new Error(`与执行面尺分母不同名（${n.length} vs ${s.length}）`);
          for (const t of ['chain-baseline-instrument-surface', 'chain-baseline-ledger-gap']) {
            if (!n.includes(t)) throw new Error(`名单里没有 ${t}（新量具对代价量具隐身）`);
          }
          return `${n.length} 件，两件新量具都在`;
        } },
      { name: 'C9 旧形状（只有 INSTRUMENTS 数组、无 analyze 导出）⇒ 必须抛错，不许退回任何第二名单',
        run: () => {
          try { const n = instrumentList(oldShape); throw new Error(`旧形状竟然出了数（${n.length} 件）`); }
          catch (e) { if (!/没有导出 analyze/.test(e.message)) throw new Error(`抛了但不是这条判据：${e.message}`); return '拒出数'; }
        } },
      { name: 'C10 analyze 只回 3 行 ⇒ 分母不成立必须抛错（小分母不得冒充干净）',
        run: () => {
          try { const n = instrumentList(tinyShape); throw new Error(`3 件的分母出了数（${n.length}）`); }
          catch (e) { if (!/分母不成立/.test(e.message)) throw new Error(`抛了但不是这条判据：${e.message}`); return '拒出数'; }
        } },
      { name: 'C11 执行面尺路径指空 ⇒ 必须抛错（读不到文件≠零件干净）',
        run: () => {
          try { instrumentList(path.join(tmp, 'not-here.cjs')); throw new Error('路径指空还出了数'); }
          catch (e) { if (!/读不到执行面尺/.test(e.message)) throw new Error(`抛了但不是这条判据：${e.message}`); return '拒出数'; }
        } },
    ];
    for (const a of arms) {
      armCount += 1;
      try { console.log(`  ✔ ${a.name} → ${a.run()}`); }
      catch (e) { armBad += 1; console.log(`  ✕ ${a.name} → ${e.message}`); }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const total = cases.length + 2 + armCount;
  const badAll = bad + armBad;
  console.log(`接线代价判据自测：${total - badAll}/${total} 抓到（条数由本脚本自报：五桶签名 ${cases.length}`
    + ` ＋ 拒出数/恒等式 2 ＋ 清单来源 ${armCount} 臂）`);
  return badAll === 0;
}

function main() {
  if (process.argv.includes('--self-test')) process.exit(selfTest() ? 0 : 3);
  let targets;
  try {
    targets = instrumentList();
  } catch (error) {
    console.error(`FAIL ci_onboarding_cost：${error.message}`);
    process.exit(2);
  }
  const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);
  const list = only ? only.split(',').filter((x) => targets.includes(x)) : targets;
  if (only && !list.length) { console.error('FAIL ci_onboarding_cost：--only 没解析到任何在清单内的目标'); process.exit(2); }
  const records = [];
  console.log(`执行条件：链级基线集群**未启动**、不装任何依赖、不碰 CI workflow；单件上限 ${Math.round(PER_TARGET_TIMEOUT_MS / 1000)}s`);
  for (const target of list) {
    if (NOT_MEASURED[target] && !only) {
      records.push({ target, skipped: true, reason: NOT_MEASURED[target] });
      console.log(`  ${target}  跳过（${NOT_MEASURED[target]}）`);
      continue;
    }
    const r = run(target);
    records.push(r);
    console.log(`  ${target}  rc=${r.rc ?? 'timeout'} ${r.seconds}s  → ${classify(r)}`);
  }
  const t = tally(records);
  const v = judge(records, t.buckets, t);
  console.log('分桶（互斥，数须对上）：'
    + `ready ${t.buckets.ready.length}｜needs-db ${t.buckets['needs-db'].length}`
    + `｜needs-dep ${t.buckets['needs-dep'].length}｜failed ${t.buckets.failed.length}`
    + `｜not-measured ${t.buckets['not-measured'].length}｜合计 ${t.sum}/${t.total}`);
  for (const [k, arr] of Object.entries(t.buckets)) if (arr.length) console.log(`  ${k}: ${arr.join(' ')}`);
  if (!v.ok) {
    for (const p of v.problems) console.error(`FAIL ci_onboarding_cost：${p}`);
    process.exit(1);
  }
  fs.writeFileSync(path.join(ROOT, 'tmp', 'ci-onboarding-cost.json'), JSON.stringify(records.map((r) => ({
    target: r.target, bucket: classify(r), rc: r.rc ?? null, seconds: r.seconds ?? null, reason: r.reason || null,
  })), null, 2) + '\n');
  console.log('机器可读：tmp/ci-onboarding-cost.json（本轮只测不改：未动任何 .github/workflows，未装任何依赖）');
}

if (require.main === module) main();
module.exports = { classify, tally, judge, instrumentList };
