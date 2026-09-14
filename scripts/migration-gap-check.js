#!/usr/bin/env node
'use strict';

/**
 * migration-gap-check.js — 迁移缺口检测门禁（发布前强制执行）。
 *
 * 背景：ECS 部署从未自动执行迁移（compose `--no-deps api` 跳过 migrate），
 * 导致 070–100 共 31 个迁移 / 183 列在生产库缺失，引发生产 500。
 * 本脚本将该检测固化为发布前门禁。
 *
 * 用法：
 *   ssh -L 55432:127.0.0.1:5432 root@<ECS_HOST> -N &
 *   EWOH_PRODUCTION_DATABASE_URL='postgresql://ewoh_owner:***@127.0.0.1:55432/ewoh' \
 *     node scripts/migration-gap-check.js
 *
 * 依赖：ewoh-spark-app/node_modules/postgres（已有，零额外安装）。
 * 退出码：0 = 一致；1 = 有缺口；2 = 连接失败。
 */

(async () => {
  const PROD_URL = process.env.EWOH_PRODUCTION_DATABASE_URL;
  if (!PROD_URL) {
    console.error('Usage: EWOH_PRODUCTION_DATABASE_URL=postgres://… node scripts/migration-gap-check.js');
    process.exit(2);
  }

  const path = require('node:path');
  const fs = require('node:fs');
  const root = path.resolve(__dirname, '..');
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

    // 3) 输出
    console.log(`预期表: ${expectedTables.size} | 生产表: ${prodTables.size}`);
    console.log(`缺失表: ${missingTables.length} | 缺失列: ${missingColumns.length}`);

    if (missingTables.length > 0) {
      console.log('\n缺失表（需新建）:');
      for (const t of missingTables) console.log(`  - ${t}`);
    }
    if (missingColumns.length > 0) {
      console.log('\n缺失列（需 ALTER TABLE ADD COLUMN）:');
      for (const c of missingColumns.slice(0, 50)) console.log(`  - ${c}`);
      if (missingColumns.length > 50) console.log(`  … 共 ${missingColumns.length} 条`);
    }

    if (missingTables.length > 0 || missingColumns.length > 0) {
      console.error('\n❌ MIGRATION GAP DETECTED — 发布前必须补齐缺失迁移。');
      process.exit(1);
    }
    console.log('\n✅ MIGRATION GAP CHECK PASSED — 迁移链与生产库一致。');
  } finally {
    await sql.end();
  }
})();
