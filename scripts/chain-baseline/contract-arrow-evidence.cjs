#!/usr/bin/env node
/**
 * 一问：契约声明的每条转换（from→to），**有没有一条常驻用例真的走过它**？
 *
 * 与 V152 的分工：`contract-arrows.cjs` 问的是"代码里有没有人这么写"；本量具问
 * "测试面有没有人走过"。两个问题共用同一份契约清单，但语料与档位不同，读数不合并。
 * 这正是目标里"测试是否真正覆盖了这些边界"最细的一层——六场景矩阵量的是场景类（正常/拒绝/重复/超时/断网/重启），
 * 箭头量的是契约逐条声明的迁移。
 *
 * 语料 = 常驻用例：test/e2e 下的 .e2e.spec.ts、server 下的 .spec.ts、client/src 下的 .test.ts(x)、
 * 顶层 tests 下的 .py。注：块注释里不能出现 glob（星号接斜杠会提前结束注释）。
 *
 * 四档（互斥，数须等于箭头数）：
 *   cond-named     用例里出现契约的 condition 词（`reject_and_revise` 这种专有名最硬）
 *   pair-in-file   同一用例文件里来源态与目标态字面量同时出现（**不证明**走了这条边 ⇒ 逐条人工确认）
 *   target-only    只有目标态出现（可能被别的路径写进去）
 *   none           两个词都没出现在任何常驻用例里
 * 边界（照量具纪律，不折算比例）：condition 词是普通英文动词时（`approve`/`submit`/`start`）必然过匹配
 * ⇒ 本量具对"短词"只报命中位置，不据此判"已覆盖"；判"已覆盖"要求 condition 是带下划线的专有名或成对出现。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const { contracts } = require('./contract-arrows.cjs');

function testCorpus() {
  const found = [];
  const push = (p) => { if (fs.existsSync(p)) found.push(p); };
  const walk = (d, keep) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'dist') walk(p, keep); }
      else if (keep(e.name)) found.push(p);
    }
  };
  walk(path.join(ROOT, 'ewoh-spark-app/server'), (n) => n.endsWith('.spec.ts'));
  walk(path.join(ROOT, 'ewoh-spark-app/test'), (n) => n.endsWith('.spec.ts') || n.endsWith('.spec.tsx'));
  walk(path.join(ROOT, 'ewoh-spark-app/client/src'), (n) => /\.test\.tsx?$/.test(n));
  walk(path.join(ROOT, 'tests'), (n) => n.endsWith('.py'));
  const files = [...new Set(found)];
  return files.map((f) => ({
    rel: path.relative(ROOT, f),
    lines: fs.readFileSync(f, 'utf8').split('\n'),
  }));
}

function shortCondition(c) {
  return !c || !/_/.test(c) || c.length <= 8;   // 短/无下划线 ⇒ 易过匹配
}

function classify(arrows, corpus) {
  const rows = [];
  for (const a of arrows) {
    if (!a.states.has(a.to) || !a.states.has(a.from)) {
      rows.push({ ...a, bucket: 'not-a-single-arrow' });
      continue;
    }
    const hits = { cond: [], pair: [], target: [] };
    for (const f of corpus) {
      const text = f.lines.join('\n');
      const toRe = new RegExp(`['"\`]${a.to}['"\`]`);
      const fromRe = new RegExp(`['"\`]${a.from}['"\`]`);
      const hasTo = toRe.test(text);
      const hasFrom = fromRe.test(text);
      const condHit = a.condition ? text.split('\n').map((l, i) => ({ l, i })).filter(({ l }) => !/^\s*(\/\/|#)/.test(l) && l.includes(a.condition)) : [];
      if (condHit.length && !shortCondition(a.condition)) hits.cond.push(`${f.rel}:${condHit[0].i + 1}`);
      else if (condHit.length) hits.cond.push(`(短词，仅记位置)${f.rel}:${condHit[0].i + 1}`);
      if (hasTo && hasFrom) hits.pair.push(f.rel);
      if (hasTo) hits.target.push(f.rel);
    }
    const realCond = hits.cond.filter((x) => !x.startsWith('(短词'));
    const bucket = realCond.length ? 'cond-named'
      : hits.pair.length ? 'pair-in-file'
        : hits.target.length ? 'target-only' : 'none';
    rows.push({ ...a, bucket, cond: realCond.slice(0, 2), pair: hits.pair.slice(0, 3), targetFiles: hits.target.length });
  }
  return rows;
}

const BUCKETS = ['cond-named', 'pair-in-file', 'target-only', 'none', 'not-a-single-arrow'];
function tally(rows) {
  const b = Object.fromEntries(BUCKETS.map((k) => [k, []]));
  for (const r of rows) (b[r.bucket] || (b[r.bucket] = [])).push(r);
  return { b, sum: BUCKETS.reduce((n, k) => n + (b[k] || []).length, 0), total: rows.length };
}
function judge(rows, t, corpus) {
  const problems = [];
  if (!rows.length) problems.push('一条箭头都没解析到 ⇒ 契约清单坏，本轮不出数');
  if (!corpus.length) problems.push('一份常驻用例都没扫到 ⇒ 语料为空，否定读数作废');
  if (t.sum !== t.total) problems.push(`分桶恒等式不成立：${t.sum} ≠ ${t.total} ⇒ 读数作废`);
  return { ok: problems.length === 0, problems };
}

function flatten(cs) {
  const all = [];
  for (const c of cs) all.push(...c.arrows.map((a) => ({ ...a, states: c.states })));
  return all;
}

function selfTest() {
  const states = new Set(['pending_review', 'approved']);
  const arrows = [{ file: 'f.yaml', from: 'pending_review', to: 'approved', condition: 'approve_and_seal', states }];
  const withCond = [{ rel: 'a.spec.ts', lines: ["  it('approve_and_seal 走一遍', async () => {", "    expect(row.status).toBe('approved');", '  });'] }];
  const pairOnly = [{ rel: 'b.spec.ts', lines: ["  const before = 'pending_review';", "  expect(after).toBe('approved');"] }];
  const targetOnly = [{ rel: 'c.spec.ts', lines: ["  expect(after).toBe('approved');"] }];
  const none = [{ rel: 'd.spec.ts', lines: ['  expect(1).toBe(1);'] }];
  const cases = [
    ['E1 condition 专有名出现 ⇒ cond-named（注入必须开火）', withCond, 'cond-named'],
    ['E2 来源+目标同文件 ⇒ pair-in-file', pairOnly, 'pair-in-file'],
    ['E3 只有目标态 ⇒ target-only（撤销掉来源后不得再算成对）', targetOnly, 'target-only'],
    ['E4 两个词都没有 ⇒ none（这条否定必须能开火）', none, 'none'],
  ];
  let bad = 0;
  for (const [name, corpus, want] of cases) {
    const rows = classify(arrows, corpus);
    const ok = rows.length === 1 && rows[0].bucket === want;
    if (!ok) bad += 1;
    console.log(`  ${ok ? '✔' : '✕'} ${name} → ${rows[0].bucket}`);
  }
  const empty = judge([], tally([]), []);
  const okEmpty = empty.problems.some((p) => p.includes('一条箭头都没解析到') || p.includes('语料为空'));
  if (!okEmpty) bad += 1;
  console.log(`  ${okEmpty ? '✔' : '✕'} E5 空契约/空语料 ⇒ 拒出数`);
  const shortOnly = classify([{ file: 'f.yaml', from: 'pending_review', to: 'approved', condition: 'approve', states }],
    [{ rel: 'e.spec.ts', lines: ["  // approve 只是注释里出现", "  expect(x).toBe('approved');"] }]);
  const okShort = shortOnly[0].bucket === 'target-only';   // 短词+注释行 ⇒ 不得判成已覆盖
  if (!okShort) bad += 1;
  console.log(`  ${okShort ? '✔' : '✕'} E6 短 condition 且只命中注释 ⇒ 不得判 cond-named → ${shortOnly[0].bucket}`);
  const n = cases.length + 2;
  console.log(`箭头测试面判据自测：${n - bad}/${n} 抓到`);
  return bad === 0;
}

function main() {
  if (process.argv.includes('--self-test')) process.exit(selfTest() ? 0 : 3);
  const cs = contracts();
  const corpus = testCorpus();
  const rows = classify(flatten(cs), corpus);
  const t = tally(rows);
  const v = judge(rows, t, corpus);
  console.log(`语料：${cs.length} 份契约 ${rows.length} 条单态箭头；常驻用例文件 ${corpus.length} 份（e2e spec / 服务端 spec / client test / 顶层 python tests）`);
  for (const r of rows) {
    console.log(`  ${r.file} ${r.from}→${r.to}${r.condition ? ` (${r.condition})` : ''} → ${r.bucket}`
      + `${r.cond && r.cond.length ? `  证据:${r.cond.join(' ')}` : ''}`
      + `${r.pair && r.pair.length ? `  同现文件:${r.pair.join(' ')}` : ''}`);
  }
  console.log('分桶（互斥，须对上）：' + BUCKETS.map((k) => `${k} ${(t.b[k] || []).length}`).join('｜') + `｜合计 ${t.sum}/${t.total}`);
  console.log('边界：pair-in-file 只证明同一用例文件里两个状态字面量都出现，**不证明走过这条边**；none 的每条都要人工确认是不是被别的写法（枚举/模板串/客户端名）绕过。');
  if (!v.ok) { for (const p of v.problems) console.error(`FAIL contract_arrow_evidence：${p}`); process.exit(1); }
  fs.writeFileSync(path.join(ROOT, 'tmp', 'contract-arrow-evidence.json'),
    JSON.stringify({ rows, none: (t.b.none || []).map((r) => `${r.file} ${r.from}→${r.to}`) }, null, 2) + '\n');
  console.log('机器可读：tmp/contract-arrow-evidence.json');
}
if (require.main === module) main();
module.exports = { classify, tally, judge, testCorpus };
