-- EWOH AgentTask 编排注册表 (standalone_038, ADR-017 / NO-06f, Phase 9)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS /
--            DROP POLICY IF EXISTS / ENABLE ROW LEVEL SECURITY（幂等可重复执行）。
--
-- 背景（ADR-017 AgentTask 契约，contracts/agent_task/agent-task.schema.json）：
--   1) ewoh_agent_task：结构化编排任务持久化——创建唯一入口（云侧
--      AgentOrchestratorService.createTask 先经 validateAgentTask 契约校验
--      fail-closed 再落库）；状态推进唯一写者 = AgentOrchestratorService
--      （created→dispatched→in_progress→completed/failed；cancelled 仅从
--      非终态——转移由服务层状态机（contracts/state-machines/agent-task.yaml）
--      判定 + DB CHECK 守护枚举）；
--   2) 租户边界：TENANT_SCOPED（org_id NOT NULL + RLS agent_task_org_isolation
--      读 app.current_org_id，与 standalone_025 同 idiom）；业务键唯一约束在
--      (org_id, task_id)；
--   3) 依赖门控：dependencies 为规范身份数组（DAG 自引用由契约层拒绝）；
--      跨任务环检测与依赖未 completed 不得 dispatch 由编排服务 fail-closed。
--
-- 回滚语义：表为全新（additive）；回滚 = DROP TABLE（索引/约束/RLS 策略随表级联）。
--   回滚后编排写入将失败（fail-closed，不静默降级）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

-- ============================================================================
-- 1) ewoh_agent_task：结构化编排任务（TENANT_SCOPED，RLS 强制租户隔离）。
-- ============================================================================
CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_agent_task (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar(255) NOT NULL,
  task_id varchar(180) NOT NULL,
  name varchar(255) NOT NULL,
  version integer NOT NULL DEFAULT 1,
  kind varchar(24) NOT NULL,
  assigned_role varchar(64) NOT NULL,
  assignee_agent_id varchar(180),
  dependencies jsonb NOT NULL DEFAULT '[]'::jsonb,
  priority varchar(16) NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'created',
  due_time timestamptz,
  budget jsonb NOT NULL DEFAULT '{"maxSteps":1,"maxTokens":1,"maxDurationSec":1}'::jsonb,
  correlation_id varchar(255),
  input_contract jsonb,
  output_contract jsonb,
  task_json jsonb NOT NULL,
  _created_at timestamptz NOT NULL DEFAULT now(),
  _updated_at timestamptz NOT NULL DEFAULT now(),
  _created_by uuid,
  _updated_by uuid,
  CONSTRAINT chk_ewoh_agent_task_kind
    CHECK (kind IN ('analysis', 'suggestion', 'execution')),
  CONSTRAINT chk_ewoh_agent_task_priority
    CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  CONSTRAINT chk_ewoh_agent_task_status
    CHECK (status IN ('created', 'dispatched', 'in_progress', 'completed', 'failed', 'cancelled')),
  CONSTRAINT chk_ewoh_agent_task_version CHECK (version >= 1),
  CONSTRAINT uq_ewoh_agent_task UNIQUE (org_id, task_id)
);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_agent_task IS
  '结构化编排任务（ADR-017/NO-06f）。创建唯一入口：validateAgentTask 契约校验 fail-closed 后落库；状态推进唯一写者=AgentOrchestratorService（状态机 contracts/state-machines/agent-task.yaml，DB CHECK 守护枚举）。TENANT_SCOPED（RLS agent_task_org_isolation）。依赖门控（未 completed 不得 dispatch/环检测）由编排服务 fail-closed。';

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_agent_task.dependencies IS '依赖任务规范身份数组（DAG；自引用由契约层拒绝，跨任务环由编排服务检测）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_agent_task.status IS 'created/dispatched/in_progress/completed/failed/cancelled（转移经状态机 yaml + 服务 CAS）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_agent_task.task_json IS '完整契约快照（审计同源，含 budget/correlationId/契约引用）';

CREATE INDEX IF NOT EXISTS idx_ewoh_agent_task_role_status
  ON __EWOH_SCHEMA__.ewoh_agent_task (org_id, assigned_role, status);
CREATE INDEX IF NOT EXISTS idx_ewoh_agent_task_due
  ON __EWOH_SCHEMA__.ewoh_agent_task (org_id, due_time);

-- ============================================================================
-- 2) RLS：TENANT_SCOPED 隔离（与 standalone_025 同 idiom：读 app.current_org_id，
--    旧名 app.primary_org_id 仅在未设置新名时回退）。
-- ============================================================================
ALTER TABLE __EWOH_SCHEMA__.ewoh_agent_task ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_task_org_isolation
  ON __EWOH_SCHEMA__.ewoh_agent_task;
CREATE POLICY agent_task_org_isolation
  ON __EWOH_SCHEMA__.ewoh_agent_task
  FOR ALL
  TO service_role
  USING (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
  )
  WITH CHECK (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_agent_task TO service_role;
