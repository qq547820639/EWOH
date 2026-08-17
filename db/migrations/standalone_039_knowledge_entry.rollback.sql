-- standalone_039_knowledge_entry 回滚（结构性变更全部可逆）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 回滚步骤：
--   1) 恢复遗留通用 RLS 策略（ewoh_org_select / ewoh_service_all），
--      删除本迁移的 knowledge_entry_service_all；
--   2) 删除契约 CHECK / 索引；
--   3) base_id 置回 NOT NULL（NULL 行以 entry_id 回填——恢复遗留不变量，
--      映射记录于此，确定性可重放）；
--   4) body → content 反向 RENAME；
--   5) 删除契约列；
--   6) entry_id 全局唯一恢复。
--
-- 不可逆部分（记录；审计 SQL-047 文档化，2026-08-17）：status 归一化
-- （遗留值域 → 契约三态）不回放——正向迁移 039 已把 draft/verified/superseded
-- 之外的遗留值（如 published/archived）统一改写为 'draft'，原始值不可恢复
-- （数据损失：仅历史 status 标签，正文/证据/版本事实无损）；值域收敛为
-- {draft, verified, superseded} 保留在 varchar(50) 列中，无结构损失；
-- kind/scope 的遗留映射与 evidence 空数组的 legacy 标记随列删除。
-- 若需保留原始 status 值域，应在执行 039 前先做归档备份（本回滚无法还原）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

-- 1) RLS 策略恢复
ALTER TABLE __EWOH_SCHEMA__.ewoh_knowledge_entry ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS knowledge_entry_service_all ON __EWOH_SCHEMA__.ewoh_knowledge_entry;
DROP POLICY IF EXISTS ewoh_org_select ON __EWOH_SCHEMA__.ewoh_knowledge_entry;
DROP POLICY IF EXISTS ewoh_service_all ON __EWOH_SCHEMA__.ewoh_knowledge_entry;
CREATE POLICY ewoh_org_select ON __EWOH_SCHEMA__.ewoh_knowledge_entry
  FOR SELECT TO authenticated
  USING (__EWOH_SCHEMA__.ewoh_org_visible(org_id));
CREATE POLICY ewoh_service_all ON __EWOH_SCHEMA__.ewoh_knowledge_entry
  FOR ALL TO service_role
  USING (__EWOH_SCHEMA__.ewoh_org_visible(org_id))
  WITH CHECK (__EWOH_SCHEMA__.ewoh_org_visible(org_id));

-- 2) 契约 CHECK / 索引删除
ALTER TABLE __EWOH_SCHEMA__.ewoh_knowledge_entry
  DROP CONSTRAINT IF EXISTS chk_ewoh_knowledge_entry_kind,
  DROP CONSTRAINT IF EXISTS chk_ewoh_knowledge_entry_scope,
  DROP CONSTRAINT IF EXISTS chk_ewoh_knowledge_entry_status,
  DROP CONSTRAINT IF EXISTS chk_ewoh_knowledge_entry_version,
  DROP CONSTRAINT IF EXISTS chk_ewoh_knowledge_entry_summary,
  DROP CONSTRAINT IF EXISTS chk_ewoh_knowledge_entry_body,
  DROP CONSTRAINT IF EXISTS chk_ewoh_knowledge_entry_evidence,
  DROP CONSTRAINT IF EXISTS chk_ewoh_knowledge_entry_scope_tenant,
  DROP CONSTRAINT IF EXISTS chk_ewoh_knowledge_entry_provenance,
  DROP CONSTRAINT IF EXISTS chk_ewoh_knowledge_entry_time,
  DROP CONSTRAINT IF EXISTS chk_ewoh_knowledge_entry_audit;
DROP INDEX IF EXISTS __EWOH_SCHEMA__.idx_ewoh_knowledge_entry_scope_org;
DROP INDEX IF EXISTS __EWOH_SCHEMA__.idx_ewoh_knowledge_entry_kind;

-- 3) base_id 置回 NOT NULL（NULL 行以 entry_id 确定性回填，恢复遗留不变量）
UPDATE __EWOH_SCHEMA__.ewoh_knowledge_entry SET base_id = entry_id WHERE base_id IS NULL;
ALTER TABLE __EWOH_SCHEMA__.ewoh_knowledge_entry ALTER COLUMN base_id SET NOT NULL;

-- 4) body → content 反向 RENAME（条件化，幂等）
DO $$
DECLARE
  has_content boolean;
  has_body boolean;
BEGIN
  SELECT count(*) > 0 INTO has_content FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ewoh_knowledge_entry'
      AND column_name = 'content';
  SELECT count(*) > 0 INTO has_body FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ewoh_knowledge_entry'
      AND column_name = 'body';
  IF has_body AND NOT has_content THEN
    ALTER TABLE __EWOH_SCHEMA__.ewoh_knowledge_entry RENAME COLUMN body TO content;
  END IF;
END $$;

-- 5) 契约列删除（数据随列删除——契约运行时已回退）
ALTER TABLE __EWOH_SCHEMA__.ewoh_knowledge_entry
  DROP COLUMN IF EXISTS kind,
  DROP COLUMN IF EXISTS scope,
  DROP COLUMN IF EXISTS summary,
  DROP COLUMN IF EXISTS source_evidence_ids,
  DROP COLUMN IF EXISTS related_entity_ids,
  DROP COLUMN IF EXISTS provenance,
  DROP COLUMN IF EXISTS verified_by,
  DROP COLUMN IF EXISTS valid_from,
  DROP COLUMN IF EXISTS valid_to,
  DROP COLUMN IF EXISTS audit_trail,
  DROP COLUMN IF EXISTS legacy_without_evidence;

-- 6) entry_id 全局唯一恢复
ALTER TABLE __EWOH_SCHEMA__.ewoh_knowledge_entry
  DROP CONSTRAINT IF EXISTS uq_ewoh_knowledge_entry;
CREATE UNIQUE INDEX IF NOT EXISTS ewoh_knowledge_entry_entry_id_key
  ON __EWOH_SCHEMA__.ewoh_knowledge_entry (entry_id);
