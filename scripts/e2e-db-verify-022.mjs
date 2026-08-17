#!/usr/bin/env node
/**
 * P0-7 022 DB 契约验证（单发，运行到结束）。
 * 017 建表 → 009 EXCLUDE → 022 拆分 → verify → 行为断言 → rollback（空表）→ re-apply。
 * 全程 postgres.js + runner，不依赖 psql/createdb。
 */
'use strict';
// SCR-004: 路径参数化——ROOT 从脚本位置推导；embedded-postgres 依赖目录优先
// EWOH_EMBEDDED_PG_DIR env，缺省回退 ~/.workbuddy（仓内未安装该依赖）；node 用 process.execPath。
import { createRequire } from 'module';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EMBEDDED_PG_DIR = process.env.EWOH_EMBEDDED_PG_DIR || path.join(os.homedir(), '.workbuddy/binaries/node/workspace');
const requireFromWs = createRequire(path.join(EMBEDDED_PG_DIR, 'package.json'));
const EmbeddedPostgres = requireFromWs('embedded-postgres').default || requireFromWs('embedded-postgres');

const APP = path.join(ROOT, 'ewoh-spark-app');
const PG_PORT = Number(process.env.EWOH_E2E_PG_PORT || 15438);
const PG_PASS = 'ewohp0';
const PG_DIR = '/tmp/ewoh-pg-verify-022-final';
const DB_NAME = 'ewoh_verify';
const NODE = process.execPath;
const RUNNER = path.join(ROOT, 'db/runner/run_migrations.js');
const URL = `postgresql://postgres:${PG_PASS}@127.0.0.1:${PG_PORT}/${DB_NAME}`;

function run(cmd) {
  process.stdout.write(`\n>>> ${cmd}\n`);
  const out = execSync(cmd, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 180000,
    env: { ...process.env, EWOH_DATABASE_URL: URL, EWOH_ALLOW_DDL: '1', EWOH_ALLOW_DESTRUCTIVE_ROLLBACK: '1' },
  });
  const tail = out.trim().split('\n').slice(-3).join('\n');
  process.stdout.write(`${tail}\n`);
}

async function main() {
  fs.rmSync(PG_DIR, { recursive: true, force: true });
  fs.mkdirSync(PG_DIR, { recursive: true });
  const pg = new EmbeddedPostgres({
    databaseDir: PG_DIR, user: 'postgres', password: PG_PASS, port: PG_PORT, persistent: false,
  });
  process.stdout.write('=== 1. 启动嵌入式 PostgreSQL ===\n');
  await pg.initialise();
  await pg.start();

  const { createRequire: cr } = await import('module');
  const req = cr(path.join(APP, 'package.json'));
  const postgres = req('postgres');
  const admin = postgres(`postgresql://postgres:${PG_PASS}@127.0.0.1:${PG_PORT}/postgres`, { max: 1 });
  const dbExists = await admin`SELECT 1 FROM pg_database WHERE datname=${DB_NAME}`;
  if (dbExists.length === 0) await admin.unsafe(`CREATE DATABASE ${DB_NAME}`);
  await admin.unsafe(`DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END $do$`);
  await admin.end();
  process.stdout.write('DB + service_role ready\n');

  run(`${NODE} ${RUNNER} --apply-standalone-scheduling-tables-fix`);
  run(`${NODE} ${RUNNER} --apply-standalone-reservation-conflict`);
  run(`${NODE} ${RUNNER} --apply-standalone-reservation-capacity`);
  run(`${NODE} ${RUNNER} --verify-standalone-reservation-capacity`);

  const sql = postgres(URL, { max: 1 });

  process.stdout.write('\n=== 约束定义（022 生效）===\n');
  const defs = await sql`SELECT c.conname, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c WHERE c.conrelid='public.ewoh_resource_reservation'::regclass ORDER BY c.conname`;
  for (const d of defs) process.stdout.write(`${d.conname} => ${d.def}\n`);

  process.stdout.write('\n=== 可回滚性（空表 rollback → 旧全类型 EXCLUDE 恢复）===\n');
  run(`${NODE} ${RUNNER} --rollback-standalone-reservation-capacity`);
  const afterRb = await sql`SELECT c.conname FROM pg_constraint c WHERE c.conrelid='public.ewoh_resource_reservation'::regclass ORDER BY c.conname`;
  if (!afterRb.some((r) => r.conname === 'ewoh_resource_reservation_no_overlap')) {
    throw new Error('rollback did not restore unfiltered EXCLUDE');
  }
  process.stdout.write('ROLLBACK_OK: 旧全类型 EXCLUDE 已恢复\n');
  const defsRb = await sql`SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c WHERE c.conname='ewoh_resource_reservation_no_overlap' AND c.conrelid='public.ewoh_resource_reservation'::regclass`;
  process.stdout.write(`rollback def => ${defsRb[0]?.def ?? 'N/A'}\n`);

  process.stdout.write('\n=== re-apply 022 + verify（闭环）===\n');
  run(`${NODE} ${RUNNER} --apply-standalone-reservation-capacity`);
  run(`${NODE} ${RUNNER} --verify-standalone-reservation-capacity`);

  process.stdout.write('\n=== 行为断言（022 生效下）===\n');
  await sql`INSERT INTO public.ewoh_resource_reservation (reservation_id, resource_type, resource_id, assignment_id, plan_id, task_id, start_ms, end_ms, status, version, org_id, created_by)
    VALUES ('RSV-CAP-1','station','S1','ASN-1','PLAN-1','T-1',1000,2000,'reserved',1,'org1','u1'),
           ('RSV-CAP-2','station','S1','ASN-2','PLAN-1','T-2',1500,2500,'reserved',1,'org1','u1')`;
  const s = await sql`SELECT count(*)::int AS n FROM public.ewoh_resource_reservation WHERE resource_type='station' AND resource_id='S1'`;
  if (s[0].n !== 2) throw new Error(`station overlap rejected (n=${s[0].n})`);
  process.stdout.write(`STATION_OK: 容量>1 工位重叠预占成功（2 行）\n`);

  await sql`INSERT INTO public.ewoh_resource_reservation (reservation_id, resource_type, resource_id, assignment_id, plan_id, task_id, start_ms, end_ms, status, version, org_id, created_by)
    VALUES ('RSV-P1','person','P1','ASN-1','PLAN-1','T-1',1000,2000,'reserved',1,'org1','u1')`;
  let rejected = false;
  try {
    await sql`INSERT INTO public.ewoh_resource_reservation (reservation_id, resource_type, resource_id, assignment_id, plan_id, task_id, start_ms, end_ms, status, version, org_id, created_by)
      VALUES ('RSV-P2','person','P1','ASN-2','PLAN-1','T-2',1500,2500,'reserved',1,'org1','u1')`;
  } catch (e) { rejected = /exclusion|23P01|overlap/i.test(String(e.message || e)); }
  if (!rejected) throw new Error('person overlap NOT rejected by EXCLUDE');
  process.stdout.write('PERSON_OK: person 重叠被 DB EXCLUDE 拒绝（二值硬后盾保留）\n');

  await sql.end();
  try { await pg.stop(); } catch (_e) {}
  process.stdout.write('\n✅ 022 DB 验证全部通过\n');
}

main().catch((err) => { process.stderr.write(`❌ 022 DB 验证失败: ${err && (err.message || err)}\n`); process.exitCode = 1; });
