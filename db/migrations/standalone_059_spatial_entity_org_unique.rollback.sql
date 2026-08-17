-- standalone_059 rollback：恢复 entity_id 全局单列唯一。
-- 注意：若复合唯一期间已有跨租户同 entity_id 行，回滚将因重复而失败——
-- 需先人工合并/清理，再执行本回滚。
DROP INDEX IF EXISTS __EWOH_SCHEMA__.uq_ewoh_spatial_entity_org_entity;
CREATE UNIQUE INDEX IF NOT EXISTS ewoh_spatial_entity_entity_id_key
  ON __EWOH_SCHEMA__.ewoh_spatial_entity (entity_id);
