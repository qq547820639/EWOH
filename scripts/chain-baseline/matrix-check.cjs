#!/usr/bin/env node
/**
 * 链级矩阵的逐格核对（V109 提升为常驻入口：`make chain-baseline-matrix`）。
 *
 * 为什么需要它：§四 开头写着"按本格逐格机器核对"，但那段核对脚本当年只存在于 `tmp/`
 * （被 .gitignore 忽略），也就是说**试点第一步交付物（六场景基线）的"填满"这件事本身
 * 已经没有可复算入口**——正是 V97 给登记册修过的同一类问题。
 *
 * 判据（故意保守，宁可少判成"已实测"）：
 *   1. 结构：表必须是 5 阶段 × 6 场景 = 30 格，缺行缺列直接判失败（不"按现有格数"自圆）；
 *   2. 分类：每格按**内容**分类为 实测 / 不适用 / 空；
 *   3. 有据：判为"实测"的格必须至少引用一个可解析的证据标记——
 *        `e2e:<场景>`（须在 verify.sh 的场景清单里）、`*.e2e.spec.ts`（须在磁盘上且尽量在 CHAIN_SPECS 里）、
 *        或大写用例号（形如 B-01 / RJ-02 / X-01 / S-05 / D-01）；
 *   4. 期望：28 实测 + 2 不适用 + 0 空（与 §四 的自述一致；不符就是自述与表不一致，报出来）。
 *
 * 自测（--self-test）用四类注入证明这把尺子会红：掏空格子、把"不适用"改成无据"已实测"、
 * 删掉一行、引用一个不存在的 spec 文件。任一注入没被抓到 ⇒ 判自测失败。
 */
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const DOC = process.env.EWOH_MATRIX_DOC || 'docs/audit/current/chain-behavior-baseline.md';
const VERIFY = process.env.EWOH_MATRIX_VERIFY || 'scripts/chain-baseline/verify.sh';
const STAGES = ['调度', '审批', '派工', '执行', '回执'];
const SCENARIOS = ['正常', '拒绝', '重复', '超时', '断网', '重启'];
const EXPECT = { measured: 28, na: 2, empty: 0 };

function readMatrix(docText) {
  const lines = docText.split('\n');
  const head = lines.findIndex((l) => l.startsWith('| 阶段 \\ 场景'));
  if (head < 0) throw new Error('找不到矩阵表头「| 阶段 \\ 场景 |」');
  const rows = [];
  for (let i = head + 2; i < lines.length && lines[i].startsWith('|'); i++) {
    const cells = lines[i].replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
    rows.push({ stage: cells[0], cells: cells.slice(1) });
  }
  return rows;
}

function loadVerify() {
  const txt = fs.readFileSync(path.join(ROOT, VERIFY), 'utf8');
  const specs = [];
  const m = txt.match(/CHAIN_SPECS="([\s\S]*?)"/);
  if (m) specs.push(...m[1].replace(/\\\s*\n/g, ' ').split(/\s+/).filter(Boolean));
  // 场景清单的唯一权威是 verify.sh 的 SCENARIOS（第 45 行附近），不是注释里的例子；
  // 早期版本从注释与 e2e: 出现处抓名字，会把文档里已经改名的旧场景（`loop`）当成合法引用。
  const scen = new Set();
  // verify.sh 里这行是 `[ -n "${SCENARIOS// /}" ] || SCENARIOS="golden wave …"`，
  // 所以不能按行首匹配（第一版就因此拿到空清单，反过来把合法场景报成"不存在"）。
  // 文件里有多处 SCENARIOS="..."（初始化 `SCENARIOS=""`、参数覆盖、默认全跑清单），
  // 权威是**默认全跑那一条**：取分词最多的一处。第一版按第一次匹配取，抓到的是空串/变量名，
  // 于是把合法场景报成"不存在"——尺子自己错，产品看起来像有问题。
  const cands = [...txt.matchAll(/SCENARIOS=\s*"([^"]+)"/g)].map((m) => m[1]);
  let best = '';
  for (const c of cands) if (c.split(/\s+/).filter(Boolean).length > best.split(/\s+/).filter(Boolean).length) best = c;
  for (const nm of best.split(/\s+/)) if (nm && !nm.includes('$')) scen.add(nm);
  return { specs, scen: [...scen], src: best ? 'SCENARIOS(默认全跑清单)' : 'none' };
}

function classify(cell) {
  const plain = cell.replace(/\*/g, '').trim();
  if (/^不适用|不适用（|标「不适用」/.test(plain)) return 'na';
  if (plain === '' || /^(未开始|待填|TBD|—|-)/.test(plain)) return 'empty';
  return 'measured';
}

// 旧场景名 → 现名。文档里出现左边这些就是要修的证据（引用腐坏），
// 由本脚本点名，而不是靠人记得哪个场景改过名（V109 实测：`loop` 在四格里还写着，权威名是 control-actuator）。
const STALE_SCENARIO = { loop: 'control-actuator', 'edge-loop': 'control-actuator' };

function evidenceGaps(cell, ctx) {
  const gaps = [];
  for (const [stale, now] of Object.entries(STALE_SCENARIO)) {
    if (new RegExp(`\\b${stale}\\b`).test(cell)) gaps.push(`引用了已改名的场景 ${stale}（现名 ${now}）`);
  }
  for (const m of cell.matchAll(/\b([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\s*(?:步|\/\d|\d\/\d)/g)) {
    const nm = m[1];
    if (STALE_SCENARIO[nm]) continue;
    if (/^(e2e|api|test|spec|step|run|plan|task)$/.test(nm)) continue;
    if (ctx.scen.includes(nm)) continue;
  }
  const citedSpecs = [...cell.matchAll(/([a-z0-9-]+\.e2e\.spec\.ts)/g)].map((m) => m[1]);
  const citedCases = [...cell.matchAll(/\b([A-Z]{1,4}-\d{1,2}[a-z]?(?:\/\d{1,2})?)\b/g)].map((m) => m[1]);
  const citedScen = [...cell.matchAll(/e2e:([a-z0-9-]+)/g)].map((m) => m[1]);
  for (const s of citedScen) {
    if (!ctx.scen.includes(s)) gaps.push(`引用了不存在的场景 e2e:${s}`);
  }
  for (const f of citedSpecs) {
    const onDisk = fs.existsSync(path.join(ROOT, 'ewoh-spark-app/test/e2e', f));
    if (!onDisk) gaps.push(`引用的 spec 文件不在磁盘上：${f}`);
    else if (!ctx.specs.some((x) => x === f.replace('.e2e.spec.ts', ''))) {
      gaps.push(`引用的 spec 未列入 CHAIN_SPECS（D/D2 不跑它）：${f}`);
    }
  }
  // 证据标记：用例号 / spec 文件 / e2e: 场景 / 现场景名 + 步数（`wave 步 8/9`、`golden 22/22`）/ §5.x 实测小节
  const citedBare = [...cell.matchAll(new RegExp(`\\b(${ctx.scen.join('|')})\\b`, 'g'))].map((m) => m[1]);
  const citedSec = /§5\.\d|§3\.\d|§4\.\d/.test(cell);
  if (!citedSpecs.length && !citedCases.length && !citedScen.length && !citedBare.length && !citedSec) {
    gaps.push('没有任何可解析的证据标记（用例号 / spec 文件 / e2e 场景 / 实测小节）');
  }
  return gaps;
}

/** V144：测试标题里出现过的用例号集合（判定"这条证据是不是有东西在跑"）。
 *  只扫测试目录（路径含 test/__tests__/tests），跳过 node_modules/dist；标题行 = it( / test( / def test_。 */
function titleCaseTokens() {
  const dirs = [path.join(ROOT, 'ewoh-spark-app'), path.join(ROOT, 'src')];
  const hit = new Set();
  const walk = (d, depth) => {
    if (depth > 7) return;
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full, depth + 1); continue; }
      if (!/(test|spec)\.(ts|js|py)$|^test_.*\.py$/.test(e.name)) continue;
      if (!/(^|[/\\])(test|tests|__tests__)[/\\]/.test(full) && !/^test_.*\.py$/.test(e.name)) continue;
      for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
        if (!/\bit\s*\(|\btest\s*\(|def\s+test_/.test(line)) continue;
        for (const m of line.matchAll(/\b([A-Z]{1,4}-\d{1,2}[a-z]?(?:\/\d{1,2})?)\b/g)) hit.add(m[1]);
      }
    }
  };
  for (const d of dirs) walk(d, 0);
  return hit;
}

/** V144 格位点档：T1 常驻且在重放清单里；T2 常驻但在重放之外（单测/未列入清单的 spec）；T3 只有文字记录。 */
function cellTier(cell, ctx, titles) {
  const specs = [...cell.matchAll(/([a-z0-9-]+\.e2e\.spec\.ts)/g)].map((m) => m[1]);
  const scen = [...cell.matchAll(/e2e:([a-z0-9-]+)/g)].map((m) => m[1]);
  const bare = [...cell.matchAll(/\b([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\b/g)].map((m) => m[1]);
  const inReplay = scen.some((s) => ctx.scen.includes(s))
    || specs.some((f) => ctx.specs.includes(f.replace('.e2e.spec.ts', '')))
    || bare.some((b) => ctx.scen.includes(b) && /步|\d\/\d/.test(cell));
  if (inReplay) return 'T1';
  const cases = [...cell.matchAll(/\b([A-Z]{1,4}-\d{1,2}[a-z]?(?:\/\d{1,2})?)\b/g)].map((m) => m[1]);
  if (cases.some((c) => titles.has(c))) return 'T2';
  return 'T3';
}

function check(docText, ctx) {
  const problems = [];
  const notes = [];
  if (ctx.scen.length < 5) {
    problems.push(`场景清单解析异常（只抓到 ${ctx.scen.length} 个：${ctx.scen.join(',')}）——`
      + '此时"引用了不存在的场景"类报告全部无效，必须先看这里');
  }
  const rows = readMatrix(docText);
  const stages = rows.map((r) => r.stage);
  if (stages.join(',') !== STAGES.join(',')) {
    problems.push(`阶段行不符预期：${stages.join('/')}（应为 ${STAGES.join('/')}）`);
  }
  const tally = { measured: 0, na: 0, empty: 0 };
  const tiers = { T1: 0, T2: 0, T3: 0 }; const t3cells = []; const t2cells = [];
  const titles = check._titles || (check._titles = titleCaseTokens());
  let cells = 0;
  for (const row of rows) {
    if (row.cells.length !== SCENARIOS.length) {
      problems.push(`「${row.stage}」行有 ${row.cells.length} 格（应为 ${SCENARIOS.length}）`);
    }
    row.cells.forEach((cell, i) => {
      cells += 1;
      const kind = classify(cell);
      tally[kind] += 1;
      const label = `${row.stage}／${SCENARIOS[i] ?? '第' + (i + 1) + '列'}`;
      if (kind === 'empty') problems.push(`${label}：空格（六场景基线不允许留白，要么测要么写明不适用依据）`);
      if (kind === 'measured') {
        for (const g of evidenceGaps(cell, ctx)) problems.push(`${label}：${g}`);
        const t = cellTier(cell, ctx, titles);
        tiers[t] += 1;
        if (t === 'T3') t3cells.push(label); else if (t === 'T2') t2cells.push(label);
      }
    });
  }
  if (cells !== 30) problems.push(`矩阵格数 ${cells}，应为 30`);
  for (const k of Object.keys(EXPECT)) {
    if (tally[k] !== EXPECT[k]) {
      problems.push(`${k === 'measured' ? '实测' : k === 'na' ? '不适用' : '空'}格数 ${tally[k]}，§四 自述为 ${EXPECT[k]}`);
    }
  }
  notes.push(`格数 ${cells}：实测 ${tally.measured} / 不适用 ${tally.na} / 空 ${tally.empty}`);
  // V144：每格证据的**常驻档**。T1 = 一键重放会跑到；T2 = 有测试标题命中但在重放之外；
  // T3 = 只有 §5.x 文字记录（这一格的"已实测"没有可重跑的东西兜底）。T3 不判红——先量，别在未测假阳性前收紧。
  notes.push(`格位点档（V144，T1+T2+T3 必须 = 实测格数）：T1 常驻·重放内 ${tiers.T1}｜T2 常驻·重放外 ${tiers.T2}｜T3 仅文字记录 ${tiers.T3}`);
  if (tiers.T1 + tiers.T2 + tiers.T3 !== tally.measured) {
    problems.push(`分档恒等式不成立：T1+T2+T3=${tiers.T1 + tiers.T2 + tiers.T3} ≠ 实测格 ${tally.measured}（分档器漏计）`);
  }
  if (t3cells.length) notes.push('T3 格（该格的"已实测"目前只有文字记录）：' + t3cells.join('、'));
  if (t2cells.length) notes.push('T2 格（常驻但在重放之外：单测或未列入 CHAIN_SPECS 的 spec）：' + t2cells.join('、'));
  return { problems, notes, tally, cells, tiers, t3cells };
}

function selfTest() {
  const base = fs.readFileSync(path.join(ROOT, DOC), 'utf8');
  const ctx = loadVerify();
  const inject = [
    {
      name: 'M1 掏空一格（变成空格）',
      run: (t) => t.replace('已实测：整波拒绝无半应用（wave 步 8/9）', '不适用（伪造：其实没测）'),
      expect: (r) => r.problems.some((p) => p.includes('不适用格数') || p.includes('实测格数')),
    },
    {
      name: 'M2 把不适用改成无据"已实测"',
      run: (t) => t.replace('| 不适用 |', '| 已实测（没有引用任何用例号或 spec） |'),
      expect: (r) => r.problems.some((p) => p.includes('没有任何可解析的证据标记')),
    },
    {
      name: 'M3 删掉一整行（结构塌陷）',
      run: (t) => t.split('\n').filter((l) => !/^\| 回执 \|/.test(l)).join('\n'),
      expect: (r) => r.problems.some((p) => p.includes('阶段行不符预期') || p.includes('格数')),
    },
    {
      name: 'M4 引用一个不存在的 spec 文件',
      run: (t) => t.replace('已实测：`e2e:receipt` 19/19', '已实测：`ghost-case.e2e.spec.ts` GS-01'),
      expect: (r) => r.problems.some((p) => p.includes('不在磁盘上')),
    },
    {
      name: 'M5 引用不存在的 e2e 场景名',
      run: (t) => t.replace('已实测：wave 12/12', '已实测：e2e:no-such-scenario 12/12'),
      expect: (r) => r.problems.some((p) => p.includes('不存在的场景')),
    },
  ];
  inject.push(
    { name: 'M6 抹掉一格里所有可重跑证据、只留 §5.x 文字 ⇒ 该格必须落到 T3',
      run: (t) => t.replace('已实测：整波拒绝无半应用（wave 步 8/9）', '已实测：见 §5.3x（文字记录）'),
      expect: (r) => r.tiers.T3 > 0 && r.tiers.T1 + r.tiers.T2 + r.tiers.T3 === r.tally.measured },
    // M7 是"必须不误报"的那一半：把一格证据从清单内场景换成另一个清单内场景，
    // T1 计数不得变、恒等式必须仍成立（否则分档器对引用文字过度敏感，读数不可信）。
    { name: 'M7 清单内场景换成清单内场景 ⇒ T1 不得变化、恒等式仍成立（不误报对照）',
      run: (t) => t.replace('已实测：`e2e:receipt` 19/19', '已实测：`e2e:golden` 22/22（换名注入）'),
      expect: (r) => r.tiers.T1 === baseTiers.T1 && r.tiers.T1 + r.tiers.T2 + r.tiers.T3 === r.tally.measured
        && !r.problems.some((x) => x.includes('分档恒等式')),
      guard: () => true },
  );
  const baseTiers = check(base, ctx).tiers;
  console.log(`  基线分档：T1 ${baseTiers.T1}｜T2 ${baseTiers.T2}｜T3 ${baseTiers.T3}（实测格 ${baseTiers.T1 + baseTiers.T2 + baseTiers.T3}）`);
  let bad = 0;
  for (const c of inject) {
    const mutated = c.run(base);
    if (mutated === base) {
      console.log(`  ✕ ${c.name} → 注入根本没改变输入（判据自测本身失效）`);
      bad += 1;
      continue;
    }
    const r = check(mutated, ctx);
    const ok = c.expect(r);
    if (!ok) bad += 1;
    console.log(`  ${ok ? '✔' : '✕'} ${c.name} → 报 ${r.problems.length} 项`);
    if (!ok) console.log('     首项: ' + (r.problems[0] ?? '(无)'));
  }
  const clean = check(base, ctx);
  console.log(`对照（未注入的原文）：${clean.problems.length} 项`);
  for (const p of clean.problems.slice(0, 12)) console.log('   · ' + p);
  console.log(`矩阵判据自测：${inject.length - bad}/${inject.length} 抓到`);
  return bad === 0;
}

function main() {
  if (!fs.existsSync(path.join(ROOT, DOC))) {
    console.error('必须在仓库根运行（找不到 ' + DOC + '）');
    process.exit(3);
  }
  if (process.argv.includes('--self-test')) {
    process.exit(selfTest() ? 0 : 3);
  }
  const ctx = loadVerify();
  const r = check(fs.readFileSync(path.join(ROOT, DOC), 'utf8'), ctx);
  console.log(`· CHAIN_SPECS=${ctx.specs.length} 个、场景清单取自 ${VERIFY}:${ctx.src} ⇒ ${ctx.scen.join(',')}`);
  for (const n of r.notes) console.log('  · ' + n);
  if (!r.problems.length) {
    console.log('✅ 六场景矩阵逐格核对通过：30 格 = 28 实测 + 2 不适用，且每格证据可解析');
    return;
  }
  console.log(`❌ 逐格核对不通过（${r.problems.length} 项）：`);
  for (const p of r.problems) console.log('  · ' + p);
  process.exit(1);
}

main();
