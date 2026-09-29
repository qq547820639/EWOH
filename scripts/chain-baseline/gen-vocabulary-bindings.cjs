#!/usr/bin/env node
/**
 * 状态词表绑定生成器（V313）。
 *
 * 为什么要它：WDRV-01 与 TBLST-01 两行登记的是同一件事——"哪张表用哪份词表、那份词表是哪一级"
 * 从来没有机读来源，只能散在几把尺子的硬编码里（主线9 的 WRITER_DRIFT_TARGETS、复算入口的 FACTS），
 * 于是命令表被挂上请求级词表（V312 已让 `sent` 报红为证）。
 * 本文件把"绑定"从手抄变成**由事实推导＋可复算**：对每张真有状态列、且被链上代码写入状态的表，
 * 拿各契约 yaml 的 `states` 去比它的可写态集合，按覆盖率给出 bound／partial／unbound 三态与差集。
 *
 * 规则是机械的、可审的（不靠人记）：
 *   覆盖率 = |可写态 ∩ 词表| / |可写态|；覆盖 100% ⇒ bound；≥50% ⇒ partial；否则 unbound。
 *   并列最高分的契约胜；分数为 0 的契约不参与。
 *
 * 用法：node scripts/chain-baseline/gen-vocabulary-bindings.cjs [--write|--check]
 *   --check：与已存文件逐字比对，不一致退 2（常驻用例走这条路 ⇒ 手改或事实变了都会被发现）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(__dirname, 'status-vocabulary-bindings.json');
const { collect } = require('./status-target-states.cjs');
// FACTS 由复算入口导出（status-target-states 自己不导出它）；两把尺共用同一份清单来源，避免各存一份
const { statusTablesInSchema, FACTS } = require('./promotion-readings.cjs');

const SM = path.join(ROOT, 'contracts/state-machines');
const SCHEMA = path.join(ROOT, 'ewoh-spark-app/server/database/schema.ts');
const MIG_DIR = path.join(ROOT, 'db/migrations');
/** 物理表名 ↔ drizzle 导出符号（`export const ewohControlRequest = pgTable("ewoh_control_request", …)`）。
 *  绑定文件按 drizzle 符号键（与守卫尺／扇出尺同源），而 DB 约束按物理表名写，两轴必须靠这张表连起来。 */
function schemaPhysicalMap() {
  const src = fs.readFileSync(SCHEMA, 'utf8');
  const out = new Map();
  const re = /export const (ewoh\w+) = pgTable\("([^"]+)"/g;
  let m;
  while ((m = re.exec(src)) !== null) out.set(m[2], m[1]);
  return out;
}
/** 平衡括号取一段：从 openIdx 处的 `(` 起，返回其配对 `)` 的下标。 */
function matchParen(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}
/** 该位置所属的表：逆向取最近一条 `CREATE TABLE`／`ALTER TABLE`（含 `IF EXISTS` 写法）的目标名，去掉 schema 前缀与占位符。
 *  调用方必须再拿真实物理表名集合过滤——不匹配的一律算"解析不到"，不许张冠李戴
 *  （实测 `ALTER TABLE IF EXISTS` 旧写法会读成表名 "IF"、注释里的 `CREATE TABLE IF NOT EXISTS` 读成 "/"、
 *   DO 块里的 `ALTER TABLE %I.%I` 读成 "%I"）。 */
function tableBefore(text, idx) {
  const head = text.slice(0, idx);
  const re = /\b(?:CREATE TABLE(?: IF NOT EXISTS)?|ALTER TABLE(?: IF EXISTS)?)\s+([^\s(]+)/gi;
  let m, last = null;
  while ((m = re.exec(head)) !== null) last = m[1];
  if (!last) return null;
  const name = last.replace(/[;,]?$/, '');
  const parts = name.split('.');
  const tail = parts[parts.length - 1].replace(/["`]/g, '');
  return /^(public|__EWOH_SCHEMA__|information_schema)$/i.test(tail) ? null : tail;
}
/** 词表形状分四态。**只有 plain 才是"该列的取值清单"**：
 *  · plain        ＝整条 CHECK 就是 `col IN ('a','b')`，外面不挂别的谓词；
 *  · implication  ＝`status IN ('ended','aborted') OR actual_end_at IS NULL` 这类配对/蕴含约束
 *                   （`standalone_046_exo_session.sql:47-48`、`standalone_088_improvement_action.sql:94-95` 实测都有，
 *                    与真词表只差尾巴；旧写法把后定义的那条当词表 ⇒ 真值 `active` 被读成"库不许"）；
 *  · compound-or-negated ＝状态列以 `NOT IN` 出现，或与别的列合取分型
 *                   （`standalone_046_exo_session.sql:49` 的 `status NOT IN (…) OR …`、
 *                    `standalone_051_exo_config.sql:52-56` 的 kind×status）——压成单列清单就是发明一个不存在的词表；
 *  · other        ＝与状态列无关的 CHECK（不进清单，免噪声）。
 */
function classifyCheck(body) {
  const m = body.match(/^\s*\(?\s*([A-Za-z_][A-Za-z0-9_]*)\s+IN\s*\(/i);
  const refsState = /\b(?:status|state)\b/i.test(body);
  if (!m) {
    if (!refsState) return { shape: 'other', column: null, values: [] };
    const shape = /\bIN\s*\(/i.test(body) ? 'compound-or-negated'
      : (/\b(?:OR|AND)\b|<>|!=|\bIS\b/i.test(body) ? 'implication' : 'other');
    return { shape, column: null, values: [] };
  }
  // 本尺只判状态列的词表：`receipt_source IN ('real','simulated')` 那种**别的列**的枚举
  // 既不算词表也不进"读不到的形状"清单——否则 db_surface 会虚报"有状态约束我读不到"（V313 复核顶出）。
  if (!['status', 'state'].includes(m[1].toLowerCase())) {
    return { shape: 'other', column: m[1], values: [] };
  }
  const open = m.index + m[0].length - 1;
  const close = matchParen(body, open);
  if (close < 0) return { shape: 'other', column: m[1], values: [] };
  const values = [...new Set([...body.slice(open + 1, close).matchAll(/'([^']+)'/g)].map((x) => x[1]))].sort();
  if (!values.length) return { shape: 'other', column: m[1], values: [] };
  const rest = (body.slice(0, m.index) + ' ' + body.slice(close + 1)).replace(/[()\s]/g, '');
  return { shape: rest ? 'implication' : 'plain', column: m[1], values };
}
/** 纯函数：迁移文本 → 每张真实表的 DB 侧词表约束。
 *  只认具名 `CONSTRAINT … CHECK (…)`；`*.rollback.sql` 不参与；跨迁移取最后一个定义；
 *  定义之后出现 `DROP CONSTRAINT` 视为已解除；表名必须落在 knownTables（默认＝schema.ts 的 pgTable 物理名）。
 *  非 plain 形状只点名不折算：`unparsed` 让"有约束但形状读不到"与"这张表没有约束"是两格，不互相折算。
 *  动态 EXECUTE format(…) 造约束的形态本机未检索到（只检索到动态 RLS POLICY），故本面是静态迁移的下界。 */
function dbVocabularyConstraints(files, knownTables) {
  const known = knownTables || new Set(schemaPhysicalMap().keys());
  const state = new Map();
  const unparsed = new Map();
  const unresolved = [];
  for (const [rel, text] of files) {
    if (!text || rel.endsWith('.rollback.sql')) continue;
    const events = [];
    const defRe = /CONSTRAINT\s+([A-Za-z_][A-Za-z0-9_]*)\s+CHECK\s*\(/g;
    let m;
    while ((m = defRe.exec(text)) !== null) {
      const open = m.index + m[0].length - 1;
      const close = matchParen(text, open);
      if (close < 0) continue;
      const body = text.slice(open + 1, close);
      const cls = classifyCheck(body);
      // 'other' 已含"与状态列无关"这一层（classifyCheck 里判），所以这里只需一道闸
      if (cls.shape === 'other') continue;
      const table = tableBefore(text, m.index);
      if (!table || !known.has(table)) { unresolved.push({ source: rel, constraint: m[1], table: table || null }); continue; }
      events.push({ at: m.index, drop: false, name: m[1], table, cls });
    }
    const dropRe = /DROP CONSTRAINT(?: IF EXISTS)?\s+([A-Za-z_][A-Za-z0-9_]*)/g;
    while ((m = dropRe.exec(text)) !== null) {
      if (m[1].toUpperCase() !== 'IF') events.push({ at: m.index, drop: true, name: m[1] });
    }
    events.sort((a, b) => a.at - b.at);
    for (const e of events) {
      if (e.drop) {
        const cur = state.get(e.name);
        if (cur) cur.dead = true;
        continue;
      }
      if (e.cls.shape !== 'plain') {
        if (!unparsed.has(e.table)) unparsed.set(e.table, []);
        unparsed.get(e.table).push({ constraint: e.name, shape: e.cls.shape, source: rel });
        continue;
      }
      const prev = state.get(e.name);
      if (prev && prev.table === e.table && prev.source === rel
        && JSON.stringify(prev.values) !== JSON.stringify(e.cls.values)) {
        if (!unparsed.has(e.table)) unparsed.set(e.table, []);
        unparsed.get(e.table).push({ constraint: e.name, shape: 'conflicting-defs', source: rel });
      }
      state.set(e.name, { table: e.table, column: e.cls.column, values: e.cls.values, source: rel, dead: false });
    }
  }
  const byTable = new Map();
  for (const [name, c] of state) {
    if (c.dead) continue;
    // 一张表可能有多条词表 CHECK（status 与别的枚举列）：只收状态列，别的单列计数不折进来
    if (!['status', 'state'].includes(c.column)) continue;
    const prev = byTable.get(c.table);
    if (!prev || c.source >= prev.source) byTable.set(c.table, { constraint: name, column: c.column, values: c.values, source: c.source });
  }
  for (const [t, list] of unparsed) {
    const row = byTable.get(t);
    if (row) row.unparsed = list;
    else byTable.set(t, { constraint: null, column: null, values: null, source: null, unparsed: list });
  }
  byTable.unresolved = unresolved;
  return byTable;
}
function migrationTexts() {
  if (!fs.existsSync(MIG_DIR)) return [];
  return fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort()
    .map((f) => [`db/migrations/${f}`, fs.readFileSync(path.join(MIG_DIR, f), 'utf8')]);
}
/** ── 第四面：TS 类型面（生产侧规范面，与主线9 的 TS_ENFORCED 同源思路）
 *  只扫 `ewoh-spark-app/shared/`：那是前后端共用的规范层；client/ 下的同名 union 是 UI 侧镜像，
 *  算进去会把"界面筛选项"当词表权威（本轮实测 `client/src/api/learning.ts` 就有 ImprovementActionStatus）。
 *  认三种写法：单行 union、多行前缀 `|` union、`as const` 数组。 */
const TS_DIR = path.join(ROOT, 'ewoh-spark-app/shared');
function tsFiles(dir, out) {
  out = out || [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) tsFiles(p, out);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') && !/\.spec\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}
const quoted = (s) => [...s.matchAll(/'([^']+)'/g)].map((m) => m[1]);
const stripComments = (s) => s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
/** 只认"整条联合体都是字符串字面量"的写法，三条各挡一种假词表：
 *  · 逐项 `('…'| 可省竖线)` 匹配，`\s*` 连换行一起吃 ⇒ 多行前缀 `|` 的写法读得到；
 *  · 字面量后面若还挂着 `| 具名类型`，值集合就读不全 ⇒ **整条丢弃**，
 *    绝不把读到的一半当这一列的取值清单（读不全比读不到更容易骗人）；
 *  · RHS 一律不用 `[^;]+` 那种贪婪写法：漏写分号的多行 union 会把下一条语句的字面量吞进来，
 *    别人的值就此被算成这张表的词表。 */
const UNION_RE = /export\s+type\s+(\w+)\s*=\s*((?:\s*\|?\s*'[^']+')+)(\s*\|\s*[A-Za-z_$][\w$]*)?/g;
/** 纯函数：一份 TS 源文本 → 该文件里的字符串字面量联合类型与 as const 数组。 */
function tsTypesFromSource(rel, src) {
  const out = [];
  const text = stripComments(src);
  for (const m of text.matchAll(UNION_RE)) {
    if (m[3]) continue;                       // 混入具名类型 ⇒ 不是纯字面量词表
    const values = [...new Set(quoted(m[2]))].sort();
    if (values.length > 1) out.push({ file: rel, name: m[1], values });
  }
  for (const m of text.matchAll(/export\s+const\s+(\w+)\s*=\s*\[([^\]]*)\]\s+as\s+const/g)) {
    const rest = m[2].replace(/'[^']*'/g, '').replace(/[,\s]/g, '');
    if (rest !== '') continue;                // 数组里混了非字面量元素 ⇒ 同上，丢弃
    const values = [...new Set(quoted(m[2]))].sort();
    if (values.length > 1) out.push({ file: rel, name: m[1], values });
  }
  return out;
}
/** 接口体里的字段级内联联合（`export interface OutboxEvent { status: 'pending' | 'published' }`）。
 *  这一族**只喂取值面**：`name` 带点号（`OutboxEvent.status`），命名规则永远命不中，
 *  所以它进不了强认领——本轮实测正因只读具名别名，`ewoh_outbox`／`ewoh_policy_activation`
 *  两张表的 DDL 默认值被读成"shared/ 里无人认领"，而 `api.interface.ts:1385`、`scheduler.ts:2374` 就写着。 */
function inlineFieldTypes(rel, src) {
  const out = [];
  const lines = src.split('\n');
  let iface = null;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = raw.replace(/\/\/[^\n]*/, '');
    if (iface === null) {
      const m = /^\s*export\s+interface\s+(\w+)[^{]*\{/.exec(line);
      if (m) iface = m[1];
      continue;
    }
    // 顶层 interface 只会由第 0 列的 `}` 收尾；按嵌套深度数括号会被体内跨行的注释／内联对象类型带偏
    // （实测把 PolicyActivationRecord.status 记到上一个 interface 名下，正是这么错的）
    if (/^\}/.test(raw)) { iface = null; continue; }
    const f = /^\s*(?:readonly\s+)?(status|state)\s*:\s*((?:\s*\|?\s*'[^']+')+);?\s*$/.exec(line);
    if (f) {
      const values = [...new Set(quoted(f[2]))].sort();
      if (values.length > 1) out.push({ file: rel, name: `${iface}.${f[1]}`, values, inline: true });
    }
  }
  return out;
}
function tsTypes() {
  const out = [];
  for (const f of tsFiles(TS_DIR)) {
    const rel = path.relative(ROOT, f);
    const src = fs.readFileSync(f, 'utf8');
    out.push(...tsTypesFromSource(rel, src), ...inlineFieldTypes(rel, src));
  }
  return out;
}
/** 物理表名 → 期望的类型名（`ewoh_scheduling_policy` → `SchedulingPolicyStatus`）。
 *  这是**命名约定**，不是证据：所以调用方另出一根"取值面是否覆盖"的独立判（corroborated），
 *  两根轴分开写，不并成一句"已绑定"。 */
function expectedTypeNames(physical) {
  const base = physical.replace(/^ewoh_/, '');
  const camel = base.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join('');
  return [camel + 'Status', camel + 'State'];
}
function tsTypeFor(physical, types) {
  const want = expectedTypeNames(physical);
  return types.find((t) => want.includes(t.name)) || null;
}
/** 命名规则之外的一根**取值面**判据：shared/ 里是否存在某个字面量联合，
 *  它允许的值集合**包含**本表链上可写集合（superset）／与它**完全相等**（exact）。
 *  只为回答"这套词到底只活在链自己的字面量里吗"——命名没命中但值集合得上，
 *  就说明 V313 那句"只活在代码里"说过头了；反过来命中命名规则也不代表值面覆盖（见 ts_type_corroborated）。 */
function tsValueMatches(ws, types) {
  const superset = [];
  const exact = [];
  for (const t of types) {
    const tv = new Set(t.values);
    if ([...ws].every((s) => tv.has(s))) {
      superset.push(`${t.file}#${t.name}`);
      if (tv.size === ws.size) exact.push(`${t.file}#${t.name}`);
    }
  }
  return { superset, exact };
}

function vocabularies() {
  const out = [];
  for (const f of fs.readdirSync(SM).filter((x) => x.endsWith('.yaml')).sort()) {
    const m = fs.readFileSync(path.join(SM, f), 'utf8').match(/^states:\n((?:[ \t]*-[ \t]*\S+[ \t]*\n?)+)/m);
    if (!m) continue;
    out.push({ file: `contracts/state-machines/${f}`,
      states: new Set(m[1].split('\n').map((l) => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean)) });
  }
  return out;
}

/** 契约**自述**的权威表：`authority_table:` 出现处（V316 第二根轴）。
 *  与上面那根"覆盖率最高的那份词表"不同轴：那根是量具挑的，这根是契约自己写的。
 *  一张物理表可被多个文件、同一文件的多个块声明（`ewoh_event` 当下是 3 处），
 *  所以返回 表名 → [{file, block, shard_note, shard_type}]，block 取该出现点最近的顶层键，
 *  shard_note 逐字取同一行的行尾注释（契约用注释写分片，结构化字段里没有分片条件 ⇒ 不解析成 SQL），
 *  shard_type 取同块里紧随其后的 `authority_type:`（契约唯一结构化的一点分片键，逐字取不推断）。 */
function contractAuthors(dir = SM) {
  const out = new Map();
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.yaml')).sort()) {
    let block = null;
    let last = null;
    for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      const top = /^([A-Za-z_][\w-]*):(?:\s*(?:#.*)?)$/.exec(l);
      if (top) { block = top[1]; last = null; continue; }
      const ty = /^[ \t]+authority_type:[ \t]*([A-Za-z0-9_]+)/.exec(l);
      if (ty) { if (last) last.shard_type = ty[1]; continue; }
      const m = /^[ \t]+authority_table:[ \t]*([A-Za-z0-9_]+)(?:[ \t]+#[ \t]*(.*?))?[ \t]*$/.exec(l);
      if (!m) continue;
      const arr = out.get(m[1]) || [];
      last = { file: `contracts/state-machines/${f}`, block, shard_note: m[2] || null, shard_type: null };
      arr.push(last);
      out.set(m[1], arr);
    }
  }
  return out;
}
function chainSources() {
  const dirs = ['scheduler', 'control', 'approval', 'task', 'agent', 'ingest', 'work-orchestration', 'gamification'];
  const src = [];
  const walk = (d, keep) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') walk(p, keep); continue; }
      if (!e.name.endsWith('.ts') || e.name.endsWith('.d.ts') || e.name.endsWith('.spec.ts')) continue;
      if (!keep) continue;
      src.push([path.relative(ROOT, p), fs.readFileSync(p, 'utf8')]);
    }
  };
  for (const m of dirs) {
    const abs = path.join(ROOT, 'ewoh-spark-app/server/modules', m);
    if (fs.existsSync(abs)) walk(abs, true);
  }
  return src;
}
/** 纯函数：由事实推导绑定（常驻用例直接喂夹具语料与假词表，证明它真能判出三态）。
 *  第三、四参可选：传入 DB 侧词表约束与"物理表名→drizzle 符号"映射时，每行加权威面与三面差集；
 *  第五参可选：传入 `shared/` 抽出的 TS 字面量联合，每行加第四面（见 tsTypeFor 的命名约定告警）。
 *  不传（常驻用例的旧形状）只出契约推导面，行为与 V313 首版逐字一致。 */
function bindingsFrom(writtenByTable, vocabs, dbByTable, physOfSymbol, tsList, authorsOf) {
  const baseName = (f) => require('path').basename(f);
  const statesByFile = new Map(vocabs.map((v) => [baseName(v.file), v.states]));
  return Object.entries(writtenByTable).map(([table, written]) => {
    const ws = new Set(written);
    const scored = vocabs.map((v) => ({
      file: v.file, states: v.states,
      cov: ws.size ? [...ws].filter((s) => v.states.has(s)).length / ws.size : 0,
    })).filter((x) => x.cov > 0).sort((a, b) => b.cov - a.cov);
    const physical = physOfSymbol ? physOfSymbol[table] || table : table;
    const dbc = dbByTable ? dbByTable.get(physical) : undefined;
    const decorate = (row) => {
      const hasCode = ws.size > 0;
      const hasContract = Boolean(row.vocabulary);
      const hasVocab = Boolean(dbc && dbc.constraint);
      row.db_constraint = hasVocab ? {
        constraint: dbc.constraint, column: dbc.column, values: dbc.values, source: dbc.source,
      } : null;
      row.enforced_by_db = hasVocab;
      // 三态不许折成两态：有状态 CHECK 但形状读不到（蕴含式／分型复合）≠ 这张表没有约束
      const shapeUnreadable = Boolean(dbc && dbc.unparsed && dbc.unparsed.length);
      if (shapeUnreadable) row.db_check_unparsed = dbc.unparsed;
      if (hasVocab) {
        const dv = new Set(dbc.values);
        row.code_outside_db = [...ws].filter((s) => !dv.has(s)).sort();
        row.db_not_written = [...dv].filter((s) => !ws.has(s)).sort();
      }
      // DB 词表 ↔ 契约词表的同异判：等＝该契约的权威被库强制；DB 更窄＝契约多半管的是别的主体
      // （例 ewoh_agent_approval 的 CHECK 4 词 ⊂ approval.yaml 6 态 ⇒ 那份契约是审批实例的，不是代理审批的）；
      // DB 有契约没有的词＝契约欠态（PLANV-01 那一族的机器判法）。
      // 取"本行最终选中的那份词表"而不是外层变量：早退那一支（无候选）还没走到 best/status 的声明，
      // 直接引用会撞 TDZ；按行上的 vocabulary 回查，两支都安全。
      const chosen = row.vocabulary ? scored.find((x) => require('path').basename(x.file) === row.vocabulary) : null;
      const cv = chosen ? chosen.states : null;
      if (hasVocab && cv) {
        const ds = new Set(dbc.values);
        const extraInDb = [...ds].filter((s) => !cv.has(s)).sort();
        const extraInContract = [...cv].filter((s) => !ds.has(s)).sort();
        row.db_vs_contract = extraInDb.length ? 'db-has-extra'
          : (extraInContract.length ? 'db-narrower' : 'db-equals-contract');
        if (extraInDb.length) row.db_extra_over_contract = extraInDb;
        if (extraInContract.length) row.contract_extra_over_db = extraInContract;
      } else if (hasVocab) {
        row.db_vs_contract = 'no-contract-binding';
      } else if (shapeUnreadable) {
        row.db_vs_contract = 'db-shape-unreadable';
      } else {
        row.db_vs_contract = 'no-db-check';
      }
      // ── 第二根归属轴（V316）：契约**自述**的权威表，与上面"覆盖率挑中的那份词表"分轴报。
      // 刻意**不**把其他自述方的态并进三面目已知集合：同一列可由多个分片共用，
      // 而分片条件只写在契约的行尾注释里（`event_type='AndonRaised' 的那些行`），
      // 并集会替"这批行根本不属的那个分片"消音——所以只点名、不认领。
      if (authorsOf) {
        const list = authorsOf.get(physical) || [];
        row.contract_authors = list.map((a) => ({ file: baseName(a.file), block: a.block,
          shard_note: a.shard_note, shard_type: a.shard_type }));
        row.chosen_self_declared = row.vocabulary ? list.some((a) => baseName(a.file) === row.vocabulary) : null;
        const others = new Set();
        for (const a of list) {
          if (baseName(a.file) === row.vocabulary) continue;
          for (const s of statesByFile.get(baseName(a.file)) || []) others.add(s);
        }
        row.other_author_states = [...others].filter((s) => !(cv && cv.has(s))).sort();
        if (row.missingInVocabulary) {
          row.missing_claimed_by_other_author = row.missingInVocabulary.filter((s) => others.has(s));
        }
      }
      const faces = [];
      if (hasVocab) faces.push('db');
      if (hasContract) faces.push('contract');
      if (hasCode) faces.push('code');
      // 第四面：shared/ 里的 TS 字面量联合。命名规则命中只算"声明面"，
      // 取值面（链上可写态是否全在该类型里）另出一根轴，两根不并成一句"已绑定"。
      const ts = tsList ? tsTypeFor(physical, tsList) : null;
      if (tsList) row.ts_type = ts ? { file: ts.file, name: ts.name, values: ts.values } : null;
      if (ts) {
        faces.push('ts');
        const tv = new Set(ts.values);
        row.ts_outside_type = [...ws].filter((s) => !tv.has(s)).sort();
        row.ts_type_not_written = [...tv].filter((s) => !ws.has(s)).sort();
        row.ts_type_corroborated = ws.size ? row.ts_outside_type.length === 0 : null;
      }
      if (tsList && ws.size) {
        const vm = tsValueMatches(ws, tsList);
        row.ts_value_superset_types = vm.superset;
        row.ts_exact_value_match = vm.exact;
      }
      row.authority = faces.length ? faces.join('+') : 'none';
      return row;
    };
    if (!scored.length) {
      return decorate({ table, physical, written: [...ws].sort(), vocabulary: null,
        status: ws.size ? 'unbound' : 'no-writes' });
    }
    const best = scored[0];
    // 并列最高分 ⇒ 谁才是权威词表无从判（纯集合相似度给不出答案），标 ambiguous 而不是随便挑一个
    const tie = scored.filter((x) => Math.abs(x.cov - best.cov) < 1e-9).map((x) => require('path').basename(x.file));
    const status = tie.length > 1 ? 'ambiguous' : (best.cov === 1 ? 'bound' : (best.cov >= 0.5 ? 'partial' : 'unbound'));
    const row = {
      table, physical, written: [...ws].sort(),
      vocabulary: status === 'unbound' ? null : require('path').basename(best.file),
      status,
      coverage: Number(best.cov.toFixed(3)),
    };
    if (tie.length > 1) row.candidates = tie;
    if (status !== 'unbound') {
      row.missingInVocabulary = [...ws].filter((s) => !best.states.has(s)).sort();
      row.declaredNotWritten = [...best.states].filter((s) => !ws.has(s)).sort();
    }
    if (status === 'unbound') row.nearest = { vocabulary: require('path').basename(best.file), coverage: row.coverage };
    return decorate(row);
  }).sort((a, b) => (a.table < b.table ? -1 : 1));
}

/** 纯函数：把逐行事实汇成一处总账（V313 第①项——`sent`／`proposed` 这类欠词只在这里叙述一次）。 */
function summaryOf(rows) {
  const withDb = rows.filter((r) => r.enforced_by_db);
  const outside = rows.filter((r) => r.enforced_by_db && r.code_outside_db && r.code_outside_db.length);
  const deadInDb = rows.filter((r) => r.enforced_by_db && r.db_not_written && r.db_not_written.length);
  const noDb = rows.filter((r) => !r.enforced_by_db && r.written.length);
  const withTs = rows.filter((r) => r.ts_type);
  const outsideTs = rows.filter((r) => r.ts_type && r.ts_outside_type.length);
  const c = {};
  for (const r of rows) c[r.status] = (c[r.status] || 0) + 1;
  return {
    tables: rows.length,
    contract_status_counts: c,
    with_db_check: withDb.length,
    written_but_no_db_check: noDb.map((r) => r.table),
    code_outside_db_check: outside.map((r) => ({ table: r.table, values: r.code_outside_db })),
    db_check_values_not_written_by_chain: deadInDb.map((r) => ({ table: r.table, values: r.db_not_written })),
    authority_counts: rows.reduce((acc, r) => { acc[r.authority] = (acc[r.authority] || 0) + 1; return acc; }, {}),
    db_vs_contract_counts: rows.reduce((acc, r) => { acc[r.db_vs_contract] = (acc[r.db_vs_contract] || 0) + 1; return acc; }, {}),
    // 权威被库强制且与契约同集合＝这条链上"词表↔表"最硬的一格；单独点名，别混进"有 CHECK"里
    db_equals_contract: rows.filter((r) => r.db_vs_contract === 'db-equals-contract').map((r) => r.table),
    db_narrower_than_contract: rows.filter((r) => r.db_vs_contract === 'db-narrower').map((r) => r.table),
    db_shape_unreadable: rows.filter((r) => r.db_vs_contract === 'db-shape-unreadable').map((r) => r.table),
    // ── 第四面（TS 类型）总账：命名规则命中数、取值面覆盖数、只有字面量的表。
    // `authority === 'code'` 才是"只活在代码里"的严格读法：库不许词表、契约不是主体、shared/ 也没有同名类型。
    with_ts_type: withTs.length,
    ts_written_outside_type: outsideTs.map((r) => ({ table: r.table, values: r.ts_outside_type })),
    ts_type_values_not_written: rows.filter((r) => r.ts_type && r.ts_type_not_written.length)
      .map((r) => ({ table: r.table, values: r.ts_type_not_written })),
    ts_type_corroborated: rows.filter((r) => r.ts_type_corroborated === true).map((r) => r.table),
    code_only_no_ts: rows.filter((r) => r.authority === 'code').map((r) => r.table),
    // 取值面的严格读法：链上可写集合被 shared/ 某个联合**整个容下**的表 ⇔ 反过来说，
    // `shared_written_nowhere` 才是"这套词只活在链自己的字面量里"的可辩护分母。
    ts_value_superset: rows.filter((r) => (r.ts_value_superset_types || []).length).map((r) => r.table),
    shared_written_nowhere: rows.filter((r) => r.written.length && !(r.ts_value_superset_types || []).length)
      .map((r) => r.table),
    code_only_no_ts_no_shared_match: rows.filter((r) => r.authority === 'code'
      && r.written.length && !(r.ts_value_superset_types || []).length).map((r) => r.table),
    // ── 自述归属轴总账（V316）：覆盖率挑中的那份词表，契约自己有没有把这张表写成它的权威表。
    // 两根轴的和不必等于 tables：没有词表可挑的行既不算"自述"也不算"未自述"，一律不折算。
    chosen_self_declared: rows.filter((r) => r.chosen_self_declared === true).map((r) => r.table),
    chosen_not_self_declared: rows.filter((r) => r.chosen_self_declared === false).map((r) => r.table),
    multi_author_tables: rows.filter((r) => (r.contract_authors || []).length > 1)
      .map((r) => ({ table: r.table, authors: r.contract_authors.map((a) => `${a.file}#${a.block}`) })),
    false_gap_named_by_other_author: rows.filter((r) => (r.missing_claimed_by_other_author || []).length)
      .map((r) => ({ table: r.table, values: r.missing_claimed_by_other_author })),
  };
}

function writtenByTable(sources, tables) {
  const r = collect(sources, new Set(tables));
  const out = {};
  for (const t of tables) {
    const b = r.byTable.get(t);
    out[t] = b ? [...new Set([...b.direct, ...b.via.keys()])] : [];
  }
  return out;
}
module.exports = { bindingsFrom, summaryOf, dbVocabularyConstraints, schemaPhysicalMap, vocabularies, chainSources, writtenByTable, statusTablesInSchema, migrationTexts, tsTypesFromSource, inlineFieldTypes, tsTypes, tsTypeFor, expectedTypeNames, tsValueMatches, contractAuthors };

if (require.main === module) {
  const statusTables = statusTablesInSchema();
  const srcs = chainSources();
  const allWritten = writtenByTable(srcs, statusTables);
  const chainWritten = statusTables.filter((t) => (allWritten[t] || []).length > 0);
  const factsOnly = FACTS.map(([t]) => t).filter((t) => statusTables.includes(t));
  const tables = [...new Set([...chainWritten, ...factsOnly])].sort();
  const wb = writtenByTable(srcs, tables);
  const dbMap = dbVocabularyConstraints(migrationTexts());
  const ts = tsTypes();
  const rows = bindingsFrom(wb, vocabularies(), dbMap,
    Object.fromEntries([...schemaPhysicalMap().entries()].map(([phys, sym]) => [sym, phys])), ts,
    contractAuthors());
  const summary = summaryOf(rows);
  const dbSurface = {
    tables_with_plain_status_check: [...dbMap.values()].filter((v) => v.constraint).length,
    tables_with_unreadable_shape_only: [...dbMap.values()].filter((v) => !v.constraint && v.unparsed).length,
    defs_with_unresolved_table: dbMap.unresolved.length,
    unresolved_examples: dbMap.unresolved.slice(0, 5).map((u) => `${u.constraint}@${u.source}→${u.table || '空'}`),
  };
  const tsSurface = {
    shared_ts_files_scanned: tsFiles(TS_DIR).length,
    shared_literal_unions_found: ts.length,
    shared_literal_unions_status_named: ts.filter((t) => /(?:Status|State)$/.test(t.name)).length,
    shared_inline_field_unions: ts.filter((t) => t.inline).length,
  };
  const doc = {
    generated_by: 'scripts/chain-baseline/gen-vocabulary-bindings.cjs（不要手改：改规则就改生成器）',
    rule: '覆盖率=|可写态∩词表|/|可写态|；1 ⇒ bound，≥0.5 ⇒ partial，其余 unbound；0 覆盖不参与。'
      + 'DB 面另判：只认 CHECK (<col> IN (…))，跨迁移取最后一个定义，DROP 在后则视为已解除，rollback.sql 不参与。'
      + 'TS 面再另判：命名规则（物理表名去 ewoh_ 前缀→大驼峰+Status/State）命中记 ts_type；'
      + '取值集合另出一根轴（ts_value_superset_types／ts_exact_value_match），两根不并成一句"已绑定"。'
      + '归属再出第三根轴（V316）：contract_authors 逐字取契约自己的 authority_table: 出现处（文件名#顶层块名＋行尾分片注释），'
      + 'chosen_self_declared 只答"覆盖率挑中那份词表有没有把本表写成权威表"，不改动 vocabulary/差集',
    scope: '链上模块目录（scheduler/control/approval/task/agent/ingest/work-orchestration/gamification）'
      + ' ∩ schema 里有 status/state 列的表；另并入试点权威表清单里同样有状态列的那些；'
      + 'TS 面只扫 ewoh-spark-app/shared/（前后端共用规范层），client/ 下的同名 union 是界面镜像，不计入权威',
    limits: 'DB 面是静态迁移的下界（本机未检索到动态 EXECUTE 造 CHECK 的形态，只检索到动态 RLS POLICY）；'
      + '可写集合只算链上模块目录，别处写入不计；非 status/state 命名的枚举列不计；'
      + '蕴含式与分型复合 CHECK 只点名不折算成词表（db_check_unparsed／db-shape-unreadable）；'
      + 'TS 面只认纯字面量联合与 as const 数组（混入具名类型的联合体丢弃），'
      + '且 ts_value_superset 只证明"shared/ 存在容得下这些值的联合"，不证明那个联合管的就是本列；'
      + 'contract_authors 只点名不认领：一张表被多份契约自述时，各份管的是该列的**不同分片**'
      + '（分片条件只在契约的行尾注释里，没有结构化字段），把几份的态并起来会替"这批行不属的那个分片"消音，'
      + '所以其他自述方的态只进 other_author_states／missing_claimed_by_other_author 两个诊断字段，'
      + '三面目已知集合与写点集合都不并入',
    db_surface: dbSurface,
    ts_surface: tsSurface,
    summary,
    bindings: rows,
  };
  const txt = JSON.stringify(doc, null, 1) + '\n';
  const printRows = () => {
    for (const r of rows) {
      console.log(`  ${r.table.padEnd(30)} ${r.status.padEnd(9)} ${(r.vocabulary || '—').padEnd(16)}`
        + `覆盖 ${r.coverage ?? 0}`
        + `｜DB ${r.db_constraint ? `${r.db_constraint.constraint}(${r.db_constraint.values.length} 词)@${r.db_constraint.source.split('/').pop()}` : '无词表 CHECK'}`
        + `${r.candidates ? ' 并列:' + r.candidates.join(',') : ''}`
        + `${r.missingInVocabulary && r.missingInVocabulary.length ? ' 词表缺:' + r.missingInVocabulary.join(',') : ''}`
        + `${r.code_outside_db && r.code_outside_db.length ? ' 代码写出但 DB 不许:' + r.code_outside_db.join(',') : ''}`
        + `${r.db_not_written && r.db_not_written.length ? ' DB 允许但链上无人写:' + r.db_not_written.join(',') : ''}`
        + `｜TS ${r.ts_type ? `${r.ts_type.name}(${r.ts_type.values.length})` : '命名未命中'}`
        + `${r.ts_outside_type && r.ts_outside_type.length ? ' 类型不许:' + r.ts_outside_type.join(',') : ''}`
        + `｜shared 容得下 ${(r.ts_value_superset_types || []).length} 个联合`);
      if (r.contract_authors) {
        console.log(`      自述权威：${r.contract_authors.length ? r.contract_authors.map((a) => `${a.file}#${a.block}${a.shard_type ? `[${a.shard_type}]` : ''}${a.shard_note ? `（${a.shard_note}）` : ''}`).join('、') : '—'}`
          + `｜挑中的那份${r.chosen_self_declared === null ? '（没有词表可判）' : (r.chosen_self_declared ? '自己写了本表' : '没把本表写成权威表')}`
          + `${(r.other_author_states || []).length ? `｜其他自述方独有的态：${r.other_author_states.join(',')}（只点名，不并进三面目）` : ''}`
          + `${(r.missing_claimed_by_other_author || []).length ? `｜其中把"词表缺"接住的：${r.missing_claimed_by_other_author.join(',')} ⇒ 那份欠词是归属挑错，不是真缺口` : ''}`);
      }
    }
    console.log(`[summary] 表 ${summary.tables} 张｜有 DB 词表 CHECK ${summary.with_db_check} 张｜`
      + `链上写了状态但没有 DB 词表 ${summary.written_but_no_db_check.length} 张`
      + `（${summary.written_but_no_db_check.join(', ') || '—'}）`);
    console.log(`[ts-surface] shared/ 扫 ${tsSurface.shared_ts_files_scanned} 个 .ts、`
      + `纯字面量联合 ${tsSurface.shared_literal_unions_found} 个（具名 ${(tsSurface.shared_literal_unions_found - tsSurface.shared_inline_field_unions)}／`
      + `字段级内联 ${tsSurface.shared_inline_field_unions}；名字带 Status/State 的 ${tsSurface.shared_literal_unions_status_named} 个）｜`
      + `命名规则命中 ${summary.with_ts_type} 张、其中取值面全在类型内 ${summary.ts_type_corroborated.length} 张｜`
      + `链上可写集被某个联合整个容下 ${summary.ts_value_superset.length} 张｜`
      + `谁都不容下 ${summary.shared_written_nowhere.length} 张`);
    console.log(`  authority：${Object.entries(summary.authority_counts).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    console.log(`[自述轴] 契约自述与覆盖率挑中一致 ${summary.chosen_self_declared.length} 张｜`
      + `挑中了但那份契约没把本表写成权威表 ${summary.chosen_not_self_declared.length} 张`
      + `（${summary.chosen_not_self_declared.join(', ') || '—'}）｜`
      + `一张表被多处自述 ${summary.multi_author_tables.length} 张｜`
      + `因归属挑错造出的"假缺口" ${summary.false_gap_named_by_other_author.length} 处：`
      + `${summary.false_gap_named_by_other_author.map((x) => `${x.table}[${x.values.join(',')}]`).join(' ') || '—'}`);
    for (const x of summary.ts_written_outside_type) {
      console.log(`  ⚠ 链上写出的值不在同名 TS 类型里（改名或类型欠态）：${x.table} → ${x.values.join(', ')}`);
    }
    console.log(`[db-surface] 全仓 plain 词表 CHECK ${dbSurface.tables_with_plain_status_check} 张｜`
      + `只有读不到形状的 ${dbSurface.tables_with_unreadable_shape_only} 张｜`
      + `表名解析不到的定义 ${dbSurface.defs_with_unresolved_table} 条`
      + `${dbSurface.unresolved_examples.length ? '（例：' + dbSurface.unresolved_examples.join('；') + '）' : ''}`);
    for (const x of summary.code_outside_db_check) {
      console.log(`  ⚠ 代码可写出而 DB CHECK 不许（运行时会撞约束）：${x.table} → ${x.values.join(', ')}`);
    }
  };
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (cur !== txt) {
      console.error('绑定文件与重新生成结果不一致 ⇒ 事实变了或文件被手改。差异表：');
      try {
        const a = JSON.parse(cur).bindings, b = doc.bindings;
        const ka = new Map(a.map((x) => [x.table, x])), kb = new Map(b.map((x) => [x.table, x]));
        for (const t of new Set([...ka.keys(), ...kb.keys()])) {
          const x = JSON.stringify(ka.get(t) || null), y = JSON.stringify(kb.get(t) || null);
          if (x !== y) console.log(`  ${t}: 已存=${(ka.get(t) || {}).status || '缺'} 重生成=${(kb.get(t) || {}).status || '缺'}`);
        }
      } catch { console.log('  （旧文件解析失败，按整体不一致处理）'); }
      process.exit(2);
    }
    console.log(`[bindings] 一致：${rows.length} 张表、bound ${rows.filter((r) => r.status === 'bound').length}`
      + `／partial ${rows.filter((r) => r.status === 'partial').length}／unbound ${rows.filter((r) => r.status === 'unbound').length}`
      + `／DB 词表 CHECK ${summary.with_db_check} 张`);
  } else {
    fs.writeFileSync(OUT, txt);
    console.log(`已写出 ${path.relative(ROOT, OUT)}（${rows.length} 张表）`);
    printRows();
  }
}
