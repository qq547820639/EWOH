#!/usr/bin/env node
'use strict';
/**
 * 文档面对账（DOCFACE-01 的机械半，V227 新增）
 * ─────────────────────────────────────────────────────────────────────────
 * 这条量具只回答一个问题：**文档与注释里"抄写"下来的权威词表，今天还和权威源一致吗？**
 * 也就是 V226 改动放大系数顶出的那一面——代码／契约／迁移 verify／常驻用例都在重放覆盖集内
 * （一改 stamp 就作废），而"把同一批名字再抄一遍给人看"的那些落笔没有任何机器核。
 *
 * 六类判据（分母＝声明的类数，判决加总不上即"读数作废"并非零退出）：
 *  1. `pair`   —— 文档/注释声明的封闭词表 ↔ 权威源集合（TS `as const` 数组、DB CHECK、代码字面量）。
 *  2. `claim`  —— 注释里"与某迁移逐项一致"这类**指向性声明**：被指的那个文件是否仍是现行定义。
 *  3. `refs`   —— 文档里的文件引用（含 `path:line`）落不落得到；`git ls-files` 认不认。
 *  4. `token`  —— 三件产物正文里残留的记账模板占位符（V317 新增，三族形状；这一条补记是因为
 *               V317 加它时**没同步本行**，头部一路写"三类"到 V336——本仓"一处数字多个写者"的又一实例。
 *               本行自己现在也带着这个病：写这里时又漏了第 6 类，是 V337 复核时才补的）。
 *  5. `ddl`    —— 文档分类表逐行抄写的**表级 DDL 事实** ↔ `db/migrations` 现行定义（V336 新增）。
 *  6. `facts`  —— 文档表格抄写的**非 DDL 类事实** ↔ 各自的权威（V336 的 DOCDDL-01 那三处同类抄写，
 *               V337 纳进来）：`rls`＝走查表的「隔离方式」列 ↔ `schema-facts.txt` 的「RLS 开关」小节、
 *               `writer`＝ADR 的「拥有者」列 ↔ `status-write-guard-census` 的 prod 站点、
 *               `columns`＝交付指令手抄列清单 ↔ `schema.ts` 该表 pgTable 块的列集合。
 *
 * 判决态（关键：不把"看不见"折算成任何一侧的结论）：
 *  `match` / `drift`（点名差集）/ `indeterminate`（任一侧解析不到 ⇒ 既不算一致也不算漂移）/ `n/a`
 *  / `amended`（V336 随第五类加：与权威不符，但同一份文档里有一条**指向该事实权威**的现行口径注记
 *   ⇒ 记载档允许保留当时的表述，条件是现行真相写在同一处；V337 起分两根锚——`ddl` 仍要求注记首行写出
 *   该权威**迁移号**（`AMEND_RE`），`facts` 各条只要求注记点到**自己那类权威的名字**（`amendRe`），
 *   因为 writer／columns 两类的权威是普查档与 schema.ts，硬要迁移号只会逼人编一个。两档各有反证控制）。
 *
 * 限度（不许读成"已穷尽"）：
 *  - 只覆盖**词表级／表格式抄写**的对账。散文里对同一事实的复述读不到（V336 实测：ADR-004 要点 2 那句
 *    "物理表无 org_id 列"就在判据的表格面之外）。
 *  - `facts/rls` 的权威是一份**采样档**（只采链相关 18 张表），未采到的行一律单列不可判 ⇒ 真语料当期
 *    这一类整体读作 indeterminate，不是"全对"。`facts/writer` 的普查只扫 drizzle 写点（raw SQL 不在面内）⇒ 下界。
 *  - 新鲜度守卫要求事实档不早于它所反映的静态源；一旦有人改了 `db/migrations` 或 `schema.ts` 而没重跑
 *    探针，这一族整体转不可判（宁可不判，也不拿旧档替今天说话）。
 *  - TS 编译器已经钉住的成对关系（如 `Record<Reason, string>` 的穷尽性）不在此列——那面有闸。
 *  - 登记册↔状态件的**编号双向比对**早已由 `artifact-consistency` 承担（V227 实测确认），
 *    本件不重复实现；DOCFACE-01 原修法把那一半也算成"没人核"是记账错误，已在登记册更正。
 *  - 权威源用正则解析而非 AST：形态一变（换引号、换写法）即 `indeterminate`，不会假绿。
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const SELF = 'scripts/chain-baseline/doc-face-reconciliation.cjs';

// ---------------------------------------------------------------- 读盘上下文（自测用内存夹具替换）
function makeCtx(overrides) {
  const ov = overrides || new Map();
  return {
    read(rel) {
      if (ov.has(rel)) return ov.get(rel);
      const abs = path.join(root, rel);
      try { return fs.readFileSync(abs, 'utf8'); } catch { return null; }
    },
    migrationFiles() {
      const real = fs.readdirSync(path.join(root, 'db/migrations'))
        .filter((f) => f.endsWith('.sql') && !f.endsWith('.rollback.sql'))
        .map((f) => 'db/migrations/' + f);
      const fromOv = [...ov.keys()].filter((k) => k.startsWith('db/migrations/') && k.endsWith('.sql'));
      return [...new Set([...real, ...fromOv])].filter((f) => !f.endsWith('.rollback.sql')).sort();
    },
    exists(rel) {
      if (ov.has(rel)) return true;
      return fs.existsSync(path.join(root, rel));
    },
    /** 内存夹具没有 mtime ⇒ 返回 null，调用方按"判不了新鲜度"处理，绝不折成"新鲜"。 */
    mtime(rel) {
      if (ov.has(rel)) return null;
      try { return fs.statSync(path.join(root, rel)).mtimeMs; } catch { return null; }
    },
  };
}

// ---------------------------------------------------------------- 提取器（解析不到一律返回 null，不返回空集）
const stripLine = (s) => s.replace(/\/\/[^\n]*/g, '');
const lits = (s) => [...new Set([...s.matchAll(/'([^']+)'/g)].map((m) => m[1]))];

/** TS `export const NAME = [...] as const` 的字面量集合；数组体内的 `//` 注释不得进集合。 */
function tsArray(text, name) {
  if (text == null) return null;
  const body = stripLine(text);
  const m = new RegExp('export const ' + name + '\\b(?!\\w)[^=]*=\\s*\\[([\\s\\S]*?)\\]').exec(body);
  if (!m) return null;
  const values = lits(m[1]);
  return values.length ? values : null;
}

/** 某字段被写成的字面量全集（`field: 'x'`），跨给定文件清单。 */
function tsFieldLiterals(ctx, files, field) {
  const out = new Set();
  let anyFile = false;
  for (const rel of files) {
    const text = ctx.read(rel);
    if (text == null) continue;
    anyFile = true;
    for (const m of text.matchAll(new RegExp(field + ':\\s*\'([a-z0-9_]+)\'', 'g'))) out.add(m[1]);
  }
  if (!anyFile) return null;
  return out.size ? [...out].sort() : null;
}

/** 迁移里某个 CHECK 约束的 `col IN (...)` 字面量；同名约束被后续迁移重定义时**取最后一个定义**。 */
function sqlCheck(ctx, constraint) {
  let win = null;
  let definitions = 0;
  for (const rel of ctx.migrationFiles()) {
    const text = ctx.read(rel);
    if (text == null) continue;
    let at = text.indexOf('CONSTRAINT ' + constraint);
    while (at >= 0) {
      definitions += 1;
      const tail = text.slice(at);
      const inAt = tail.search(/[A-Za-z_][A-Za-z0-9_]*\s+IN\s*\(/i);
      if (inAt >= 0) {
        let i = tail.indexOf('(', inAt);
        let depth = 0;
        let end = -1;
        for (; i < tail.length; i += 1) {
          if (tail[i] === '(') depth += 1;
          else if (tail[i] === ')') { depth -= 1; if (depth === 0) { end = i; break; } }
        }
        if (end > 0) {
          const values = lits(stripLine(tail.slice(inAt, end)));
          if (values.length) win = { values, source: rel };
        }
      }
      at = text.indexOf('CONSTRAINT ' + constraint, at + 1);
    }
  }
  if (!win) return null;
  return { ...win, definitions };
}

/** 文档一行里的斜杠封闭词表：anchor 命中行内**第一个"整组都是词表形态"的括号**。
 *  为什么不能取第一个括号：真实语料那一行同时有 `（审批时效 + 指纹 + 租户）` 这类中文括注，
 *  取第一个括号会让判据 indeterminate（V227 第一版就是这么红的）。 */
function docSlashList(text, anchorRe) {
  if (text == null) return null;
  for (const line of text.split('\n')) {
    if (!anchorRe.test(line)) continue;
    for (const m of line.matchAll(/[（(]([^（）]*)[)）]/g)) {
      const tokens = m[1].split('/').map((s) => s.replace(/`/g, '').trim());
      if (tokens.length && tokens.every((t) => /^[a-z][a-z0-9_]*$/.test(t))) return tokens;
    }
    return null;
  }
  return null;
}

/** 文档一行里的集合写法：anchor 命中行内第一个 ∈ {a, b, c}。 */
function docBraceSet(text, anchorRe) {
  if (text == null) return null;
  for (const line of text.split('\n')) {
    if (!anchorRe.test(line)) continue;
    const m = /\{([^}]*)\}/.exec(line);
    if (!m) return null;
    const tokens = m[1].split(',').map((s) => s.replace(/`/g, '').trim());
    if (!tokens.length || !tokens.every((t) => /^[a-z][a-z0-9_]*$/.test(t))) return null;
    return tokens;
  }
  return null;
}

/* ---------------------------------------------------------------- 第五类：表级 DDL 事实的文档副本（V336 新增）
 * 这一类管的正是 `change-amplification` 新分出来的"链外无机器入口"那一档：ADR／分类表这类
 * **写定就不再随 schema 改**的记载，抄的是别人的可机读事实（某表 policy 有没有 NULL 放行分支、
 * org_id 现行是否 NOT NULL），而权威源后来变了。实物起因（本轮逐条读码所得，取证 `tmp/v336-ddl-drift-evidence.log`）：
 *   `standalone_057_rls_null_reject.sql:135` 明写"去除 `OR org_id IS NULL` 放行分支"（:200-215 重建 policy），
 *   并在 :120-129 对 `v_tables` 清单里 15 张调度表动态 `ALTER COLUMN org_id SET NOT NULL`；
 *   而 `docs/decisions/ADR-004-scheduler-tenancy.md` 的分类表仍写「隔离；NULL=全局」（8 行），
 *   要点 1 仍写「`org_id IS NULL` = 全局/存量行对任意 org 可见（policy 的 OR 分支）」——
 *   该文件仍被 `feature-status.yaml:189` 与 `docs/agent/project-state.yaml:1792` 当现行工件引用。
 * 判什么（逐行判，分母＝文档那张表自己声明的行数，行数解析不到即整类不可判）：
 *   claim(放行)：org_id 语义格写了 `NULL=全局` ⇒ 断言"现行 policy 里还有 NULL 放行分支"；
 *   claim(非空)：写了 `org_id NOT NULL` ⇒ 断言"该列现行是 NOT NULL"；两者都没写 ⇒ `n-a`（不判、也不从分母里丢）。
 * 权威侧一律按**迁移号最大的那份定义**取（与 `sqlCheck` 同一条"最后定义 wins"）。两处形状必须认得：
 *   ① policy 体只截到下一条顶层语句为止（不截会让**邻表**的 `org_id IS NULL` 串进本表判语）；
 *   ② `SET NOT NULL` 在 057 是 DO 块里的动态 EXECUTE ⇒ 必须把同块内 `v_tables := ARRAY[ 'a', 'b' … ]`
 *     那份清单摊开。只认字面 ALTER 行就会把 057 读成"没有收紧"，把这条已漂移的声明判成一致——那是假绿。
 * 五态：`match`／`drift`／`amended`（与权威不符，但同一份文档里有一条指向**该事实的权威迁移号**的
 *   现行口径注记 ⇒ 记载档允许保留旧表述，前提是把现行真相写在一起）／`indeterminate`（权威侧解析不到，
 *   绝不折成前三者）／`n-a`。加总必须等于分母，否则读数作废。 */
const AMEND_RE = /^>\s*现行口径.*standalone_(\d{3})/m;
/* V337：第五类扩到 `facts` 之后发现 AMEND_RE 是**为 DDL 量身**的——那条权威就是一支迁移，所以"注记里必须
   出现迁移号"既是形状也是指向。`writer`／`columns` 两类的权威分别是普查 JSON 与 `schema.ts`，硬要注记里
   塞一个 `standalone_\d{3}` 只会把我推向**编一个迁移号**。故分两根锚：DDL 仍用 AMEND_RE；带 `amendRe`
   的 facts 条目用本行锚定位注记，"点到点不到权威"完全交给各条自己的 `amendRe`（三支都写了，无一为空），
   强度不减：泛泛一句「现行口径已更正」在两把尺下都判 drift（判据自测里有这一对控制）。 */
const AMEND_HEAD_RE = /^>\s*现行口径/m;
const escRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 取 `CREATE POLICY … ON [schema.]<table>` 的语句体：起点后到下一条顶层语句之前。 */
function policyBody(text, table) {
  const re = new RegExp(`CREATE POLICY\\s+\\w+\\s+ON\\s+(?:[\\w.]+\\.)?${escRx(table)}\\b`, 'i');
  const m = re.exec(text);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const next = rest.search(/\n(?:CREATE POLICY|ALTER TABLE|COMMENT ON|DROP POLICY|CREATE TABLE|DO \\$\\$|--\s{2,}=)/i);
  return next > 0 ? rest.slice(0, next) : rest.slice(0, 1500);
}
/** 该文件里"动态收紧 org_id"的清单：DO 块内出现 `ALTER COLUMN org_id SET NOT NULL` 时，
 *  把同块里的 `text[] := ARRAY[ … ]` 字面量摊成表名集合（形状不止一个变量名，按 ARRAY 字面量取）。 */
function dynamicNotNullTables(text) {
  const out = new Set();
  const blocks = text.match(/DO \$\$[\s\S]*?\$\$/g) ?? [];
  for (const b of blocks) {
    if (!/ALTER COLUMN org_id SET NOT NULL/.test(b)) continue;
    for (const m of b.matchAll(/text\[\]\s*:=\s*ARRAY\[([\s\S]*?)\]/g)) {
      for (const x of m[1].matchAll(/'([a-z0-9_]+)'/g)) out.add(x[1]);
    }
  }
  return out;
}
/** 从 `openIdx`（左括号处）起按**括号深度**取到配对右括号。
 *  不用非贪婪 `\(([\s\S]*?)\)`——列定义里的 `varchar(255)` 会让它在第一个内层右括号就收，
 *  于是"建表即 NOT NULL"这一族整批读空（本仓数落这张尺的老形状：形状一变就 indeterminate）。 */
function balancedParens(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') { depth -= 1; if (depth === 0) return text.slice(openIdx + 1, i); }
  }
  return null;
}
/** 按**深度为 0 的逗号**切列定义——一列一行与一行多列都得认（真实迁移两种写法都在用：
 *  `standalone_017:106-116` 每列一行，`standalone_006` 里有把几列挤在一行的）。
 *  按行切只认前一种，就会把后一种整批读成"该列没写 NOT NULL"，那是量具自己造的假漂移。 */
function splitColumnDefs(body) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of body) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}
/** 表级 DDL 事实的现行定义。返回 { bypass:{value,source}|null, notnull:{value,source,via}|null,
 *  policyDefs:number }；一条都没解析到 ⇒ 对应字段为 null ⇒ 上层判不可判，不判"没有"。 */
function ddlFacts(ctx, table) {
  const res = { bypass: null, notnull: null, policyDefs: 0 };
  for (const f of ctx.migrationFiles()) {
    const text = ctx.read(f);
    if (text == null || !text.includes(table)) continue;
    const body = policyBody(text, table);
    if (body != null) {
      res.policyDefs += 1;
      res.bypass = { value: /\borg_id\s+IS\s+NULL\b/i.test(body), source: f };
    }
    const direct = new RegExp(`ALTER TABLE\\s+(?:[\\w.]+\\.)?${escRx(table)}\\s+ALTER COLUMN org_id SET NOT NULL`, 'i');
    const dropped = new RegExp(`ALTER TABLE\\s+(?:[\\w.]+\\.)?${escRx(table)}\\s+ALTER COLUMN org_id DROP NOT NULL`, 'i');
    if (dropped.test(text)) res.notnull = { value: false, source: f, via: 'DROP NOT NULL' };
    else if (direct.test(text)) res.notnull = { value: true, source: f, via: '字面 ALTER' };
    else if (dynamicNotNullTables(text).has(table)) res.notnull = { value: true, source: f, via: 'DO 块清单动态 EXECUTE' };
    else {
      // 建表／加列时就带 NOT NULL（replan_trigger 那一族：017 建表即非空）
      const ct = new RegExp(`CREATE TABLE[^\\n]*?(?:[\\w.]+\\.)?${escRx(table)}\\s*\\(`, 'i');
      const m = ct.exec(text);
      const body = m ? balancedParens(text, m.index + m[0].length - 1) : null;
      const seg = body == null ? null : splitColumnDefs(body).find((p) => /^\s*org_id\b/.test(p));
      if (seg != null) res.notnull = { value: /NOT NULL/i.test(seg), source: f, via: '建表列定义' };
      else {
        const ac = new RegExp(`ADD COLUMN\\s+org_id\\b[^;\\n]*NOT NULL`, 'i');
        if (ac.test(text) && text.includes(table)) res.notnull = { value: true, source: f, via: '加列 NOT NULL（同文件按表名匹配，未验列属于该表）' };
      }
    }
  }
  return res;
}
/** 文档那张分类表 ⇒ { rows, dropped }；表头认不到或一行都没认到即返回 null（整类不可判）。
 *  `dropped` 是"这行看着是表行但表名不合形状"的点名清单——**认不出来的行必须露头**，
 *  否则 `ewoh_` 那条过滤器一变宽，分母就会静默缩水、判决照样加总自洽（本仓数分母的老形状）。 */
function docDdlRows(text) {
  if (text == null) return null;
  const lines = text.split('\n');
  const head = lines.findIndex((l) => /^\|\s*表\s*\|\s*分类\s*\|\s*RLS\s*\|\s*org_id 语义\s*\|/.test(l));
  if (head < 0) return null;
  const rows = [];
  const dropped = [];
  for (let i = head + 2; i < lines.length; i += 1) {
    const l = lines[i];
    if (!l.startsWith('|')) break;
    const cells = l.replace(/\\\|/g, '⏐').split('|').map((c) => c.trim());
    if (cells.length < 5) { dropped.push(`${i + 1}（格数 ${cells.length - 2}）`); continue; }
    const table = cells[1].replace(/`/g, '');
    if (!/^ewoh_[a-z0-9_]+$/.test(table)) { dropped.push(`${i + 1}（表名「${table}」）`); continue; }
    rows.push({
      line: i + 1, table, cell: cells[4],
      claimBypass: /NULL\s*=?\s*全局/.test(cells[4]),
      claimNotNull: /org_id\s+NOT\s+NULL/i.test(cells[4]),
      rlsOff: /关闭/.test(cells[3]),
    });
  }
  return rows.length ? { rows, dropped } : null;
}

/* ---------------------------------------------------------------- 第五类的三个扩展条目（V337）
 * V336 只把 ADR-004-scheduler-tenancy 那一张表接进机械核，另三处**同类抄写**留在 `DOCDDL-01` 上。
 * 这一节把它们逐一纳进来，每处都用**它自己那类事实的权威源**，而不是再抄一遍结论：
 *   `rls`     —— `docs/reviews/rls-coverage-audit-2026-08-08.md` 的「隔离方式」列 ↔ `schema-facts.txt`
 *                的「=== RLS 开关 ===」小节（该小节由 `schema-probe.mjs` 从 `pg_class`/`pg_policies` 读，
 *                是既有 B 段事实档，不另立第二份真值）；「org_id 列」只认 ✅／❌ 两种声明，「—」算未声明。
 *   `writer`  —— `adr-004-mes-scheduling-convergence.md` 的「拥有者」列 ↔ `status-write-guard-census` 的
 *                `prod` 站点清单（AST 扫 drizzle 写点，表名由 `schema.ts` 的 `pgTable("物理名")` 反解）；
 *                普查里没有这张表的站点 ⇒ **不可判**，绝不折成"文档说错了"。
 *   `columns` —— `delivery/开发指令-AI调度说明生成-2026-08-21.md` 的「字段」列 ↔ `schema.ts` 该表的 pgTable 块
 *                （列名逐个必须在；**没列全不算漂移**，因为那份是摘要——但"未列 N 列"要打印出来）。
 * 新鲜度守卫（这一族的假绿入口）：事实档比它应当反映的静态源（`db/migrations/*` 与 `schema.ts`）还旧 ⇒
 * 整条判不可判并点名档的 mtime。少了这一条，一份停在三周前的 `schema-facts.txt` 能让今天的 DDL 改动全部隐身。 */
const FACTS_RLS_PATH = process.env.EWOH_AUDIT_FACTS || 'tmp/chain-baseline/schema-facts.txt';
const CENSUS_PATH = 'tmp/chain-baseline/status-write-guard-census.json';
const SCHEMA_TS = 'ewoh-spark-app/server/database/schema.ts';

function factsSection(text, title) {
  if (text == null) return null;
  const lines = text.split('\n');
  const h = lines.findIndex((l) => l.trim() === `=== ${title} ===`);
  if (h < 0) return null;
  const out = [];
  for (let i = h + 1; i < lines.length && !/^=== /.test(lines[i]); i += 1) if (lines[i].trim()) out.push(lines[i].trim());
  return out;
}
/** 事实档里有没有这张表的小节行——小节整体缺 ⇒ {missing:true}；小节在但表不在 ⇒ {unsampled:true}
 *  （两者都判不可判，但**理由必须分开**：一个是档没采这项，一个是档采了 18 张链相关表而这张不在其中。
 *  把它并成一句话就会让"没采"看起来像"这张表没问题"——`a == null` 与 `a === undefined` 在 JS 里同真，
 *  本仓第一版就是这么把 3 行未采样误报成"小节不存在"的）。 */
function factsRls(ctx, table) {
  const sec = factsSection(ctx.read(FACTS_RLS_PATH), 'RLS 开关');
  if (sec == null) return { missing: true };
  const hit = sec.find((l) => l.startsWith(`${table} `));
  if (!hit) {
    const n = (sec.find((l) => l.startsWith('SECTION')) || '').match(/rows=(\d+)/);
    return { unsampled: true, sampled: n ? Number(n[1]) : sec.length };
  }
  const m = hit.match(/rls=(true|false)/);
  return m ? { rls: m[1] === 'true', source: FACTS_RLS_PATH } : { unsampled: true, sampled: 0 };
}
/** schema.ts → { byName: Map<物理名,{var,cols:Set>} }，一次解析多处复用。 */
function schemaTables(ctx) {
  const text = ctx.read(SCHEMA_TS);
  if (text == null) return null;
  const map = new Map();
  const re = /export const (\w+) = pgTable\(\s*"([a-z0-9_]+)"\s*,\s*\{/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const body = balancedBraces(text, m.index + m[0].length - 1);
    if (body == null) continue;
    const cols = new Set([...splitColumnDefs(body).map((p) => (p.match(/\(\s*"([a-z0-9_]+)"/) || [])[1]).filter(Boolean)]);
    map.set(m[2], { var: m[1], cols });
  }
  return map;
}
function balancedBraces(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') { depth -= 1; if (depth === 0) return text.slice(openIdx + 1, i); }
  }
  return null;
}
/** census 的 prod 站点 → Map<物理表名, Set<file>>；档读不到／JSON 坏 ⇒ null（整条不可判）。 */
function censusWriters(ctx) {
  const text = ctx.read(CENSUS_PATH);
  if (text == null) return null;
  let j;
  try { j = JSON.parse(text); } catch { return null; }
  const sites = Array.isArray(j.prod) ? j.prod : null;
  if (!sites) return null;
  const tables = schemaTables(ctx);
  const varToPhys = new Map();
  if (tables) for (const [phys, v] of tables) varToPhys.set(v.var, phys);
  const byTable = new Map();
  for (const s of sites) {
    const key = varToPhys.get(s.table);
    if (!key) continue;   // 变量名反解不到物理名 ⇒ 不猜（猜出来的归属比"没判"更危险）
    if (!byTable.has(key)) byTable.set(key, new Set());
    byTable.get(key).add(s.file);
  }
  return { byTable, count: sites.length, source: CENSUS_PATH };
}
/** 守卫：事实档必须不早于它反映的静态源。返回 null＝没法判（自测注入档没有 mtime）；返回字符串＝过期原因。 */
function factsStaleness(ctx, paths) {
  const mt = paths.map((p) => ctx.mtime(p)).filter((x) => x != null);
  if (!mt.length) return null;
  const src = [];
  for (const f of ctx.migrationFiles()) { const t = ctx.mtime(f); if (t != null) src.push(t); }
  const st = ctx.mtime(SCHEMA_TS); if (st != null) src.push(st);
  if (!src.length) return null;
  const newest = Math.max(...src);
  const oldest = Math.min(...mt);
  return newest > oldest ? `事实档（${paths.join('、')}）采集于 ${new Date(oldest).toISOString().slice(0, 16)}，`
    + `而它要反映的静态源最新到 ${new Date(newest).toISOString().slice(0, 16)}` : null;
}
/** 通用：从一段 markdown 表里取"每个数据行的指定格"，返回 { rows, dropped }。 */
function docTableRows(text, headerRe, cellOf) {
  if (text == null) return null;
  const lines = text.split('\n');
  const head = lines.findIndex((l) => headerRe.test(l));
  if (head < 0) return null;
  const rows = []; const dropped = [];
  for (let i = head + 2; i < lines.length; i += 1) {
    const l = lines[i];
    if (!l.startsWith('|')) break;
    const cells = l.replace(/\\\|/g, '⏐').split('|').map((c) => c.trim());
    const parsed = cellOf(cells, i + 1);
    if (parsed == null) dropped.push(`${i + 1}（${l.replace(/\s+/g, ' ').slice(0, 46)}）`);
    else rows.push(parsed);   // 「这行没做该类声明」也进分母，判决落 n-a——静默少一行就等于分母会随阅读顺序漂
  }
  return rows.length ? { rows, dropped } : null;
}

/** 每张表自己的"行提取"：把三种事实的文档声明各读成 {table, line, cell, …claims}。
 *  规则统一：**读不准就落到 dropped（作废整条读数）**，而不是默默少一行；只有"这行确实没做该类声明"才是 n-a。 */
function factsRows(p, text) {
  const tableOf = (s) => {
    const hits = [...stripParen(s).matchAll(/\b(ewoh_[a-z0-9_]+)\b/g)].map((m) => m[1]);
    return hits.length === 1 ? hits[0] : (hits.length > 1 ? null : undefined);
  };
  const cellOf = {
    rls: (cells, line) => {
      const table = tableOf(cells[1]);
      if (table === null) return null;   // 一行里两张表 ⇒ 归属歧义，必须作废而不是挑一个
      if (table === undefined) return { noClaim: true, line, table: null, cell: cells[1] };
      const iso = String(cells[4]);
      const claimRls = /应用层/.test(iso) ? false : (/RLS|数据库级/.test(iso) ? true : null);
      const flag = String(cells[2]);
      const claimOrg = flag.includes('✅') ? true : (flag.includes('❌') ? false : null);
      if (claimRls == null && claimOrg == null) return { noClaim: true, line, table, cell: `${cells[2]}｜${cells[4]}` };
      return { line, table, cell: `${cells[2]}｜${cells[4]}`, claimRls, claimOrg };
    },
    writer: (cells, line) => {
      const table = tableOf(cells[1]);
      if (table === null) return null;   // 一行里两张表 ⇒ 归属歧义，必须作废而不是挑一个
      if (table === undefined) return { noClaim: true, line, table: null, cell: cells[1] };
      const owner = (String(cells[3]).match(/[A-Za-z][A-Za-z0-9]*(?:Service|Controller|Repository|Manager)/) || [])[0] || null;
      if (!owner) return null;   // 指向了表却没读出拥有者 ⇒ 歧义必须露头
      return { line, table, cell: cells[3], owner };
    },
    columns: (cells, line) => {
      const table = tableOf(cells[2]);
      /* V337：`null`（一格里两张表）此前与 `undefined`（一格里没有表）并成 n-a，
         于是"归属歧义"这一族在 columns 类被静默吞掉——rls／writer 两族早就判 dropped 作废。
         三族必须同判：歧义 ⇒ dropped ⇒ 整条读数作废；没有表 ⇒ n-a 且占分母一行。
         改前后对同一份真语料读数不变（match 2／n-a 3），已核对。 */
      if (table === null) return null;
      if (table === undefined) return { noClaim: true, line, table: null, cell: cells[2] };
      const cols = [...new Set(stripParen(cells[3]).split(/[、,，]/).map((s) => s.trim())
        .filter((s) => /^[a-z][a-z0-9_]{2,}$/.test(s)))];
      // 括号里是举例（`原因（如 person_unavailable、time_conflict）` 那两个是取值枚举，不是列名）；
      // 剥完一个 snake_case 标识符都不剩 ⇒ 那格本来就不是列清单 ⇒ n-a，但表名与原文仍留在读数里。
      if (!cols.length) return { noClaim: true, line, table, cell: cells[3] };
      return { line, table, cell: cells[3], cols };
    },
  }[p.fact];
  return docTableRows(text, p.header, cellOf);
}
/** 归一化「类名 ↔ 文件名」：`PlanService` 与 `plan.service.ts` 都归到 planservice。
 *  只对**文件名**做归一，不对文件内容做猜——归属判错的代价比"没判"高。 */
const normName = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
/** 括号内是**举例**而不是清单：`原因（如 person_unavailable、time_conflict）` 里那几个是取值枚举，
 *  当列名读就会凭空造出一条漂移（本轮第一版就这么假红了一次）。全角半角都剥。 */
const stripParen = (s) => String(s).replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '');
function judgeFacts(p, ctx, r, amendOk) {
  if (r.noClaim) {
    return { line: r.line, table: r.table || '（该行不指向单张表）', cell: r.cell || '', verdict: 'n-a',
      detail: '未做该类声明（n-a 仍占分母一行，不许静默少一行）' };
  }
  const st = schemaTables(ctx);
  const notes = [];
  const bad = [];
  const unknown = [];
  if (p.fact === 'rls') {
    if (r.claimRls != null) {
      const a = factsRls(ctx, r.table);
      if (a.missing) unknown.push('事实档没有「RLS 开关」小节');
      else if (a.unsampled) unknown.push(`该表不在事实档 RLS 小节的采样面里（档内 ${a.sampled} 张）⇒ 未采到，不等于没开也没等于开了`);
      else if (a.rls !== r.claimRls) bad.push(`文档写「${r.cell}」而 ${a.source} 记 rls=${a.rls}`);
      else notes.push(`rls=${a.rls} 与文档一致`);
    }
    if (r.claimOrg != null) {
      const t = st && st.get(r.table);
      if (!t) unknown.push('schema.ts 里找不到这张表');
      else if (t.cols.has('org_id') !== r.claimOrg) bad.push(`org_id 列声明＝${r.claimOrg}，schema.ts 实际＝${t.cols.has('org_id')}`);
      else notes.push(`org_id ${r.claimOrg ? '在' : '不在'} schema.ts`);
    }
  } else if (p.fact === 'writer') {
    const cw = censusWriters(ctx);
    if (!cw) unknown.push('普查档读不到或 JSON 不可解析');
    else {
      const writers = cw.byTable.get(r.table);
      if (!writers || !writers.size) unknown.push(`普查里这张表没有写者站点（普查只扫 drizzle 写点，raw SQL 不在内）`);
      else {
        const own = [...writers].filter((f) => normName(f).includes(normName(r.owner)));
        notes.push(`普查 ${writers.size} 处写者，归属该拥有者文件的 ${own.length} 处`);
        if (!own.length) bad.push(`文档写拥有者「${r.owner}」，而普查到的写者是 ${[...writers].join('、')}`);
        else if (own.length !== writers.size) notes.push(`不独占：另有 ${[...writers].filter((f) => !own.includes(f)).join('、')}`);
      }
    }
  } else {
    const t = st && st.get(r.table);
    if (!t) unknown.push('schema.ts 里找不到这张表');
    else {
      const miss = r.cols.filter((c) => !t.cols.has(c));
      if (miss.length) bad.push(`清单里的列在 schema.ts 不存在：${miss.join('、')}`);
      const extra = [...t.cols].filter((c) => !r.cols.includes(c));
      notes.push(`文档列 ${r.cols.length}／表列 ${t.cols.size}（清单未列 ${extra.length} 列，摘要不算漂移）`);
    }
  }
  let verdict;
  if (bad.length) verdict = amendOk ? 'amended' : 'drift';
  else verdict = unknown.length ? 'indeterminate' : (notes.length ? 'match' : 'n-a');
  return { line: r.line, table: r.table, cell: r.cell, verdict, detail: [...bad, ...unknown, ...notes].join('｜') };
}

// ---------------------------------------------------------------- 判据声明（分母）
const CONTROL_CODE = 'ewoh-spark-app/server/modules/control/control.service.ts';
// 三件产物的路径（tokens_ledger 的覆盖面）；自测的多面前提与判据共用同一组常量，别再各抄一份。
const LEDGER_PATH = 'docs/audit/current/chain-behavior-baseline.md';
const PKG = 'docs/audit/current/pilot-promotion-verdict.md';
const STATEF = '.codex/artifacts/chain-behavior-baseline-state.json';
const FX_DATAFLOW = 'docs/architecture/data-flow.md';
const CONTROL_E2E = [
  'ewoh-spark-app/server/modules/control/control.service.ts',
  'ewoh-spark-app/server/modules/control/authorization-fingerprint.ts',
];

const PAIRS = [
  {
    id: 'revoke_reasons_dataflow', kind: 'pair',
    note: 'NO-62a/65a 投递前复核撤回原因：架构文档抄写的封闭词表 ↔ 代码权威数组',
    docText: (ctx) => docSlashList(ctx.read(FX_DATAFLOW), /复核失败原因封闭词表/),
    authorityText: (ctx) => tsArray(ctx.read(CONTROL_CODE), 'CONTROL_REVOKE_REASONS'),
    authorityLabel: 'CONTROL_REVOKE_REASONS（control.service.ts）',
  },
  {
    id: 'result_types_dataflow', kind: 'pair',
    note: '结果行类型：架构文档 `resultType ∈ {…}` ↔ 服务侧写出的字面量全集',
    docText: (ctx) => docBraceSet(ctx.read(FX_DATAFLOW), /ewoh_control_result\.resultType\s*∈/),
    authorityText: (ctx) => tsFieldLiterals(ctx, CONTROL_E2E, 'resultType'),
    authorityLabel: 'resultType 字面量（control 模块产品码）',
  },
  {
    id: 'revoke_reasons_dbcheck', kind: 'pair',
    note: '同一份词表的 DB 侧：CHECK 约束（按"最后一个定义 wins"跨迁移解析）↔ 代码权威数组',
    docText: (ctx) => (ctx.sqlWin ? ctx.sqlWin.values : null),
    authorityText: (ctx) => tsArray(ctx.read(CONTROL_CODE), 'CONTROL_REVOKE_REASONS'),
    authorityLabel: 'chk_ewoh_control_command_revocation（db/migrations 现行定义）',
    sqlConstraint: 'chk_ewoh_control_command_revocation',
  },
  {
    id: 'revoke_comment_claim', kind: 'claim',
    note: '代码注释声明"与 standalone_093 的 CHECK 逐项一致"：093 是否仍是该约束的现行定义',
    claimFile: CONTROL_CODE, claimRe: /standalone_(\d{3})[\s\S]{0,80}?CHECK 约束逐项一致/,
    sqlConstraint: 'chk_ewoh_control_command_revocation',
  },
  {
    id: 'rls_audit_isolation', kind: 'facts', fact: 'rls',
    docFile: 'docs/reviews/rls-coverage-audit-2026-08-08.md',
    header: /^\|\s*表\s*\|\s*org_id 列\s*\|\s*建表位置\s*\|\s*隔离方式\s*\|/,
    note: '08-08 那份 RLS 走查表的「隔离方式」列 ↔ `schema-facts.txt` 的 RLS 开关；「org_id 列」只认 ✅／❌ 两种声明',
    amendRe: /现行口径[\s\S]{0,300}RLS 开关/,   // 注记必须点到这条判据自己的权威源
  },
  {
    id: 'mes_adr_writers', kind: 'facts', fact: 'writer',
    docFile: 'docs/architecture/adr-004-mes-scheduling-convergence.md',
    header: /^\|\s*表\s*\|\s*角色\s*\|\s*拥有者\s*\|\s*状态\s*\|/,
    note: 'ADR-004-mes 表归属列 ↔ `status-write-guard-census` 的 prod 写者站点（AST 扫 drizzle 写点，表名由 schema.ts 反解）',
    amendRe: /现行口径[\s\S]{0,300}写者/,     // 「域没变、类名搬了」这种更正才免检，泛泛一句不算
  },
  {
    id: 'delivery_columns', kind: 'facts', fact: 'columns',
    docFile: 'delivery/开发指令-AI调度说明生成-2026-08-21.md',
    header: /^\|\s*输入块\s*\|\s*来源\s*\|\s*字段\s*\|/,
    note: '交付指令里手抄的 AI 输入列清单 ↔ `schema.ts` 该表 pgTable 块的列集合（没列全不算漂移，只报「未列 N 列」）',
    amendRe: /现行口径[\s\S]{0,300}schema\.ts/,
  },
  {
    id: 'rls_adr_null_bypass', kind: 'ddl',
    note: 'ADR-004 分类表逐行抄写的表级 DDL 事实（policy 的 `org_id IS NULL` 放行分支／org_id 是否 NOT NULL）↔ db/migrations 现行定义',
    docFile: 'docs/decisions/ADR-004-scheduler-tenancy.md',
  },
  { id: 'refs_dataflow', kind: 'refs', note: '架构文档里的文件引用是否落得到', files: ['docs/architecture/data-flow.md'] },
  { id: 'refs_ledger', kind: 'refs', note: '《基线》登记册里的文件引用是否落得到', files: ['docs/audit/current/chain-behavior-baseline.md'] },
  { id: 'refs_runbook', kind: 'refs', note: '运维手册里的文件引用是否落得到', files: ['docs/operations/production-runbook.md'] },
  {
    id: 'tokens_ledger', kind: 'token',
    note: '三件产物正文里不得残留记账脚本未渲染的词元（双 at 号包名字）；反引号里的逐字引用不算残留',
    files: [LEDGER_PATH, PKG, STATEF],
  },
];

/** 未渲染词元（V317 第四类·DOCFACE-02 同族的"词面残缺"）：记账脚本的模板占位符没被渲染就落了盘。
 *  判法：**先摘掉反引号包住的内联代码**（那是"逐字引用某个残缺"，不是残缺本身），再摘掉 `%%` 转义，
 *  然后按三族形状找：
 *    ①at 成对包标识符，at 的个数 1 个或多个都算——只认 `@@x@@` 会放过 V316 自己造出的那种**半渲染**（`@x@`）；
 *    ②Python **命名**格式串 `%\(name\)s|d|f`——V321 补：状态件里 V112 的 8 处与《基线》§七 的 1 处
 *      就是这个形状，它不带 at，所以 V317 那版判据结构性看不见（现算假阴面 9 处，活了约 200 轮）；
 *    ③位置式 `%s/%d/%f`（允许宽度与 flags）——同族里最松的一档，先量过假阳面再进：三件产物里
 *      位置式共 9 处，7 处本就在反引号里（被①的豁免吃掉）、2 处是 V260 逐字引用自己踩的这族错，
 *      本轮把那 2 处补上反引号 ⇒ 加这一档的净假阳面为 0。
 *  读不到文件返回 null（不可判），不返回空集。 */
const RESIDUE_RES = [
  /@{1,}[A-Za-z_][A-Za-z0-9_]*@{1,}/g,
  /%\([A-Za-z_][A-Za-z0-9_]*\)[sdf]/g,
  /%[-+ #0]*\d*[sdif]/g,
];
function unrenderedTokens(text) {
  if (text == null) return null;
  const stripped = text.replace(/`[^`\n]*`/g, '').replace(/%%/g, '');
  const hits = new Set();
  for (const re of RESIDUE_RES) for (const m of stripped.matchAll(re)) hits.add(m[0]);
  return [...hits];
}

const REAL = makeCtx(null);

function diff(docValues, authValues) {
  const doc = new Set(docValues);
  const auth = new Set(authValues);
  const missing = authValues.filter((v) => !doc.has(v));
  const extra = docValues.filter((v) => !auth.has(v));
  return { missing, extra };
}

// ---------------------------------------------------------------- refs 解析
// 扩展名交替必须**长名在前**并带右边界：`x.json` 若先撞上 `js` 会被切成 `x.js`，
// 于是"文件不存在"是量具自己造出来的（V227 首跑在 .codex 状态件引用上现形）。
const REF_RE = /(?:^|[\s`(:：，、（])((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:tsx|yaml|json|sql|mjs|cjs|sh|py|md|ts|js))(?![A-Za-z0-9_])(?::(\d+))?/g;

function gitList(args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\n').filter(Boolean);
  } catch { return null; }
}

function indexBasenames() {
  const tracked = gitList(['ls-files']);
  if (tracked === null) return null;
  // 工作树里存在但还没提交的（试点四件产物刻意不提交、以及他人的未提交文件）也要认，
  // 且单独成档：今天能跑到，别人克隆下来跑不到（V227 首跑把《基线》自己判成"引用失效"）。
  const others = gitList(['ls-files', '--others', '--exclude-standard']) || [];
  const list = [...tracked, ...others];
  const trackedSet = new Set(tracked);
  const byBase = new Map();
  for (const rel of list) {
    const base = path.basename(rel);
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(rel);
  }
  // `postgres.js` 这类是**包名**不是文件引用（npm 依赖 postgres）——按依赖清单认出来，别算失效。
  const deps = new Set();
  for (const pkg of ['ewoh-spark-app/package.json', 'package.json']) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(root, pkg), 'utf8'));
      for (const k of Object.keys(j.dependencies || {})) deps.add(k + '.js');
      for (const k of Object.keys(j.devDependencies || {})) deps.add(k + '.js');
    } catch { /* 读不到就不认包名 */ }
  }
  return { tracked: trackedSet, untracked: new Set(others), byBase, deps };
}

const REF_ROOTS = ['ewoh-spark-app/', 'scripts/chain-baseline/', 'scripts/', 'src/', 'db/migrations/', 'tools/'];

function measureRefs(ctx, files, index) {
  const B = ['ok', 'untrackedPending', 'rootRelative', 'loose', 'ambiguous', 'placeholder', 'depNamed', 'gitignored', 'bareUnmatched', 'missing', 'unresolved'];
  const buckets = {};
  for (const k of B) buckets[k] = [];
  const locate = (t) => {
    if (index && index.tracked.has(t)) return 'tracked';
    if (index && index.untracked.has(t)) return 'untracked';
    if (!ctx.exists(t)) return null;
    // 磁盘上有、但 git 的 tracked/untracked 两张清单都不认 ⇒ 被 .gitignore 忽略（别人克隆下来跑不到）。
    // 不再用硬编码目录猜测：`.codex/` 这类前缀其实是**已跟踪**的，猜错会把在册文件报成"只在 gitignore 里"。
    return index ? 'ignored' : 'untracked';
  };
  const seen = new Set();
  for (const rel of files) {
    const text = ctx.read(rel);
    if (text == null) continue;
    for (const line of text.split('\n')) {
      for (const m of line.matchAll(REF_RE)) {
        const target = m[1];
        const key = rel + '#' + target;
        if (seen.has(key)) continue;
        seen.add(key);
        const clean = target.replace(/^\.\//, '');
        const push = (b) => buckets[b].push({ from: rel, target });
        if (clean.startsWith('/')) continue;                        // 仓外绝对路径：不参与对账
        const base = path.basename(clean);
        // 文档里的通配/省略写法（`*.e2e.spec.ts`、`…mobile.service.ts`）不是文件引用。
        if (base.startsWith('.') || clean.includes('...') || clean.includes('*')) { push('placeholder'); continue; }
        if (!clean.includes('/') && index && index.deps.has(clean)) { push('depNamed'); continue; }
        const here = locate(clean);
        if (here === 'tracked') { push('ok'); continue; }
        if (here === 'untracked') { push('untrackedPending'); continue; }
        if (here === 'ignored') { push('gitignored'); continue; }
        const rooted = REF_ROOTS.map((r) => r + clean).map(locate).filter(Boolean);
        if (rooted.includes('tracked') || rooted.includes('untracked')) { push('rootRelative'); continue; }
        if (rooted.includes('ignored')) { push('gitignored'); continue; }
        const hits = index ? (index.byBase.get(base) || []) : [];
        if (hits.length === 1) { push('loose'); continue; }
        if (hits.length > 1) { push('ambiguous'); continue; }
        if (!index) { push('unresolved'); continue; }        // git 清单没拿到：判不可判，不判失效
        // 只有**带目录**的引用才是位点声明（"这个文件在这儿"）；裸名多是口语指代，
        // 全仓找不到同名文件时单列一档，不折算成失效（V227 首跑 9 条"找不到"里 5 条是这一形）。
        if (clean.includes('/')) push('missing'); else push('bareUnmatched');
      }
    }
  }
  return buckets;
}

// ---------------------------------------------------------------- 出数
function measure(overrides) {
  const ctx = makeCtx(overrides);
  if (PAIRS.some((p) => p.sqlConstraint)) ctx.sqlWin = sqlCheck(ctx, 'chk_ewoh_control_command_revocation');
  const index = indexBasenames();
  const rows = [];
  for (const p of PAIRS) {
    if (p.kind === 'pair') {
      const doc = p.docText(ctx);
      const auth = p.authorityText(ctx);
      if (doc == null || auth == null) {
        rows.push({ id: p.id, kind: p.kind, verdict: 'indeterminate',
          why: [doc == null ? '文档侧词表解析不到' : null, auth == null ? '权威侧解析不到' : null].filter(Boolean).join('＋'),
          note: p.note });
        continue;
      }
      const { missing, extra } = diff(doc, auth);
      rows.push({ id: p.id, kind: p.kind, verdict: missing.length || extra.length ? 'drift' : 'match',
        docCount: doc.length, authCount: auth.length, missing, extra, note: p.note,
        detail: p.authorityLabel + (p.sqlConstraint && ctx.sqlWin ? `｜现行定义＝${ctx.sqlWin.source}（共 ${ctx.sqlWin.definitions} 次定义）` : '') });
    } else if (p.kind === 'claim') {
      const text = ctx.read(p.claimFile);
      const m = text && p.claimRe.exec(text);
      const win = ctx.sqlWin;
      if (!m || !win) {
        rows.push({ id: p.id, kind: p.kind, verdict: 'indeterminate', why: !m ? '声明原文匹配不到' : '约束定义解析不到', note: p.note });
        continue;
      }
      const cited = 'standalone_' + m[1];
      const current = path.basename(win.source).slice(0, 'standalone_000'.length);
      rows.push({ id: p.id, kind: p.kind, verdict: cited === current ? 'match' : 'drift',
        cited, current, definitions: win.definitions, note: p.note, detail: `${p.claimFile} 声明指向 ${cited}，现行定义是 ${win.source}` });
    } else if (p.kind === 'token') {
      const hits = [];
      const unreadable = [];
      for (const f of p.files) {
        const found = unrenderedTokens(ctx.read(f));
        if (found == null) unreadable.push(f);
        else for (const h of found) hits.push(`${f} → ${h}`);
      }
      rows.push({ id: p.id, kind: 'token',
        verdict: unreadable.length ? 'indeterminate' : (hits.length ? 'drift' : 'match'),
        why: unreadable.length ? `读不到：${unreadable.join('、')}` : null,
        hits, files: p.files, note: p.note,
        detail: `扫 ${p.files.length} 份产物` });
    } else if (p.kind === 'ddl') {
      const text = ctx.read(p.docFile);
      const parsed = docDdlRows(text);
      if (!parsed) {
        rows.push({ id: p.id, kind: 'ddl', verdict: 'indeterminate',
          why: text == null ? '文档读不到' : '分类表的表头形状认不到（`| 表 | 分类 | RLS | org_id 语义 |`）',
          note: p.note });
        continue;
      }
      const amend = text.match(AMEND_RE);
      const docRows = parsed.rows;
      if (parsed.dropped.length) {
        rows.push({ id: p.id, kind: 'ddl', verdict: 'indeterminate',
          why: `分类表有 ${parsed.dropped.length} 行没被认出来（${parsed.dropped.join('、')}）⇒ 分母不完整，本类读数作废`,
          note: p.note });
        continue;
      }
      const cells = docRows.map((r) => {
        const f = ddlFacts(ctx, r.table);
        const parts = [];
        const st = [];
        if (r.claimBypass || r.claimNotNull) {
          // 两类声明都是"断言该事实为真"：放行分支存在／列现行非空
          const auth = r.claimBypass ? f.bypass : f.notnull;
          if (auth == null) st.push('indeterminate');
          else if (auth.value !== true) st.push('contradicted');
          else st.push('agree');
          parts.push(`${r.claimBypass ? '放行分支' : 'org_id 非空'}＝${auth == null ? '未解析到' : String(auth.value)}（${auth ? auth.source : '-'}${auth && auth.via ? '／' + auth.via : ''}）`);
        } else {
          st.push('n-a');
          parts.push(`该行未做这两类声明（原文「${r.cell}」）`);
        }
        const bad = st.includes('contradicted');
        const unknown = st.includes('indeterminate');
        let verdict;
        if (bad) {
          const cited = ((r.claimBypass ? f.bypass : f.notnull)?.source ?? '').match(/standalone_(\d{3})/);
          verdict = (amend && cited && amend[1] === cited[1]) ? 'amended' : 'drift';
        } else verdict = unknown ? 'indeterminate' : (st[0] === 'n-a' ? 'n-a' : 'match');
        return { line: r.line, table: r.table, cell: r.cell, verdict, detail: parts.join('｜') };
      });
      const counts = {};
      for (const c of cells) counts[c.verdict] = (counts[c.verdict] || 0) + 1;
      const sum = Object.values(counts).reduce((a, b) => a + b, 0);
      if (sum !== docRows.length) {
        rows.push({ id: p.id, kind: 'ddl', verdict: 'indeterminate',
          why: `逐格判决加总 ${sum}≠文档行数 ${docRows.length} ⇒ 本类读数作废`, note: p.note });
        continue;
      }
      const verdict = counts.drift ? 'drift' : (counts.indeterminate ? 'indeterminate'
        : (counts.amended ? 'amended' : (counts.match ? 'match' : 'n-a')));
      rows.push({
        id: p.id, kind: 'ddl', verdict, counts, cells, docFile: p.docFile,
        amend: amend ? `现行口径注记指向 standalone_${amend[1]}` : '无现行口径注记',
        note: p.note, detail: `${docRows.length} 行逐格判`,
      });
    } else if (p.kind === 'facts') {
      const text = ctx.read(p.docFile);
      const parsed = factsRows(p, text);
      if (!parsed) {
        rows.push({ id: p.id, kind: 'facts', verdict: 'indeterminate',
          why: text == null ? '文档读不到' : '那张表的表头形状或数据行取不到（认不到不等于没有）', note: p.note });
        continue;
      }
      if (parsed.dropped.length) {
        rows.push({ id: p.id, kind: 'facts', verdict: 'indeterminate',
          why: `有 ${parsed.dropped.length} 行没被认出来（${parsed.dropped.join('、')}）⇒ 分母不完整，本类读数作废`, note: p.note });
        continue;
      }
      const authPaths = p.fact === 'columns' ? [SCHEMA_TS]
        : (p.fact === 'writer' ? [CENSUS_PATH, SCHEMA_TS] : [FACTS_RLS_PATH, SCHEMA_TS]);
      const stale = factsStaleness(ctx, authPaths);
      if (stale) {
        rows.push({ id: p.id, kind: 'facts', verdict: 'indeterminate', why: `新鲜度守卫：${stale}`, note: p.note });
        continue;
      }
      const head = text.match(p.amendRe ? AMEND_HEAD_RE : AMEND_RE);
      const block = head ? text.slice(head.index, head.index + 1200) : '';
      const amendOk = !!head && (!p.amendRe || p.amendRe.test(block));
      const cells = parsed.rows.map((r) => judgeFacts(p, ctx, r, amendOk));
      const counts = {};
      for (const c of cells) counts[c.verdict] = (counts[c.verdict] || 0) + 1;
      const sum = Object.values(counts).reduce((a, b) => a + b, 0);
      if (sum !== parsed.rows.length) {
        rows.push({ id: p.id, kind: 'facts', verdict: 'indeterminate',
          why: `逐格判决加总 ${sum}≠文档行数 ${parsed.rows.length} ⇒ 本类读数作废`, note: p.note });
        continue;
      }
      const verdict = counts.drift ? 'drift' : (counts.indeterminate ? 'indeterminate'
        : (counts.amended ? 'amended' : (counts.match ? 'match' : 'n-a')));
      rows.push({
        id: p.id, kind: 'facts', verdict, counts, cells, docFile: p.docFile, fact: p.fact,
        amend: amendOk ? '同文件有指向权威的现行口径注记' : '无指向权威的现行口径注记',
        note: p.note, detail: `${parsed.rows.length} 行逐格判｜权威＝${authPaths.join('＋')}`,
      });
    } else {
      const buckets = measureRefs(ctx, p.files, index);
      const counts = {};
      for (const [k, v] of Object.entries(buckets)) counts[k] = v.length;
      rows.push({ id: p.id, kind: 'refs', verdict: counts.missing ? 'drift' : 'match',
        counts, buckets, note: p.note });
    }
  }
  return rows;
}

/** 判红的极性：只有词表／声明两类可以判失败；refs 类当期只报读数（见脚本头部限度）。 */
function hardDriftIds(rows) {
  return rows.filter((r) => r.kind !== 'refs' && r.verdict === 'drift').map((r) => r.id);
}

function report(rows) {  for (const r of rows) {
    console.log(`\n[${r.id}] ${r.note}`);
    if (r.kind === 'refs') {
      const c = r.counts;
      const total = Object.values(c).reduce((a, b) => a + b, 0);
      console.log(`  引用 ${total} 处｜` + Object.entries(c).map(([k, v]) => `${k} ${v}`).join('｜'));
      const print = (label, list) => { if (list.length) console.log(`  ${label}：\n    ` + list.slice(0, 12).map((x) => `${x.from} → ${x.target}`).join('\n    ') + (list.length > 12 ? `\n    …另 ${list.length - 12} 条` : '')); };
      print('找不到（带目录的位点声明失效，须逐条读）', r.buckets.missing);
      print('裸名且全仓无同名文件（口语指代，不折算失效）', r.buckets.bareUnmatched.slice(0, 8));
      print('git 清单不可用而判不了的（不可判）', r.buckets.unresolved.slice(0, 4));
      print('只在 gitignore 里（别人克隆下来跑不到）', r.buckets.gitignored);
      print('工作树里有但还没提交（他人/试点未提交面）', r.buckets.untrackedPending.slice(0, 8));
      print('按包根才匹配上（引用少写了目录）', r.buckets.rootRelative.slice(0, 5));
      print('按文件名才匹配上（引用少了目录）', r.buckets.loose.slice(0, 5));
      print('通配／省略写法（不算文件引用）', r.buckets.placeholder.slice(0, 5));
      continue;
    }
    console.log(`  判决：${r.verdict}${r.detail ? '｜' + r.detail : ''}${r.why ? '｜' + r.why : ''}`);
    if (r.verdict === 'drift' && r.kind === 'pair') {
      if (r.missing.length) console.log(`  ✗ 抄写侧缺 ${r.missing.length} 项：${r.missing.join('、')}`);
      if (r.extra.length) console.log(`  ✗ 抄写侧多出 ${r.extra.length} 项（权威源里没有）：${r.extra.join('、')}`);
      console.log(`  （文档 ${r.docCount} 项／权威 ${r.authCount} 项）`);
    }
    if (r.verdict === 'drift' && r.kind === 'claim') console.log(`  ✗ 声明指向 ${r.cited}，而该约束的现行定义在 ${r.current}（共 ${r.definitions} 次重定义）`);
    if (r.kind === 'ddl' || r.kind === 'facts') {
      console.log(`  逐格 ${r.cells ? r.cells.length : 0} 行｜` + Object.entries(r.counts ?? {}).map(([k, v]) => `${k} ${v}`).join('｜')
        + `｜${r.amend ?? ''}`);
      if (r.cells) {
        const show = r.cells.filter((c) => c.verdict !== 'match' && c.verdict !== 'n-a');
        for (const c of show) console.log(`  ${c.verdict === 'drift' ? '✗' : c.verdict === 'amended' ? '▲' : '·'}:${c.line} ${c.table} 原文「${c.cell}」｜${c.detail}`);
        const quiet = r.cells.filter((c) => c.verdict === 'match' || c.verdict === 'n-a');
        if (quiet.length) console.log(`  （一致或未声明 ${quiet.length} 行，逐行号：${quiet.map((c) => c.line).join(',')}）`);
      }
    }
    if (r.kind === 'token') {
      console.log(`  残留词元 ${r.hits.length} 处${r.hits.length ? '：\n    ' + r.hits.slice(0, 10).join('\n    ') : ''}`);
      if (r.hits.length > 10) console.log(`    …另 ${r.hits.length - 10} 条`);
    }
  }
  const counts = {};
  for (const r of rows) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
  const sum = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`\n[doc-face] 分母 ${PAIRS.length} 类对账｜${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join('｜')}`);
  if (sum !== PAIRS.length) {
    console.error(`[doc-face] 判决加总 ${sum}≠分母 ${PAIRS.length} ⇒ 读数作废（漏判或重复判）`);
    process.exitCode = 1;
    return;
  }
  // 退出码只由 pair／claim 两类决定：refs 类的极性还没被真语料验过（V227 首轮 6 条"找不到"
  // 逐条读完＝0 条真位点失效，全是历史探针／依赖包内部文件），把它接成失败就是把尺子的影子当规则。
  const hardIds = hardDriftIds(rows);
  const soft = rows.filter((r) => r.kind === 'refs' && r.verdict === 'drift');
  for (const r of soft) console.log(`⚠ ${r.id}：只报读数、不判失败（判据极性未验，见脚本头部限度）`);
  if (hardIds.length) { console.error(`[doc-face] ${hardIds.length} 项词表／声明对账判红：${hardIds.join('、')}`); process.exitCode = 1; }
}

// ---------------------------------------------------------------- 自测（夹具全在内存，不碰真实文件）
function selfTest() {
  const cases = [];
  const ok = (name, cond, detail = '') => cases.push({ name, pass: !!cond, detail });
  const FX_CODE = CONTROL_CODE;
  const FX_DOC = FX_DATAFLOW;
  const base = measure();
  ok('分母＝声明的类数且每条都有判决（不许漏判）',
    base.length === PAIRS.length
    && base.every((r) => ['match', 'drift', 'indeterminate', 'amended', 'n-a'].includes(r.verdict)),
    base.map((r) => `${r.id}:${r.verdict}`).join(' '));
  ok('真实语料必须至少抓到一条漂移（否则怀疑尺子在空转）',
    base.some((r) => r.verdict === 'drift'), base.map((r) => `${r.id}:${r.verdict}`).join(' '));
  ok('git 清单解析不到时不得把在盘的文件判成"找不到"（只能判不可判）',
    (() => { const r = measureRefs(makeCtx(null), [FX_DATAFLOW], null);
      return r.missing.length === 0 && (r.ok.length + r.untrackedPending.length + r.rootRelative.length) > 0; })(),
    '见 measureRefs：index 为 null 时退化为按磁盘判，判不了的单列 unresolved');
  const bareDoc = REAL.read(FX_DOC) + '\n自测裸名 `qqz_bare_probe_widget.ts`\n';
  const bareRow = measure(new Map([[FX_DOC, bareDoc]])).find((x) => x.id === 'refs_dataflow');
  ok('裸名且全仓无同名文件必须落 bareUnmatched（口语指代≠失效位点）',
    bareRow.buckets.bareUnmatched.some((x) => x.target === 'qqz_bare_probe_widget.ts')
    && !bareRow.buckets.missing.some((x) => x.target === 'qqz_bare_probe_widget.ts'),
    JSON.stringify(bareRow.counts));

  // 注入 1：文档侧少一项 ⇒ 必须 drift 且点名那一项
  const docText = REAL.read(FX_DOC);
  const rowBase = base.find((r) => r.id === 'revoke_reasons_dataflow');
  const firstTok = '`authorization_expired`/';
  ok('夹具的前提：真实文档那一行确实以该成员开头（否则注入是空操作）',
    docText.includes(firstTok), 'fixture precondition');
  // 文档**少抄**一项 ⇒ 权威侧有、抄写侧没有 ⇒ 落 missing 档（极性写反是本仓老错）
  const fewer = docText.replace(firstTok, '');
  const withFewer = measure(new Map([[FX_DOC, fewer]]));
  const rowFewer = withFewer.find((r) => r.id === 'revoke_reasons_dataflow');
  ok('文档少抄一项必须判 drift 并点名该项（missing 档）',
    rowFewer.verdict === 'drift' && rowFewer.missing.includes('authorization_expired')
    && rowFewer.missing.length === rowBase.missing.length + 1, JSON.stringify(rowFewer).slice(0, 200));
  ok('少抄一项不得让别的判据跟着翻（各判据彼此隔离）',
    withFewer.find((r) => r.id === 'result_types_dataflow').verdict === base.find((r) => r.id === 'result_types_dataflow').verdict,
    'result_types 读数被 docs 注入带偏');

  // 注入 2：文档侧多一项（权威源没有）⇒ 必须 drift
  const more = docText.replace(firstTok, firstTok + '`not_a_real_reason`/');
  const rowMore = measure(new Map([[FX_DOC, more]])).find((r) => r.id === 'revoke_reasons_dataflow');
  ok('文档多抄一项必须判 drift 且落 extra 档（权威源里没有这个名字）',
    rowMore.verdict === 'drift' && rowMore.extra.includes('not_a_real_reason'), JSON.stringify(rowMore).slice(0, 200));

  // 必须不开火 1：数组改名 ⇒ 权威侧解析不到，只能 indeterminate，不得判 match 也不得判 drift
  const renamed = REAL.read(FX_CODE).replace('export const CONTROL_REVOKE_REASONS = [', 'export const CONTROL_REVOKE_REASONS_RENAMED = [');
  const rowRenamed = measure(new Map([[FX_CODE, renamed]])).find((r) => r.id === 'revoke_reasons_dataflow');
  ok('权威数组改名必须 indeterminate（"看不见"≠"没同步"≠"一致"）',
    rowRenamed.verdict === 'indeterminate', rowRenamed.verdict + '｜' + (rowRenamed.why || ''));

  // 必须不开火 2：真实语料那一行同时含中文括注（`（审批时效 + 指纹 + 租户）`）——
  // 斜杠词表必须扫"第一个整组成词表形态的括号"，不能被第一个括号顶掉而判 indeterminate。
  ok('同一行有中文括注时，词表必须仍然解析得到（V227 第一版在此判 indeterminate）',
    (() => {
      const line = REAL.read(FX_DATAFLOW).split('\n').find((l) => /复核失败原因封闭词表/.test(l));
      const got = docSlashList(line, /复核失败原因封闭词表/);
      return Array.isArray(got) && got.length >= 5 && got.includes('device_org_mismatch');
    })(),
    String(docSlashList(REAL.read(FX_DATAFLOW), /复核失败原因封闭词表/)));

  // 必须不开火 3：数组体内的注释里带引号词面，不得被算成词表成员
  const commented = REAL.read(FX_CODE).replace("  'request_terminal',", "  // 例外的 'legacy_reason' 已废弃\n  'request_terminal',");
  const rowCommented = measure(new Map([[FX_CODE, commented]])).find((r) => r.id === 'revoke_reasons_dataflow');
  ok('数组体内注释里的引号词面不得进权威集合',
    !rowCommented.missing.includes('legacy_reason') && !rowCommented.extra.includes('legacy_reason'),
    JSON.stringify({ missing: rowCommented.missing, extra: rowCommented.extra }));

  // 必须开火 3（真语料形状）：CHECK 被后续迁移重定义 ⇒ 必须读最后一个定义，否则会把已同步的 DB 面报成漂移
  const win = sqlCheck(REAL, 'chk_ewoh_control_command_revocation');
  ok('CHECK 跨迁移重定义必须取最后一个定义',
    win && win.values.includes('fingerprint_key_missing') && /standalone_09[4-9]/.test(win.source),
    JSON.stringify({ source: win && win.source, defs: win && win.definitions }));
  const only093 = new Map([['db/migrations/standalone_094_control_fingerprint_key_missing.sql', 'SELECT 1;\n'],
    ['db/migrations/standalone_093_control_command_authorization.sql', REAL.read('db/migrations/standalone_093_control_command_authorization.sql')]]);
  const win093 = sqlCheck(makeCtx(only093), 'chk_ewoh_control_command_revocation');
  ok('去掉 094 后现行定义必须回落到 093（尺子认得出"哪条迁移在管"）',
    win093 && !win093.values.includes('fingerprint_key_missing') && /standalone_093/.test(win093.source),
    JSON.stringify({ source: win093 && win093.source }));

  // 必须开火 4：refs——把某文档引用改成不存在的文件 ⇒ missing 档 +1；改成 tmp/ 前缀 ⇒ gitignored 档 +1
  const okRefs = base.find((r) => r.id === 'refs_dataflow').buckets.ok.map((x) => x.target);
  const realRef = okRefs.find((t) => t.endsWith('control.service.ts')) || okRefs[0];
  ok('夹具的前提：架构文档里确实有可改写的文件引用', Boolean(realRef), JSON.stringify(okRefs.slice(0, 4)));
  const broken = docText.split(realRef).join(realRef.replace(/([A-Za-z0-9_-]+)\.(ts|sql|yaml|md|py)$/, 'qqz_missing.$1.$2'));
  const rowBroken = measure(new Map([[FX_DOC, broken]])).find((r) => r.id === 'refs_dataflow');
  ok('指向不存在文件的引用必须进 missing 档',
    rowBroken.buckets.missing.length === base.find((r) => r.id === 'refs_dataflow').buckets.missing.length + 1,
    JSON.stringify(rowBroken.counts));
  const moved = docText.split(realRef).join('tmp/zz-selftest-probe.mjs');
  const rowMoved = measure(new Map([[FX_DOC, moved],
    ['tmp/zz-selftest-probe.mjs', '// 自测夹具：磁盘上有，但 git 的 tracked/untracked 两张清单都不认 ⇒ ignored\n']]))
    .find((r) => r.id === 'refs_dataflow');
  ok('磁盘上有而 git 不认（被忽略）的引用必须单独成档——别人克隆下来跑不到',
    rowMoved.buckets.gitignored.some((x) => x.target === 'tmp/zz-selftest-probe.mjs'), JSON.stringify(rowMoved.counts));
  ok('已跟踪的 `.codex/` 状态件不得被"前缀猜测"误判成只在 gitignore 里（V227 首跑的假档）',
    rowMoved.buckets.gitignored.every((x) => !x.target.startsWith('.codex/')),
    JSON.stringify(rowMoved.buckets.gitignored.map((x) => x.target)));
  // 必须不开火：文档把 `ewoh-spark-app/` 前缀省掉（本仓文档的常态写法）⇒ 落 rootRelative，
  // 折进"找不到"会造出上百条假阳性（V227 首跑实测：登记册 567 处引用里 235 处是这种）。
  const rootedTarget = realRef.startsWith('ewoh-spark-app/') ? realRef.slice('ewoh-spark-app/'.length) : null;
  const rooted = rootedTarget ? docText.split(realRef).join(rootedTarget) : docText;
  const rowRooted = measure(new Map([[FX_DOC, rooted]])).find((r) => r.id === 'refs_dataflow');
  ok('省掉包根前缀的引用必须落 rootRelative 而不是"找不到"（文档少写目录≠文件失效）',
    !rootedTarget || (rowRooted.buckets.rootRelative.some((x) => x.target === rootedTarget)
      && !rowRooted.buckets.missing.some((x) => x.target === rootedTarget)),
    JSON.stringify(rowRooted.counts));
  ok('未注入时真实文档的引用不得整档为空（refs 判据本身在跑）',
    (base.find((r) => r.id === 'refs_dataflow').counts.ok || 0) > 0,
    JSON.stringify(base.find((r) => r.id === 'refs_dataflow').counts));
  // 必须不开火：工作树里存在但**没提交**的文件不得判成失效（试点四件产物刻意不提交，
  // 只按 `git ls-files` 建索引会把《基线》自己读成"引用不到"）。
  ok('未提交但工作树存在的文件必须可解析（索引不能只认 git ls-files）',
    (() => { const idx = indexBasenames(); return idx && idx.byBase.has('chain-behavior-baseline.md'); })(),
    'chain-behavior-baseline.md 未进 git，但工作树里有');
  ok('本脚本自身不进任何判据', !PAIRS.some((p) => (p.files || []).includes(SELF)), '见 PAIRS');
  // 必须不开火：`.json` 不得被扩展名交替切成 `.js`（V227 首跑把状态件引用读成 xxx.js ⇒ 假"找不到"）
  ok('扩展名交替必须长名在前：`state.json` 整体捕获，不得切成 `state.js`',
    (() => {
      const m = /x/.test('') ? null : [...'见 .codex/artifacts/chain-behavior-baseline-state.json 与 a.yaml'.matchAll(REF_RE)].map((x) => x[1]);
      return m.includes('.codex/artifacts/chain-behavior-baseline-state.json') && m.includes('a.yaml');
    })(),
    [...'见 .codex/artifacts/chain-behavior-baseline-state.json 与 a.yaml'.matchAll(REF_RE)].map((x) => x[1]).join(','));

  // 未渲染词元这一类（V317）：一支必须开火、三支不得开火／判不可判——它抓的是 V316 靠手工 grep 才发现的形状
  const LEDGER = LEDGER_PATH;
  const ledBase = REAL.read(LEDGER);
  ok('夹具前提：真实《基线》当期没有残留词元（有的话这条判据今天就该红）',
    unrenderedTokens(ledBase).length === 0, unrenderedTokens(ledBase).join(','));
  // V321：V112 那 8 处 `%(name)s` 就藏在状态件里，而这条前提当时只核《基线》一面 ⇒ 面要铺全
  for (const face of [PKG, STATEF]) {
    const hits = unrenderedTokens(REAL.read(face));
    ok(`夹具前提（多面）：${face.split('/').pop()} 当期也没有残留词元`,
      hits !== null && hits.length === 0, (hits || ['读不到']).join(','));
  }
  // 注入支一律用**合成干净底本**：往真实语料上追加会让"底本本来就有残留"混进读数里
  const LEDGER_CLEAN = '# 假登记册\n当期读数写在正文里：链上另有表被写状态。\n';
  // 夹具自足（V321）：这条判据扫的是**三件产物**，只覆写《基线》一面就等于把另外两面的真语料混进读数里。
  // 旧版能过只因状态件当时恰好没有 at 成对的形状——状态件一有 `%(x)s` 就全部串味（本轮实测 26/36 的成因）。
  const tokRow = (text) => measure(new Map([[PKG, ''], [STATEF, ''], [LEDGER, text]]))
    .find((x) => x.id === 'tokens_ledger');
  const withLeak = LEDGER_CLEAN + '轴①由 9/10 更正为 @@a_with2@@/@@a_total2@@ 张。\n';
  const leakRow = tokRow(withLeak);
  ok('正文里残留未渲染词元必须判 drift 并逐处点名出处',
    leakRow.verdict === 'drift' && leakRow.hits.length === 2
    && leakRow.hits.every((h) => h.startsWith(LEDGER + ' → @@')),
    JSON.stringify(leakRow.hits));
  // 半渲染那一支：V316 的记账脚本自己造出来的形状（哨兵只换成一个 at），只认 `@@x@@` 就会放过它
  const halfRow = tokRow(LEDGER_CLEAN + '那句写着 @orph_n@ 张表。\n');
  ok('半个渲染（单 at 包名字）也必须开火——这条是 V316 自己踩出来的形状',
    halfRow.verdict === 'drift' && halfRow.hits.join() === `${LEDGER} → @orph_n@`,
    JSON.stringify(halfRow.hits));
  ok('词元判红必须进退出码（它不属于"只报数"那一类）',
    hardDriftIds([leakRow]).join() === 'tokens_ledger', '极性');
  const quotedRow = tokRow(LEDGER_CLEAN + '登记文本里逐字写着 `链上另 @@orph_n@@ 张表` 这一句。\n');
  ok('反引号里逐字引用某个残缺，不得被判成残缺本身（缺席断言会被自己的复述挡）',
    quotedRow.verdict === 'match' && quotedRow.hits.length === 0, JSON.stringify(quotedRow.hits));
  // V321 补的两族形状：命名式与位置式（V317 那版只认 at 成对 ⇒ 这两族结构性看不见）
  const fmtNamedRow = tokRow(LEDGER_CLEAN + 'CI 判定面：spec %(dir_files)s、实到 %(executed)s。\n');
  ok('命名式格式串 %(name)s 没渲染就落盘必须开火（V112 那一族的形状）',
    fmtNamedRow.verdict === 'drift' && fmtNamedRow.hits.length === 2
    && fmtNamedRow.hits.every((h) => h.includes('%(')), JSON.stringify(fmtNamedRow.hits));
  const fmtBareRow = tokRow(LEDGER_CLEAN + '留有未格式化的 %d 与 seven_tiers_sum_%d，另有一处 %02s。\n');
  ok('位置式 %s/%d 没渲染也必须开火；且点名按**形状去重**（同形状出现两次只列一条，别拿 hits 数当 occurrence 数）',
    fmtBareRow.verdict === 'drift' && fmtBareRow.hits.length === 2
    && new Set(fmtBareRow.hits).size === fmtBareRow.hits.length
    && fmtBareRow.hits.some((h) => h.endsWith(' → %d')) && fmtBareRow.hits.some((h) => h.endsWith(' → %02s')),
    JSON.stringify(fmtBareRow.hits));
  const fmtEscRow = tokRow(LEDGER_CLEAN + '转义写法 100%% 与 %%s 不是残留。\n');
  ok('对照：`%%` 转义不得被当成残留（否则任何提到百分号的句子都开火）',
    fmtEscRow.verdict === 'match' && fmtEscRow.hits.length === 0, JSON.stringify(fmtEscRow.hits));
  const fmtQuotedRow = tokRow(LEDGER_CLEAN + '登记文本逐字写着 `%(orph_n)s` 与 `%d` 这两个形状时，不算残留。\n');
  ok('对照：反引号里逐字引用新纳入的两族形状，不得判成残留（复述不是残缺）',
    fmtQuotedRow.verdict === 'match' && fmtQuotedRow.hits.length === 0, JSON.stringify(fmtQuotedRow.hits));
  const noFileRow = tokRow(null);
  ok('读不到某份产物时判"不可判"，不得折成 match（看不见≠没有）',
    noFileRow.verdict === 'indeterminate', String(noFileRow.why));
  /* ── V336 第五类（rls_adr_null_bypass）的七条控制，夹具全在内存。
   * 为什么必须有"后续迁移改了同一条 policy"这一支：本类判的是**现行定义**，
   * 若解析器只会取第一份定义，那条已漂移的声明照样读成一致——假绿与真绿同形。 */
  const ADRF = 'docs/decisions/ADR-004-scheduler-tenancy.md';
  const ddlDoc = (note) => [
    '# ADR 夹具', '', note || '',
    '| 表 | 分类 | RLS | org_id 语义 | DB 层证据 |',
    '|----|------|-----|-------------|-----------|',
    '| ewoh_tight | TENANT_SCOPED | 开（001） | 隔离；NULL=全局 | verify-001 |',
    '| ewoh_loose | TENANT_SCOPED | 开（001） | 隔离；NULL=全局 | verify-001 |',
    '| ewoh_nn | TENANT_SCOPED | 开（001） | org_id NOT NULL；隔离 | verify-001 |',
    '| ewoh_multi | TENANT_SCOPED | 开（001） | org_id NOT NULL；隔离 | verify-001 |',
    '| ewoh_dyn | TENANT_SCOPED | 开（002） | org_id NOT NULL；隔离 | verify-002 |',
    '| ewoh_shared | GLOBAL_SHARED | 关闭 | 血缘记录 | 明确排除 |',
    '',
  ].join('\n');
  const M1 = 'db/migrations/standalone_001_zz_ddlfixture.sql';
  const M2 = 'db/migrations/standalone_002_zz_ddlfixture.sql';
  const MIG1 = [
    'CREATE POLICY p_tight ON __S__.ewoh_tight',
    '  FOR ALL', '  USING ( org_id::text = \'a\' OR org_id IS NULL );',
    'CREATE POLICY p_loose ON __S__.ewoh_loose',
    '  USING ( org_id::text = \'a\' OR org_id IS NULL );',
    'CREATE TABLE __S__.ewoh_nn ( id int, org_id varchar(64) NOT NULL );',
    'CREATE TABLE __S__.ewoh_multi (',
    '  id int,',
    '  org_id varchar(64) NOT NULL,',
    '  status text',
    ');',
  ].join('\n');
  // 002 干三件事：① 用**动态清单**给 ewoh_dyn 收紧（认不出这形状就会判不可判）；
  // ② 重建 ewoh_tight 的 policy 且**去掉**放行分支（现行定义因此变了）；
  // ③ 紧接其后写一条**别的表**的放行分支（切不开语句体就会串味、把 tight 读成仍放行）。
  const MIG2 = [
    'DO $$', 'DECLARE t text;', "  v_tables text[] := ARRAY[", "    'ewoh_dyn',", "    'zz_other'", '  ];',
    'BEGIN', "  EXECUTE format('ALTER TABLE __S__.%I ALTER COLUMN org_id SET NOT NULL', t);", 'END $$;',
    'CREATE POLICY p_tight ON __S__.ewoh_tight',
    '  USING (', "    org_id::text = 'a'", '  );',
    'CREATE POLICY p_loose ON __S__.ewoh_loose',
    '  USING (', "    org_id::text = 'a' OR org_id IS NULL", '  );',
  ].join('\n');
  const ddlRow = (migs, note = '') => measure(new Map([[ADRF, ddlDoc(note)], ...migs]))
    .find((r) => r.id === 'rls_adr_null_bypass');
  const cellOf = (row, table) => (row.cells ?? []).find((c) => c.table === table);
  const only1 = ddlRow([[M1, MIG1]]);
  ok('第五类正向对照：权威 policy 仍含 `org_id IS NULL` 时，文档"NULL=全局"必须判 match（尺子不是只会报红）',
    cellOf(only1, 'ewoh_tight').verdict === 'match' && cellOf(only1, 'ewoh_loose').verdict === 'match',
    JSON.stringify(only1.counts));
  ok('建表列定义那条腿必须认得，且**一行多列与一列一行两种形状都要认**（按行切只认后者，前者会整批读空）',
    cellOf(only1, 'ewoh_nn').verdict === 'match' && cellOf(only1, 'ewoh_multi').verdict === 'match',
    `${cellOf(only1, 'ewoh_nn').detail} / ${cellOf(only1, 'ewoh_multi').detail}`);
  ok('没做这两类声明的行必须落 n-a 并从加总里露头（不许从分母里静默消失）',
    cellOf(only1, 'ewoh_shared').verdict === 'n-a' && only1.counts['n-a'] === 1
    && Object.values(only1.counts).reduce((a, b) => a + b, 0) === 6, JSON.stringify(only1.counts));
  const with2 = ddlRow([[M1, MIG1], [M2, MIG2]]);
  ok('必须开火：后续迁移去掉了放行分支 ⇒ 同一份文档立刻判 drift 并点名那张表',
    with2.verdict === 'drift' && cellOf(with2, 'ewoh_tight').verdict === 'drift'
    && cellOf(with2, 'ewoh_loose').verdict === 'match', JSON.stringify(with2.counts));
  ok('必须不开火（串味）：邻表 policy 的放行分支不得算进本表判语——切错语句体时这一支会翻成 match',
    cellOf(with2, 'ewoh_tight').detail.includes('放行分支＝false'), cellOf(with2, 'ewoh_tight').detail);
  ok('DO 块里的动态清单必须摊开：只认字面 ALTER 就会把 ewoh_dyn 读成解析不到',
    cellOf(with2, 'ewoh_dyn').verdict === 'match' && /清单动态 EXECUTE/.test(cellOf(with2, 'ewoh_dyn').detail),
    cellOf(with2, 'ewoh_dyn').detail);
  ok('对照：那张只由清单收紧的表在 001 侧必须落"不可判"而不是"违规"（读不到≠不符）',
    cellOf(only1, 'ewoh_dyn').verdict === 'indeterminate', cellOf(only1, 'ewoh_dyn').detail);
  const amendedRow = ddlRow([[M1, MIG1], [M2, MIG2]], '> 现行口径（依 standalone_002 更正）：放行分支已去除。');
  ok('记载档允许保留旧表述，前提是有指向**该权威迁移号**的现行口径注记 ⇒ 判 amended 不判失败',
    amendedRow.verdict === 'amended' && cellOf(amendedRow, 'ewoh_tight').verdict === 'amended', JSON.stringify(amendedRow.counts));
  const staleNote = ddlRow([[M1, MIG1], [M2, MIG2]], '> 现行口径（依 standalone_001 更正）：见下。');
  ok('注记指向的迁移号与权威不符 ⇒ 仍必须判 drift（挂个横幅就当免检，是这族判据最软的形状）',
    staleNote.verdict === 'drift' && cellOf(staleNote, 'ewoh_tight').verdict === 'drift', JSON.stringify(staleNote.counts));
  const brokenHead = measure(new Map([[ADRF, '# 夹具\n没有那张表\n']]))
    .find((r) => r.id === 'rls_adr_null_bypass');
  ok('分类表表头认不到 ⇒ 整类判不可判，不得读成"零行一致"',
    brokenHead.verdict === 'indeterminate', String(brokenHead.why));
  const droppedRow = measure(new Map([[ADRF, ddlDoc().replace('| ewoh_nn |', '| EWOH_TYPO |')], [M1, MIG1]]))
    .find((r) => r.id === 'rls_adr_null_bypass');
  ok('表名不合形状的那一行必须露头并作废读数（过滤器静默缩分母是本仓老错）',
    droppedRow.verdict === 'indeterminate' && /没被认出来/.test(String(droppedRow.why)), String(droppedRow.why));
  ok('真语料当期：第五类不得有 drift（本轮已把现行口径注记落进 ADR-004）',
    base.find((r) => r.id === 'rls_adr_null_bypass').verdict !== 'drift',
    base.find((r) => r.id === 'rls_adr_null_bypass').verdict);

  /* ── V337 第五类 facts 的控制集，夹具全在内存。
   * 这一族最容易自欺的地方：权威是一份**采样档**（事实档只采 18 张链相关表），"没采到"与"不符"在终端上
   * 都长得像"没报红"。所以两种落空必须各有一支控制、理由必须不同形；三处真语料各自也要一支当期无 drift。 */
  const RLSDOC = 'docs/reviews/rls-coverage-audit-2026-08-08.md';
  const MESDOC = 'docs/architecture/adr-004-mes-scheduling-convergence.md';
  const DELDOC = 'delivery/开发指令-AI调度说明生成-2026-08-21.md';
  const RLF = 'tmp/chain-baseline/schema-facts.txt';
  const CENF = 'tmp/chain-baseline/status-write-guard-census.json';
  const SCH = [
    'export const ewohTight = pgTable("ewoh_tight", {',
    '  id: text("id"),',
    '  org_id: text("org_id"),',
    '  status: text("status"),',
    '});',
    'export const ewohNoOrg = pgTable("ewoh_no_org", {',
    '  id: text("id"),',
    '});',
    'export const ewohPlan = pgTable("ewoh_schedule_plan", {',
    '  plan_id: text("plan_id"),',
    '  status_col: text("status"),',
    '});',
    'export const ewohAsg = pgTable("ewoh_scheduling_plan_assignment", {',
    '  assignment_id: text("assignment_id"),',
    '  status: text("status"),',
    '});',
  ].join('\n');
  const fc = (row, table) => (row.cells ?? []).find((c) => c.table === table);
  const sumOf = (row) => Object.values(row.counts || {}).reduce((a, b) => a + b, 0);

  /* facts/rls：一张开了 RLS、一张确实只应用层、一张没进采样面、一行不指向单表 */
  const rlsDoc = (note) => [
    '# RLS 走查夹具', '', note || '',
    '| 表 | org_id 列 | 建表位置 | 隔离方式 |',
    '|----|-----------|----------|----------|',
    '| `ewoh_tight` | ✅ | 001 | 应用层 |',
    '| `ewoh_no_org` | ❌ | 006 | 应用层 |',
    '| `ewoh_never` | ✅ | 007 | 应用层 |',
    '| 汇总行 | — | — | — |',
    '',
  ].join('\n');
  const RLF_BODY = ['=== RLS 开关 ===', 'ewoh_tight rls=true forced=false',
    'ewoh_no_org rls=false forced=false', 'SECTION RLS 开关 rows=2'].join('\n');
  const RLF_NOSECTION = '=== 别的节 ===\nx\n';
  const rlsRow = (facts, note) => measure(new Map([[RLSDOC, rlsDoc(note)], [RLF, facts], [SCHEMA_TS, SCH]]))
    .find((r) => r.id === 'rls_audit_isolation');
  const rlsDrift = rlsRow(RLF_BODY);
  ok('facts/rls 必须开火：走查写「应用层」而事实档记 rls=true ⇒ drift，并把权威那份读数带进判语',
    rlsDrift.verdict === 'drift' && fc(rlsDrift, 'ewoh_tight').verdict === 'drift'
    && fc(rlsDrift, 'ewoh_tight').detail.includes('rls=true'), fc(rlsDrift, 'ewoh_tight').detail);
  ok('facts/rls 正向对照：事实档 rls=false 而文档写「应用层」⇒ match（这族尺子不是只会报红）',
    fc(rlsDrift, 'ewoh_no_org').verdict === 'match', fc(rlsDrift, 'ewoh_no_org').detail);
  ok('"没进采样面"必须报成未采到、且不折成任何一侧（并打印档内采了几张）',
    fc(rlsDrift, 'ewoh_never').verdict === 'indeterminate'
    && /采样面/.test(fc(rlsDrift, 'ewoh_never').detail) && /18 张|档内 2 张/.test(fc(rlsDrift, 'ewoh_never').detail),
    fc(rlsDrift, 'ewoh_never').detail);
  const rlsNoSec = rlsRow(RLF_NOSECTION);
  ok('"事实档没这个小节"与"没进采样面"必须**两种理由分开**（并成一句就会让没采看着像没问题）',
    /没有「RLS 开关」小节/.test(fc(rlsNoSec, 'ewoh_tight').detail)
    && !/采样面/.test(fc(rlsNoSec, 'ewoh_tight').detail)
    && rlsNoSec.verdict === 'indeterminate', fc(rlsNoSec, 'ewoh_tight').detail);
  ok('不指向单张表的行落 n-a 且占分母一行，加总必须等于文档行数',
    rlsDrift.counts['n-a'] === 1 && sumOf(rlsDrift) === 4, JSON.stringify(rlsDrift.counts));
  const rlsAmen = rlsRow(RLF_BODY, '> 现行口径（2026-09-29 补，依 standalone_057 更正）：当期以 schema-facts.txt 的「RLS 开关」小节为准。');
  ok('facts/rls 免检要点到**本条判据自己的权威**（注记里出现「RLS 开关」）⇒ 该格判 amended',
    rlsAmen.counts.amended === 1 && rlsAmen.counts.drift === undefined, JSON.stringify(rlsAmen.counts));
  const rlsBareNote = rlsRow(RLF_BODY, '> 现行口径（依 standalone_057 更正）：本表口径以当期为准。');
  ok('facts/rls 反证：只挂横幅、没点到权威 ⇒ 仍判 drift（改锚之后这条强度必须还在）',
    rlsBareNote.verdict === 'drift' && rlsBareNote.counts.drift === 1, JSON.stringify(rlsBareNote.counts));

  /* facts/writer：拥有者↔文件名归一，权威是普查 prod 站点清单 */
  const mesDoc = (note, owner) => [
    '# ADR 夹具', '', note || '',
    '| 表 | 角色 | 拥有者 | 状态 |',
    '| -- | ---- | ------ | ---- |',
    `| \`ewoh_schedule_plan\` | 方案权威 | \`${owner || 'SchedulerService'}\` | 保留 |`,
    '',
  ].join('\n');
  const wrRow = (sites, note, owner) => measure(new Map([[MESDOC, mesDoc(note, owner)],
    [CENF, JSON.stringify({ sites, prod: sites })], [SCHEMA_TS, SCH]])).find((r) => r.id === 'mes_adr_writers');
  const WR_LC = [{ file: 'server/modules/scheduler/scheduling-plan.lifecycle.ts', table: 'ewohPlan', line: 12 }];
  const wrDrift = wrRow(WR_LC);
  ok('facts/writer 必须开火：文档拥有者归一后仍不属任何写者文件 ⇒ drift 并列出普查站点',
    wrDrift.verdict === 'drift' && fc(wrDrift, 'ewoh_schedule_plan').verdict === 'drift'
    && fc(wrDrift, 'ewoh_schedule_plan').detail.includes('scheduling-plan.lifecycle.ts'), fc(wrDrift, 'ewoh_schedule_plan').detail);
  const wrMatch = wrRow([{ file: 'server/modules/scheduler/plan.service.ts', table: 'ewohPlan', line: 3 }], '', 'PlanService');
  ok('facts/writer 正向对照：类名与文件名归一（PlanService ↔ plan.service.ts）对上 ⇒ match',
    wrMatch.verdict === 'match', JSON.stringify(wrMatch.counts));
  const wrEmpty = wrRow([]);
  ok('普查里这张表没有站点 ⇒ 不可判，绝不折成"文档写错了"（普查只扫 drizzle 写点，raw SQL 不在面内）',
    wrEmpty.verdict === 'indeterminate' && /没有写者站点/.test(fc(wrEmpty, 'ewoh_schedule_plan').detail),
    fc(wrEmpty, 'ewoh_schedule_plan').detail);
  const wrNoCensus = measure(new Map([[MESDOC, mesDoc()], [CENF, '{坏 json'], [SCHEMA_TS, SCH]]))
    .find((r) => r.id === 'mes_adr_writers');
  ok('普查档读不到／JSON 坏 ⇒ 不可判（不得读成"没有写者"，那会把档的故障判成文档的错）',
    wrNoCensus.verdict === 'indeterminate' && /普查档读不到/.test(fc(wrNoCensus, 'ewoh_schedule_plan').detail),
    fc(wrNoCensus, 'ewoh_schedule_plan').detail);
  const wrNoteNoAuth = wrRow(WR_LC, '> 现行口径（依 standalone_057 更正）：分类表保留当时原文。');
  ok('V337 改锚的强度对照：写者注记里只写迁移号、不点"写者"⇒ 仍判 drift（DDL 那把锚换成 facts 锚不等于放松）',
    wrNoteNoAuth.verdict === 'drift', JSON.stringify(wrNoteNoAuth.counts));
  const wrNoteOk = wrRow(WR_LC, '> 现行口径：当期写者站点以 status-write-guard-census 的 prod 清单为准。');
  ok('facts/writer 免检：注记点到写者权威 ⇒ amended（这一支同时钉住"无迁移号的注记在新锚下仍生效"）',
    wrNoteOk.verdict === 'amended', JSON.stringify(wrNoteOk.counts));

  /* facts/columns：手抄列清单 ↔ schema.ts 该表列集合；摘要漏列不算漂移 */
  const delDoc = (note, lastRow) => [
    '# 交付指令夹具', '', note || '',
    '| 输入块 | 来源 | 字段 |',
    '| ---- | ---- | ---- |',
    `| 方案 | \`ewoh_scheduling_plan_assignment\` | ${lastRow} |`,
    '| 取值 | `ewoh_scheduling_plan_assignment` | 原因（如 assignment_id、status） |',
    '',
  ].join('\n');
  const delDocAmbig = [
    '# 交付指令夹具', '',
    '| 输入块 | 来源 | 字段 |',
    '| ---- | ---- | ---- |',
    '| 方案 | `ewoh_scheduling_plan_assignment` | assignment_id |',
    '| 双表 | `ewoh_tight`／`ewoh_no_org` | assignment_id |',
    '',
  ].join('\n');
  const colRow = (cell, note) => measure(new Map([[DELDOC, delDoc(note, cell)], [SCHEMA_TS, SCH]]))
    .find((r) => r.id === 'delivery_columns');
  const colDrift = colRow('assignment_id、ghost_col');
  ok('facts/columns 必须开火：清单里的列不在该表 pgTable 块 ⇒ drift 并点名缺哪几列',
    colDrift.verdict === 'drift' && /ghost_col/.test(fc(colDrift, 'ewoh_scheduling_plan_assignment').detail),
    fc(colDrift, 'ewoh_scheduling_plan_assignment').detail);
  const colParen = colRow('assignment_id');
  ok('括号里是**举例**不是清单：那格剥完只剩举例 ⇒ 判 n-a（把取值枚举当列名会凭空造出一条漂移）',
    colParen.counts['n-a'] === 1 && colParen.verdict === 'match', JSON.stringify(colParen.counts));
  const colAmbig = measure(new Map([[DELDOC, delDocAmbig], [SCHEMA_TS, SCH]])).find((r) => r.id === 'delivery_columns');
  ok('一行里出现两张表 ⇒ 归属歧义必须作废整条读数，而不是挑一张',
    colAmbig.verdict === 'indeterminate' && /没被认出来/.test(String(colAmbig.why)), String(colAmbig.why));
  const colAmen = colRow('assignment_id、ghost_col', '> 现行口径（2026-09-29 补）：当期列清单以 server/database/schema.ts 该表 pgTable 块为准。');
  const colBare = colRow('assignment_id、ghost_col', '> 现行口径：本节写于交付当时，口径已更正。');
  ok('facts/columns 免检要点到 schema.ts：「已更正」三个字不算指向权威',
    colAmen.verdict === 'amended' && colBare.verdict === 'drift', `${colAmen.verdict}／${colBare.verdict}`);

  const factDrift = base.filter((r) => r.kind === 'facts' && r.verdict === 'drift').map((r) => r.id);
  ok('真语料当期：三个 facts 条目都不得有 drift（本轮把两条现行口径注记落进了文档，第三条本来就一致）',
    factDrift.length === 0, factDrift.join('、') || '三条目均无 drift');
  ok('真语料当期：新鲜度守卫不得在无 stamp 场景静默放行——事实档与普查档都必须在场才出判决',
    base.filter((r) => r.kind === 'facts').every((r) => ['match', 'amended', 'indeterminate'].includes(r.verdict)),
    base.filter((r) => r.kind === 'facts').map((r) => `${r.id}=${r.verdict}`).join('、'));


  // 判红极性对照：refs 独红不得判失败，pair／claim 红必须判失败（把尺子的影子接成规则是老牌错法）
  ok('判红极性：refs 独红不判失败、pair 红必须判失败',
    hardDriftIds([{ id: 'r1', kind: 'refs', verdict: 'drift' }]).length === 0
    && hardDriftIds([{ id: 'p1', kind: 'pair', verdict: 'drift' }]).join() === 'p1'
    && hardDriftIds([{ id: 'c1', kind: 'claim', verdict: 'drift' }]).join() === 'c1'
    && hardDriftIds([{ id: 'm1', kind: 'pair', verdict: 'match' }]).length === 0, '极性对照');
  ok('真实语料当期：除 refs 之外各类（词表／声明／词元／ddl／facts）都必须无 drift（漂移都在轮内修掉），refs 只报数',
    hardDriftIds(base).length === 0, hardDriftIds(base).join('、'));
  let bad = 0;
  for (const c of cases) { console.log(`${c.pass ? '✔' : '✗'} ${c.name}${c.pass ? '' : ` → ${c.detail}`}`); if (!c.pass) bad += 1; }
  console.log(`[doc-face] 判据自测 ${cases.length - bad}/${cases.length} 通过`);
  return bad === 0;
}

function main(argv) {
  if (argv.includes('--self-test')) { process.exitCode = selfTest() ? 0 : 1; return; }
  const rows = measure(argv.includes('--overlay') ? new Map() : null);
  report(rows);
  if (argv.includes('--json')) {
    fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tmp/doc-face.json'), JSON.stringify({
      generatedBy: SELF, pairs: PAIRS.length, rows,
    }, null, 2));
  }
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { measure, tsArray, sqlCheck, docSlashList, docBraceSet, unrenderedTokens, PAIRS };
