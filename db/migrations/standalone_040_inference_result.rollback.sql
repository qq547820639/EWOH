-- standalone_040_inference_result 回滚（表为全新，additive）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- 回滚 = DROP TABLE（索引/约束/RLS 策略随表级联）。
-- 回滚后推理结果写入将失败（fail-closed，不静默降级）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_inference_result CASCADE;
