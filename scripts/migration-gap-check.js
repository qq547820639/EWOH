#!/usr/bin/env node
'use strict';

/**
 * migration-gap-check.js — 迁移缺口检测门禁（发布前强制执行）。
 *
 * 背景：ECS 部署从未自动执行迁移（compose `--no-deps api` 跳过 migrate），
 * 导致 070–100 共 31 个迁移 / 183 列在生产库缺失，引发生产 500。
 * 本脚本将该检测固化为发布前门禁。
 *
 * 覆盖三类迁移产物（2026-09-19 扩容）：
 *   1. 表（CREATE TABLE IF NOT EXISTS）
 *   2. 列（CREATE TABLE 内定义 / ALTER TABLE ADD COLUMN）
 *   3. **CHECK 约束的枚举清单**（ADD CONSTRAINT … CHECK (col IN (…))）
 * 第 3 类此前是盲区：standalone_101 把死信 reason 从 5 个扩到 7 个，
 * 属约束变更而非表/列变更，表级 diff **看不见**——不检测则生产仍是旧约束，
 * 新 reason 落账必然违约 500。此类缺口只在真实取值上暴露，故必须单独比。
 *
 * 用法：
 *   ssh -L 55432:127.0.0.1:5432 root@<ECS_HOST> -N &
 *   EWOH_PRODUCTION_DATABASE_URL='postgresql://ewoh_owner:***@127.0.0.1:55432/ewoh' \
 *     node scripts/migration-gap-check.js
 *   node scripts/migration-gap-check.js --self-test   # 无 DB，验证检测器能变红
 *
 * 依赖：ewoh-spark-app/node_modules/postgres（已有，零额外安装）。
 * 退出码：0 = 一致；1 = 有缺口；2 = 连接失败/用法错误。
 */

const path = require('node:path');
const fs = require('node:fs');

const root = path.resolve(__dirname, '..');

/** 去掉行注释（保留 SQL 主体） */
function stripLineComments(text) {
  return text.replace(/^--.*$/gm, '');
}

/**
 * 从 `ADD CONSTRAINT <name> … CHECK ( … )` 中抽出括号配平的 CHECK 表达式。
 * 返回 [{ name, expr }]，同一约束在多个迁移中出现时**后者覆盖前者**
 * （本仓库用 DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT 做幂等重定义）。
 */
function extractCheckConstraints(sqlText) {
  const out = [];
  const clean = stripLineComments(sqlText);
  const headRe = /ADD\s+CONSTRAINT\s+([a-z0-9_]+)[\s\S]{0,120}?CHECK\s*\(/gi;
  let m;
  while ((m = headRe.exec(clean)) !== null) {
    const name = m[1];
    let i = headRe.lastIndex; // 指向 CHECK( 之后
    let depth = 1;
    const start = i;
    while (i < clean.length && depth > 0) {
      const ch = clean[i];
      if (ch === "'") {
        // 跳过字符串字面量，避免其中的括号影响配平
        i++;
        while (i < clean.length && clean[i] !== "'") i++;
      } else if (ch === '(') depth++;
      else if (ch === ')') depth--;
      i++;
    }
    if (depth === 0) out.push({ name, expr: clean.slice(start, i - 1) });
    headRe.lastIndex = i;
  }
  return out;
}

/** 从 CHECK 表达式中抽出所有单引号字符串字面量（枚举清单的取值集合） */
function extractLiterals(expr) {
  const lits = new Set();
  const re = /'([^']*)'/g;
  let m;
  while ((m = re.exec(expr)) !== null) lits.add(m[1]);
  return lits;
}

/** 汇总全链预期约束：name -> { expr, literals } */
function buildExpectedConstraints(migrationsDir) {
  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.startsWith('standalone_') && f.endsWith('.sql') && !f.includes('.rollback'))
    .sort((a, b) => Number(a.match(/_(\d+)_/)?.[1] ?? 0) - Number(b.match(/_(\d+)_/)?.[1] ?? 0));

  const expected = new Map();
  for (const file of files) {
    const text = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    for (const { name, expr } of extractCheckConstraints(text)) {
      expected.set(name, { expr, literals: extractLiterals(expr), file });
    }
  }
  return expected;
}

/** 自检：证明检测器在"生产约束偏窄"时确实会变红（无 DB 依赖） */
function selfTest() {
  const prodNarrow = "CHECK (((reason)::text = ANY ((ARRAY['contract_violation'::character varying, 'unknown_event_type'::character varying])::text[])))";
  const expected = extractLiterals(
    "reason IN ('contract_violation','unknown_event_type','clock_drift_future')"
  );
  const actual = extractLiterals(prodNarrow);
  const missing = [...expected].filter((l) => !actual.has(l));
  const ok = missing.length === 1 && missing[0] === 'clock_drift_future';
  console.log(ok
    ? `✅ SELF-TEST PASSED — 检测器可在约束偏窄时变红（识别缺失字面量: ${missing.join(', ')}）`
    : `❌ SELF-TEST FAILED — 期望识别 1 个缺失字面量，实得: ${JSON.stringify(missing)}`);
  process.exit(ok ? 0 : 1);
}

(async () => {
  if (process.argv.includes('--self-test')) selfTest();

  const PROD_URL = process.env.EWOH_PRODUCTION_DATABASE_URL;
  if (!PROD_URL) {
    console.error('Usage: EWOH_PRODUCTION_DATABASE_URL=postgres://… node scripts/migration-gap-check.js');
    console.error('       node scripts/migration-gap-check.js --self-test');
    process.exit(2);
  }

  const postgres = require(path.join(root, 'ewoh-spark-app', 'node_modules', 'postgres'));
  const sql = postgres(PROD_URL, { max: 1, connect_timeout: 10, prepare: false });

  try {
    // 1) 从迁移 SQL 解析预期表/列
    const migrationsDir = path.join(root, 'db', 'migrations');
    const migrationFiles = fs.readdirSync(migrationsDir)
      .filter(f => f.startsWith('standalone_') && f.endsWith('.sql') && !f.includes('.rollback'))
      .sort();

    const expectedTables = new Map(); // tableName -> Set<columnName>
    for (const file of migrationFiles) {
      const clean = fs.readFileSync(path.join(migrationsDir, file), 'utf8').replace(/^--.*$/gm, '');
      let m;
      const createRe = /CREATE TABLE IF NOT EXISTS\s+(?:__EWOH_SCHEMA__\.)?(\w+)\s*\(([\s\S]*?)\);/gi;
      while ((m = createRe.exec(clean)) !== null) {
        const tName = m[1];
        if (!expectedTables.has(tName)) expectedTables.set(tName, new Set());
        for (const line of m[2].split('\n')) {
          const col = line.trim().match(/^(\w+)\s+(?:uuid|varchar|text|int|bigint|numeric|boolean|timestamptz|jsonb|real|double precision|date|time|custom)/i);
          if (col) expectedTables.get(tName).add(col[1]);
        }
      }
      const alterRe = /ALTER TABLE\s+(?:IF EXISTS\s+)?(?:__EWOH_SCHEMA__\.)?(\w+)\s+ADD COLUMN\s+(?:IF NOT EXISTS\s+)?(\w+)/gi;
      while ((m = alterRe.exec(clean)) !== null) {
        if (!expectedTables.has(m[1])) expectedTables.set(m[1], new Set());
        expectedTables.get(m[1]).add(m[2]);
      }
    }

    // 2) 查生产库
    const prodTables = new Set(
      (await sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`)
        .map(r => r.table_name)
    );

    const missingTables = [];
    const missingColumns = [];

    for (const [tName] of expectedTables) {
      if (!prodTables.has(tName)) { missingTables.push(tName); continue; }
      const cols = await sql`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=${tName}`;
      const colSet = new Set(cols.map(c => c.column_name));
      const expected = expectedTables.get(tName);
      for (const col of expected) {
        if (!colSet.has(col)) missingColumns.push(`${tName}.${col}`);
      }
    }

    // 2b) CHECK 约束枚举清单比对（表/列 diff 的盲区）
    const expectedConstraints = buildExpectedConstraints(migrationsDir);
    const missingConstraintLiterals = [];
    const absentConstraints = [];
    const enumConstraints = [...expectedConstraints].filter(([, v]) => v.literals.size > 0);
    if (enumConstraints.length > 0) {
      const names = enumConstraints.map(([n]) => n);
      const rows = await sql`
        SELECT conname, pg_get_constraintdef(oid) AS def
          FROM pg_constraint WHERE conname = ANY(${names})`;
      const prodDefs = new Map(rows.map(r => [r.conname, r.def]));
      for (const [name, exp] of enumConstraints) {
        const prodDef = prodDefs.get(name);
        if (!prodDef) { absentConstraints.push(name); continue; }
        const prodLits = extractLiterals(prodDef);
        const missing = [...exp.literals].filter(l => !prodLits.has(l));
        if (missing.length > 0) {
          missingConstraintLiterals.push({ name, missing, file: exp.file });
        }
      }
    }

    // 3) 输出
    console.log(`预期表: ${expectedTables.size} | 生产表: ${prodTables.size}`);
    console.log(`缺失表: ${missingTables.length} | 缺失列: ${missingColumns.length}`);
    console.log(`枚举约束受检: ${enumConstraints.length} | 缺失约束: ${absentConstraints.length} | 约束取值缺失: ${missingConstraintLiterals.length}`);

    if (missingTables.length > 0) {
      console.log('\n缺失表（需新建）:');
      for (const t of missingTables) console.log(`  - ${t}`);
    }
    if (missingColumns.length > 0) {
      console.log('\n缺失列（需 ALTER TABLE ADD COLUMN）:');
      for (const c of missingColumns.slice(0, 50)) console.log(`  - ${c}`);
      if (missingColumns.length > 50) console.log(`  … 共 ${missingColumns.length} 条`);
    }
    if (absentConstraints.length > 0) {
      console.log('\n缺失约束（需 ADD CONSTRAINT）:');
      for (const c of absentConstraints) console.log(`  - ${c}`);
    }
    if (missingConstraintLiterals.length > 0) {
      console.log('\n约束取值缺失（生产枚举清单偏窄 → 新取值落库会违约）:');
      for (const { name, missing } of missingConstraintLiterals) {
        console.log(`  - ${name}: 缺 ${missing.join(', ')}`);
      }
    }

    const hasGap = missingTables.length > 0 || missingColumns.length > 0 ||
      absentConstraints.length > 0 || missingConstraintLiterals.length > 0;
    if (hasGap) {
      console.error('\n❌ MIGRATION GAP DETECTED — 发布前必须补齐缺失迁移。');
      process.exit(1);
    }
    console.log('\n✅ MIGRATION GAP CHECK PASSED — 迁移链与生产库一致。');
  } finally {
    await sql.end();
  }
})();
