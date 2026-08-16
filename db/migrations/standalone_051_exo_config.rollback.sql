-- standalone_051_exo_config 回滚（表为全新 additive；回滚 = DROP TABLE）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- 索引/约束/RLS 策略随表级联删除；回滚后回到 R-72 前水平（无行数据保留，
-- 配置台账事实随表删除——与 standalone_046 回滚语义一致）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_exo_config;
