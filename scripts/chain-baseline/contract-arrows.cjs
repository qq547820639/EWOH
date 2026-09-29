#!/usr/bin/env node
/**
 * 一问：`contracts/state-machines/*.yaml` 里**每一条声明的转换**（from→to），代码里有没有一处写它的地方？
 *
 * 为什么还缺这一问：试点已经把状态机的三件事分别量过——词表（主线9 的写入位点棘轮）、
 * 谁能改（DB 授权层 + 写入口扇出）、事件三面（EVT-02/03/04/05）。
 * 但**箭头本身**没人量过：契约声明"从 A 到 B"，可能全仓根本没有一处把状态从 A 写成 B
 * （声明了却不可达），也可能写了却不检查来源（任何人都能直接落终态）。
 * 这两个方向正是目标里"谁能修改哪类事实 / 测试是否覆盖这些边界"的交点。
 *
 * 读数分五档（互斥，数必须等于箭头数）：
 *   guard+write   同文件里既写了目标态、也出现过把来源态当条件的写法（**不等于**证明是 CAS ⇒ 逐条人工确认）
 *   write-only    写了目标态，但该文件里找不到来源态作为条件
 *   no-write      全仓没有任何一处写目标态 ⇒ 这条箭头声明了但不可达（或只由 DB 默认值/迁移产生）
 *   any-source    来源写的是 `any`：单独一档，不和上面混算
 *   to-not-a-state 目标态不在该契约的 states 清单里 ⇒ 契约自身不自洽
 *
 * 语料边界（照量具纪律：静态拿不到的只报边界，不折算比例）：
 *   · 只扫 `ewoh-spark-app/server` 的 .ts（非 spec）；状态字符串必须**带引号字面量**出现才算写；
 *   · 经变量/枚举/模板串写入的状态看不见 ⇒ 那一档只报"看不见多少处写"，不并进任何比例；
 *   · 客户端/边缘 Python 侧的写法不在本量具问题域内（另档）。
 *
 * 三件对照（缺任何一件本轮不出数，--self-test 跑）：
 *   K1 注入一条"目标态从不被写"的契约 ⇒ 必须落 no-write（否定必须开火）；
 *   K2 把那个目标态在某夹具文件里写一次 ⇒ 必须离开 no-write（撤销必须不开火）；
 *   K3 目标态不在 states 清单 ⇒ 必须单独成档，不得被 no-write 吸收。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const ROOT = path.resolve(__dirname, '../..');
const SM = path.join(ROOT, 'contracts', 'state-machines');
const SRV = path.join(ROOT, 'ewoh-spark-app', 'server');
const req = createRequire(path.join(ROOT, 'ewoh-spark-app', 'package.json'));
const yaml = req('js-yaml');

function readCorpus() {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'dist') walk(p); }
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')) files.push(p);
    }
  };
  walk(SRV);
  return files.map((f) => ({
    rel: path.relative(ROOT, f),
    text: fs.readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n'),
  }));
}

function contracts() {
  return fs.readdirSync(SM).filter((f) => f.endsWith('.yaml')).sort().map((f) => {  // 解析失败即抛出：契约读不出来就不出数
    // 只用核心 JSON schema 解析（不构造任意类型），并把结构显式校验成"字符串列表 + 对象列表"
    const doc = yaml.load(fs.readFileSync(path.join(SM, f), 'utf8'), { schema: yaml.JSON_SCHEMA });
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`${f} 顶层不是映射`);
    if (!Array.isArray(doc.states) || !doc.states.every((x) => typeof x === 'string')) throw new Error(`${f} states 不是字符串列表`);
    if (!Array.isArray(doc.transitions) || !doc.transitions.every((x) => x && typeof x === 'object' && !Array.isArray(x))) throw new Error(`${f} transitions 不是对象列表`);
    const states = new Set(doc.states.map(String));
    const arrows = doc.transitions.map((t) => ({
      file: f, from: String(t.from), to: String(t.to),
      condition: t.condition ? String(t.condition) : null, role: t.role ? String(t.role) : null,
    }));
      return { file: f, states, arrows, terminal: Array.isArray(doc.terminal) ? doc.terminal.map(String) : [] };
  });
}

/** 纯函数：契约箭头 × 代码语料 → 五档。 */
function classify(arrows, corpus) {
  return arrows.map((a) => {
    if (!a.states.has(a.to)) return { ...a, bucket: 'to-not-a-state' };
    if (!a.states.has(a.from)) return { ...a, bucket: 'from-not-a-state' };   // any / any_non_terminal 等伪来源
    if (a.from === 'any') {
      const w = corpus.filter((c) => new RegExp(`['"]${a.to}['"]`).test(c.text));
      return { ...a, bucket: 'any-source', writers: w.map((x) => x.rel).slice(0, 6) };
    }
    const re = new RegExp(`['"]${a.to}['"]`);
    const hit = corpus.filter((c) => re.test(c.text));
    if (!hit.length) return { ...a, bucket: 'no-write', writers: [] };
    const guardRe = new RegExp(`(where|eq\\(|===|status\\s*[:=]|\\bfrom\\b)[^\\n]{0,80}['"]${a.from}['"]`);
    const guarded = hit.filter((c) => guardRe.test(c.text));
    return {
      ...a,
      bucket: guarded.length ? 'guard+write' : 'write-only',
      writers: hit.map((x) => x.rel).slice(0, 6),
      guardedBy: guarded.map((x) => x.rel).slice(0, 4),
    };
  });
}

const BUCKETS = ['guard+write', 'write-only', 'no-write', 'any-source', 'to-not-a-state', 'from-not-a-state'];

function tally(rows) {
  const b = Object.fromEntries(BUCKETS.map((k) => [k, []]));
  for (const r of rows) (b[r.bucket] || (b[r.bucket] = [])).push(r);
  return { b, sum: BUCKETS.reduce((n, k) => n + (b[k] || []).length, 0), total: rows.length };
}

function judge(rows, t, contractsMeta) {
  const problems = [];
  if (!rows.length) problems.push('一条箭头都没解析到 ⇒ 契约或解析坏了，本轮不出数');
  if (t.sum !== t.total) problems.push(`分桶恒等式不成立：${t.sum} ≠ ${t.total} ⇒ 读数作废`);
  if (!contractsMeta.length || contractsMeta.length < 4) problems.push(`契约文件只解析到 ${contractsMeta.length} 份，分母可疑`);
  return { ok: problems.length === 0, problems };
}

function run(contractsList, corpus) {
  const all = [];
  for (const c of contractsList) all.push(...c.arrows.map((a) => ({ ...a, states: c.states })));
  const rows = classify(all, corpus);
  return { rows, t: tally(rows) };
}

function selfTest() {
  const corpus = [
    { rel: 'fake/a.service.ts', text: "        .set({ status: 'approved' })\n        .where(eq(t.status, 'pending_review'))\n" },
    { rel: 'fake/b.service.ts', text: "        .set({ status: 'simulating' })\n" },
  ];
  const cs = [{
    file: 'fake.yaml',
    states: new Set(['pending_review', 'approved', 'simulating', 'gone', 'shadow']),
    terminal: [],
    arrows: [
      { file: 'fake.yaml', from: 'pending_review', to: 'approved', bucketHint: 'guard+write' },
      { file: 'fake.yaml', from: 'shadow', to: 'simulating', bucketHint: 'write-only' },
      { file: 'fake.yaml', from: 'approved', to: 'gone', bucketHint: 'no-write（K1 注入：目标态从不被写）' },
      { file: 'fake.yaml', from: 'any', to: 'approved', bucketHint: 'from-not-a-state（伪来源单独成档）' },
    ],
  }];
  const { rows, t } = run(cs, corpus);
  const want = ['guard+write', 'write-only', 'no-write', 'from-not-a-state'];
  let bad = 0;
  rows.forEach((r, i) => {
    const ok = r.bucket === want[i];
    if (!ok) bad += 1;
    console.log(`  ${ok ? '✔' : '✕'} K0/${i} ${r.from}→${r.to} → ${r.bucket}（期望 ${want[i]}）`);
  });
  // K2：把目标态 'gone' 写进语料 ⇒ 必须离开 no-write
  const k2 = run(cs, corpus.concat([{ rel: 'fake/c.service.ts', text: "set({ status: 'gone' })" }]));
  const k2row = k2.rows.find((r) => r.to === 'gone');
  const ok2 = k2row.bucket !== 'no-write';
  if (!ok2) bad += 1;
  console.log(`  ${ok2 ? '✔' : '✕'} K2 注入一次写之后必须离开 no-write → ${k2row.bucket}`);
  // K3：目标态不在 states 清单 ⇒ 必须单独成档
  const cs3 = [{ ...cs[0], arrows: [{ file: 'fake.yaml', from: 'pending_review', to: 'notdeclared' }], states: new Set(['pending_review']) }];
  const k3 = run(cs3, corpus).rows[0];
  const ok3 = k3.bucket === 'to-not-a-state';
  if (!ok3) bad += 1;
  console.log(`  ${ok3 ? '✔' : '✕'} K3 未声明的目标态必须单独成档 → ${k3.bucket}`);
  // K4：伪来源（any_non_terminal 这类不在 states 里的 from）必须单独成档，不得被 write-only 吸收
  const cs4 = [{ ...cs[0], arrows: [{ file: 'fake.yaml', from: 'any_non_terminal', to: 'approved' }], states: new Set(['pending_review', 'approved']) }];
  const k4 = run(cs4, corpus).rows[0];
  const ok4 = k4.bucket === 'from-not-a-state';
  if (!ok4) bad += 1;
  console.log(`  ${ok4 ? '✔' : '✕'} K4 伪来源必须单独成档（第一版把它算成 write-only）→ ${k4.bucket}`);
  // 恒等式
  const okSum = t.sum === t.total;
  const n = rows.length + 4;   // 4 格逐档 + K2 + K3 + K4 + 恒等式
  const okIdentity = t.sum === t.total;
  if (!okIdentity) bad += 1;
  console.log(`  ${okIdentity ? '✔' : '✕'} 恒等式：${t.sum}/${t.total}`);
  console.log(`契约箭头判据自测：${n - bad}/${n} 抓到`);
  return bad === 0;
}

function main() {
  if (process.argv.includes('--self-test')) process.exit(selfTest() ? 0 : 3);
  const cs = contracts();
  const corpus = readCorpus();
  const { rows, t } = run(cs, corpus);
  const v = judge(rows, t, cs);
  console.log(`语料：${cs.length} 份契约、${rows.length} 条箭头；服务端 .ts（非 spec）${corpus.length} 个文件（注释行已剔除）`);
  for (const r of rows) {
    console.log(`  ${r.file} ${r.from}→${r.to}${r.condition ? ` (${r.condition})` : ''} → ${r.bucket}`
      + `${r.writers && r.writers.length ? `  写点:${r.writers.slice(0, 3).join(' ')}${r.writers.length > 3 ? ` +${r.writers.length - 3}` : ''}` : ''}`
      + `${r.guardedBy && r.guardedBy.length ? `  来源态同现于:${r.guardedBy.join(' ')}` : ''}`);
  }
  console.log('分桶（互斥，须对上）：' + BUCKETS.map((k) => `${k} ${(t.b[k] || []).length}`).join('｜') + `｜合计 ${t.sum}/${t.total}`);
  console.log('边界：guard+write 只证明"同文件里既写了目标态也出现过来源态"，**不证明是 CAS**；经变量/枚举写入的状态看不见 ⇒ 不折算比例，no-write 的每一条都要人工确认是否只由迁移/默认值产生。');
  if (!v.ok) { for (const p of v.problems) console.error(`FAIL contract_arrows：${p}`); process.exit(1); }
  fs.writeFileSync(path.join(ROOT, 'tmp', 'contract-arrows.json'), JSON.stringify({ rows, buckets: Object.fromEntries(BUCKETS.map((k) => [k, (t.b[k] || []).map((r) => `${r.file} ${r.from}→${r.to}`)])) }, null, 2) + '\n');
  console.log('机器可读：tmp/contract-arrows.json');
}

if (require.main === module) main();
module.exports = { classify, tally, judge, contracts };
