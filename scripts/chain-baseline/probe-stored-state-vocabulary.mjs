#!/usr/bin/env node
/**
 * 存量状态取值 ↔ 词表三档判据（V314）：链基线库里每张链上表的 status/state 列，
 * 它的 DDL 默认值与实有取值，分别被哪一档词表认领？
 *
 * 这条量具只回答一个问题：**"某个存量值没有任何规范面认领"这件事，加几个面才消得掉。**
 * 三档由窄到宽，同一份存量读数一次跑完、逐格对齐，不许只报最宽那档：
 *   三面（V313 判据）＝链上可写 ∪ 迁移 CHECK ∪ 契约声明
 *   强四面＝三面 ∪ **命名规则命中**的那张 shared/ 字面量联合（`ewoh_x_y` → `XYStatus`）
 *   弱四面＝强四面 ∪ "容得下该表全部可写值"的那些 shared/ 联合（含 `export interface` 的字段级内联联合）
 * 判定档位（三态，不互相折算）：
 *   F1＝该列 DDL 默认值在本档词表外（省略该列的写入会静默落进状态机不认识的值）
 *   F2＝库里实有取值在本档词表外（⇒ 有链外写入者、遗留值，或量具读不到的写法）
 *   F3＝本库 0 行 ⇒ 存量侧不可判（绝不折成"没有异常值"）
 *   OK-strict＝NOT NULL 且无默认 ⇒ 省略列会被 23502 拒，这是结构性安全那一档
 * 用法：先 `make chain-baseline-up`（一般还要 seed／跑过重放）。
 *   node scripts/chain-baseline/probe-stored-state-vocabulary.mjs
 *   判据自测：同一路径加 --self-test（不起集群、不连库）
 * 集群未起 ⇒ 退出码 3（与 doctor 同语义：不可判，不是"没有缺陷"）。
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const req = createRequire(path.join(root, 'ewoh-spark-app/package.json'));
const gen = createRequire(import.meta.url)('./gen-vocabulary-bindings.cjs');
const BINDINGS = path.join(root, 'scripts/chain-baseline/status-vocabulary-bindings.json');

export const ARMS = ['三面', '强四面', '弱四面'];

/** 纯函数：一张表在三档各自的已知词表。types＝shared/ 抽出的联合清单（按 `file#name` 索引）。 */
export function armSets(row, types) {
  const three = new Set([
    ...(row.written || []),
    ...(row.db_constraint ? row.db_constraint.values : []),
    ...(row.declaredNotWritten || []),
  ]);
  const strong = new Set(three);
  if (row.ts_type) for (const v of row.ts_type.values) strong.add(v);
  const weak = new Set(strong);
  const byName = new Map((types || []).map((t) => [`${t.file}#${t.name}`, t]));
  for (const key of row.ts_value_superset_types || []) {
    const t = byName.get(key);
    if (t) for (const v of t.values) weak.add(v);
  }
  return { 三面: three, 强四面: strong, 弱四面: weak };
}

/** 某个值被哪一面认领：强＝命名规则命中的那张类型；弱＝别名的联合里也有这个值。 */
export function claimOf(value, row, tsIndex) {
  const faces = [];
  if ((row.written || []).includes(value)) faces.push('代码可写');
  if (row.db_constraint && row.db_constraint.values.includes(value)) faces.push('DB CHECK');
  if ((row.declaredNotWritten || []).includes(value)) faces.push('契约声明');
  const strong = row.ts_type && row.ts_type.values.includes(value) ? row.ts_type.name : null;
  if (strong) faces.push(`TS 同名(${strong})`);
  const weak = (tsIndex[value] || []).filter((n) => n !== strong);
  return { faces, strong, weak, claimed: faces.length > 0 };
}

/** 纯函数：一格（表×列）在三档各自的 red（F1／F2）＋两档共用的中性判语。 */
export function classifyArms(row, sets) {
  const out = { neutral: [], red: {} };
  const dv = row.default_value;
  if (dv !== null && dv !== undefined) {
    for (const a of ARMS) if (!sets[a].has(dv)) (out.red[a] = out.red[a] || []).push({ f: 'F1', v: dv });
  } else if (row.is_nullable === 'NO') {
    out.neutral.push('OK-strict');
  }
  if (!row.row_count) {
    out.neutral.push('F3');
  } else {
    for (const a of ARMS) {
      const bad = row.values.filter((v) => !sets[a].has(v.v));
      if (bad.length) (out.red[a] = out.red[a] || []).push(...bad.map((b) => ({ f: 'F2', v: b.v, n: b.n })));
    }
  }
  return out;
}

/** 纯函数（V316 分片档）：某一行群体（event_type×取值）在两根轴上各自怎么读——
 *  ①该 event_type 是否出现在任一自述方的分片串里（`authority_type` 或契约的行尾注释，逐字包含，不解析成 SQL）；
 *  ②该取值被哪一档认领。两轴不并成一句"合规"：只有「不在任何已声明分片 ∧ 三面不认」才是这一档要找的形状，
 *  而「不在分片 ∧ 三面认得」是量具挑错了主体，「在分片 ∧ 三面不认」是另一码事，都得分开报。 */
export function shardVerdict(eventType, value, authors, sets, otherAuthorStates) {
  const notes = (authors || []).map((a) => `${a.shard_type || ''} ${a.shard_note || ''}`).filter((s) => s.trim());
  const inShard = eventType !== null && notes.some((s) => s.includes(String(eventType)));
  const v = String(value);
  const face = sets['三面'].has(v) ? '三面内'
    : ((otherAuthorStates || []).includes(v) ? '只被另一自述方的词表持有'
      : (sets['弱四面'].has(v) ? '只被 shared/ 弱认领' : '无人认领'));
  const flag = !inShard && (face === '只被另一自述方的词表持有' || face === '无人认领');
  return { inShard, face, flag };
}

function selfTest() {
  const types = [
    { file: 'shared/x.ts', name: 'FooStatus', values: ['a', 'b', 'c'] },
    { file: 'shared/y.ts', name: 'BarStatus', values: ['a', 'b', 'q'] },
  ];
  // 命名规则命中这张表（ts_type 已填）
  const rowTs = { written: ['a'], db_constraint: null, declaredNotWritten: [], ts_type: types[0],
    ts_value_superset_types: ['shared/x.ts#FooStatus'] };
  // 命名没命中，但别名联合容得下它的全部可写值 ⇒ 只进取值面
  const rowWeak = { written: ['a'], db_constraint: null, declaredNotWritten: [], ts_type: null,
    ts_value_superset_types: ['shared/y.ts#BarStatus'] };
  const cases = [
    // ① 默认值只被同名类型认领 ⇒ 三面红、强四面起不红
    { name: '默认值被同名 TS 类型认领 ⇒ 只红三面',
      row: { default_value: 'c', is_nullable: 'NO', row_count: 2, values: [{ v: 'a', n: 2 }] },
      sets: armSets(rowTs, types), red: { 三面: ['F1'], 强四面: [], 弱四面: [] } },
    // ② 默认值只被别名联合认领 ⇒ 强四面仍红、弱四面不红（这一支钉住"强／弱不是同一档"）
    { name: '默认值只被别名联合认领 ⇒ 强四面仍红、弱四面不红',
      row: { default_value: 'q', is_nullable: 'YES', row_count: 2, values: [{ v: 'a', n: 2 }] },
      sets: armSets(rowWeak, types), red: { 三面: ['F1'], 强四面: ['F1'], 弱四面: [] } },
    // ③ 谁都不认 ⇒ 三档全红（"加面＝消音"的反证）
    { name: '默认值与存量三档都不认 ⇒ 三档全红',
      row: { default_value: 'zzz', is_nullable: 'NO', row_count: 1, values: [{ v: 'zzz', n: 1 }] },
      sets: armSets(rowTs, types), red: { 三面: ['F1', 'F2'], 强四面: ['F1', 'F2'], 弱四面: ['F1', 'F2'] } },
    // ④ 合规侧不得开火（否则"0 命中"毫无意义）
    { name: '默认值与存量都在三面内 ⇒ 三档都不红',
      row: { default_value: 'a', is_nullable: 'NO', row_count: 3, values: [{ v: 'a', n: 3 }] },
      sets: armSets(rowTs, types), red: { 三面: [], 强四面: [], 弱四面: [] } },
    // ⑤ 0 行 ⇒ F3，不许折成"没有异常值"
    { name: '0 行 ⇒ F3 且不算红',
      row: { default_value: null, is_nullable: 'YES', row_count: 0, values: [] },
      sets: armSets(rowTs, types), red: { 三面: [], 强四面: [], 弱四面: [] }, neutral: ['F3'] },
    // ⑥ NOT NULL 且无默认 ⇒ OK-strict 那一档，不许与"有默认且被认领"混成一格
    { name: 'NOT NULL 无默认 ⇒ OK-strict',
      row: { default_value: null, is_nullable: 'NO', row_count: 2, values: [{ v: 'a', n: 2 }] },
      sets: armSets(rowWeak, types), red: { 三面: [], 强四面: [], 弱四面: [] }, neutral: ['OK-strict'] },
    // ⑦ 弱认领必须过"容得下全部可写值"这道闸：只撞上默认值不算弱认领
    { name: '别名联合只撞上默认值、撞不上可写集 ⇒ 弱四面仍红',
      row: { default_value: 'q', is_nullable: 'YES', row_count: 2, values: [{ v: 'a', n: 2 }] },
      sets: armSets({ written: ['a', 'b'], db_constraint: null, declaredNotWritten: [], ts_type: null,
        ts_value_superset_types: [] }, types),
      red: { 三面: ['F1'], 强四面: ['F1'], 弱四面: ['F1'] } },
    // ⑧ DB CHECK 是三面那档的承重面：去掉它，同一个默认值就该从"不红"翻成"红"
    { name: '同一默认值：有 CHECK 三面不红、无 CHECK 三面红',
      row: { default_value: 'a', is_nullable: 'NO', row_count: 2, values: [{ v: 'a', n: 2 }] },
      sets: armSets({ written: [], db_constraint: { values: ['a', 'b'] }, declaredNotWritten: [],
        ts_type: null, ts_value_superset_types: [] }, types),
      red: { 三面: [], 强四面: [], 弱四面: [] },
      also: { row: { default_value: 'a', is_nullable: 'NO', row_count: 2, values: [{ v: 'a', n: 2 }] },
        sets: armSets({ written: [], db_constraint: null, declaredNotWritten: [], ts_type: null,
          ts_value_superset_types: [] }, types),
        red: { 三面: ['F1', 'F2'], 强四面: ['F1', 'F2'], 弱四面: ['F1', 'F2'] } } },
    // ⑨ 第三根轴（V316 自述归属）不许折进任何一档：别的自述方认得这个值，判语必须照红。
    //    这支是**防将来并集**的棘轮——若有人把 other_author_states 并进 armSets，本例当场翻红（"缺 F2"）。
    { name: '值只被"另一份自述方"的词表持有 ⇒ 三档都仍红（不折成已认领）',
      row: { default_value: null, is_nullable: 'YES', row_count: 3, values: [{ v: 'closed', n: 3 }] },
      sets: armSets({ written: ['a'], db_constraint: null, declaredNotWritten: [], ts_type: null,
        ts_value_superset_types: [], other_author_states: ['closed'] }, types),
      red: { 三面: ['F2'], 强四面: ['F2'], 弱四面: ['F2'] } },
  ];
  let bad = 0;
  for (const c of cases) {
    const check = (cc) => {
      const got = classifyArms(cc.row, cc.sets);
      const errs = [];
      for (const a of ARMS) {
        const gf = (got.red[a] || []).map((x) => x.f);
        const want = cc.red[a] || [];
        for (const w of want) if (!gf.includes(w)) errs.push(`${a} 缺 ${w}`);
        for (const g of gf) if (!want.includes(g)) errs.push(`${a} 多 ${g}`);
      }
      for (const n of cc.neutral || []) if (!got.neutral.includes(n)) errs.push(`缺 ${n}`);
      return { got, errs };
    };
    const first = check(c);
    const second = c.also ? check(c.also) : null;
    const errs = [...first.errs, ...(second ? second.errs : [])];
    if (errs.length) bad += 1;
    console.log(`${errs.length ? '✗' : '✔'} ${c.name}`
      + ` ⇒ ${ARMS.map((a) => `${a}:${(first.got.red[a] || []).map((x) => x.f).join('+') || '不红'}`).join('｜')}`
      + `${first.got.neutral.length ? `｜${first.got.neutral.join(',')}` : ''}`
      + `${second ? `｜反证档 ${ARMS.map((a) => `${a}:${(second.got.red[a] || []).map((x) => x.f).join('+') || '不红'}`).join(' ')}` : ''}`
      + `${errs.length ? `  ✗ ${errs.join('、')}` : ''}`);
  }
  const strong = claimOf('c', rowTs, { c: ['FooStatus'] }).strong === 'FooStatus';
  const weak = claimOf('c', rowWeak, { c: ['FooStatus'] }).faces.length === 0
    && claimOf('c', rowWeak, { c: ['FooStatus'] }).weak.join() === 'FooStatus';
  const none = claimOf('q', rowTs, {}).claimed === false;
  const gradeOk = strong && weak && none;
  if (!gradeOk) bad += 1;
  console.log(`${gradeOk ? '✔' : '✗'} claimOf 强弱分档 ⇒ 强 ${strong}／弱 ${weak}／无人认领 ${none}`);
  // ⑩⑪⑫⑬ 分片档（V316）：两根轴各自配一支必须开火与一支不得开火，免得"并成一句合规"
  const authorsEv = [
    { file: 'alert.yaml', block: 'andon', shard_note: "event_type='AndonRaised' 的那些行", shard_type: null },
    { file: 'approval.yaml', block: 'expiry', shard_note: null, shard_type: 'approval_instance' },
  ];
  const sSets = { 三面: new Set(['open']), 强四面: new Set(['open']), 弱四面: new Set(['open']) };
  const shard = [
    { name: '分片档：埋点群体的 closed ⇒ 不在任何已声明分片＋只被另一自述方持有 ⇒ 开火',
      got: shardVerdict('ui_telemetry', 'closed', authorsEv, sSets, ['closed']),
      want: { inShard: false, face: '只被另一自述方的词表持有', flag: true } },
    { name: '分片档：AndonRaised 的 closed ⇒ 落在已声明分片 ⇒ 不开火（值面那侧另有 F2 判据）',
      got: shardVerdict('AndonRaised', 'closed', authorsEv, sSets, ['closed']),
      want: { inShard: true, flag: false } },
    { name: '分片档：分片键走 authority_type（approval_instance）⇒ 认得出，且无人认领也不由本档开火',
      got: shardVerdict('approval_instance', 'consumed', authorsEv, sSets, []),
      want: { inShard: true, face: '无人认领', flag: false } },
    { name: '分片档：三面认得的值即便不在分片也不开火（那是主体挑错，不是分片外群体）',
      got: shardVerdict('ui_telemetry', 'open', authorsEv, sSets, []),
      want: { inShard: false, face: '三面内', flag: false } },
  ];
  let shardBad = 0;
  for (const c of shard) {
    const errs = Object.entries(c.want).filter(([k, v]) => c.got[k] !== v)
      .map(([k, v]) => `${k} 实得 ${c.got[k]}／期望 ${v}`);
    if (errs.length) shardBad += 1;
    console.log(`${errs.length ? '✗' : '✔'} ${c.name} ⇒ 分片 ${c.got.inShard}／认领 ${c.got.face}／开火 ${c.got.flag}`
      + `${errs.length ? `  ✗ ${errs.join('、')}` : ''}`);
  }
  const total = cases.length + 1 + shard.length;
  // `bad` 里已经把 claimOf 那一支计进去了（gradeOk 不过时 bad+=1），不能再加一遍
  const badAll = bad + shardBad;
  console.log(`[self-test] ${total - badAll}/${total} 抓到`
    + `（判据 ${cases.length}＋认领分档 1＋分片档 ${shard.length}；对照 ${badAll} 项）`);
  process.exit(badAll ? 1 : 0);
}
if (process.argv.includes('--self-test')) selfTest();

const env = (n, f) => (process.env[n] || '').trim() || f;
const url = `postgresql://${env('EWOH_CHAIN_BASE_OWNER', 'ewoh_owner')}:${env('EWOH_CHAIN_BASE_OWNER_PW', 'ewoh_chain_pw')}@127.0.0.1:${env('EWOH_CHAIN_BASE_PORT', '55432')}/${env('EWOH_CHAIN_BASE_DB', 'ewoh')}`;
if (!fs.existsSync(BINDINGS)) {
  console.error('[probe] 先跑 node scripts/chain-baseline/gen-vocabulary-bindings.cjs 生成绑定件');
  process.exit(2);
}
const bindings = JSON.parse(fs.readFileSync(BINDINGS, 'utf8')).bindings;
const tsList = gen.tsTypes();
const tsIndex = {};
for (const t of tsList) for (const v of t.values) (tsIndex[v] = tsIndex[v] || []).push(t.name);

const NAME = /^ewoh_[a-z0-9_]+$/;
const postgres = req('postgres');
const sql = postgres(url, { max: 1 });
try {
  const cells = [];
  for (const b of bindings) {
    const t = b.physical;
    if (!NAME.test(t)) { cells.push({ table: t, skip: '表名形状不合法，不拼进查询' }); continue; }
    let cols;
    try {
      cols = await sql`SELECT column_name, column_default, is_nullable FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = ${t} AND column_name IN ('status','state')`;
    } catch (e) { cells.push({ table: t, skip: `information_schema 读不到：${e.message}` }); continue; }
    if (!cols.length) { cells.push({ table: t, skip: '库里没有 status/state 列' }); continue; }
    for (const c of cols) {
      const col = c.column_name;
      if (col !== 'status' && col !== 'state') { cells.push({ table: t, skip: `列名 ${col} 不在白名单` }); continue; }
      const m = /^'([^']*)'::/.exec(c.column_default || '');
      const dv = m ? m[1] : (c.column_default || null);
      const sets = armSets(b, tsList);
      let values = [], n = 0;
      try {
        const rows = await sql.unsafe(`SELECT ${col} AS v, count(*)::int AS n FROM ${t} GROUP BY 1 ORDER BY 2 DESC LIMIT 500`);
        values = rows.map((r) => ({ v: String(r.v), n: r.n })); n = values.reduce((s, r) => s + r.n, 0);
      } catch (e) { cells.push({ table: t, column: col, skip: `取值读不到：${e.message}` }); continue; }
      cells.push({ table: t, column: col, default: dv, nullable: c.is_nullable, rows: n,
        values: values.map((r) => `${r.v}×${r.n}`).join(' '),
        authority: b.authority, ts: b.ts_type ? b.ts_type.name : null,
        otherAuthors: (b.contract_authors || []).filter((a) => a.file !== b.vocabulary),
        otherAuthorStates: b.other_author_states || [],
        claim: dv === null ? null : claimOf(dv, b, tsIndex),
        got: classifyArms({ default_value: dv, is_nullable: c.is_nullable, row_count: n, values }, sets) });
    }
  }
  const ladder = [];
  for (const r of cells) {
    if (r.skip) { console.log(`  ${r.table.padEnd(32)} 跳过：${r.skip}`); continue; }
    const at = (a) => (r.got.red[a] || []).map((x) => `${x.f}(${x.v}${x.n ? '×' + x.n : ''})`).join('+') || '不红';
    const quiet = ARMS.find((a) => !(r.got.red[a] || []).length) || null;
    if ((r.got.red[ARMS[0]] || []).length) ladder.push({ cell: `${r.table}.${r.column}`, to: quiet || '三档全红' });
    console.log(`  ${r.table.padEnd(32)} ${r.column.padEnd(6)} 默认=${JSON.stringify(r.default)} 空可=${r.nullable} 行=${r.rows} 权威=${r.authority}${r.ts ? `/TS ${r.ts}` : ''}`);
    console.log(`      取值：${r.values || '—'}`);
    console.log(`      默认值认领：${r.claim ? (r.claim.faces.join('、') || '三面与 TS 都不认')
      + (r.claim.weak.length ? `｜别名联合也含(${r.claim.weak.length} 个)：${r.claim.weak.slice(0, 4).join(',')}` : '')
      : '（无默认值）'}`);
    console.log(`      三面判：${at('三面')}｜强四面判：${at('强四面')}｜弱四面判：${at('弱四面')}`
      + `${r.got.neutral.length ? `｜${r.got.neutral.join(',')}` : ''}`);
    // 分片归属点名（V316 第三根轴）：红的存量值若只被**另一份自述方**的词表持有，写明它为什么仍红——
    // 那一份自述的是本列的别的分片（分片条件在契约的注释／authority_type 里），把它并进来就是替这批行消音。
    if (r.otherAuthors.length) {
      const named = (r.got.red[ARMS[0]] || []).map((x) => x.v)
        .filter((v) => r.otherAuthorStates.includes(v));
      if (named.length) console.log(`      分片归属：${named.join(',')} 在另一份自述方的词表里`
        + `（${r.otherAuthors.map((a) => `${a.file}#${a.block}`
          + `${a.shard_type ? `[${a.shard_type}]` : ''}${a.shard_note ? `（${a.shard_note}）` : ''}`).join('、')}），`
        + `但本列这批行读不到落在那些分片的证据 ⇒ 判语仍红，不折成"已认领"`);
    }
  }
  const tally = (a) => {
    const c = {};
    for (const r of cells.filter((x) => x.got)) for (const f of (r.got.red[a] || [])) c[f.f] = (c[f.f] || 0) + 1;
    return c;
  };
  console.log(`\n[合计] 判得动的 ${cells.filter((x) => x.got).length} 格：`
    + ARMS.map((a) => `${a} ${JSON.stringify(tally(a))}`).join('｜'));
  console.log(`[合计] 中性判语：F3 ${cells.filter((x) => x.got && x.got.neutral.includes('F3')).length} 格｜`
    + `OK-strict ${cells.filter((x) => x.got && x.got.neutral.includes('OK-strict')).length} 格`);
  console.log(`[消音梯] 三面红的 ${ladder.length} 格，各自到哪一档才不红：`);
  for (const l of ladder) {
    console.log(`  ↻ ${l.cell}：三面红 → ${l.to === '三档全红' ? '三档都红（加面消不了音）' : `到「${l.to}」不红`}`);
  }
  // ── 分片读数（V316，可选档）：整列取值说不出"这批行属哪个分片"，按 event_type 切一刀。
  //    只对「自述方 ≥2 或自述方带 authority_type」的列做；分片键逐字取契约里的 event_type 串，不解析成 SQL。
  if (process.argv.includes('--by-shard')) {
    console.log('\n[分片] 多处自述的列按 event_type 切读数（⚠＝不在任何已声明分片 ∧ 三面不认）：');
    let groups = 0, flagged = 0;
    for (const r of cells.filter((x) => !x.skip)) {
      const b = bindings.find((x) => x.physical === r.table);
      const authors = (b && b.contract_authors) || [];
      if (!(authors.length >= 2 || authors.some((a) => a.shard_type))) continue;
      const hasEt = await sql`SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = ${r.table} AND column_name = 'event_type'`;
      if (!hasEt.length) { console.log(`  ${r.table}.${r.column}：自述方 ${authors.length} 处，但库里没有 event_type 列 ⇒ 分片不可判`); continue; }
      const sets = armSets(b, tsList);
      let grp;
      try {
        grp = await sql.unsafe(`SELECT event_type AS et, ${r.column} AS v, count(*)::int AS n FROM ${r.table} GROUP BY 1,2 ORDER BY 1,3 DESC`);
      } catch (e) { console.log(`  ${r.table}.${r.column}：分片读数取不到：${e.message}`); continue; }
      console.log(`  ${r.table}.${r.column}（自述方：${authors.map((a) => `${a.file}#${a.block}`).join('、')}）`);
      for (const g of grp) {
        const v = shardVerdict(g.et, g.v, authors, sets, r.otherAuthorStates);
        groups += 1;
        if (v.flag) flagged += 1;
        console.log(`    ${String(g.et).padEnd(24)} ${String(g.v).padEnd(14)} ×${String(g.n).padStart(3)}`
          + `｜分片：${v.inShard ? '落在已声明分片' : '不在任何已声明分片'}｜认领：${v.face}${v.flag ? '  ⚠' : ''}`);
      }
    }
    console.log(`[分片合计] 读了 ${groups} 个 (event_type×取值) 组，其中「不在任何已声明分片 ∧ 三面不认」${flagged} 组`
      + `——这一档只把整列 F2 的成因分到群体上，不替换任何一档判语。`);
  }
  console.log('[限度] 读数来自链基线库（seed＋重放消费过派生数据），不是生产库；'
    + '强四面只认命名规则命中的那张联合；弱四面额外并入"容得下该表全部可写值"的联合'
    + '（含 export interface 的字段级内联联合），它只证明 shared/ 存在这样的清单，不证明那个清单管的就是本列；'
    + '第三根轴（契约自述的 authority_table）只点名不并档 ⇒ 别的自述方认得某值，不把该值从 F1／F2 里撤掉，'
    + '因为一份契约自述的是本列的**某个分片**（分片条件写在契约注释或 authority_type 里），'
    + '而这里读的是整列取值，没有按分片切行的证据。');
  await sql.end();
} catch (e) {
  console.error(`[probe] 连不上或查询失败：${e.message}`);
  process.exitCode = /ECONNREFUSED|no such file|does not exist|Connection terminated/i.test(e.message) ? 3 : 1;
}
