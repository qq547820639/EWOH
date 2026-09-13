#!/usr/bin/env node
/**
 * 未启用 RLS 的 org_id 表门禁（议题 R-7，2026-09-13）。
 *
 * 为什么需要它（现场后果）：
 *   有几张表**含 org_id 列却故意不开 RLS**——它们是跨租户共享的全局/派生血缘表
 *   （GLOBAL_SHARED / DERIVED_TENANT_OWNERSHIP）。这个裁决过去只写在
 *   db/migrations/standalone_057_rls_null_reject.sql 的头注释「裁决记录」里，
 *   以及 db/contracts/schema-manifest.yaml 的 notes 散文里——**没有任何可执行守卫**。
 *   后果：任何人新加一张带 org_id 的表忘了开 RLS（= 全租户可见可写），或者有人
 *   顺手给上面四张表补 RLS（把全局 SSE 重放/全局审计流打断），都不会有任何东西报错，
 *   直到线上出现跨租户泄漏或全局事件流静默丢包。本脚本把「哪些表允许不开 RLS」
 *   变成一份**显式、可读、可审**的裁决清单，并 fail-closed 扫描。
 *
 * 职责（任一违反 → 非零退出）：
 *   1. 解析 db/migrations 下**全部非 .rollback.sql 迁移**（含 001_ewoh_managed_tables.sql
 *      与 standalone_*.sql），建立「表 → 列集合」「表 → 是否启用 RLS」；
 *       RLS 来源同时覆盖静态 `ALTER TABLE … ENABLE ROW LEVEL SECURITY` 与
 *       `FOREACH t IN ARRAY ARRAY[…] LOOP … ENABLE ROW LEVEL SECURITY` 动态块；
 *   2. 找出所有含 org_id（或 organization_id）列却**未启用 RLS** 的表；
 *   3. 这些表必须逐张登记在 UNRLS_ALLOWLIST（含裁决语义与理由）——未登记即 FAIL；
 *   4. 反向：清单里的每张表必须**仍然是**「含 org_id + 未开 RLS」——否则视为僵尸
 *      登记（表被改名/被补了 RLS/被删），同样 FAIL，避免清单腐烂后掩盖真相；
 *   5. 解析健全性下限：解析出的表数/含 org_id 表数低于下限 → 判为解析器失效，
 *      **不得静默通过**（fail loud，而不是 fail silent）；
 *   6. 同源锁：每张清单表必须在 db/contracts/schema-manifest.yaml 里声明
 *      `org_id_policy: "GLOBAL_SHARED"`——裁决必须两处一致，防止只改一处。
 *
 * 已接入：make audit-regression-gates（议题 R-7）。
 * 用法：node scripts/audit-unrls-tenant-tables.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'db/migrations');
const SCHEMA_MANIFEST = path.join(REPO_ROOT, 'db/contracts/schema-manifest.yaml');

const failures = [];
const passes = [];
function check(name, ok, detail = '') {
  if (ok) passes.push(name);
  else failures.push(`${name}${detail ? `: ${detail}` : ''}`);
}

// ── 显式裁决清单（GLOBAL_SHARED / 派生血缘）─────────────────────────────────
// 每一张「含 org_id 却不开 RLS」的表都必须在此登记，写明**为什么**。
// 依据（同源，勿另行自造）：ADR-004 / standalone_028 / standalone_029 /
// standalone_057 头注释「裁决记录」/ db/contracts/schema-manifest.yaml notes。
const UNRLS_ALLOWLIST = new Map([
  [
    'ewoh_world_state_snapshot',
    {
      semantics: 'GLOBAL_SHARED',
      reason:
        'ADR-004：org_id 仅血缘记录，非 RLS 隔离边界；snapshot_version 为全局版本键，' +
        'SSE 跨 org 重放与审计留痕依赖其全局唯一（standalone_025/028 头注释，' +
        'standalone_057 裁决记录；manifest org_id_policy=GLOBAL_SHARED）。',
    },
  ],
  [
    'ewoh_assignment_event',
    {
      semantics: 'DERIVED_TENANT_OWNERSHIP',
      reason:
        'ADR-004/standalone_028：RLS 关闭（全局审计流）；租户边界由派生触发器 ' +
        'trg_assignment_event_derive_org 落库 + 应用层过滤保证，不是 RLS 边界' +
        '（standalone_057 裁决记录；manifest org_id_policy=GLOBAL_SHARED）。',
    },
  ],
  [
    'ewoh_outbox',
    {
      semantics: 'GLOBAL_SHARED',
      reason:
        'ADR-004：全局 sequence 事件日志，org_id 仅血缘，非隔离边界；跨 org 顺序投递' +
        '依赖全局 sequence（standalone_057 裁决记录；manifest org_id_policy=GLOBAL_SHARED）。',
    },
  ],
  [
    'prediction_shadow_observation',
    {
      semantics: 'GLOBAL_SHARED',
      reason:
        'standalone_029/ADR + 审计 SQL-010：advisory-only 观测表，null=全局/ALL 采样' +
        '语义；org_id 可空仅血缘，不启用 RLS（standalone_057 裁决记录；' +
        'manifest org_id_policy=GLOBAL_SHARED）。',
    },
  ],
]);

// 解析健全性下限（防止正则失配后静默「零表 = 全通过」）。
const MIN_PARSED_TABLES = 80;
const MIN_ORG_TABLES = 40;

// ── DDL 解析 ────────────────────────────────────────────────────────────────
/** 去掉块注释与行注释（避免把注释里的 DISABLE/ENABLE 当成真语句）。 */
function stripComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
}

/** 归一化表名：去掉 public./__EWOH_SCHEMA__ 前缀与引号，转小写。 */
function normalizeTable(raw) {
  return raw
    .replace(/^(public|__EWOH_SCHEMA__|"public")\s*\.\s*/i, '')
    .replace(/"/g, '')
    .trim()
    .toLowerCase();
}

/** standalone 迁移序号：standalone_057_x.sql → 57；001_ewoh_managed_tables.sql → 1。 */
function migrationOrder(file) {
  const m = file.match(/standalone_(\d+)/);
  if (m) return Number(m[1]);
  const n = file.match(/^(\d+)_/);
  return n ? Number(n[1]) : 0;
}

function migrationFiles() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.rollback.sql'))
    .sort((a, b) => migrationOrder(a) - migrationOrder(b) || a.localeCompare(b));
}

const CONSTRAINT_KEYWORDS = new Set([
  'constraint', 'primary', 'unique', 'foreign', 'check', 'exclude', 'like',
]);

/**
 * 单文件解析：把 CREATE TABLE / ALTER TABLE ADD COLUMN / RLS 语句收集进共享状态。
 * RLS 事件按源码内出现顺序记录（后写的 DISABLE 覆盖先前的 ENABLE）。
 */
function parseSql(rawSql, order, state) {
  const sql = stripComments(rawSql);
  const columnsOf = (table) => {
    if (!state.columns.has(table)) state.columns.set(table, new Set());
    return state.columns.get(table);
  };

  let m;
  // CREATE TABLE … ( … );（列清单体，单行/多行皆可；非贪婪停在第一个 `);`）
  const createRe = /CREATE TABLE (?:IF NOT EXISTS )?([A-Za-z_"][\w".]*)\s*\(([\s\S]*?)\)\s*;/g;
  while ((m = createRe.exec(sql)) !== null) {
    const table = normalizeTable(m[1]);
    const cols = columnsOf(table);
    // 列定义：按换行与逗号切段（兼容单行 CREATE TABLE），逐段取首列名。
    for (const segment of m[2].split(/[\n,]/)) {
      const cm = segment.match(/^\s*"?([A-Za-z_][A-Za-z0-9_]*)"?\s+[A-Za-z]/);
      if (cm && !CONSTRAINT_KEYWORDS.has(cm[1].toLowerCase())) cols.add(cm[1].toLowerCase());
    }
  }
  // ALTER TABLE … ADD COLUMN [IF NOT EXISTS] col
  const addRe = /ALTER TABLE (?:IF EXISTS )?([A-Za-z_"][\w".]*)\s+ADD COLUMN (?:IF NOT EXISTS )?"?([A-Za-z_][A-Za-z0-9_]*)"?/gi;
  while ((m = addRe.exec(sql)) !== null) columnsOf(normalizeTable(m[1])).add(m[2].toLowerCase());

  // 动态块 FOREACH t IN ARRAY ARRAY[…] LOOP … ENABLE|DISABLE ROW LEVEL SECURITY … END LOOP
  const foreachRe = /FOREACH\s+\w+\s+IN\s+ARRAY\s+ARRAY\s*\[([\s\S]*?)\]\s*LOOP([\s\S]*?)END\s+LOOP/gi;
  while ((m = foreachRe.exec(sql)) !== null) {
    const body = m[2];
    const enabled = /ENABLE ROW LEVEL SECURITY/i.test(body);
    const disabled = /DISABLE ROW LEVEL SECURITY/i.test(body);
    // PL/pgSQL 条件守卫（IF … THEN）：数组里的表只有一部分真的执行了
    // ENABLE/DISABLE，静态解析无法判定是哪几张。此时整块**放弃归属**——表保持
    // "未知"=未保护，门禁对它们 fail-loud。绝不能反着来：把没被 ENABLE 的表也
    // 判成已保护就是静默漏判（2026-09-13 临时假迁移实测：IF 守卫循环下 b 表
    // 实际未开 RLS，解析器却判为已保护，门禁静默 PASS）。IF NOT EXISTS /
    // IF EXISTS（DROP POLICY IF EXISTS 等）不是条件守卫，故要求 IF 后出现 THEN。
    const conditional = /\bIF\b[\s\S]{0,400}?\bTHEN\b/i.test(body);
    const start = m.index;
    for (const hit of m[1].matchAll(/'([^']+)'/g)) {
      if (conditional) continue;
      if (enabled && !disabled) state.rlsEvents.push({ order, pos: start, table: normalizeTable(hit[1]), on: true });
      if (disabled && !enabled) state.rlsEvents.push({ order, pos: start, table: normalizeTable(hit[1]), on: false });
    }
  }
  // 静态 ALTER TABLE … ENABLE|DISABLE ROW LEVEL SECURITY
  const rlsRe = /ALTER TABLE (?:IF EXISTS )?([A-Za-z_"][\w".]*)\s+(ENABLE|DISABLE) ROW LEVEL SECURITY/gi;
  while ((m = rlsRe.exec(sql)) !== null) {
    state.rlsEvents.push({ order, pos: m.index, table: normalizeTable(m[1]), on: m[2].toUpperCase() === 'ENABLE' });
  }
}

function parseFile(file, state) {
  const raw = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
  parseSql(raw, migrationOrder(file), state);
}

/** 对内存 state 求解「表 → 是否启用 RLS」（后写覆盖先写）。 */
function resolveRls(state) {
  state.rlsEvents.sort((a, b) => a.order - b.order || a.pos - b.pos);
  const rls = new Map();
  for (const e of state.rlsEvents) rls.set(e.table, e.on);
  return rls;
}

/**
 * 自测：把检测器喂给合成 DDL，断言它确实能识别「未开 RLS 的 org_id 表」并
 * 区分动态/静态 RLS——解析器失灵（正则被改坏、只剩静默通过）时本项 FAIL。
 * 这是门禁自身的回归锁，随每次 audit-regression-gates 运行。
 */
function selfCheck() {
  const probe = `
    CREATE TABLE public.t_undecided (id uuid, org_id uuid);
    CREATE TABLE public.t_static_rls (id uuid, org_id uuid);
    ALTER TABLE public.t_static_rls ENABLE ROW LEVEL SECURITY;
    CREATE TABLE public.t_dynamic_rls (id uuid, org_id text);
    DO $$ BEGIN
      FOREACH t IN ARRAY ARRAY['t_dynamic_rls'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      END LOOP;
    END $$;
    -- 条件守卫循环：数组里只有 a 真被 ENABLE（b 实际未开 RLS）。解析器无法判定
    -- 谁被执行 → 整块放弃归属 → a/b 都按"未保护"处理（fail-loud，不许静默漏判）。
    CREATE TABLE public.t_guarded_rls_a (id uuid, org_id uuid);
    CREATE TABLE public.t_guarded_rls_b (id uuid, org_id uuid);
    DO $$ BEGIN
      FOREACH t IN ARRAY ARRAY['t_guarded_rls_a','t_guarded_rls_b'] LOOP
        IF t <> 't_guarded_rls_b' THEN
          EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        END IF;
      END LOOP;
    END $$;
    CREATE TABLE public.t_orgless (id uuid, name text);
  `;
  const state = { columns: new Map(), rlsEvents: [] };
  parseSql(probe, 1, state);
  const rls = resolveRls(state);
  const unprotected = [...state.columns.keys()].filter((t) => orgColumnName(state.columns.get(t)) && rls.get(t) !== true);
  const ok =
    unprotected.length === 3 &&
    unprotected.includes('t_undecided') &&
    unprotected.includes('t_guarded_rls_a') &&
    unprotected.includes('t_guarded_rls_b') &&
    rls.get('t_static_rls') === true &&
    rls.get('t_dynamic_rls') === true &&
    !state.columns.has('') &&
    !unprotected.includes('t_orgless');
  return { ok, unprotected, rls: [...rls.entries()] };
}

function scanSchema() {
  const state = { columns: new Map(), rlsEvents: [] };
  const files = migrationFiles();
  for (const f of files) parseFile(f, state);
  return { files, columns: state.columns, rls: resolveRls(state) };
}

function orgColumnName(cols) {
  if (cols.has('org_id')) return 'org_id';
  if (cols.has('organization_id')) return 'organization_id';
  return null;
}

// ── manifest 同源锁 ─────────────────────────────────────────────────────────
function manifestOrgPolicy(table) {
  const text = fs.readFileSync(SCHEMA_MANIFEST, 'utf8');
  const re = new RegExp(
    `physical_table:\\s*"${table}"([\\s\\S]*?)(?=\\n  - domain:|\\nadditional_hardened_existing_tables:|\\nmanaged_tables:|\\Z)`,
  );
  const block = re.exec(text);
  if (!block) return null;
  const pol = /org_id_policy:\s*"([^"]+)"/.exec(block[1]);
  return pol ? pol[1] : null;
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
// 0) 检测器自测（合成 DDL）：解析器失灵时立刻报错，绝不静默放行。
const selfTest = selfCheck();
check('unrls_detector_self_test', selfTest.ok, `检测器自测失败：${JSON.stringify(selfTest)}`);

const { files, columns, rls } = scanSchema();

check('unrls_parse_tables_sane', columns.size >= MIN_PARSED_TABLES, `解析表数 ${columns.size} < ${MIN_PARSED_TABLES}（解析器可能失效）`);

const orgTables = [];
const unprotected = [];
for (const [table, cols] of columns) {
  const col = orgColumnName(cols);
  if (!col) continue;
  orgTables.push(table);
  if (rls.get(table) !== true) unprotected.push({ table, col });
}
unprotected.sort((a, b) => a.table.localeCompare(b.table));

check('unrls_org_tables_sane', orgTables.length >= MIN_ORG_TABLES, `含 org_id 表数 ${orgTables.length} < ${MIN_ORG_TABLES}`);
check(
  'unrls_org_column_scan_found',
  orgTables.includes('ewoh_schedule_plan') && orgTables.includes('ewoh_device'),
  '哨兵表（ewoh_schedule_plan/ewoh_device）未出现在含 org_id 表中，解析器失配',
);

// 3. 每张未开 RLS 的 org_id 表必须在裁决清单内
const undeclared = unprotected.filter((t) => !UNRLS_ALLOWLIST.has(t.table));
check(
  'unrls_org_tables_all_decided',
  undeclared.length === 0,
  `含 org_id 却未开 RLS 且未登记裁决：${undeclared.map((u) => `${u.table}(${u.col})`).join(', ')}`,
);

// 4. 反向：清单条目必须仍然是「含 org_id + 未开 RLS」（防僵尸登记掩盖改名/补 RLS）
const unprotectedNames = new Set(unprotected.map((t) => t.table));
const stale = [...UNRLS_ALLOWLIST.keys()].filter((t) => !unprotectedNames.has(t));
check(
  'unrls_allowlist_no_stale',
  stale.length === 0,
  `裁决清单条目已不再是「含 org_id + 未开 RLS」（表被改名/补了 RLS/删除）：${stale.join(', ')}`,
);

// 6. 同源锁：清单表必须在 schema-manifest 里声明 org_id_policy: GLOBAL_SHARED
const manifestDrift = [...UNRLS_ALLOWLIST.keys()].filter((t) => manifestOrgPolicy(t) !== 'GLOBAL_SHARED');
check(
  'unrls_manifest_same_source',
  manifestDrift.length === 0,
  `裁决清单与 schema-manifest 不同源（缺 org_id_policy: GLOBAL_SHARED）：${manifestDrift.join(', ')}`,
);

// ── 汇总 ────────────────────────────────────────────────────────────────────
console.log(
  `[audit-unrls-tenant-tables] 扫描 ${files.length} 个迁移文件 / 解析表 ${columns.size} 张 / 含 org_id ${orgTables.length} 张 / 未开 RLS ${unprotected.length} 张 / 裁决清单 ${UNRLS_ALLOWLIST.size} 条`,
);
for (const { table, col } of unprotected) {
  const decision = UNRLS_ALLOWLIST.get(table);
  console.log(`  · ${table}（${col}，RLS off）→ ${decision ? decision.semantics : '未登记（FAIL）'}`);
}
for (const p of passes) console.log(`PASS ${p}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`FAIL ${f}`);
  console.log(`\n[audit-unrls-tenant-tables] ${failures.length} 项失败。`);
  process.exit(1);
}
console.log(
  '[audit-unrls-tenant-tables] 全部通过：含 org_id 却未开 RLS 的表都在显式裁决清单内，且与 schema-manifest 同源。',
);
