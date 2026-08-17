#!/usr/bin/env node
/* EWOH PostgreSQL logical backup/restore for standalone deployments.
 *
 * This is a local operational tool for disposable drills and managed backups.
 * It exports every ewoh_* base table in public schema to one JSON manifest and
 * restores it into an already-migrated database with ON CONFLICT DO NOTHING.
 * Identity columns are inserted with OVERRIDING SYSTEM VALUE and their
 * sequences are advanced after restore.
 */

import fs from 'node:fs';
import postgres from '../ewoh-spark-app/node_modules/postgres/src/index.js';

const FORMAT = 'ewoh-postgres-logical-backup-v1';
const BATCH_SIZE = 100;
// R2-SCR-005：manifest 中的表名/列名属于外部输入（备份制品可被篡改），标识符无法参数化，
// 必须先过白名单正则 ^[a-zA-Z_][a-zA-Z0-9_]*$ 且存在于目标库已知 schema 集合内，非法即 fail-closed 报错退出。
const IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function parseArgs() {
  const args = process.argv.slice(2);
  const options = { action: '', url: '', out: '', in: '' };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--action') options.action = args[++index] ?? '';
    else if (arg === '--url') options.url = args[++index] ?? '';
    else if (arg === '--out') options.out = args[++index] ?? '';
    else if (arg === '--in') options.in = args[++index] ?? '';
  }
  if (!['backup', 'restore', 'verify'].includes(options.action)) {
    throw new Error('--action must be backup, restore, or verify');
  }
  if (!options.url) throw new Error('--url is required');
  if (options.action === 'backup' && !options.out) {
    throw new Error('--out is required for backup');
  }
  if (['restore', 'verify'].includes(options.action) && !options.in) {
    throw new Error('--in is required for restore/verify');
  }
  return options;
}

async function listTables(sql) {
  const rows = await sql`
    select table_name
    from information_schema.tables
    where table_schema = 'public'
      and table_type = 'BASE TABLE'
      and table_name like 'ewoh\_%'
    order by table_name
  `;
  return rows.map((row) => row.table_name);
}

async function identityColumns(sql, table) {
  const rows = await sql`
    select column_name
    from information_schema.columns
    where table_schema = 'public'
      and table_name = ${table}
      and is_identity = 'YES'
    order by ordinal_position
  `;
  return rows.map((row) => row.column_name);
}

// R2-SCR-005：查询目标库某表的实际列名集合，用于与 manifest 列名比对（拦截白名单正则内但库中不存在的伪造列）。
async function tableColumns(sql, table) {
  const rows = await sql`
    select column_name
    from information_schema.columns
    where table_schema = 'public'
      and table_name = ${table}
    order by ordinal_position
  `;
  return new Set(rows.map((row) => row.column_name));
}

// R2-SCR-005：restore/verify 前统一校验 manifest 标识符（表名/列名）。
// 校验失败直接抛错终止（fail-closed），绝不静默跳过被篡改的表/列。
async function validateManifestIdentifiers(sql, manifest) {
  if (!manifest || typeof manifest !== 'object' || manifest.tables === null
      || typeof manifest.tables !== 'object' || Array.isArray(manifest.tables)) {
    throw new Error('backup manifest has no valid tables object');
  }
  const knownTables = new Set(await listTables(sql));
  for (const [table, rows] of Object.entries(manifest.tables)) {
    if (!IDENTIFIER_PATTERN.test(table) || !knownTables.has(table)) {
      throw new Error(
        `illegal table identifier in backup manifest: ${JSON.stringify(table)}`,
      );
    }
    if (!Array.isArray(rows)) {
      throw new Error(`backup manifest rows for ${table} must be an array`);
    }
    if (rows.length === 0) continue;
    const knownColumns = await tableColumns(sql, table);
    for (const column of Object.keys(rows[0])) {
      if (!IDENTIFIER_PATTERN.test(column) || !knownColumns.has(column)) {
        throw new Error(
          `illegal column identifier in backup manifest: ` +
            `${JSON.stringify(column)} (table ${table})`,
        );
      }
    }
  }
}

async function readManifest(path) {
  const manifest = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (manifest.format !== FORMAT) {
    throw new Error(`unsupported backup format: ${manifest.format}`);
  }
  return manifest;
}

async function backup(sql, out) {
  const tables = await listTables(sql);
  const manifest = {
    format: FORMAT,
    exportedAt: new Date().toISOString(),
    tables: {},
  };
  for (const table of tables) {
    manifest.tables[table] = await sql.unsafe(`select * from public.${table}`);
  }
  fs.writeFileSync(out, `${JSON.stringify(manifest)}\n`);
  console.log(`backup written: ${out} (${tables.length} tables)`);
  return manifest;
}

async function restore(sql, manifest) {
  const restored = {};
  for (const [table, rows] of Object.entries(manifest.tables)) {
    if (!Array.isArray(rows) || rows.length === 0) {
      restored[table] = 0;
      continue;
    }
    const identities = await identityColumns(sql, table);
    const columns = Object.keys(rows[0]);
    if (columns.length === 0) {
      throw new Error(`table ${table} has no columns in backup`);
    }
    const columnSql = columns.map((column) => `"${column}"`).join(', ');
    const overriding = identities.length > 0 ? 'OVERRIDING SYSTEM VALUE' : '';
    let inserted = 0;
    for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
      const batch = rows.slice(offset, offset + BATCH_SIZE);
      const placeholders = batch
        .map((_, rowIndex) =>
          columns
            .map(
              (_, columnIndex) =>
                `$${rowIndex * columns.length + columnIndex + 1}`,
            )
            .join(', '),
        )
        .map((rowPlaceholders) => `(${rowPlaceholders})`)
        .join(', ');
      const values = batch.flatMap((row) =>
        columns.map((column) => row[column]),
      );
      await sql.unsafe(
        `insert into public.${table} (${columnSql}) ${overriding} values ${placeholders} on conflict do nothing`,
        values,
      );
      inserted += batch.length;
    }
    for (const identity of identities) {
      await sql.unsafe(
        `select setval(
           pg_get_serial_sequence('public.${table}', '${identity}'),
           coalesce((select max("${identity}") from public.${table}), 1),
           true
         )`,
      );
    }
    restored[table] = inserted;
  }
  return restored;
}

async function counts(sql, tables) {
  const result = {};
  for (const table of tables) {
    const [row] = await sql.unsafe(
      `select count(*)::int as c from public.${table}`,
    );
    result[table] = Number(row.c);
  }
  return result;
}

async function main() {
  const options = parseArgs();
  const sql = postgres(options.url, { max: 4, idle_timeout: 30_000 });
  try {
    if (options.action === 'backup') {
      await backup(sql, options.out);
      return;
    }
    const manifest = await readManifest(options.in);
    // R2-SCR-005：restore/verify 消费外部备份文件前先做标识符白名单+schema 集合校验，非法即抛错退出。
    await validateManifestIdentifiers(sql, manifest);
    if (options.action === 'restore') {
      const restored = await restore(sql, manifest);
      const expected = Object.fromEntries(
        Object.entries(manifest.tables).map(([table, rows]) => [
          table,
          rows.length,
        ]),
      );
      const mismatches = Object.keys(expected).filter(
        (table) => restored[table] !== expected[table],
      );
      if (mismatches.length > 0) {
        throw new Error(
          `restore count mismatch: ${mismatches.join(', ')}; ` +
            `expected=${JSON.stringify(expected)} restored=${JSON.stringify(restored)}`,
        );
      }
      console.log(
        `restore complete: ${Object.keys(restored).length} tables, ` +
          `${Object.values(restored).reduce((sum, n) => sum + n, 0)} rows`,
      );
      return;
    }
    const current = await counts(sql, Object.keys(manifest.tables));
    const mismatches = Object.entries(manifest.tables).filter(
      ([table, rows]) => current[table] !== rows.length,
    );
    if (mismatches.length > 0) {
      throw new Error(
        `verify mismatch: ${mismatches.map(([table]) => table).join(', ')}`,
      );
    }
    console.log(`verify complete: ${Object.keys(current).length} tables`);
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
