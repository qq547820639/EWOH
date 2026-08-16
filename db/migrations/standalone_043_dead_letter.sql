-- EWOH Dead Letter 台账 (standalone_043, ADR-024 / NO-11a, §20 Reliability)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS /
--            DROP POLICY IF EXISTS / ENABLE ROW LEVEL SECURITY（幂等可重复执行）。
--
-- 背景（ADR-024，contracts/reliability/dead-letter.schema.json）：
--   1) 永久失败消息的终态台账：envelope 快照（失败证据可审计，§3）+
--      reason/status/attempts 状态机（pending→requeued/discarded）；
--   2) 写入唯一入口：DeadLetterService.record（契约校验 fail-closed）；
--      letterId 由 (sourceId, eventId) 确定性推导（dl:{sourceHash}:{eventId}）
--      → UNIQUE (org_id, letter_id) 幂等（重复上报不重复落账不重复发事件）；
--   3) v1 禁止自动重试：requeue 仅人审触发（自动无限重试 = 事实层噪音源）；
--      discarded 必须带非空理由（CHECK 兜底，§33 不静默）；
--   4) 租户边界：TENANT_SCOPED（org_id NOT NULL + RLS dead_letter_org_isolation
--      读 app.current_org_id，与 standalone_025 同 idiom）。
--
-- 回滚语义：表为全新（additive）；回滚 = DROP TABLE（索引/约束/RLS 策略随表级联）。
--   回滚后死信写入将失败（服务层 best-effort 留痕，不影响上行主契约）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

-- ============================================================================
-- 1) ewoh_dead_letter：死信终态台账（TENANT_SCOPED）。
-- ============================================================================
CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_dead_letter (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar(255) NOT NULL,
  letter_id varchar(180) NOT NULL,
  source_id varchar(128) NOT NULL,
  reason varchar(32) NOT NULL,
  attempts integer NOT NULL,
  status varchar(16) NOT NULL,
  envelope_json jsonb NOT NULL,
  correlation_id varchar(128),
  discarded_reason text,
  record_json jsonb NOT NULL,
  _created_at timestamptz NOT NULL DEFAULT now(),
  _updated_at timestamptz NOT NULL DEFAULT now(),
  _created_by uuid,
  _updated_by uuid,
  CONSTRAINT chk_ewoh_dead_letter_reason
    CHECK (reason IN ('contract_violation', 'unknown_event_type', 'permanent_failure', 'ttl_expired', 'max_attempts_exceeded')),
  CONSTRAINT chk_ewoh_dead_letter_status
    CHECK (status IN ('pending', 'requeued', 'discarded')),
  CONSTRAINT chk_ewoh_dead_letter_attempts CHECK (attempts >= 1),
  CONSTRAINT chk_ewoh_dead_letter_discard
    CHECK (status <> 'discarded' OR (discarded_reason IS NOT NULL AND length(btrim(discarded_reason)) > 0)),
  CONSTRAINT uq_ewoh_dead_letter UNIQUE (org_id, letter_id)
);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_dead_letter IS
  'Dead Letter 终态台账（ADR-024/NO-11a，§20）。永久失败消息的失败证据（envelope 快照）+ 人审重放状态机（pending→requeued/discarded）；写入唯一入口=DeadLetterService.record（契约校验 fail-closed）；letterId=(sourceId, eventId) 确定性推导幂等；v1 禁止自动重试（requeue 仅人审，§2）。TENANT_SCOPED（RLS dead_letter_org_isolation）。';

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_dead_letter.envelope_json IS '失败消息信封快照（§3：失败也要回答为什么）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_dead_letter.attempts IS '尝试计数（≥1；requeue 人审触发 +1，杜绝自动无限重试）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_dead_letter.discarded_reason IS 'discarded 必填非空（CHECK 兜底，§33 不静默丢弃）';

CREATE INDEX IF NOT EXISTS idx_ewoh_dead_letter_status
  ON __EWOH_SCHEMA__.ewoh_dead_letter (org_id, status);
CREATE INDEX IF NOT EXISTS idx_ewoh_dead_letter_source
  ON __EWOH_SCHEMA__.ewoh_dead_letter (org_id, source_id);

-- ============================================================================
-- 2) RLS：TENANT_SCOPED 隔离（与 standalone_025 同 idiom：读 app.current_org_id，
--    旧名 app.primary_org_id 仅在未设置新名时回退）。
-- ============================================================================
ALTER TABLE __EWOH_SCHEMA__.ewoh_dead_letter ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS dead_letter_org_isolation
  ON __EWOH_SCHEMA__.ewoh_dead_letter;
CREATE POLICY dead_letter_org_isolation
  ON __EWOH_SCHEMA__.ewoh_dead_letter
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

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_dead_letter TO service_role;
