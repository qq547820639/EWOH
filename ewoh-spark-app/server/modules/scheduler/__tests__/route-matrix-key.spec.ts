/* Task 4 / P0-4：Route matrix DB 全键唯一 — 静态断言 migration SQL。
 *
 * 覆盖：standalone_026_route_cost_matrix_full_key.sql 含 ADD COLUMN IF NOT EXISTS
 * （route_graph_version / candidate_set_hash）、全键复合唯一索引
 * uq_ewoh_route_cost_matrix_full_key（WHERE candidate_set_hash IS NOT NULL 部分唯一，
 * 兼容存量 NULL 行），且不删除旧索引；rollback 幂等；verify 断言唯一性。
 * 逻辑缓存 key（不同 policyVersion/candidateSetHash 不复用矩阵）由 travel-cost.spec.ts
 * 既有用例覆盖，本文件不重复。
 */
/// <reference types="jest" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..');
const MIGRATION = readFileSync(
  join(REPO_ROOT, 'db/migrations/standalone_026_route_cost_matrix_full_key.sql'),
  'utf8',
);
const ROLLBACK = readFileSync(
  join(REPO_ROOT, 'db/migrations/standalone_026_route_cost_matrix_full_key.rollback.sql'),
  'utf8',
);
const VERIFY = readFileSync(
  join(REPO_ROOT, 'db/verify/standalone_026_route_cost_matrix_full_key.verify.sql'),
  'utf8',
);

describe('Task 4 / P0-4: Route matrix DB 全键唯一 migration', () => {
  it('migration 含全键唯一索引（5 维 + 部分唯一 WHERE candidate_set_hash IS NOT NULL）', () => {
    expect(MIGRATION).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS uq_ewoh_route_cost_matrix_full_key',
    );
    expect(MIGRATION).toContain(
      '(task_id, snapshot_version, policy_version, route_graph_version, candidate_set_hash)',
    );
    expect(MIGRATION).toContain('WHERE candidate_set_hash IS NOT NULL');
  });

  it('migration 幂等补列 route_graph_version / candidate_set_hash（ADD COLUMN IF NOT EXISTS）', () => {
    expect(MIGRATION).toContain('ADD COLUMN IF NOT EXISTS route_graph_version');
    expect(MIGRATION).toContain('ADD COLUMN IF NOT EXISTS candidate_set_hash');
  });

  it('保留旧索引：migration 不含 DROP INDEX', () => {
    expect(MIGRATION).not.toContain('DROP INDEX');
  });

  it('rollback 幂等 drop 全键索引', () => {
    expect(ROLLBACK).toContain('DROP INDEX IF EXISTS');
    expect(ROLLBACK).toContain('uq_ewoh_route_cost_matrix_full_key');
  });

  it('verify 断言索引存在且唯一（pg_index.indisunique + RAISE EXCEPTION）', () => {
    expect(VERIFY).toContain('uq_ewoh_route_cost_matrix_full_key');
    expect(VERIFY).toContain('indisunique');
    expect(VERIFY).toContain('RAISE EXCEPTION');
  });
});
