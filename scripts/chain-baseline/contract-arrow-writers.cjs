#!/usr/bin/env node
/*
 * V163 量具：状态机契约里**每个目标态到底有几处"写形状"**（AST 值位置，不是按名字出现）。
 *
 * 为什么要另建一根尺（已证实）：`contract-arrows.cjs` 的写侧判据是
 *   `new RegExp("['\"]" + to + "['\"]").test(文件全文)`
 * ⇒ 只要那个状态名在**任何文件的任何位置**带引号出现过，就判"有写点"。
 * 后果：它的 `no-write` 桶在真语料上**永远不会开火**（今天报 0 不可达），
 * 而 plan.yaml 的 `simulating`/`pending_review` 实际只在 `ai.service.ts:52` 的**联合类型标注**里出现——
 * 那是"允许值声明"，不是构造点。K1 自测注入的是一个仓内根本不存在的名字（'gone'），
 * 所以"能红"不等于"会判"：阳性对照不真实 ⇒ 判据半边是空的。
 *
 * 本尺只认两种值位置：对象字面量属性初始化、赋值右侧。比较（`===`）、Drizzle 谓词（`eq(col,'x')`）、
 * 数组清单、类型联合、`case` 标签一律不算写。看不见经变量/枚举/展开写出的态 ⇒ 报**下界**，不折算比例。
 *
 * 三件对照 + 两支反向（--self-test 全跑，任一不过退出码非零）：
 *   K1 `simulating` 在产品语料必须 0（真实阳性：只有联合类型成员）
 *   K2 `approved`  必须 ≥1（正向：量具会开火）
 *   K3 注入对象字面量 `status:'simulating'` ⇒ 必须变 1；撤销 ⇒ 必须回 0
 *   K4 注入联合类型 `status:'a'|'simulating'` ⇒ 必须**仍 0**（V152 假阳性的来源形状）
 *   K5 注入 `===` 比较与 `eq(col,'simulating')` 谓词 ⇒ 必须仍 0
 *   K6 注入赋值 `x.status = 'simulating'` ⇒ 必须变 1
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const ROOT = path.resolve(__dirname, '../..');
const SM = path.join(ROOT, 'contracts', 'state-machines');
const SRV = path.join(ROOT, 'ewoh-spark-app', 'server');
const req = createRequire(path.join(ROOT, 'ewoh-spark-app', 'package.json'));
const ts = req('typescript');
const yaml = req('js-yaml');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules' && e.name !== 'dist') walk(p, out);
    } else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')) out.push(p);
  }
  return out;
}

/** 一个文件里"写到某状态名"的值位置计数（含形状标注，便于人工回看）。 */
function writesIn(file) {
  const text = fs.readFileSync(file, 'utf8');
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found = [];
  const lit = (n) =>
    n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null;
  const visit = (n) => {
    if (ts.isPropertyAssignment(n)) {
      const v = lit(n.initializer);
      if (v) found.push({ state: v, shape: 'object-literal', name: n.name && n.name.getText() });
    } else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const v = lit(n.right);
      if (v) found.push({ state: v, shape: 'assignment', name: n.left.getText() });
    }
    ts.forEachChild(n, visit);
    return undefined; // 关键：访问函数不得返回真值，否则 forEachChild 会提前停止遍历
  };
  visit(src);
  return found;
}

function corpusWriters(files) {
  const byState = new Map();
  for (const f of files) {
    for (const w of writesIn(f)) {
      if (!byState.has(w.state)) byState.set(w.state, []);
      byState.get(w.state).push({ rel: path.relative(ROOT, f), shape: w.shape, name: w.name });
    }
  }
  return byState;
}

function contractStates() {
  return fs
    .readdirSync(SM)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((f) => {
      const doc = yaml.load(fs.readFileSync(path.join(SM, f), 'utf8'), { schema: yaml.JSON_SCHEMA });
      const states = Array.isArray(doc.states) ? doc.states.map(String) : [];
      const arrows = Array.isArray(doc.transitions) ? doc.transitions : [];
      return { file: f, states, arrows: arrows.map((t) => ({ from: String(t.from), to: String(t.to) })) };
    });
}

function main() {
  const files = walk(SRV);
  const w = corpusWriters(files);
  const cs = contractStates();
  const rows = [];
  for (const c of cs) {
    for (const s of c.states) {
      rows.push({ file: c.file, kind: 'state', name: s, writers: w.get(s) || [] });
    }
    for (const a of c.arrows) {
      const tw = w.get(a.to) || [];
      rows.push({
        file: c.file,
        kind: 'arrow',
        name: `${a.from}→${a.to}`,
        writers: tw,
        verdict: tw.length ? 'target-has-value-position-writes' : 'target-has-no-writer',
      });
    }
  }
  const noWriter = rows.filter((r) => r.kind === 'state' && !r.writers.length);
  const arrowsNoWriter = rows.filter((r) => r.kind === 'arrow' && r.verdict === 'target-has-no-writer');
  console.log(`语料：${files.length} 个 .ts（server 全量，去 spec/注释外不筛），状态名 ${rows.filter(r => r.kind === 'state').length} 个`);
  console.log(`目标态零"值位置写"的状态 ${noWriter.length} 个：${noWriter.map((r) => `${r.file}:${r.name}`).join(' ') || '（无）'}`);
  console.log(`按声明箭头看：目标态零写的箭头 ${arrowsNoWriter.length} 条：${arrowsNoWriter.map((r) => `${r.file} ${r.name}`).join(' ') || '（无）'}`);
  for (const r of rows.filter((x) => x.kind === 'state' && x.writers.length <= 2 && x.name.match(/^(simulating|pending_review|shadow)$/))) {
    console.log(`  逐条 ${r.file} ${r.name} → 写 ${r.writers.length} 处 ${r.writers.slice(0, 2).map((x) => `${x.rel}(${x.shape}:${x.name})`).join(' ')}`);
  }
  fs.writeFileSync(
    path.join(ROOT, 'tmp', 'contract-arrow-writers.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), corpusFiles: files.length, rows }, null, 2) + '\n',
  );
  console.log('机器可读：tmp/contract-arrow-writers.json');
}

function fixture(dir, name, text) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, text);
  return p;
}

function selfTest() {
  const dir = fs.mkdtempSync('/tmp/ewoh-arrow-writers-');
  const cs = contractStates();
  const plan = cs.find((c) => c.file === 'plan.yaml');
  if (!plan || !plan.states.includes('simulating')) {
    console.log('✕ K0 契约读不到 plan.yaml/states ⇒ 不出数');
    process.exit(1);
  }
  const real = corpusWriters(walk(SRV));
  const results = [];
  const sim = (real.get('simulating') || []).length;
  results.push(['K1 真实阳性：simulating 必须 0 处值位置写（只在联合类型里）', sim === 0, `${sim} 处`]);
  const appr = (real.get('approved') || []).length;
  results.push(['K2 正向对照：approved 必须 ≥1 处', appr >= 1, `${appr} 处`]);

  const t1 = fixture(dir, 'write_object.ts', "export const a = { status: 'simulating' } as const;\n");
  const t2 = fixture(dir, 'write_union.ts', "export type T = { status: 'a' | 'simulating' };\n");
  const t3 = fixture(dir, 'write_readonly.ts', "import { eq } from 'drizzle-orm';\nexport const b = (col: any, x: any) => [eq(col, 'simulating'), x === 'simulating' ? 1 : 0];\n");
  const t4 = fixture(dir, 'write_assign.ts', "export function f(x: any) { x.status = 'simulating'; }\n");
  const cnt = (files) => (corpusWriters(files).get('simulating') || []).length;
  const base = cnt([t2, t3]);
  results.push(['K4 反向对照：只加**联合类型** ⇒ 必须仍 0', base === 0, `${base} 处`]);
  results.push(['K5 反向对照：只加 `===` 比较与 eq() 谓词 ⇒ 必须仍 0', cnt([t3]) === 0, `${cnt([t3])} 处`]);
  results.push(['K3 注入对象字面量写 ⇒ 必须 1', cnt([t1]) === 1, `${cnt([t1])} 处`]);
  results.push(['K6 注入赋值写 ⇒ 必须 1', cnt([t4]) === 1, `${cnt([t4])} 处`]);
  results.push(['K3b 撤销注入（只留联合+比较） ⇒ 必须回 0', cnt([t2, t3]) === 0, `${cnt([t2, t3])} 处`]);
  fs.rmSync(dir, { recursive: true, force: true });

  let ok = true;
  for (const [name, pass, detail] of results) {
    console.log(`  ${pass ? '✔' : '✕'} ${name}（实到 ${detail}）`);
    ok = ok && pass;
  }
  console.log(ok ? '结论：尺子可用（联合/比较不记为写，字面量写必开火）' : '结论：尺子不可用，本轮不出数');
  process.exit(ok ? 0 : 1);
}

if (process.argv.includes('--self-test')) selfTest();
else main();
