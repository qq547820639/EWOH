/* D2.1：Scheduler DB RLS policy 静态审计（standalone_025_scheduler_rls）
 *
 * 背景（Task 1，Scheduler DB RLS audit/fix + 覆盖）：
 *   - standalone_023 对 ewoh_scheduling_constraint 启用了 RLS，但其 policy
 *     scheduler_constraint_org_isolation 读取 current_setting('app.primary_org_id')，
 *     而应用实际设置的 GUC 是 app.current_org_id（org-context.interceptor.ts
 *     buildGucSettings）→ 真实 PG 下该 policy 过滤掉全部 org 行（GUC 未设置 → NULL）。
 *   - standalone_025 修复该 GUC 名不一致（COALESCE + NULLIF 回退旧名），并对 8 张
 *     org-scoped 调度表启用 RLS（scheduler_<table>_org_isolation）。
 *   - ewoh_outbox / ewoh_world_state_snapshot / ewoh_assignment_event 保持非 RLS
 *     （全局 sequence/版本键语义 + 应用层 org 过滤 + 既有审计测试覆盖）。
 *
 * 本测试为纯静态断言（复用 rls-org-filter.audit.spec.ts 的 fs+path 模式，无 DB 依赖）：
 *   a) 025 migration 对每张应启用表包含 ENABLE ROW LEVEL SECURITY；
 *   b) 每个 policy 定义包含 app.current_org_id，且 app.primary_org_id 仅以
 *      NULLIF 包裹的 COALESCE 回退形式出现（无裸引用）；
 *   c) GUC 一致性：policy 引用的 GUC 名 ⊆ buildGucSettings 设置的 GUC 名集合
 *      （app.primary_org_id 为 023 兼容回退豁免）。
 * 另含 cross-org 语义用例：证明约束/方案/预约读路径的应用层 org 隔离点仍在
 * （RLS 作为 DB 层兜底，不替代应用层过滤）。
 */
/// <reference types="jest" />
import * as fs from 'fs';
import * as path from 'path';

/** 仓库根（__tests__ → scheduler → modules → server → ewoh-spark-app → EWOH）。 */
const ROOT = path.resolve(__dirname, '../../../../../');
const MIGRATION_PATH = path.join(ROOT, 'db/migrations/standalone_025_scheduler_rls.sql');
const INTERCEPTOR_PATH = path.join(
  ROOT,
  'ewoh-spark-app/server/modules/shared/org-context.interceptor.ts',
);
const SCHEDULER_DIR = path.join(ROOT, 'ewoh-spark-app/server/modules/scheduler');

/** 025 覆盖的 org-scoped 表（SQL 表名 → policy 名，与 023 命名风格一致）。 */
const ORG_SCOPED_RLS_TABLES: ReadonlyArray<{ sql: string; policy: string }> = [
  { sql: 'ewoh_scheduling_run', policy: 'scheduler_run_org_isolation' },
  { sql: 'ewoh_schedule_plan', policy: 'scheduler_plan_org_isolation' },
  { sql: 'ewoh_scheduling_plan_assignment', policy: 'scheduler_plan_assignment_org_isolation' },
  { sql: 'ewoh_resource_reservation', policy: 'scheduler_resource_reservation_org_isolation' },
  { sql: 'ewoh_scheduling_policy', policy: 'scheduler_policy_org_isolation' },
  { sql: 'ewoh_scheduling_feedback', policy: 'scheduler_feedback_org_isolation' },
  { sql: 'ewoh_replan_trigger', policy: 'scheduler_replan_trigger_org_isolation' },
  { sql: 'ewoh_scheduling_constraint', policy: 'scheduler_constraint_org_isolation' },
];

/** 提取 migration 中的 policy 定义块（CREATE POLICY ... 到首个语句分号）。 */
function extractPolicyBlocks(
  text: string,
): Array<{ policy: string; table: string; body: string }> {
  const blocks: Array<{ policy: string; table: string; body: string }> = [];
  const re = /CREATE POLICY\s+(\w+)\s+ON\s+__EWOH_SCHEMA__\.(\w+)([\s\S]*?);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    blocks.push({ policy: m[1], table: m[2], body: m[3] });
  }
  return blocks;
}

/** 提取某源文件中指定方法的文本（到下一个 2 空格缩进成员声明或文件尾）。 */
function extractMethodText(source: string, methodName: string): string {
  const re = new RegExp(
    `\\n  (?:async )?${methodName}\\([\\s\\S]*?(?=\\n  (?:async |private |protected |public |get |set )|$)`,
  );
  const m = source.match(re);
  return m ? m[0] : '';
}

describe('D2.1 Scheduler DB RLS policy 静态审计（standalone_025）', () => {
  const migration = fs.readFileSync(MIGRATION_PATH, 'utf8');
  const interceptorSource = fs.readFileSync(INTERCEPTOR_PATH, 'utf8');

  it('a) 025 对每张应启用表包含 ENABLE ROW LEVEL SECURITY', () => {
    for (const t of ORG_SCOPED_RLS_TABLES) {
      expect(migration).toContain(`ALTER TABLE __EWOH_SCHEMA__.${t.sql} ENABLE ROW LEVEL SECURITY;`);
    }
  });

  it('b) 每个 policy 定义引用 app.current_org_id；app.primary_org_id 仅作为 COALESCE 回退（NULLIF 包裹）', () => {
    const blocks = extractPolicyBlocks(migration);
    // 8 张表各 1 条 policy（023 的 constraint policy 在 025 中重建，仍在清单内）
    for (const t of ORG_SCOPED_RLS_TABLES) {
      const block = blocks.find((b) => b.table === t.sql && b.policy === t.policy);
      expect(block).toBeDefined();
      if (!block) continue;
      // 至少引用 app.current_org_id（USING 或 WITH CHECK）
      expect(block.body).toContain('app.current_org_id');
      // 所有 app.primary_org_id 引用必须被 NULLIF(current_setting(...)) 包裹（COALESCE 回退内），
      // 不允许裸引用（023 的 bug 形式 org_id = current_setting('app.primary_org_id', true)）。
      const bareRefs = block.body.match(/current_setting\('app\.primary_org_id', true\)/g) ?? [];
      const nullifWrapped =
        block.body.match(/NULLIF\(current_setting\('app\.primary_org_id', true\)/g) ?? [];
      expect(bareRefs.length).toBe(nullifWrapped.length);
    }
  });

  it('c) GUC 一致性：policy 引用的 GUC 名 ⊆ buildGucSettings 设置集合（primary_org_id 回退豁免）', () => {
    // buildGucSettings 设置的 GUC 名（interceptor 源码文本）
    const setGucs = new Set(
      Array.from(interceptorSource.matchAll(/name: 'app\.[a-z_]+'/g), (m) =>
        m[0].replace(/^name: '/, '').replace(/'$/, ''),
      ),
    );
    expect(setGucs.size).toBeGreaterThan(0);
    // policy 引用的 GUC 名（migration 文本）
    const policyGucs = new Set(
      Array.from(migration.matchAll(/app\.[a-z_]+/g), (m) => m[0]),
    );
    const unexpected = [...policyGucs].filter(
      (g) => g !== 'app.primary_org_id' && !setGucs.has(g),
    );
    expect(unexpected).toEqual([]);
    // 主 GUC 必须是应用设置的 current_org_id（023 修复核心）
    expect(policyGucs.has('app.current_org_id')).toBe(true);
  });

  it('cross-org：约束读路径查询级 org 过滤仍在应用层生效（RLS 为 DB 层兜底）', () => {
    // ConstraintLoaderService 是持久化约束的唯一加载入口；查询级 org 过滤（.orgId）仍存在。
    const loader = fs.readFileSync(path.join(SCHEDULER_DIR, 'constraint-loader.service.ts'), 'utf8');
    const orgFilters = loader.match(/eq\(ewohSchedulingConstraint\.orgId, orgId\)/g) ?? [];
    // loadGlobalActive + loadForPlan 两个读路径
    expect(orgFilters.length).toBeGreaterThanOrEqual(2);
  });

  it('cross-org：预约写路径 org 感知仍在应用层（GUC 事务 + org_id 归属列写入）', () => {
    const res = fs.readFileSync(
      path.join(SCHEDULER_DIR, 'resource-reservation.service.ts'),
      'utf8',
    );
    const reserve = extractMethodText(res, 'reserve');
    // reserve 在 GUC 事务内执行（buildGucSettings 设置 app.current_org_id，RLS 启用后生效）
    expect(reserve).toContain('buildGucSettings(ctx)');
    // 归属列写入：orgId = ctx.primaryOrgId（RLS 的 WITH CHECK 依赖该列）
    expect(reserve).toContain('orgId: ctx.primaryOrgId');
  });

  it('cross-org：方案读路径由 025 新增 RLS 兜底（org_id 列 + policy），应用层维持键查询语义', () => {
    // ewoh_schedule_plan 此前无 org_id 列（schema.ts 无该字段）——025 补齐列并启用 RLS。
    expect(migration).toContain(
      'ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan\n  ADD COLUMN IF NOT EXISTS org_id varchar(255);',
    );
    expect(migration).toContain(
      'ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan ENABLE ROW LEVEL SECURITY;',
    );
    // 方案读路径仍为受控查询：planId 键查询或状态白名单（不引入无过滤全表暴露；
    // 存量/全局行由 policy 的 org_id IS NULL 分支放行，新写入行带 org_id 后由 RLS 隔离）。
    const planService = fs.readFileSync(path.join(SCHEDULER_DIR, 'plan.service.ts'), 'utf8');
    for (const m of ['getPlan', 'listActivePlans', 'approvePlan', 'rejectPlan']) {
      const text = extractMethodText(planService, m);
      expect(text.length).toBeGreaterThan(0);
      const hasKeyGuard = text.includes('planId') || text.includes('activeStatuses');
      expect(hasKeyGuard).toBe(true);
    }
  });
});
