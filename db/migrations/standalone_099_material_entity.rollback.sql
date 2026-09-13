-- standalone_099_material_entity 回滚（全新表 additive：DROP TABLE 即回滚，
-- 索引/约束/RLS 策略随表级联删除）。
--
-- 警告：回滚会丢掉物料主数据、库存事实与需求/阈值台账——materials.service.ts
-- 将失去一等实体读面并**回退到 ewoh_event 投影**（投影把"读不到"当 0 的历史
-- 缺陷随之回归）。生产回滚前应先导出三表，否则「库存未知 vs 库存 0」的区分
-- 会永久丢失（无法从事件重建：事件里本就没有 unknown 语义）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_material_requirement;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_material_stock;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_material;
