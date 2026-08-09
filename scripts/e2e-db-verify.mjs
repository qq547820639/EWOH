#!/usr/bin/env node
/**
 * Phase 0 DB 真实验证：嵌入式 PostgreSQL 上执行 scheduler migrations
 * apply → verify → rollback → re-apply（standalone_012~016 + 前置链）。
 *
 * 用法：NODE_PATH=... node scripts/e2e-db-verify.mjs
 */
'use strict';

import { createRequire } from 'module';
const requireFromWs = createRequire('/Users/panhao/.workbuddy/binaries/node/workspace/package.json');
const EmbeddedPostgres = requireFromWs('embedded-postgres').default || requireFromWs('embedded-postgres');

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const ROOT = '/Volumes/Extra/CodeProj/EWOH';
const PG_PORT = 15432;
const PG_DIR = '/tmp/ewoh-pg-verify';
const DB_NAME = 'ewoh_verify';
const SCHEMA = 'workspace_aadknm4yzbyds';
const RUNNER = path.join(ROOT, 'db/runner/run_migrations.js');

function run(cmd, env = {}) {
  console.log(`\n>>> ${cmd}`);
  const out = execSync(cmd, {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${PG_DIR}/bin:${process.env.PATH || ''}`,
      EWOH_DATABASE_URL: `postgresql://postgres@127.0.0.1:${PG_PORT}/${DB_NAME}`,
      EWOH_SCHEMA: SCHEMA,
      EWOH_ALLOW_DDL: '1',
      ...env,
    },
  });
  console.log(out.split('\n').slice(-6).join('\n'));
  return out;
}

async function main() {
  fs.rmSync(PG_DIR, { recursive: true, force: true });
  fs.mkdirSync(PG_DIR, { recursive: true });

  console.log('=== 1. 启动嵌入式 PostgreSQL ===');
  const pg = new EmbeddedPostgres({
    databaseDir: PG_DIR,
    user: 'postgres',
    password: '',
    port: PG_PORT,
    persistent: false,
  });
  await pg.initialise();
  await pg.start();

  // 建库
  execSync(`${PG_DIR}/bin/createdb -p ${PG_PORT} -U postgres ${DB_NAME}`, { stdio: 'inherit' });
  console.log('database created:', DB_NAME);

  // 建 service_role（migrations GRANT 目标）
  execSync(
    `${PG_DIR}/bin/psql -p ${PG_PORT} -U postgres -d ${DB_NAME} -c "DO \\\$\\\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END \\\$\\\$;"`,
    { stdio: 'inherit' },
  );
  console.log('service_role ready');

  const NODE = '/Users/panhao/.workbuddy/binaries/node/versions/22.22.2/bin/node';

  console.log('\n=== 2. apply 前置链（001 schema / 003 role / 004 domain / 005 / 006 scheduling / 009 / 010 / 011）===');
  run(`${NODE} ${RUNNER} --apply-standalone`);
  run(`${NODE} ${RUNNER} --apply-standalone-runtime-role`);
  run(`${NODE} ${RUNNER} --apply-standalone-domain`);
  run(`${NODE} ${RUNNER} --apply-standalone-workbench-prod`);
  run(`${NODE} ${RUNNER} --apply-standalone-scheduling`);
  run(`${NODE} ${RUNNER} --apply-standalone-reservation-conflict`);
  run(`${NODE} ${RUNNER} --apply-standalone-scheduling-feedback`);
  run(`${NODE} ${RUNNER} --apply-standalone-outbox-sequence`);

  console.log('\n=== 3. apply 012~016 ===');
  run(`${NODE} ${RUNNER} --apply-standalone-domain-columns`);
  run(`${NODE} ${RUNNER} --apply-standalone-conflict-lifecycle`);
  run(`${NODE} ${RUNNER} --apply-standalone-policy-weights`);
  run(`${NODE} ${RUNNER} --apply-standalone-route-cost-matrix`);
  run(`${NODE} ${RUNNER} --apply-standalone-task-requirement`);

  console.log('\n=== 4. verify 012~016 ===');
  run(`${NODE} ${RUNNER} --verify-standalone-domain-columns`);
  run(`${NODE} ${RUNNER} --verify-standalone-conflict-lifecycle`);
  run(`${NODE} ${RUNNER} --verify-standalone-policy-weights`);
  run(`${NODE} ${RUNNER} --verify-standalone-route-cost-matrix`);
  run(`${NODE} ${RUNNER} --verify-standalone-task-requirement`);

  console.log('\n=== 5. rollback 016 → 再 apply 016 → verify（可回滚性验证）===');
  run(`${NODE} ${RUNNER} --rollback-standalone-task-requirement`);
  run(`${NODE} ${RUNNER} --apply-standalone-task-requirement`);
  run(`${NODE} ${RUNNER} --verify-standalone-task-requirement`);

  console.log('\n=== 5b. 022 reservation capacity：apply → verify → rollback → re-apply → verify（P0-7）===');
  run(`${NODE} ${RUNNER} --apply-standalone-reservation-capacity`);
  run(`${NODE} ${RUNNER} --verify-standalone-reservation-capacity`);
  run(`${NODE} ${RUNNER} --rollback-standalone-reservation-capacity`);
  run(`${NODE} ${RUNNER} --apply-standalone-reservation-capacity`);
  run(`${NODE} ${RUNNER} --verify-standalone-reservation-capacity`);

  console.log('\n=== 6. backfill 数据验证（016）===');
  const backfillCheck = execSync(
    `${PG_DIR}/bin/psql -p ${PG_PORT} -U postgres -d ${DB_NAME} -t -A -c "SELECT count(*) FROM ${SCHEMA}.ewoh_production_task WHERE required_device_capabilities IS NULL;"`,
    { encoding: 'utf8' },
  ).trim();
  console.log('required_device_capabilities NULL rows:', backfillCheck);

  console.log('\n=== 7. 关键表/列冒烟 ===');
  const cols = execSync(
    `${PG_DIR}/bin/psql -p ${PG_PORT} -U postgres -d ${DB_NAME} -t -A -c "SELECT column_name FROM information_schema.columns WHERE table_schema='${SCHEMA}' AND table_name='ewoh_production_task' AND column_name IN ('required_device_capabilities','candidate_stations','required_skills','required_certifications','predecessor_ids') ORDER BY column_name;"`,
    { encoding: 'utf8' },
  ).trim();
  console.log('production_task TaskRequirement 列:', cols.replace(/\n/g, ', '));

  const conflictCols = execSync(
    `${PG_DIR}/bin/psql -p ${PG_PORT} -U postgres -d ${DB_NAME} -t -A -c "SELECT column_name FROM information_schema.columns WHERE table_schema='${SCHEMA}' AND table_name='ewoh_scheduling_conflict' ORDER BY ordinal_position;"`,
    { encoding: 'utf8' },
  ).trim();
  console.log('conflict 表列:', conflictCols.replace(/\n/g, ', '));

  console.log('\n=== 8. 停止 PG ===');
  await pg.stop();
  console.log('\n✅ DB 验证全部通过');
}

main().catch((err) => {
  console.error('❌ DB 验证失败:', err);
  process.exitCode = 1;
});
