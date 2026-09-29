#!/usr/bin/env node
/**
 * 一问（V319）：主线9 那条「代码写入的词 −（挑中的）契约声明的词 = 词表漂移」判据，
 * **外推到链上全部有状态列的权威表**，今天会红几处？其中几处是"归属挑错"造出的假红？
 *
 * 为什么问这一层：主线9 今天只对两张表算这条（`scripts/audit-state-machine-roles.js:206-209`
 * WRITER_DRIFT_TARGETS = plan.yaml↔ewohSchedulePlan、control.yaml↔ewohControlCommand），
 * 另外五份契约被它自己登记成"未覆盖"（同文件 NOT_COVERED）。推广评估要回答
 * 「这条判据换到别的模块还成立吗」，而它现在只成立在两张表上 ⇒ 分母本身就是答案的一半。
 * V313–V316 的绑定件（`status-vocabulary-bindings.json`）补齐了外推要用的两根轴：
 * 第四面（`ewoh-spark-app/shared/` 的 TS 字面量联合）与契约自述轴（`contract_authors`／
 * `chosen_self_declared`）。⇒ 本影子档只量**外推的代价与假红面**，不改主线9、不接共享门禁。
 *
 * 三档并排跑同一条取词规则（唯一变量＝声明侧从哪来）：
 *   contract  绑定件挑中的那份契约的 `states:` 块（与主线9 同一解析式）
 *   face4     第四面：`shared/` 里与该表值集有关系的 TS 字面量联合
 *   author    自述轴：改由"自己写了本表"的那份契约供声明侧（挑中≠自述时与 contract 分叉）
 *
 * 三件硬校准（任一不符 ⇒ rc=1，整份读数不作数）：
 *   K1 复刻同源：本文件对 plan／command 两表算出的「写入 N 词／声明 M 词／漂移 K [ … ]」
 *      必须与真门禁 `--report-drift` 的打印逐字相同（复刻不许是近似）。
 *   K2 加面不消音：外推之后这两张既有表的欠账集必须与真门禁完全一致（新表不许把旧判决拖走）。
 *   K3 Σ=分母：每张表都要落进"可判／不可判·无取词／不可判·无声明侧"之一，加总等于绑定件自报表数。
 *
 * 退出码：0=有读数且三件校准全过；1=校准不符或判据自测没抓到；2=读数作废（Σ≠分母）；
 *        3=不可用（绑定件读不到、真门禁跑不起来）。
 * 用法：node scripts/chain-baseline/writer-drift-shadow.cjs [--self-test|--json]
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../..');
const BINDINGS = path.join(__dirname, 'status-vocabulary-bindings.json');
const AUDIT = path.join(ROOT, 'scripts/audit-state-machine-roles.js');
const SM_DIR = path.join(ROOT, 'contracts/state-machines');
const SERVER_ROOT = path.join(ROOT, 'ewoh-spark-app/server');

/** 真门禁今天钉的两张表（K1/K2 的对照对象；表名↔契约名成对，别拿契约名去比表名）。 */
const TODAY = [
  { table: 'ewohSchedulePlan', contract: 'plan.yaml' },
  { table: 'ewohControlCommand', contract: 'control.yaml' },
];
const TODAY_TABLES = new Set(TODAY.map((t) => t.table));

/**
 * 取词规则：逐字复刻 `scripts/audit-state-machine-roles.js:235-261` 的 scanWrittenStatesFromText
 * （V312 形状：认 `.update(表)` 起 18 行、`.insert(表)` 起 12 行；窗口内必须有 `status :`；
 * 只收 `status: '字面量'`，参数化 patch 归位点维度管）。
 * 为什么复刻而不 require 真门禁：那一段写在脚本顶层，require 会把整条门禁连同退出码一起跑完
 * （副作用不可控，且它自身就是被判对象）。两抄不一致的风险由 K1 逐字校准兜住。
 */
function harvestFromEntries(entries, tables) {
  const written = new Map();
  const sites = new Map();
  for (const t of tables) {
    written.set(t, new Set());
    sites.set(t, new Set());
  }
  for (const [rel, lines] of entries) {
    lines.forEach((l, i) => {
      for (const table of tables) {
        const isInsert = new RegExp(`\\.insert\\(${table}\\)`).test(l);
        if (!isInsert && !new RegExp(`\\.update\\(${table}\\)`).test(l)) continue;
        const window = lines.slice(i, i + (isInsert ? 12 : 18)).join('\n');
        if (!/\bstatus\s*:/.test(window)) continue;
        sites.get(table).add(rel);
        const re = /(?:^|[{,\s])status\s*:\s*'([\w-]+)'/g;
        let m;
        while ((m = re.exec(window)) !== null) written.get(table).add(m[1]);
      }
    });
  }
  return { written, sites };
}

/** 契约 `states:` 块解析（与真门禁 :223-232 同一表达式）。读不到返回 null，不返回空数组。 */
function parseDeclaredStates(file, dir = SM_DIR) {
  if (!file) return null;
  let text;
  try { text = fs.readFileSync(path.join(dir, file), 'utf8'); } catch { return null; }
  const block = /^states:\s*$([\s\S]*?)(?=^\S)/m.exec(text);
  if (!block) return null;
  const list = block[1].split('\n').map((l) => /^\s*-\s*([\w-]+)\s*$/.exec(l)).filter(Boolean).map((m) => m[1]);
  return list.length ? list : null;
}

function walkTs(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === '__tests__' || ent.name === 'node_modules') continue;
      walkTs(p, out);
    } else if (ent.name.endsWith('.ts') && !ent.name.endsWith('.spec.ts')) out.push(p);
  }
  return out;
}

const readCorpus = () => walkTs(SERVER_ROOT)
  .map((f) => [path.relative(SERVER_ROOT, f), fs.readFileSync(f, 'utf8').split('\n')]);

/** 真门禁的 --report-drift 逐表读数（K1/K2 的对照面）。整段读不到 ⇒ 抛错走 rc=3。 */
function realGateReport() {
  let out = '';
  try {
    out = execFileSync(process.execPath, [AUDIT, '--report-drift'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
  } catch (e) {
    out = String((e && e.stdout) || '');
  }
  if (!out.includes('[drift]')) throw new Error('真门禁 --report-drift 没打出 [drift] 行（门禁崩了或改了打印形状）');
  const rows = {};
  for (const line of out.split('\n')) {
    const m = /^\[drift\] \S+\((\w+)\): 写入 (\d+) 词 \/ 契约声明 (\d+) 词 \/ 词表漂移 (\d+) \[([^\]]*)\]/.exec(line);
    if (m) rows[m[1]] = { words: Number(m[2]), declared: Number(m[3]), drift: Number(m[4]), list: m[5] };
  }
  for (const { table } of TODAY) {
    if (!rows[table]) throw new Error(`真门禁的读数里缺 ${table} 这一行 ⇒ 对照不成，拒绝出数`);
  }
  return rows;
}

/** shared/ 里按名字取字面量联合的成员（face4 的"超集型"退化档要值，绑定件只存了名字）。 */
function loadSharedUnions() {
  const dir = path.join(ROOT, 'ewoh-spark-app/shared');
  const out = {};
  const re = /(?:export\s+)?type\s+(\w+)\s*=\s*([^;]+);/g;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.ts')) continue;
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    let m;
    while ((m = re.exec(text)) !== null) {
      const vals = [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]);
      if (vals.length) out[m[1]] = vals;
    }
  }
  return out;
}

/** 单表三档判定。声明侧取不到一律 declared=null ＋ why，绝不折成"欠账为空"。 */
function verdictFor(b, written, arms) {
  const w = [...written];
  const rows = {};
  const chosen = b.vocabulary || null;
  const chosenStates = parseDeclaredStates(chosen, arms.smDir);
  rows.contract = chosenStates
    ? { declared: chosenStates, source: chosen, undeclared: w.filter((x) => !chosenStates.includes(x)).sort() }
    : { declared: null, source: chosen, undeclared: null, why: chosen ? '那份契约里读不到 states 块' : '绑定件没挑中任何契约' };

  const authors = b.contract_authors || [];
  const others = b.other_author_states || [];
  rows.author = authors.length === 0
    ? { declared: null, source: null, undeclared: null, why: '没有任何契约自述本表（contract_authors 空）' }
    : (others.length
      ? { declared: others, source: authors.map((a) => `${a.file}#${a.block}`).join(' '),
        undeclared: w.filter((x) => !others.includes(x)).sort(),
        note: b.chosen_self_declared ? '挑中的那份即自述方 ⇒ 与 contract 档同解' : '改用自述方的词表' }
      : { declared: null, source: authors.map((a) => a.file).join(' '), undeclared: null, why: '自述方存在但没写 states 词表' });

  const sets = [];
  if (b.ts_type && Array.isArray(b.ts_type.values)) {
    sets.push({ source: `${b.ts_type.file}#${b.ts_type.name}`, values: b.ts_type.values, exact: b.ts_type_corroborated });
  }
  for (const ref of (b.ts_value_superset_types || [])) {
    const got = (arms.tsByName || {})[String(ref).split('#').pop()];
    if (got) sets.push({ source: ref, values: got, exact: true });
  }
  const union = [...new Set([].concat(...sets.map((x) => x.values)))];
  rows.face4 = sets.length
    ? { declared: union, source: [...new Set(sets.map((x) => x.source))].join(' '), merged: sets.length,
      undeclared: w.filter((x) => !union.includes(x)).sort(),
      exactOnly: sets.filter((x) => x.exact).map((x) => x.source) }
    : { declared: null, source: null, undeclared: null, why: 'shared/ 没有与该表值集相关的联合' };
  return rows;
}

function run({ bindings, corpus, smDir }) {
  const tables = bindings.bindings.map((b) => b.table);
  const { written, sites } = harvestFromEntries(corpus, tables);
  const arms = { smDir, tsByName: loadSharedUnions() };
  return bindings.bindings.map((b) => {
    const w = [...(written.get(b.table) || [])].sort();
    return {
      table: b.table,
      physical: b.physical,
      written: w,
      writtenCount: w.length,
      siteCount: (sites.get(b.table) || new Set()).size,
      authority: b.authority,
      coverage: b.coverage,
      selfDeclared: b.chosen_self_declared,
      authors: (b.contract_authors || []).length,
      verdicts: w.length ? verdictFor(b, new Set(w), arms)
        : { contract: { declared: null, undeclared: null, why: '取词为空（这条判据对它无话可说）' },
          author: { declared: null, undeclared: null, why: '取词为空' },
          face4: { declared: null, undeclared: null, why: '取词为空' } },
    };
  });
}

/* ── 三件校准 ───────────────────────────────────────────────────────── */
function calibrate(rows, real, denominator) {
  const problems = [];
  const byTable = new Map(rows.map((r) => [r.table, r]));
  const k1 = [];
  const k2 = [];
  for (const { table, contract } of TODAY) {
    const r = byTable.get(table);
    if (!r) { problems.push(`K0 既有表 ${table} 不在外推面里 ⇒ 分母本身不完整`); continue; }
    const declared = parseDeclaredStates(contract) || [];
    const und = r.written.filter((x) => !declared.includes(x));
    const got = { words: r.writtenCount, declared: declared.length, drift: und.length, list: und.join(',') };
    const want = real[table];
    const equal = got.words === want.words && got.declared === want.declared
      && got.drift === want.drift && got.list === want.list;
    k1.push({ table, replica: `${got.words}|${got.declared}|${got.drift}|${got.list}`,
      realGate: `${want.words}|${want.declared}|${want.drift}|${want.list}`, equal });
    if (!equal) problems.push(`K1 复刻与真门禁不符：${table} 复刻=${k1.at(-1).replica} 真门禁=${k1.at(-1).realGate}`);
    // K2 单独判欠账集本身：外推不许改动既有判决（与 K1 各一支，防"只靠 K1 蒙对"）
    const sameList = got.list === want.list;
    k2.push({ table, sameList });
    if (!sameList) problems.push(`K2 外推改动了既有判决：${table} 复刻=[${got.list}] 真门禁=[${want.list}]`);
  }
  const buckets = { 可判: 0, '不可判·无取词': 0, '不可判·无声明侧': 0 };
  for (const r of rows) {
    if (r.writtenCount === 0) buckets['不可判·无取词'] += 1;
    else if (r.verdicts.contract.declared == null && r.verdicts.face4.declared == null) buckets['不可判·无声明侧'] += 1;
    else buckets.可判 += 1;
  }
  const sum = Object.values(buckets).reduce((a, b) => a + b, 0);
  if (sum !== rows.length || rows.length !== denominator) {
    problems.push(`K3 分母加总 ${sum}／外推行数 ${rows.length}／绑定件自报 ${denominator} 三者不齐 ⇒ 读数作废`);
  }
  return { k1, k2, buckets, sum, problems };
}

/* ── 外推代价 ───────────────────────────────────────────────────────── */
function costOf(rows) {
  const fresh = [];
  const dubious = [];
  for (const r of rows) {
    if (TODAY_TABLES.has(r.table)) continue;
    const v = r.verdicts.contract;
    if (!v.undeclared || !v.undeclared.length) continue;
    const item = {
      table: r.table, contract: v.source, n: v.undeclared.length, words: v.undeclared.join(','),
      selfDeclared: r.selfDeclared, authors: r.authors, authority: r.authority,
      // 归属可信度三档：挑中的那份自述本表 ⇒ 可信；有别的契约自述本表而挑的不是它 ⇒ 可疑（WDRV-01 型假红）；
      // 一份自述都没有 ⇒ 无归属证据（既不能算真也不能算假）
      trust: r.selfDeclared ? '归属可信（自述本表）'
        : (r.authors ? '可疑（挑中≠自述方）' : '无归属证据（无契约自述本表）'),
    };
    (item.trust === '归属可信（自述本表）' ? fresh : dubious).push(item);
  }
  const face4Rescued = rows.filter((r) => r.writtenCount > 0 && r.verdicts.contract.declared == null
    && r.verdicts.face4.declared != null);
  const mergedUnions = face4Rescued.filter((r) => (r.verdicts.face4.merged || 1) > 1).map((r) => r.table);
  const authorDropped = rows.filter((r) => r.writtenCount > 0 && r.verdicts.contract.declared != null
    && r.verdicts.author.declared == null);
  const authorChanged = rows.filter((r) => r.writtenCount > 0 && r.verdicts.author.undeclared
    && r.verdicts.contract.undeclared
    && r.verdicts.author.undeclared.join(',') !== r.verdicts.contract.undeclared.join(','));
  return {
    fresh, dubious,
    face4Rescued: face4Rescued.map((r) => ({
      table: r.table, tsUnion: r.verdicts.face4.source, n: r.verdicts.face4.undeclared.length,
      words: r.verdicts.face4.undeclared.join(','), exact: r.verdicts.face4.exactOnly.length > 0,
      merged: r.verdicts.face4.merged || 1,
    })),
    mergedUnions,
    authorDropped: authorDropped.map((r) => r.table),
    authorChanged: authorChanged.map((r) => ({
      table: r.table, contract: r.verdicts.contract.undeclared.join(','), author: r.verdicts.author.undeclared.join(','),
    })),
  };
}

function report(rows, cal, cost, bindings) {
  console.log(`[分母] 外推面 ${rows.length} 张表（绑定件自报 ${bindings.summary.tables}）｜三档并排 contract／face4／author`);
  console.log('[K1 复刻同源] ' + cal.k1.map((x) => `${x.table} ${x.equal ? '逐字相同' : '★不符'}（复刻=${x.replica}｜真门禁=${x.realGate}）`).join('｜'));
  console.log('[K2 加面不消音] ' + cal.k2.map((x) => `${x.table} ${x.sameList ? '判决未动' : '★被改动'}`).join('｜'));
  console.log(`[K3 Σ=分母] ${JSON.stringify(cal.buckets)} 加总 ${cal.sum}`);
  const taken = rows.filter((r) => r.writtenCount > 0);
  console.log(`[取词] 这条判据取得到词的表 ${taken.length}/${rows.length} 张，写入位点共 ${taken.reduce((a, r) => a + r.siteCount, 0)} 处（按文件计）`);
  console.log(`[contract 档·外推] 新表里出现欠账：归属可信 ${cost.fresh.length} 张／${cost.fresh.reduce((a, x) => a + x.n, 0)} 条；`
    + `归属可疑或无证据 ${cost.dubious.length} 张／${cost.dubious.reduce((a, x) => a + x.n, 0)} 条`);
  for (const x of cost.fresh) console.log(`  ✔ ${x.table} 契约=${x.contract} 欠 ${x.n} 条 [${x.words}] ⇒ ${x.trust}`);
  for (const x of cost.dubious) console.log(`  ⚠ ${x.table} 契约=${x.contract} 欠 ${x.n} 条 [${x.words}] ⇒ ${x.trust}｜authority=${x.authority}`);
  console.log(`[face4 档] 契约面读不到、只有第四面可挂的表 ${cost.face4Rescued.length} 张：`
    + (cost.face4Rescued.map((x) => x.table).join(' ') || '（无）'));
  for (const x of cost.face4Rescued) {
    console.log(`  · ${x.table} 挂 ${x.tsUnion} ⇒ 欠 ${x.n} 条 [${x.words}]`
      + `（与实现值集精确同值＝${x.exact ? '是' : '否：非精确档会把真欠账读成没有'}；`
      + `并了 ${x.merged} 份联合${x.merged > 1 ? '⇒ 词集是并集，别的表写的词会被算进本表头上（消音方向）' : ''}）`);
  }
  console.log(`[author 档] 声明侧改由自述方供 ⇒ 判定改变的表 ${cost.authorChanged.length} 张`
    + `：${cost.authorChanged.map((x) => `${x.table}(${x.contract}→${x.author})`).join(' ') || '（无）'}`);
  console.log(`[author 档] 改成只认自述方后**掉进不可判**的表 ${cost.authorDropped.length} 张`
    + `：${cost.authorDropped.join(' ') || '（无）'}`);
  console.log(`[限度] 本影子档不改主线9 的判定面：两张既有表的判决由 K1/K2 逐字对回真门禁；`
    + `外推出来的欠账没有一条被登记成缺陷，也没有一条进棘轮基线（那属"接共享门禁"的严度裁决）。`);
  return cal.problems;
}

/* ── 判据自测：每条判据都配"必须报"与"必须不报"两侧，外加三件校准各自的独立极性 ──
 * 约定：一支用例**通过**＝它内部的断言全部成立；`✔` 不等于"判据开火"，开火与否写在名字里。
 * 之所以这样定：V319 第一版把"我的断言抛了"当成"判据开火"，于是夹具坏掉（契约解析不出 states）
 * 时四支"必须报"的分支全被读成 ✔ ——崩溃与开火同形。现在崩溃一律记 ✗。
 */
function selfTest() {
  const cases = [];
  const push = (name, fn) => {
    let msg = '';
    let crashed = '';
    try { fn(); } catch (e) {
      const m = String(e && e.message);
      // 我自己用 ok() 抛的是判语；TypeError 之类是量具崩了——两者都必须记红，但要说清是哪种。
      if (/^判据|^没|^合规|^不可|^外推|^Σ|桶|档|侧|窗口|欠账|INSERT|词数|分母|判决/.test(m)) msg = m;
      else crashed = m.slice(0, 120);
    }
    cases.push([name, !msg && !crashed, msg, crashed]);
  };
  const ok = (c, m) => { if (!c) throw new Error(m); };

  const smDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wds-'));
  // 夹具前提：`states:` 块靠"下一个顶层键"收尾（与真契约同形），少了收尾行解析必空。
  fs.writeFileSync(path.join(smDir, 'foo.yaml'), 'states:\n  - active\n  - done\ninitial: active\n');
  fs.writeFileSync(path.join(smDir, 'bar.yaml'), 'states:\n  - active\ninitial: active\n');
  fs.writeFileSync(path.join(smDir, 'empty.yaml'), 'role: 没有 states 块\n');
  const mk = (over) => ({
    table: 'ewohFoo', physical: 'ewoh_foo', vocabulary: 'foo.yaml', contract_authors: [],
    chosen_self_declared: false, other_author_states: [], ts_type: null, ts_value_superset_types: [],
    authority: 'contract+code', coverage: 1, ...over,
  });
  const one = (over, lines) => run({
    bindings: { summary: { tables: 1 }, bindings: [mk(over || {})] },
    corpus: [['a.ts', lines]], smDir,
  })[0];
  const REAL = () => {
    const declared = parseDeclaredStates('plan.yaml') || [];
    return (words, list) => ({
      ewohSchedulePlan: { words: words === undefined ? declared.length : words, declared: declared.length,
        drift: list ? list.split(',').filter(Boolean).length : 0, list: list || '' },
      ewohControlCommand: { words: 0, declared: 0, drift: 0, list: '' },
    });
  };

  push('T1 必须报·契约外字面量进欠账（写 ghost，foo.yaml 没这个词）', () => {
    const r = one(null, ["db.update(ewohFoo).set({ status: 'ghost' }).where(x)"]);
    ok(r.verdicts.contract.undeclared && r.verdicts.contract.undeclared.join() === 'ghost',
      `判据没报：${JSON.stringify(r.verdicts.contract)}`);
  });
  push('T2 必须不报·契约内字面量零欠账（写 active）', () => {
    const r = one(null, ["db.update(ewohFoo).set({ status: 'active' }).where(x)"]);
    ok(r.verdicts.contract.declared && r.verdicts.contract.declared.includes('active'), '夹具契约没解析出来');
    ok(JSON.stringify(r.verdicts.contract.undeclared) === '[]', `合规侧被误报：${JSON.stringify(r.verdicts.contract.undeclared)}`);
  });
  push('T3 必须不报也不判·契约无 states 块 ⇒ 落不可判而不是零欠账', () => {
    const r = one({ vocabulary: 'empty.yaml' }, ["db.update(ewohFoo).set({ status: 'ghost' })"]);
    ok(r.verdicts.contract.declared === null, '不可判被写成了判定');
    ok(r.verdicts.contract.undeclared === null, '欠账集凭空有了值');
    const cost = costOf([r]);
    ok(cost.fresh.length === 0 && cost.dubious.length === 0, '不可判被计进了欠账桶');
  });
  push('T4 必须报·INSERT 的 values({status}) 也在取词面（V312 那半边）', () => {
    const r = one(null, ['db.insert(ewohFoo).values({ status: \'fresh\' })']);
    ok(r.written.includes('fresh'), `INSERT 侧没被取到：${JSON.stringify(r.written)}`);
    ok(r.verdicts.contract.undeclared.includes('fresh'), 'INSERT 侧的词没进欠账判定');
  });
  push('T5 必须不报·窗口外的字面量不计入（取词窗口 18 行是承重参数）', () => {
    const lines = ['db.update(ewohFoo).set({'];
    for (let i = 0; i < 30; i += 1) lines.push(`  const pad${i} = i;`);
    lines.pop();
    lines.push("  status: 'ghost'");
    const r = one(null, lines);
    ok(!r.written.includes('ghost'), '窗口边界没承重：远处那行被计进来了');
  });
  const planRow = () => {
    const r = one(null, ["db.update(ewohFoo).set({ status: 'ghost' })"]);
    return [{ ...r, table: 'ewohSchedulePlan' }, { ...r, table: 'ewohControlCommand' }];
  };
  push('T6 校准 K1 独立极性·只词数不一致时 K1 响、K2 不许抢', () => {
    const declared = parseDeclaredStates('plan.yaml') || [];
    const rows = planRow();
    rows[0].written = ['ghost']; rows[0].writtenCount = 1;
    rows[1].written = []; rows[1].writtenCount = 0;
    const real = REAL()(declared.length + 5, 'ghost');
    real.ewohSchedulePlan.declared = declared.length;
    real.ewohSchedulePlan.drift = 1;
    const cal = calibrate(rows, real, 2);
    ok(cal.problems.some((p) => p.startsWith('K1') && /ewohSchedulePlan/.test(p)), 'K1 没响（词数不一致读成一致）');
    ok(!cal.problems.some((p) => p.startsWith('K2')), 'K2 抢了 K1 的活 ⇒ 它不是独立判');
  });
  push('T7 校准 K2 独立极性·欠账集不一致时 K2 自己那条必须在', () => {
    const rows = planRow();
    const declared = parseDeclaredStates('plan.yaml') || [];
    rows[0].written = []; rows[0].writtenCount = 0;
    rows[1].written = []; rows[1].writtenCount = 0;
    const cal = calibrate(rows, REAL()(0, 'nope'), 2);
    ok(cal.problems.some((p) => p.startsWith('K2')), 'K2 没响');
  });
  push('T8 校准 K3/K0·外推面少一张既有表或行数与绑定件自报不齐必须响', () => {
    const rows = [one(null, ["db.update(ewohFoo).set({ status: 'active' })"])];
    const cal = calibrate(rows, REAL()(0, ''), 4);
    ok(cal.problems.some((p) => p.startsWith('K0')), '既有表被静默丢掉没响');
    ok(cal.problems.some((p) => p.startsWith('K3')), 'Σ=分母这条是恒真的');
  });
  push('T9 归属分档·挑中≠自述方的欠账落"可疑"桶，不进"可信"桶', () => {
    const r = one({ chosen_self_declared: false, contract_authors: [{ file: 'bar.yaml', block: 'b' }],
      other_author_states: ['active'] }, ["db.update(ewohFoo).set({ status: 'ghost' })"]);
    const cost = costOf([r]);
    ok(cost.fresh.length === 0, '可疑归属进了可信桶');
    ok(cost.dubious.length === 1 && /可疑/.test(cost.dubious[0].trust), `没分档：${JSON.stringify(cost.dubious)}`);
  });
  push('T10 author 档·没有任何契约自述本表 ⇒ 不可判，且不得等于 contract 档', () => {
    const r = one(null, ["db.update(ewohFoo).set({ status: 'ghost' })"]);
    ok(r.verdicts.author.declared === null, 'author 档凭空有了声明侧');
    ok(r.verdicts.contract.undeclared.length === 1, 'contract 档反而丢了');
  });
  push('T11 face4 档·非精确联合必须仍标非精确，且这一档确实判出了零欠账', () => {
    const r = one({ vocabulary: 'empty.yaml',
      ts_type: { file: 'ewoh-spark-app/shared/x.ts', name: 'Whatever', values: ['ghost'] },
      ts_type_corroborated: false }, ["db.update(ewohFoo).set({ status: 'ghost' })"]);
    ok(r.verdicts.face4.exactOnly.length === 0, '非精确档被记成了精确档');
    ok(r.verdicts.face4.undeclared.length === 0, `第四面这一档没起作用：${JSON.stringify(r.verdicts.face4.undeclared)}`);
    const cost = costOf([r]);
    ok(cost.face4Rescued.length === 1 && cost.face4Rescued[0].exact === false, '契约不可判＋第四面可判这格没被点名');
  });
  fs.rmSync(smDir, { recursive: true, force: true });

  let bad = 0;
  for (const [name, good, msg, crashed] of cases) {
    if (!good) bad += 1;
    console.log(`${good ? '✔' : '✗'} ${name}${msg ? ' → ' + msg : ''}${crashed ? ' → ★量具崩溃：' + crashed : ''}`);
  }
  console.log(`\n[writer-drift-shadow] 判据自测 ${cases.length - bad}/${cases.length} 通过（条数由本脚本自报）`);
  return bad === 0 ? 0 : 1;
}

if (require.main === module) {
  if (process.argv.includes('--self-test')) {
    process.exitCode = selfTest();
  } else {
    let bindings;
    try { bindings = JSON.parse(fs.readFileSync(BINDINGS, 'utf8')); } catch (e) {
      console.error(`[writer-drift-shadow] 不可用：绑定件读不到（${e.message}）`);
      process.exit(3);
    }
    let real;
    try { real = realGateReport(); } catch (e) {
      console.error(`[writer-drift-shadow] 不可用：${e.message}`);
      process.exit(3);
    }
    const rows = run({ bindings, corpus: readCorpus(), smDir: SM_DIR });
    const cal = calibrate(rows, real, bindings.summary.tables);
    const cost = costOf(rows);
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify({ rows, cal, cost }, null, 1));
    } else {
      report(rows, cal, cost, bindings);
    }
    if (cal.problems.some((p) => p.startsWith('K3') || p.startsWith('K0'))) {
      console.error('\n' + cal.problems.filter((p) => p.startsWith('K3') || p.startsWith('K0')).join('\n') + ' ⇒ 读数作废');
      process.exit(2);
    }
    if (cal.problems.length) {
      console.error('\n校准不符：\n' + cal.problems.join('\n'));
      process.exit(1);
    }
    console.log('✅ 三件校准全过：复刻与真门禁逐字同源、外推未改动既有判决、分母加总等于绑定件自报表数');
  }
}

module.exports = { run, calibrate, costOf, harvestFromEntries, parseDeclaredStates, verdictFor, loadSharedUnions };
