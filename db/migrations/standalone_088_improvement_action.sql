-- EWOH 改进行动项台账 (standalone_088, NO-55a, §10 Level 7 + §12 反馈腿)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS /
--            DROP POLICY IF EXISTS / ENABLE ROW LEVEL SECURITY（幂等可重复执行）。
--
-- 背景（学习回路接线第二轮，`docs/architecture/capability-alignment.md` §3 原 #1 的剩余部分）：
--   1) 复盘已能产出**结构化经验条目**（`ewoh_retrospective.lessons_json`）与**缺口清单**
--      （`assembled_json.gaps`），但条目落进复盘记录后**没有人负责、没有期限、没有完成证据**；
--   2) 本表存**改进行动项**（不是阈值提案）：做法/培训/工具/维护类改进的一等工作项，
--      与 `ewoh_learning_proposal`（可激活的参数变更）并列，二者可互相引用
--      （`kind='threshold_review'` 表示"这条经验需要人去提案面板改参数"）；
--   3) 契约兜底（与 `shared/improvement-action.ts` 的 validateImprovementAction 对齐）：
--      · accepted 必须有 owner + due_at + acceptance_criteria + 接受人/时间
--        （"做完了"要能被别人判断）；
--      · completed 还必须带完成人/时间/**结果说明**；
--      · rejected / dropped 必须带决定人/时间/理由（§33 不静默作废）；
--      · proposed 不得带完成时间（不许先写完成再补状态）；
--      · 证据必填（没有证据就没有行动项）；
--   4) 租户边界：TENANT_SCOPED（org_id varchar(255) NOT NULL + RLS
--      improvement_action_org_isolation）+ UNIQUE (org_id, action_id)（行动项号确定性 → 重复扫描幂等）。
--
-- 回滚语义：表为全新（additive）；回滚 = DROP TABLE（索引/约束/RLS 策略随表级联）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

-- ============================================================================
-- 1) ewoh_improvement_action：改进行动项台账（TENANT_SCOPED）。
-- ============================================================================
CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_improvement_action (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar(255) NOT NULL,
  action_id varchar(180) NOT NULL,
  source_type varchar(32) NOT NULL,
  source_ref varchar(255) NOT NULL,
  title varchar(255) NOT NULL,
  detail text NOT NULL,
  kind varchar(32) NOT NULL,
  kind_source varchar(16) NOT NULL DEFAULT 'suggested',
  priority varchar(16) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'proposed',
  evidence_json jsonb NOT NULL,
  owner varchar(255),
  due_at timestamptz,
  acceptance_criteria text,
  accepted_by varchar(255),
  accepted_at timestamptz,
  completed_by varchar(255),
  completed_at timestamptz,
  outcome_note text,
  decided_by varchar(255),
  decided_at timestamptz,
  decided_reason text,
  detected_at timestamptz NOT NULL,
  record_json jsonb NOT NULL,
  _created_at timestamptz NOT NULL DEFAULT now(),
  _updated_at timestamptz NOT NULL DEFAULT now(),
  _created_by varchar(255),
  _updated_by varchar(255),
  CONSTRAINT uq_ewoh_improvement_action UNIQUE (org_id, action_id),
  CONSTRAINT chk_ewoh_improvement_action_source
    CHECK (source_type IN ('retrospective_lesson', 'retrospective_gap')),
  CONSTRAINT chk_ewoh_improvement_action_kind
    CHECK (kind IN ('process_change', 'training', 'tooling', 'maintenance', 'threshold_review')),
  CONSTRAINT chk_ewoh_improvement_action_kind_source
    CHECK (kind_source IN ('suggested', 'human')),
  CONSTRAINT chk_ewoh_improvement_action_priority
    CHECK (priority IN ('low', 'medium', 'high')),
  CONSTRAINT chk_ewoh_improvement_action_status
    CHECK (status IN ('proposed', 'accepted', 'rejected', 'completed', 'dropped')),
  -- 没有证据就没有行动项（原则 5：建议必须能追到来源）。
  CONSTRAINT chk_ewoh_improvement_action_evidence
    CHECK (jsonb_typeof(evidence_json) = 'array' AND jsonb_array_length(evidence_json) >= 1),
  -- 接受门槛：人 + 期限 + 判据 + 接受痕迹。
  CONSTRAINT chk_ewoh_improvement_action_accepted
    CHECK (status NOT IN ('accepted', 'completed')
      OR (owner IS NOT NULL AND length(btrim(owner)) > 0
        AND due_at IS NOT NULL
        AND acceptance_criteria IS NOT NULL AND length(btrim(acceptance_criteria)) > 0
        AND accepted_by IS NOT NULL AND length(btrim(accepted_by)) > 0
        AND accepted_at IS NOT NULL)),
  -- 完成门槛：完成人 + 时间 + 结果说明。
  CONSTRAINT chk_ewoh_improvement_action_completed
    CHECK (status <> 'completed'
      OR (completed_by IS NOT NULL AND length(btrim(completed_by)) > 0
        AND completed_at IS NOT NULL
        AND outcome_note IS NOT NULL AND length(btrim(outcome_note)) > 0)),
  -- 拒绝/放弃：决定人 + 时间 + 理由。
  CONSTRAINT chk_ewoh_improvement_action_decided
    CHECK (status NOT IN ('rejected', 'dropped')
      OR (decided_by IS NOT NULL AND length(btrim(decided_by)) > 0
        AND decided_at IS NOT NULL
        AND decided_reason IS NOT NULL AND length(btrim(decided_reason)) > 0)),
  -- 未完成不许写完成痕迹（状态与事实不许互相矛盾）。
  CONSTRAINT chk_ewoh_improvement_action_not_completed
    CHECK (status IN ('completed') OR completed_at IS NULL)
);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_improvement_action IS
  '改进行动项台账（NO-55a）：复盘经验条目/缺口 → 有人负责、有期限、有验收判据、有完成证据的一等工作项。与 ewoh_learning_proposal（可激活的参数变更）并列，二者可互相引用。TENANT_SCOPED（RLS improvement_action_org_isolation）。';

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_improvement_action.kind_source IS
  'suggested=平台建议类型（人接受时应确认）；human=人明确选择（接受/改类时写入）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_improvement_action.acceptance_criteria IS
  '验收判据（accepted/completed 必填）：让"做完了"能被别人判断，而不是自我声明';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_improvement_action.outcome_note IS
  '完成结果说明（completed 必填）：对着判据说清楚做了什么、结果如何';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_improvement_action.decided_reason IS
  '拒绝/放弃理由（必填，§33 不静默作废）';

CREATE INDEX IF NOT EXISTS idx_ewoh_improvement_action_status
  ON __EWOH_SCHEMA__.ewoh_improvement_action (org_id, status);
CREATE INDEX IF NOT EXISTS idx_ewoh_improvement_action_priority
  ON __EWOH_SCHEMA__.ewoh_improvement_action (org_id, priority, status);
CREATE INDEX IF NOT EXISTS idx_ewoh_improvement_action_due
  ON __EWOH_SCHEMA__.ewoh_improvement_action (org_id, due_at);

-- ============================================================================
-- 2) RLS：TENANT_SCOPED 隔离（与 standalone_025/045/087 同 idiom：读 app.current_org_id，
--    旧名 app.primary_org_id 仅在未设置新名时回退）。
-- ============================================================================
ALTER TABLE __EWOH_SCHEMA__.ewoh_improvement_action ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS improvement_action_org_isolation
  ON __EWOH_SCHEMA__.ewoh_improvement_action;
CREATE POLICY improvement_action_org_isolation
  ON __EWOH_SCHEMA__.ewoh_improvement_action
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

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_improvement_action TO service_role;
