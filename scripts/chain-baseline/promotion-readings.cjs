#!/usr/bin/env node
/**
 * 推广三判据的**唯一复算入口**（V309）。
 *
 * 为什么要它：试点的放行条件是「维护成本下降、业务语义没丢、恢复能力改善」三条都成立才可外推。
 * 到这轮为止，这三条的数散在《基线》§六／§5.3 各处**手抄文本**里——手抄会漂（本试点已登记过多处副本漂移），
 * 而且没人能保证"轴还在量同一件事"。这里把三轴的读数由**量具本身现算**并集中打印：
 *   轴①维护成本：十张权威表里"代码能读出的目标态集合非空"的表数（V296 前 8/10 → 现 10/10）
 *   轴②业务语义：每张表 declared（契约词表）↔ writable（可写集合）的双向差集
 *           （V315 起："该表归哪份词表"读 `status-vocabulary-bindings.json`，不可判的分档不折算成判定）
 *   轴③恢复能力：常驻用例里"断到终态"的文件数/块数与三档（pollBound/waitOnly/single）＋等式面/可判面
 *                     ＋人工恢复轴 18 格的两口径（从《基线》表体现算，不按记忆）
 *
 * 用法：node scripts/chain-baseline/promotion-readings.cjs [--json]
 * 判据本身不新建：全部复用 convergence-sites / status-target-states 的导出，避免"第二把近似尺"（V292 的教训）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');

const { collect } = require('./status-target-states.cjs');


// ---- 轴①②：权威表 ↔ 契约词表 ↔ 可写集合
// 表 → 契约：**V315 起这份手挂只作两件事**——①轴②分母（哪十张表进判定，属口径、TBLST-01 待拍）；
// ②不可判档的**诊断退回位**（绑定件判不出归属时，照人认的那份词表把差集算出来给人看，但标"诊断"）。
// 真值源是 `status-vocabulary-bindings.json`；两处不一致会在读数里点名（归属分歧），不静默取其一。
const FACTS = [
  ['ewohSchedulingRun', null], ['ewohSchedulePlan', 'plan.yaml'],
  ['ewohSchedulingPlanAssignment', null], ['ewohSchedulingExecution', null],
  ['ewohProductionTask', 'task.yaml'], ['ewohControlRequest', 'control.yaml'],
  // 级别错绑的已知项：control.yaml 那份 states 是**请求级**的（V229/V300 都记过）——
  // 命令表照挂时差集会造假红，故这里也标 null，并在读数里点名"该表无自己级别的词表（WDRV-01）"
  ['ewohControlCommand', null], ['ewohControlResult', null],
  ['ewohAgentApproval', null], ['ewohAgentTask', 'agent-task.yaml'],
];
/** 该表在 schema 里到底有没有状态列（`ewohControlResult` 没有：它的列是 result_type/result_code）——
 *  没有状态列的表不该算进"轴①能读出集合"的分母，否则会把一张本不该出现的表读成覆盖缺口。 */
const SCHEMA = path.join(ROOT, 'ewoh-spark-app/server/database/schema.ts');
function hasStatusColumn(table) {
  const src = fs.readFileSync(SCHEMA, 'utf8');
  // schema 里的物理名是蛇形（pgTable("ewoh_control_result"…），按驼峰找必然落空 ⇒ 用导出名定位
  const i = src.indexOf('export const ' + table + ' = pgTable(');
  if (i < 0) return null;                                  // 这一张在 schema 里找不到 ⇒ 未知
  const seg = src.slice(i, i + 6000);
  const end = seg.search(/\n\}\)/);                      // drizzle 定义以 `})` 结尾（可能带分号）
  const body = end > 0 ? seg.slice(0, end) : seg;
  return /\bvarchar\("(status|state)"/.test(body) || /text\("(status|state)"/.test(body);
}

const SM = path.join(ROOT, 'contracts/state-machines');
function declaredStates(file) {
  const p = path.join(SM, file);
  if (!fs.existsSync(p)) return null;                      // 契约未声明这份词表
  const m = fs.readFileSync(p, 'utf8').match(/^states:\n((?:[ \t]*-[ \t]*\S+[ \t]*\n?)+)/m);
  if (!m) return null;
  return new Set(m[1].split('\n').map((l) => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean));
}
function serverSources() {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') walk(p); continue; }
      if (!e.name.endsWith('.ts') || e.name.endsWith('.d.ts') || e.name.endsWith('.spec.ts')) continue;
      out.push([path.relative(ROOT, p), fs.readFileSync(p, 'utf8')]);
    }
  };
  walk(path.join(ROOT, 'ewoh-spark-app/server'));
  return out;
}
/** V315 起轴②的"该表归哪份词表"改为读绑定件（`gen-vocabulary-bindings.cjs` 的产物），
 *  手挂的 FACTS 第二元素降级成**交叉核对**：两处不一致就报出来，而不是再各说一遍。
 *  分档（不可判不折算成"没问题"，也不折算成"违规"）：
 *    差集可算            ＝契约按覆盖判到 bound，且库侧没有否证它
 *    差集可算·契约欠词    ＝partial（链上写出的词有一个以上不在契约里 ⇒ 正是 PLANV-01／WDRV-01 那族欠账）
 *    不可判·并列词表      ＝ambiguous（两份词表并列，归属本身无从判）
 *    不可判·库否证主体    ＝db-narrower（库里那份 CHECK 比契约窄 ⇒ 挂来的契约讲的不是这张表）
 *    不可判·覆盖不足（差集只作诊断）＝unbound（词表没选中；仍照 nearest 那份算差集，但标 diagnostic，不记成判定）
 *    不可判·无可对词表    ＝vocabulary 与 nearest 都没有
 *    不可判·不在绑定件里  ＝这张表没出现在「链上写过状态 ∩ schema 有状态列」的分母里
 *  读不到绑定件（文件缺失或解析失败）⇒ 全部退回手挂并在读数里点名"轴②按手挂"，不静默少一格。 */
const BINDINGS = path.join(__dirname, 'status-vocabulary-bindings.json');
function bindingsByTable(file = BINDINGS) {
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const m = new Map();
    for (const r of doc.bindings) m.set(r.table, r);
    return m;
  } catch (e) { return null; }
}
function gradeAxis2(b) {
  if (!b) return { eligible: false, diagnostic: false, grade: '不可判·不在绑定件里', contract: null };
  if (b.vocabulary) {
    if (b.status === 'ambiguous') return { eligible: false, diagnostic: true, grade: '不可判·并列词表', contract: b.vocabulary };
    if (b.db_vs_contract === 'db-narrower') {
      return { eligible: false, diagnostic: true, grade: '不可判·库否证主体', contract: b.vocabulary };
    }
    return {
      eligible: true, diagnostic: false,
      grade: b.status === 'bound' ? '差集可算' : '差集可算·契约欠词',
      contract: b.vocabulary, dbCorroboration: b.db_vs_contract,
    };
  }
  const near = b.nearest && b.nearest.vocabulary ? b.nearest.vocabulary : null;
  if (!near) {
    return { eligible: false, diagnostic: false,
      grade: b.status === 'no-writes' ? '不可判·链上没写过状态' : '不可判·无可对词表', contract: null };
  }
  return { eligible: false, diagnostic: true, grade: '不可判·覆盖不足（差集只作诊断）', contract: near };
}
/** 纯函数（可被常驻用例喂夹具）：算出轴①②。 */
function axesFromSources(sources, facts = FACTS, declaredOf = declaredStates, bindingOf = bindingsByTable()) {
  const tableSet = new Set(facts.map(([t]) => t));
  const byTable = collect(sources, tableSet).byTable;
  const rows = facts.map(([table, handContract]) => {
    const b = byTable.get(table);
    const writable = new Set([...(b ? b.direct : []), ...(b ? [...b.via.keys()] : [])]);
    const g = bindingOf ? gradeAxis2(bindingOf.get(table)) : { eligible: false, diagnostic: false, grade: '不可判·没有绑定件（按手挂）', contract: handContract };
    // 用哪份词表算差集：判定档一律用绑定件给的；**不可判档退回手挂那一份**（绑定件的 nearest 只是"最不错的集合"，
    // 不是归属证据——plan 那张的最近邻算出来是 approval.yaml，照它报差集就是把别人的词表当方案的词表）。
    const contract = g.eligible ? g.contract : (handContract || g.contract);
    const from = !contract ? 'none' : (g.eligible ? '绑定件'
      : (!bindingOf ? '手挂（没有绑定件）' : (handContract ? '手挂·诊断' : '绑定件最近邻·诊断')));
    const mismatch = Boolean(bindingOf) && g.contract && handContract && g.contract !== handContract;
    const declared = contract ? declaredOf(contract) : null;
    const statusCol = hasStatusColumn(table);
    return {
      table, contract: contract || null, handContract: handContract || null,
      contractFrom: from,
      handMountedVsArtifact: mismatch ? `${handContract}≠绑定件 ${g.contract}` : null,
      grade: g.grade, judged: g.eligible, diagnostic: g.diagnostic,
      dbCorroboration: g.dbCorroboration || null,
      // 三种"看起来都像空"的成因要分开（V296 的老教训）：没有写点 / 有写点但集合读不出 / 词表本身缺
      // 三种成因分开：表根本没有状态列 / 有列但代码里没有写点 / 有写点而集合读不出
      hasStatusColumn: statusCol, hasContract: declared !== null,
      noWrites: statusCol === false ? false : !b,
      writable: [...writable].sort(),
      declaredNoWriter: declared ? [...declared].filter((s) => !writable.has(s)).sort() : [],
      writerNotDeclared: declared ? [...writable].filter((s) => !declared.has(s)).sort() : [],
    };
  });
  const scored = rows.filter((r) => r.hasStatusColumn !== false);
  const withSet = scored.filter((r) => r.writable.length > 0).length;
  const noWrites = scored.filter((r) => r.noWrites).map((r) => r.table);
  const noStatusCol = rows.filter((r) => r.hasStatusColumn === false).map((r) => r.table);
  const grades = {};
  for (const r of rows) grades[r.grade] = (grades[r.grade] || 0) + 1;
  return { rows, totalTables: scored.length, tablesWithSet: withSet, noWritesTables: noWrites,
    noStatusColTables: noStatusCol, gradeCounts: grades,
    handMismatches: rows.filter((r) => r.handMountedVsArtifact).map((r) => `${r.table}：${r.handMountedVsArtifact}`) };
}

/** 轴③机器侧：直接跑收敛尺、解析它自己打印的汇总行。
 *  为什么不 import 它的内部函数：judgeBlock/blocks 的入参形状不是这里的公开契约（第一版按猜的签名调用直接
 *  TypeError）；而"汇总行"是它给人看的稳定面。解析失败时返回 null，调用方按"不可判"处理——
 *  常驻用例里有一条专门断"解析不出就算轴失效"，所以格式改了会红，不会静默少一格。 */
function machineAxis() {
  const { execFileSync } = require('node:child_process');
  let out = '';
  try {
    out = execFileSync(process.execPath, ['scripts/chain-baseline/convergence-sites.cjs'],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    return { error: `收敛尺退出非 0：${e && e.message ? String(e.message).slice(0, 120) : e}` };
  }
  const head = out.match(/文件 (\d+) 个 \/ 用例块 (\d+) 个；三档 pollBound (\d+) · waitOnly (\d+) · single (\d+)/);
  const eq = out.match(/等式面（集合＋状态）＝(\d+)\/(\d+)/);
  const jd = out.match(/可判面＝(\d+)\/(\d+)/);
  if (!head || !eq || !jd) return { error: '收敛尺汇总行解析失败（格式变了？本轴按不可判处理）' };
  return {
    files: Number(head[1]), blocks: Number(head[2]), pollBound: Number(head[3]),
    waitOnly: Number(head[4]), single: Number(head[5]),
    eqFace: Number(eq[1]), judgeableFace: Number(jd[1]),
  };
}

/** 轴③人工侧：从《基线》的 18 格表体现算两口径（不按记忆、不手数）。 */
function gridAxis(docPath = path.join(ROOT, 'docs/audit/current/chain-behavior-baseline.md')) {
  const lines = fs.readFileSync(docPath, 'utf8').split('\n');
  const h = lines.findIndex((l) => l.startsWith('| 格 | 原判（V228 记的）'));
  if (h < 0) return { rows: 0, v166: {}, strict: {} };
  const tally = { v166: {}, strict: {} };
  let n = 0;
  for (let i = h + 2; i < lines.length && lines[i].startsWith('| '); i += 1) {
    const cells = lines[i].split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 4) continue;
    n += 1;
    for (const [k, col] of [['v166', 2], ['strict', 3]]) {
      tally[k][cells[col]] = (tally[k][cells[col]] || 0) + 1;
    }
  }
  return { rows: n, v166: tally.v166, strict: tally.strict };
}
module.exports = { axesFromSources, machineAxis, gridAxis, FACTS, declaredStates, serverSources,
  statusTablesInSchema, orphanStatusTables, gradeAxis2, bindingsByTable };

function m2(x) { return Array.isArray(x) ? x.length : 0; }
/** 清单漏网检测（V311）：schema 里**有状态列**的 ewoh_ 表 ∩ 链上模块源码引用，
 *  凡不在权威表清单里的就报出来。链范围仍是口径（清单本身保留），但"新表加了状态列"不再静默。 */
function statusTablesInSchema() {
  const src = fs.readFileSync(SCHEMA, 'utf8');
  const out = [];
  const re = /export const (ewoh\w+) = pgTable\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const i = m.index;
    const seg = src.slice(i, i + 6000);
    const end = seg.search(/\n\}\)/);
    const body = end > 0 ? seg.slice(0, end) : seg;
    if (/\b(?:varchar|text)\("(?:status|state)"/.test(body)) out.push(m[1]);
  }
  return out;
}
function orphanStatusTables(sources, facts = FACTS) {
  const known = new Set(facts.map(([x]) => x));
  const all = statusTablesInSchema();
  // 关键收窄：不看"有没有状态列"，看"链上代码有没有把状态**写进**这张表"——
  // 用同一套写点扫描（UPDATE 的 set 侧＋INSERT 的 values 侧），所以不会把只读表也算成漏网。
  const hit = collect(sources, new Set(all)).byTable;
  const out = [];
  for (const [tbl, b] of hit) {
    if (known.has(tbl)) continue;
    const n = (b.direct ? b.direct.size : 0) + (b.via ? b.via.size : 0);
    if (n > 0) out.push([tbl, n]);
  }
  return out.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
}

function main() {
  const src = serverSources();
  const a = axesFromSources(src);
  const m = machineAxis();
  const g = gridAxis();
  const out = {
    axis1_maintainability: { tablesWithSet: a.tablesWithSet, totalTables: a.totalTables },
    axis2_semantics: a.rows.map((r) => ({
      table: r.table, writable: r.writable.length, noWrites: r.noWrites,
      declaredNoWriter: r.declaredNoWriter, writerNotDeclared: r.writerNotDeclared, hasContract: r.hasContract,
      grade: r.grade, judged: r.judged, diagnostic: r.diagnostic, contract: r.contract,
      contractFrom: r.contractFrom, handMountedVsArtifact: r.handMountedVsArtifact,
    })),
    axis2_grades: a.gradeCounts,
    axis2_source: a.rows.some((r) => r.contractFrom === '绑定件' || r.grade.startsWith('不可判·不在绑定件里'))
      ? 'status-vocabulary-bindings.json' : '手挂（没有绑定件）',
    axis3_recovery: { machine: m, humanGrid: g },
  };
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(out, null, 1));
  } else {
    console.log(`轴①维护成本：${out.axis1_maintainability.tablesWithSet}/${out.axis1_maintainability.totalTables} 张**有状态列的**权威表能读出非空目标态集合`
      + `；"有列但代码里没写点"的 ${m2(a.noWritesTables)}：${a.noWritesTables.join(', ') || '—'}`
      + `；因"表根本没有状态列"而剔出分母的 ${m2(a.noStatusColTables)}：${a.noStatusColTables.join(', ') || '—'}`);
    console.log('  ⚠ 扫描面声明：可写集含 UPDATE 的 .set() 侧与 INSERT 的 .values() 侧'
      + '（V310 起两面都算；⇒ `pending_approval` 这类只在创建时写入的态不再被误记为无写者）。');
    console.log(`轴②业务语义：词表归属改读绑定件（${out.axis2_source}），手挂那份只作交叉核对；`
      + `分档 ${JSON.stringify(out.axis2_grades)}`);
    for (const r of out.axis2_semantics) {
      console.log(`  ${r.table.padEnd(30)} 可写 ${String(r.writable).padStart(2)}｜${r.grade}`
        + `｜词表 ${r.contract || '—'}（${r.contractFrom}）`
        + `｜契约声明而写不出 ${r.declaredNoWriter.length ? r.declaredNoWriter.join(',') : '—'}`
        + `｜越表词 ${r.writerNotDeclared.length ? r.writerNotDeclared.join(',') : '—'}`
        + `${r.diagnostic ? '（诊断，不记成判定）' : ''}${r.handMountedVsArtifact ? `｜手挂≠绑定件：${r.handMountedVsArtifact}` : ''}`);
    }
    if (a.handMismatches.length) {
      console.log(`  ⚠ 归属分歧（手挂 ≠ 绑定件给的词表）${a.handMismatches.length} 处：${a.handMismatches.join('；')}`
      + `——差集按上面那列标注的来源算，判定档只认绑定件`);
    }
    const chainSrc = src.filter(([f]) => /server\/modules\/(scheduler|control|approval|task|agent|ingest|work-orchestration)\//.test(f));
    const orph = orphanStatusTables(chainSrc);
    console.log(`轴①补：schema 里有状态列的 ewoh_ 表共 ${statusTablesInSchema().length} 张；`
      + `链上模块**把状态写进**、却不在权威表清单里的 ${orph.length} 张：`
      + (orph.length ? orph.map(([x, n]) => `${x}(${n})`).join(', ') : '—')
      + `（检测只扫链上模块目录，且要求确有写入，避免把只读表算成漏网）`);
    console.log(`轴③恢复能力：机器侧 文件 ${m.files}／断到终态的块 ${m.blocks}＝pollBound ${m.pollBound}＋waitOnly ${m.waitOnly}＋single ${m.single}；`
      + `等式面 ${m.eqFace}/${m.blocks}、主语可判面 ${m.judgeableFace}/${m.blocks}`);
    console.log(`           人工 18 格：${g.rows} 行，V166 口径 ${JSON.stringify(g.v166)}，严格口径 ${JSON.stringify(g.strict)}`);
    const empty = Object.keys(g.strict).length === 0 || g.rows !== 18 || out.axis1_maintainability.tablesWithSet === 0 || !m.blocks;
    if (empty) { console.log('判据不可判：有轴的分母为 0（不是"没问题"，是尺子没扫到东西）'); process.exitCode = 3; }
  }
}
if (require.main === module) main();
