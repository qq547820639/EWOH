#!/usr/bin/env node
/**
 * 状态列词表对账尺（V296）：只回答一个问题——
 *   「全仓被 UPDATE 写过取值的『状态列』里，有哪些**不在两把尺的词表上**，它们有没有来源态守卫？」
 *
 * 为什么要有它：守卫尺（status-write-guard-census）与扇出尺（write-fanout）的状态列词表都写死成
 * ['status','state']（write-fanout.cjs:52 / status-write-guard-census.cjs:51）。V293-V295 量到
 * schema 里另有以 Status/State 结尾的列，其中 1 处真有 UPDATE 写者。用那两把尺去查自己的盲区会自证，
 * 所以这里独立解析一次，并**与扇出尺逐项对账**（对不上就判"读数作废"，不各说各话）。
 *
 * 三态纪律：解不开的（set 实参不是对象字面量／列名解析不到表）单列一档，不折算成"没写"也不折算成"漏守卫"。
 * 判据自测条数由脚本自报。第一轮只出报告：未守卫数为 0 才 rc=0；本尺**未**接进共享门禁（接不接是口径裁决）。
 *
 *   node scripts/chain-baseline/state-column-vocabulary.cjs --self-test
 *   node scripts/chain-baseline/state-column-vocabulary.cjs [--report-only]
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'ewoh-spark-app/server');
const SCHEMA = path.join(SERVER, 'database/schema.ts');
const FANOUT_JSON = path.join(ROOT, 'tmp/write-fanout.json');
const VOCAB = new Set(['status', 'state']);
const ARGS = process.argv.slice(2);

function stateCols(body) {
  const out = new Map();
  for (const m of body.matchAll(/^\s+([A-Za-z_$][\w$]*)\s*:/gm)) {
    const k = m[1];
    if (VOCAB.has(k) || /(?:Status|State)$/.test(k)) out.set(k, VOCAB.has(k) ? 'in-vocab' : 'out-of-vocab');
  }
  return out;
}
/** schema.ts → 表变量名 → 该表的状态类列（含"这列在不在两把尺词表上"）。 */
function schemaStateColumns(src) {
  const tables = new Map();
  for (const m of src.matchAll(/export const (\w+)\s*=\s*pgTable\(\s*['"`](\w+)['"`]\s*,\s*\{/g)) {
    let d = 0;
    let i = m.index + m[0].length - 1;
    for (; i < src.length; i++) {
      if (src[i] === '{') d += 1;
      else if (src[i] === '}') { d -= 1; if (d === 0) break; }
    }
    const cols = stateCols(src.slice(m.index + m[0].length, i));
    if (cols.size) tables.set(m[1], { table: m[2], cols });
  }
  return tables;
}
function setArgAndWhere(tail) {
  const sm = /^\s*\.set\(/.exec(tail);
  if (!sm) return null;
  const start = sm[0].length;
  let j = start, d = 0, q = null;
  for (; j < tail.length; j++) {
    const c = tail[j];
    if (q) { if (c === '\\') { j += 1; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '(' || c === '{' || c === '[') d += 1;
    else if (c === ')' || c === '}' || c === ']') { d -= 1; if (d === 0) break; }
  }
  return { arg: tail.slice(start, j), where: tail.slice(j, j + 1500) };
}
function topLevelKeys(arg) {
  if (!/^\s*\{/.test(arg)) return null;
  const segs = [];
  let depth = 0, seg = '', q = null;
  for (let j = arg.indexOf('{') + 1; j < arg.length; j++) {
    const c = arg[j];
    if (q) { seg += c; if (c === '\\') seg += arg[++j]; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; seg += c; continue; }
    if (c === '{' || c === '(' || c === '[') depth += 1;
    else if (c === '}' || c === ')' || c === ']') depth -= 1;
    if (depth < 0) break;
    if (c === ',' && depth === 0) { segs.push(seg); seg = ''; continue; }
    seg += c;
  }
  segs.push(seg);
  return segs.map((raw) => {
    const s = raw.trim();
    if (!s) return null;
    if (/^\.\.\./.test(s)) return { key: null, spread: true };
    const m = s.match(/^(?:['"]?)([A-Za-z_$][\w$]*)(?:['"]?)\s*:/);
    if (m) return { key: m[1], spread: false };
    if (/^[A-Za-z_$][\w$]*$/.test(s)) return { key: s, spread: false };
    return null;
  }).filter(Boolean);
}
/** 分母：一个位点＝一处 `.update(表变量)` 紧跟的 `.set(...)`；排除面＝__tests__／*.spec.ts／*.d.ts。 */
function scan(entries, tables) {
  const sites = [];
  for (const [rel, src] of entries) {
    for (const m of src.matchAll(/\.update\((\w+)\)/g)) {
      const tbl = m[1];
      if (!tables.has(tbl)) continue;                  // 表变量在 schema 里解不到 → 不入分母，另计（见 unresolved）
      // 守卫窗口必须停在**同一条语句**内：切到下一个 `.update(` 之前。
      // 不切的话，下一条语句里别人的 `eq(t.lifecycleStatus, …)` 会把这一条读成"已守卫"（自测第 4 支钉住这件事）。
      const rawTail = src.slice(m.index + m[0].length);
      const nxt = rawTail.indexOf('.update(');
      const tail = nxt >= 0 ? rawTail.slice(0, nxt) : rawTail;
      const tw = setArgAndWhere(tail);
      const line = src.slice(0, m.index).split('\n').length;
      if (!tw) { sites.push({ rel, line, tbl, kind: 'no-set' }); continue; }
      const keys = topLevelKeys(tw.arg);
      if (!keys) { sites.push({ rel, line, tbl, kind: 'opaque-patch' }); continue; }
      for (const k of keys) {
        if (!k.key) { sites.push({ rel, line, tbl, kind: 'spread', col: null }); continue; }
        if (!tables.get(tbl).cols.has(k.key)) continue; // 该列不是状态类列
        const guarded = new RegExp(`\\.${k.key}\\b`).test(tw.where);
        sites.push({ rel, line, tbl, kind: 'write', col: k.key, vocab: tables.get(tbl).cols.get(k.key), guarded });
      }
    }
  }
  return sites;
}
function listSources(root) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') walk(p); continue; }
      if (!e.name.endsWith('.ts') || e.name.endsWith('.d.ts') || e.name.endsWith('.spec.ts')) continue;
      out.push([path.relative(ROOT, p), fs.readFileSync(p, 'utf8')]);
    }
  };
  walk(root);
  return out;
}

function selfTest(tablesAll) {
  const bad = [];
  let CHECKS = 0;
  const ck = (ok, msg) => { CHECKS += 1; if (!ok) bad.push(msg); };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'statecol-'));
  try {
    const w = (rel, body) => {
      const p = path.join(dir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, body);
    };
    w('database/schema.ts', [
      'export const ewohThing = pgTable("ewoh_thing", {',
      '  id: text("id"),',
      '  status: text("status"),',
      '  lifecycleStatus: text("lifecycle_status"),',
      '  statusCode: text("status_code"),',
      '  payloadJson: jsonb("payload_json"),',
      '});',
      'export const ewohOther = pgTable("ewoh_other", { id: text("id"), healthStatus: text("health_status") });',
    ].join('\n'));
    const tables = schemaStateColumns(fs.readFileSync(path.join(dir, 'database/schema.ts'), 'utf8'));
    ck(tables.get('ewohThing').cols.get('status') === 'in-vocab', '正例失败：status 没被认成词表内状态列（尺子压根不开火）');
    ck(tables.get('ewohThing').cols.get('lifecycleStatus') === 'out-of-vocab', '待测失败：lifecycleStatus 没被认成越词表状态列');
    ck(!tables.get('ewohThing').cols.has('statusCode'), '不得开火：statusCode 是码值列，不该进状态列集合');
    ck(!tables.get('ewohThing').cols.has('payloadJson'), '不得开火：jsonb 列名不含 Status，不该进集合');

    const src = [
      "await db.update(ewohThing).set({ status: 'a' }).where(and(eq(ewohThing.id, 1), eq(ewohThing.status, old)));",
      "await db.update(ewohThing).set({ lifecycleStatus: next }).where(and(eq(ewohThing.id, 1)));",           // 越词表·无守卫 ⇒ 必须点名
      "await db.update(ewohThing).set({ lifecycleStatus: next }).where(and(eq(ewohThing.lifecycleStatus, old)));", // 越词表·有守卫
      "await db.update(ewohThing).set({ payloadJson: { status: 'nested' } }).where(eq(ewohThing.id, 1));",     // 嵌套 ⇒ 不得算
      'await db.update(ewohThing).set(patch).where(eq(ewohThing.id, 1));',                                     // 解不开 ⇒ 单列
      'await db.update(ewohThing).set({ statusCode: 500 }).where(eq(ewohThing.id, 1));',                       // 码值列 ⇒ 不得算
    ].join('\n');
    const sites = scan([['x/svc.ts', src]], tables);
    const writes = sites.filter((s) => s.kind === 'write');
    const lc = writes.filter((s) => s.col === 'lifecycleStatus');
    ck(writes.some((s) => s.col === 'status' && s.guarded === true), '正例失败：带守卫的 status 写点没读到守卫');
    ck(lc.length === 2, `越词表 lifecycleStatus 应有 2 处写点，实得 ${lc.length}`);
    ck(lc.filter((s) => s.guarded).length === 1, `越词表带/不带守卫应各 1，实得 ${JSON.stringify(lc.map((s) => s.guarded))}`);
    ck(!writes.some((s) => s.col === 'payloadJson' || s.col === 'statusCode'),
      '不得开火：嵌套 jsonb 子字段 status 或码值列 statusCode 被当成了表列状态写点');
    ck(!writes.some((s) => s.col === 'statusCode'), '不得开火：statusCode 被当成了状态写点');
    ck(sites.some((s) => s.kind === 'opaque-patch'), '解不开档没被单列（.set(变量) 必须进 opaque-patch，不折算）');
    ck(writes.filter((s) => s.col === 'status').length === 1 && writes.filter((s) => s.col === 'status')[0].guarded === true,
      '词表内侧读错：status 写点应恰 1 处且判为带守卫（守卫位或嵌套判定任一读错都会改变这条）');
    // V296：分母门本身也要会开火——"看不见"与"没有"必须在退出码上分开。
    ck(denominatorVerdict(59, 86) === 'ok', '分母门不得开火：正常语料（表 59／词表内写点 86）被判成不可判或作废');
    ck(denominatorVerdict(59, 0) === 'void', '分母门必须开火：词表内侧读到 0 处时"越词表 0 处"会被读成已查干净');
    ck(denominatorVerdict(3, 86) === 'unresolved', 'schema 解析不出表时必须判不可判，不折成"没有越词表写者"');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { CHECKS, bad };
}

/**
 * 分母自证（三态，别折成任何一侧）：schema 解析不出表 ⇒ 不可判；词表内侧（status/state）
 * 真语料写点数为 0 ⇒ 探针不开火，读数作废。V293 那轮"解析出 0 列"正是靠先跑正向对照才没被读成
 * "schema 里真的没有别的状态列"，这里把它做成尺子自己的硬门，而不是靠人记得跑对照。
 * 返回：'ok' | 'unresolved'（分母不成立，exit 3 用） | 'void'（探针不开火，exit 2 用）。
 */
function denominatorVerdict(tablesSize, inVocabWrites) {
  if (tablesSize < 30) return 'unresolved';
  if (inVocabWrites === 0) return 'void';
  return 'ok';
}

function main() {
  const tables = schemaStateColumns(fs.readFileSync(SCHEMA, 'utf8'));
  if (denominatorVerdict(tables.size, 1) === 'unresolved') {
    console.log(`不可判：schema.ts 只解析出 ${tables.size} 张带状态类列的表 ⇒ 分母不成立（不把"没扫到"当成"没有"）`);
    process.exit(3);
  }
  if (ARGS.includes('--self-test')) {
    const r = selfTest(tables);
    r.bad.forEach((b) => console.log(`  ✗ ${b}`));
    if (r.CHECKS < 10) { console.log(`判据自测条数异常（${r.CHECKS}）⇒ 控制没跑完，不算通过`); process.exit(1); }
    console.log(r.bad.length ? `状态列词表判据自测：不通过（${r.bad.length} 项失败 / 共 ${r.CHECKS} 项）`
      : `状态列词表判据自测：通过（${r.CHECKS} 项：词表内外分类、守卫两极性、嵌套不得算、码值列不得算、解不开单列）`);
    process.exit(r.bad.length ? 1 : 0);
  }
  const entries = listSources(SERVER);
  const sites = scan(entries, tables);
  const writes = sites.filter((s) => s.kind === 'write');
  const inV = writes.filter((s) => s.vocab === 'in-vocab');
  const outV = writes.filter((s) => s.vocab === 'out-of-vocab');
  const opaque = sites.filter((s) => s.kind === 'opaque-patch');
  const spread = sites.filter((s) => s.kind === 'spread');
  const noSet = sites.filter((s) => s.kind === 'no-set');

  // 与扇出尺对账（同一个问题不许有两个数）：按 FACTS 表逐表比"词表内状态写点数"
  let mismatch = [];
  if (fs.existsSync(FANOUT_JSON)) {
    const fw = JSON.parse(fs.readFileSync(FANOUT_JSON, 'utf8'));
    for (const row of fw.rows || []) {
      const mine = inV.filter((s) => s.tbl === row.table).length;
      const theirs = row.after && row.after.stmts;
      if (typeof theirs === 'number' && mine !== theirs) mismatch.push(`${row.table}: 本尺 ${mine} vs 扇出尺 ${theirs}`);
    }
  } else {
    mismatch.push('（读不到 tmp/write-fanout.json ⇒ 本项未核对，不把"没核对"当成"对上了"）');
  }

  const unguarded = outV.filter((s) => !s.guarded);
  console.log(`分母自证：扫 ${entries.length} 个产品 .ts｜schema 带状态类列的表 ${tables.size} 张｜`.replace(/\n/g, '')
    + `UPDATE 写点 ${writes.length} 处（词表内 ${inV.length}／越词表 ${outV.length}）`
    + `｜解不开 .set(变量) ${opaque.length}／顶层展开 ${spread.length}／update 后无 set ${noSet.length}（三档均不折算）`);
  if (denominatorVerdict(tables.size, inV.length) === 'void') {
    console.log('读数作废：真语料词表内侧（status/state）写点数读到 0 ⇒ 探针不开火，'
      + '越词表那一侧的读数（包括"0 处"）一律不可引用——"看不见"与"没有"在这一档必须分得开');
    process.exit(2);
  }
  const agg = new Map();
  for (const s of outV) {
    const k = `${s.tbl}.${s.col}`;
    const cur = agg.get(k) || { n: 0, g: 0, at: [] };
    cur.n += 1; if (s.guarded) cur.g += 1; else cur.at.push(`${s.rel}:${s.line}`);
    agg.set(k, cur);
  }
  console.log(agg.size ? '越词表的状态列写者（两把尺在词表上看不见的那一面）：' : '越词表的状态列写者：0 处');
  for (const [k, v] of [...agg.entries()].sort()) {
    console.log(`  ${k}  写点 ${v.n}／带同列谓词 ${v.g}／未守卫位点 ${v.at.join(' ') || '（无）'}`);
  }
  console.log(`对账（与 write-fanout 的 FACTS 十表逐表比词表内写点数）：${mismatch.length ? '不一致 ⇒ 读数作废\n  ' + mismatch.join('\n  ') : '逐表同数 ✅'}`);
  if (mismatch.length) process.exit(2);
  const rc = unguarded.length === 0 ? 0 : (ARGS.includes('--report-only') ? 0 : 1);
  console.log(`判决：越词表且**无来源态谓词**的写点 ${unguarded.length} 处 ⇒ `
    + (unguarded.length === 0 ? '词表盲区当前无未守卫存量（依据见上，非"看不见所以没有"：分母与三档均已单列）'
      : '存在越词表且未守卫的写点（本尺默认判红；--report-only 只出报告）')
    + `。限度：只认 update 紧跟 set 的链式形状；守卫判据是"同一条语句内（切到下一个 .update( 之前）、至多 1500 字符里出现同名列引用"，比守卫尺的谓词第一实参位松——跨语句外溢由自测第 4 支钉住。`);
  process.exit(rc);
}
main();
