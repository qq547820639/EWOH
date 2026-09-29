#!/usr/bin/env node
/**
 * 一问：调度链上每个 `.persistPlan(` 调用点，**是否处在事务执行器的回调词法作用域内**？
 *
 * 为什么要问：主线7 现用判据是「调用点所在方法体内出现过 `runInTransaction`/`.transaction(`/
 * `requestDatabaseContextSafe` 文本」。V125 实测它有两处性质问题（登记为 GATE-16，P1）：
 *   · 方法体区间靠"看起来像方法定义的上一行/下一行"切，标记写在**别的方法**里也能把本调用点清掉；
 *   · 一行 `// runInTransaction` 注释即满足。
 * 修法（改结构判据 = 动共享 CI 严度）需裁决，但裁决缺一个数：**换成结构判据今天会红几处**。
 * 本量具是影子判据——只测不改，与现行文本判据**双向**对账（漏判面与误伤面各报一次）。
 *
 * 三态而不是两态：结构上认不出来的（执行器被变量/包装函数间接传递）记 `unresolved`，
 * 不折算成"在事务外"——把"我的量具看不见"写成"代码有问题"是假缺陷。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const ROOT = path.resolve(__dirname, '../..');
const SCHED = path.join(ROOT, 'ewoh-spark-app/server/modules/scheduler');
const ts = createRequire(path.join(ROOT, 'ewoh-spark-app/package.json'))('typescript');

const TX_EXECUTOR = /^(runInTransaction|runDetachedTransaction|requestDatabaseContextSafe|systemGlobalAdminTransaction|transaction)$/;
// 旧口径（V190 之前的主线7）文本判据，逐字复刻用作 A 档对照。
// V190 起主线7 换成"括号配定作用域 + 剥注释"；本量具仍按历史口径对账，
// 于是剩下的差集＝"同作用域内出现标记 ≠ 调用点真在事务回调里"，由结构列继续量。
const TX_MARKERS = /runInTransaction|\.transaction\(|requestDatabaseContextSafe/;
const CONTROL_FLOW_RE = /^\s*(if|for|while|switch|catch|return|else|try|do|throw)\b/;
const METHOD_DEF_RE = /^\s*(?:private|public|protected|readonly|static|async|override|\s)*[A-Za-z_$][\w$]*\s*(\(|\([^)]*\)\s*(:\s*[\w<>\[\]| .]+)?\s*\{)/;

const isMethodDef = (l) => {
  if (CONTROL_FLOW_RE.test(l)) return false;
  const t = l.trim();
  if (t.startsWith('//') || t.startsWith('*')) return false;
  if (l.match(/^\s*/)[0].length > 2) return false;
  return METHOD_DEF_RE.test(l);
};
function methodRegion(lines, idx) {
  let start = 0;
  for (let i = idx; i >= 0; i -= 1) if (isMethodDef(lines[i])) { start = i; break; }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) if (isMethodDef(lines[i])) { end = i; break; }
  return [start, end];
}
const textInTx = (lines, idx) => {
  const [s, e] = methodRegion(lines, idx);
  return TX_MARKERS.test(lines.slice(s, e).join('\n'));
};

/** 建 parent 链（ts.forEachChild 的返回值会中断遍历 ⇒ 一律用语句体）。 */
function parents(sf) {
  const map = new Map();
  const visit = (node) => {
    ts.forEachChild(node, (child) => {
      map.set(child, node);
      visit(child);
    });
  };
  visit(sf);
  return map;
}

function calleeName(node, tsLib) {
  const e = tsLib.isParenthesizedExpression(node) ? node.expression : node;
  if (tsLib.isIdentifier(e)) return e.text;
  if (tsLib.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

/** 文件级两件事：谁被当实参交给执行器；谁也被**直调**（同名回调的另一条路）。 */
function collectNames(sf, tsLib, parent) {
  const executorArgNames = new Set();
  const directCallNames = new Set();
  const visit = (node) => {
    if (tsLib.isCallExpression(node)) {
      const name = calleeName(node.expression, tsLib);
      if (name && TX_EXECUTOR.test(name)) {
        for (const a of node.arguments) {
          if (tsLib.isIdentifier(a)) executorArgNames.add(a.text);
        }
      }
      if (tsLib.isIdentifier(node.expression)) directCallNames.add(node.expression.text);
    }
    tsLib.forEachChild(node, visit);
  };
  visit(sf);
  void parent;
  return { executorArgNames, directCallNames };
}

/** 结构判据：调用点向上找"被当作事务执行器实参的函数体"（含**具名回调**这一形）。 */
function astVerdict(node, parent, tsLib, names) {
  let unresolved = false;
  let cur = node;
  while (cur) {
    const p = parent.get(cur);
    if (!p) break;
    if (tsLib.isCallExpression(p)) {
      const cn = calleeName(p.expression, tsLib);
      const fnArgs = (p.arguments || []).filter(
        (a) => tsLib.isArrowFunction(a) || tsLib.isFunctionExpression(a),
      );
      if (cn && TX_EXECUTOR.test(cn) && fnArgs.includes(cur)) return { verdict: 'in-tx', via: cn };
      if (cn && !TX_EXECUTOR.test(cn) && (fnArgs.includes(cur) || (p.arguments || []).includes(cur))) unresolved = true;
    }
    if (tsLib.isArrowFunction(cur) || tsLib.isFunctionExpression(cur)) {
      // 具名回调：`const f = async () => {…}` 而 `f` 被交给执行器 ⇒ 词法上仍在事务里
      const holder = parent.get(cur);
      const hName = holder && tsLib.isVariableDeclaration(holder) && tsLib.isIdentifier(holder.name) ? holder.name.text : null;
      if (hName && names.executorArgNames.has(hName)) {
        return { verdict: 'in-tx', via: `具名回调 ${hName}`, dualPath: names.directCallNames.has(hName) };
      }
      if (hName) return { verdict: 'outside', via: null, note: `具名回调 ${hName} 从未被交给事务执行器` };
    }
    if (tsLib.isMethodDeclaration(cur) || tsLib.isFunctionDeclaration(cur) || tsLib.isConstructorDeclaration(cur) || tsLib.isClassDeclaration(cur)) {
      break;
    }
    cur = p;
  }
  return { verdict: unresolved ? 'unresolved' : 'outside', via: null };
}

function sitesFromText(rel, lines) {
  const out = [];
  lines.forEach((l, i) => {
    if (!/\.persistPlan\(/.test(l)) return;
    if (/async\s+persistPlan\s*\(/.test(l)) return;
    out.push({ rel, line: i + 1, textInTx: textInTx(lines, i) });
  });
  return out;
}

function sitesFromAst(rel, text) {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
  const parent = parents(sf);
  const names = collectNames(sf, ts, parent);
  const out = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'persistPlan') {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      const a = astVerdict(node, parent, ts, names);
      out.push({ rel, line: line + 1, ast: a.verdict, via: a.via || null, dualPath: !!a.dualPath, note: a.note || null });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function scanAll(dir) {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.service.ts')) files.push(p);
    }
  };
  walk(dir);
  const sites = [];
  for (const f of files.sort()) {
    const rel = path.relative(dir, f);
    const text = fs.readFileSync(f, 'utf8');
    const t = sitesFromText(rel, text.split('\n'));
    const a = sitesFromAst(rel, text);
    t.forEach((site, i) => sites.push({ ...site, ...(a[i] || { ast: 'unmatched' }) }));
  }
  return sites;
}

/** 纯判据：两套读数必须**逐点对齐**，差集双向打印。 */
function judge(sites) {
  const problems = [];
  if (!sites.length) problems.push('调用点清单为空 ⇒ 扫描没吃到语料，本轮不出数');
  const unmatched = sites.filter((s) => s.ast === 'unmatched');
  if (unmatched.length) problems.push(`${unmatched.length} 处文本位点没有对应的 AST 位点 ⇒ 两套枚举器不一致，读数作废`);
  // 现行门禁自述的下界：调用点 ≥4
  if (sites.length && sites.length < 4) problems.push(`只发现 ${sites.length} 处调用点（门禁自述下界 4）⇒ 扫描面可疑`);
  const falseGreen = sites.filter((s) => s.textInTx && s.ast === 'outside');
  const wouldNotRed = sites.filter((s) => !s.textInTx && s.ast === 'in-tx');
  // 棘轮（V148 登记基线：两面各 0）：一旦有人写出"文本判据绿而结构上不在事务里"的调用点，
  // 本主线必须红——这正是影子判据常驻的理由（夹具 T1/T3/T7 负责证明它会开火）。
  if (falseGreen.length) {
    problems.push(`漏判面不为 0：${falseGreen.map((x) => `${x.rel}:${x.line}`).join(' ; ')}`
      + ' ⇒ 该调用点被现行文本判据放行，但结构上不在任何事务执行器回调内');
  }
  if (wouldNotRed.length) {
    problems.push(`误伤面不为 0：${wouldNotRed.map((x) => `${x.rel}:${x.line}`).join(' ; ')}`
      + ' ⇒ 结构上在事务内却被现行判据判违规（读数需重新核对，不是直接放宽）');
  }
  return {
    ok: problems.length === 0,
    problems,
    n: sites.length,
    falseGreen,
    wouldNotRed,
    unresolved: sites.filter((s) => s.ast === 'unresolved'),
    inTx: sites.filter((s) => s.ast === 'in-tx'),
  };
}

function print(sites, v) {
  console.log(`语料：${SCHED} 下 *.service.ts；调用点 ${sites.length} 处（文本枚举=AST 枚举需逐点对齐）`);
  for (const s of sites) {
    console.log(`  ${s.rel}:${s.line}  文本判据=${s.textInTx ? '内' : '外'}  结构判据=${s.ast}${s.via ? `（${s.via}）` : ''}`
      + `${s.dualPath ? ' ⚠ 同名回调另有一条不经事务的直调路径' : ''}${s.note ? ` · ${s.note}` : ''}`);
  }
  console.log(`原始观测：结构=内 ${v.inTx.length}｜结构=外 ${sites.filter((s) => s.ast === 'outside').length}｜结构上认不出 ${v.unresolved.length}`
    + `｜**文本绿而结构外（现行判据的漏判面）** ${v.falseGreen.length}`
    + `｜**文本红而结构内（收紧不会误伤的面）** ${v.wouldNotRed.length}`);
}

function selfTest() {
  const cases = [
    {
      name: 'T1 标记只是注释、调用点在事务外 ⇒ 文本必须绿而结构必须红（这就是"必须开火"）',
      text: `class A {\n  async go() {\n    // runInTransaction 早就加了\n    await this.planService.persistPlan(x);\n  }\n}\n`,
    },
    {
      name: 'T2 调用点确实嵌在 runInTransaction 回调里 ⇒ 两侧都绿（撤销必须不开火）',
      text: `class A {\n  async go() {\n    await this.rdc.runInTransaction(s, async () => {\n      await this.planService.persistPlan(x);\n    });\n  }\n}\n`,
    },
    {
      name: 'T3 区域塌陷：标记在**另一个函数**体内，而文本判据把整文件当成一个方法体',
      text: `class A {\n  go = () => {\n    const svc = {\n      other() {\n        return this.rdc.runInTransaction(s, async () => {});\n      },\n    };\n    return this.planService.persistPlan(x);\n  }\n}\n`,
    },
    {
      name: 'T6 具名回调交给执行器（`runInTransaction(s, f)`）⇒ 必须算 in-tx，不得当成漏判',
      text: `class A {\n  go = async () => {\n    const f = async (): Promise<void> => {\n      await this.planService.persistPlan(x);\n    };\n    await this.rdc.runInTransaction(s, f);\n  }\n}\n`,
      expect: (sites) => sites.length === 1 && sites[0].ast === 'in-tx' && /具名回调/.test(String(sites[0].via)),
    },
    {
      name: 'T6b 同一个具名回调也被直调（不经事务）⇒ in-tx 但必须带 dualPath 警示',
      text: `class A {\n  go = async () => {\n    const f = async (): Promise<void> => {\n      await this.planService.persistPlan(x);\n    };\n    await this.rdc.runInTransaction(s, f);\n    await f();\n  }\n}\n`,
      expect: (sites) => sites.length === 1 && sites[0].ast === 'in-tx' && sites[0].dualPath === true,
    },
    {
      name: 'T7 具名回调从未交给执行器（只有直调）⇒ 必须算 outside（撤销不开火的反向）',
      text: `class A {\n  go = async () => {\n    const f = async (): Promise<void> => {\n      await this.planService.persistPlan(x);\n    };\n    await f();\n  }\n}\n`,
      expect: (sites) => sites.length === 1 && sites[0].ast === 'outside',
    },
    {
      name: 'T4 执行器经别的回调包了一层 ⇒ 结构判据必须记 unresolved，不得折算成"在事务外"',
      text: `class A {\n  async go() {\n    await this.helper.wrap(async () => {\n      await this.planService.persistPlan(x);\n    });\n  }\n}\n`,
    },
  ];
  let bad = 0;
  const results = [];
  for (const c of cases) {
    const rel = 'fixture.service.ts';
    const t = sitesFromText(rel, c.text.split('\n'));
    const a = sitesFromAst(rel, c.text);
    const sites = t.map((site, i) => ({ ...site, ...(a[i] || { ast: 'unmatched' }) }));
    results.push(...sites);
    const v = judge(sites);
    let ok;
    if (c.expect) ok = c.expect(sites);
    else if (c.name.startsWith('T1')) ok = sites.length === 1 && sites[0].textInTx === true && sites[0].ast === 'outside';
    else if (c.name.startsWith('T2')) ok = sites.length === 1 && sites[0].textInTx === true && sites[0].ast === 'in-tx';
    else if (c.name.startsWith('T3')) {
      const lines = c.text.split('\n');
      const idx = lines.findIndex((l) => l.includes('persistPlan'));
      // 塌陷的机理证据：文本判据把区域起点退到了文件第 0 行（没有任何"方法定义行"被认出来）
      ok = sites.length === 1 && sites[0].textInTx === true && sites[0].ast === 'outside' && methodRegion(lines, idx)[0] === 0;
    }
    else ok = sites.length === 1 && sites[0].ast === 'unresolved';
    // 通用一条：凡夹具造出的形状就是"文本绿而结构外"，棘轮必须红——不靠给每个夹具手写期望号
    if (ok && sites.length && sites.every((x) => x.textInTx === true && x.ast === 'outside')) {
      ok = v.problems.some((x) => x.includes('漏判面不为 0'));
    }
    if (!ok) bad += 1;
    console.log(`  ${ok ? '✔' : '✕'} ${c.name} → ${sites.map((s) => `文本=${s.textInTx}/结构=${s.ast}`).join(' ')}`);
  }
  const empty = judge([]);
  const okEmpty = empty.problems.some((p) => p.includes('调用点清单为空'));
  if (!okEmpty) bad += 1;
  console.log(`  ${okEmpty ? '✔' : '✕'} T5 空语料 ⇒ 拒绝出数`);
  const total = cases.length + 1;
  console.log(`事务边界影子判据自测：${total - bad}/${total} 抓到`);
  return bad === 0;
}

function main() {
  if (process.argv.includes('--self-test')) {
    // 夹具自测不依赖真语料，但**分母必须来自真语料核对**：先扫一遍确认枚举器对齐
    const real = scanAll(SCHED);
    process.exit(selfTest() && judge(real).ok ? 0 : 3);
  }
  const sites = scanAll(SCHED);
  const v = judge(sites);
  print(sites, v);
  if (!v.ok) {
    for (const p of v.problems) console.error(`FAIL tx_boundary_shadow：${p}`);
    process.exit(1);
  }
  console.log(`结论：换成结构判据，今天会当场红 ${v.falseGreen.length} 处（现行文本判据的漏判面）、`
    + `原本红的里有 ${v.wouldNotRed.length} 处其实结构上在事务内（误伤面）；另有 ${v.unresolved.length} 处静态认不出，只报不判。`
    + `本量具不改任何代码、不接门禁。`);
}

if (require.main === module) main();
module.exports = { scanAll, judge, sitesFromText, sitesFromAst };
