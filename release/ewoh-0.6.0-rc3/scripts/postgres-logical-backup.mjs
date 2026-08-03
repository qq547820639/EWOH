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
