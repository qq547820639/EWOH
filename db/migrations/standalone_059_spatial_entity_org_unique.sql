-- EWOH 2026-08-17 审计整改 — R2-SOP-003 / R2-SAM-003：空间实体业务键租户复合唯一
-- (standalone_059, 审计 docs/audit/current/findings.jsonl R2-SOP-003 / R2-SAM-003)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: 先清理历史重复行（每 (org_id, entity_id) 保留最新一行），drop 旧
-- 单列唯一，再 CREATE UNIQUE INDEX IF NOT EXISTS；可重复执行无副作用。
--
-- 背景：ewoh_spatial_entity.entity_id 原为全局单列唯一，ingestSpatialScan 的
-- onConflictDoUpdate target=entity_id 且 set 无归属校验——orgB 上报与 orgA 相同
-- entity_id 的扫描会原地改写 orgA 行的 sourceType/confidence/extra（跨租户数据
-- 篡改）。与 057（ewoh_device）同模式收敛为 (org_id, entity_id) 复合唯一；
-- 应用层 upsert 冲突目标同步改复合键（sensor-ingest.service.ts）。

-- 1) 清理历史重复（幂等：每组 (org_id, entity_id) 保留 _created_at 最新一行）。
DELETE FROM __EWOH_SCHEMA__.ewoh_spatial_entity a
USING __EWOH_SCHEMA__.ewoh_spatial_entity b
WHERE a.entity_id = b.entity_id
  AND a.org_id IS NOT DISTINCT FROM b.org_id
  AND (a._created_at, a.id) < (b._created_at, b.id);

-- 2) drop 旧单列唯一（旧库以约束或索引两种形态存在，均清理）。
ALTER TABLE __EWOH_SCHEMA__.ewoh_spatial_entity
  DROP CONSTRAINT IF EXISTS ewoh_spatial_entity_entity_id_key;
DROP INDEX IF EXISTS __EWOH_SCHEMA__.ewoh_spatial_entity_entity_id_key;

-- 3) 复合唯一（同 org 内 entity_id 唯一；跨租户可复用同一 entity_id；
--    NULL org 行（legacy）不参与唯一判定，应用层已 fail-closed 不再新增）。
CREATE UNIQUE INDEX IF NOT EXISTS uq_ewoh_spatial_entity_org_entity
  ON __EWOH_SCHEMA__.ewoh_spatial_entity (org_id, entity_id);

COMMENT ON INDEX __EWOH_SCHEMA__.uq_ewoh_spatial_entity_org_entity IS
  '空间实体业务键租户复合唯一（standalone_059，R2-SOP-003/R2-SAM-003）：同 org 内 entity_id 唯一；跨租户可复用同一 entity_id';
