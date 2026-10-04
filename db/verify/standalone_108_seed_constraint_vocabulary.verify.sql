-- 108 verify：种子约束行不再存在"解码那一刻无声消失"的形状。
-- 只断"坏形状为零"，不断"三行必须存在"——A 段 fresh-chain 只跑迁移不跑种子，
-- 那种库里一行约束都没有的情况必须算通过（否则 fresh 档永远判红）。
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);
SELECT CASE WHEN
  -- 1) 旧键形（snake_case）全清：解码器只认 camelCase 名册，留着就是无声失效
  (SELECT count(*) FROM __EWOH_SCHEMA__.ewoh_scheduling_constraint
    WHERE value_json ? 'person_id' OR value_json ? 'device_id'
       OR value_json ? 'min_battery' OR value_json ? 'start' OR value_json ? 'end') = 0
  -- 2) 带 task_id 的行必须指到 ewoh_production_task 的主键（'TASK-12x' 那种工号/镜像列不算）
  AND (SELECT count(*) FROM __EWOH_SCHEMA__.ewoh_scheduling_constraint c
        WHERE c.task_id IS NOT NULL AND c.task_id <> ''
          AND NOT EXISTS (SELECT 1 FROM __EWOH_SCHEMA__.ewoh_production_task t
                           WHERE t.id::text = c.task_id)) = 0
  -- 3) LOCKED_PERSON 的 personId 必须指到 ewoh_personnel 的主键（employee_no 不算）
  AND (SELECT count(*) FROM __EWOH_SCHEMA__.ewoh_scheduling_constraint c
        WHERE c.type = 'LOCKED_PERSON' AND c.value_json ? 'personId'
          AND NOT EXISTS (SELECT 1 FROM __EWOH_SCHEMA__.ewoh_personnel p
                           WHERE p.id::text = c.value_json ->> 'personId')) = 0
  -- 4) LOCKED_TIME 的窗口必须是数值毫秒（字符串 "now()+5min" 求解器比较不了）
  AND (SELECT count(*) FROM __EWOH_SCHEMA__.ewoh_scheduling_constraint c
        WHERE c.type = 'LOCKED_TIME' AND c.value_json ? 'startMs'
          AND jsonb_typeof(c.value_json -> 'startMs') <> 'number') = 0
  -- 5) MIN_BATTERY 的 value 必须是数值（V366 起 value 随行往返；null/字符串都会让门槛退回默认）
  AND (SELECT count(*) FROM __EWOH_SCHEMA__.ewoh_scheduling_constraint c
        WHERE c.type = 'MIN_BATTERY' AND c.value_json ? 'value'
          AND jsonb_typeof(c.value_json -> 'value') <> 'number') = 0
  -- 6) 旧的 per-device 第二行（…-003）不该再回来：本类型是全局阈值覆盖，没有 per-device 表达法
  AND (SELECT count(*) FROM __EWOH_SCHEMA__.ewoh_scheduling_constraint
        WHERE id = '69000000-0000-4000-8000-000000000003') = 0
THEN 1 ELSE 0 END AS standalone_108_verified;
