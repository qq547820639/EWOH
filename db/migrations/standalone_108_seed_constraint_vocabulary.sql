-- 108: 种子约束行的键形／值域／值形状收敛到解码器同源（SKW-01）
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: 只改"还是旧形状"的行；引用解析不到真实行 ⇒ 删除该约束而不是留下一条无声失效的锁。
--
-- 背景（V363 立行 SKW-01，V364 量出"改键名不够"，V367 落地）：
-- `db/seed/standalone_006_scheduling_seed.sql` 第 10 段往 `ewoh_scheduling_constraint.value_json`
-- 写的是 snake_case（`person_id`/`device_id`/`min_battery`/`start`/`end`），而唯一解码器
-- `server/modules/scheduler/constraint-loader.service.ts` 的 `rowToConstraint` 只认 camelCase 名册
-- ⇒ 四行全解成空字段；`unsupported_constraint` 那道闸又只按 `c.type` 判（`constraints.ts:169/:330`），
-- 所以"类型支持、字段全空"的行既不生效也不记 violation，在求解那一刻无声消失。
--
-- 四处不同源，本迁移一次对齐（与种子文本同批改，fresh 库与存量库得到同一形状）：
--   1) 键形：换成解码器认的 `personId`/`value`/`startMs`/`endMs`；
--   2) 值域：`person_id:'P008'` 是 `ewoh_personnel.employee_no` 命名空间，`task_id:'TASK-12x'` 是
--      `ewoh_schedule_task.schedule_task_id`（MES 镜像列，`db/runner/reset-scenario-data.js:82` 的
--      PURGE_TABLES 每次场景复位清掉它，且调度器不读那张表）；求解侧比的是
--      `ewoh_personnel.id` 与 `ewoh_production_task.id`（uuid，`heuristic-scheduling-solver.ts:790` 的 `task.id`、
--      `resource-projection.service.ts` 的 `p.id`）⇒ 全部换成后者，按同一张表里的真实行解析；
--   3) 值形状：`"start":"now()+5min"` 是 JSON 字符串，Postgres 不在 jsonb 里求值，而窗口按数字毫秒比较
--      （`c.startMs != null` 之后进 `lockedTimeByTask`）⇒ 换成建库时刻现算的 bigint 毫秒；
--   4) 语义档位：`MIN_BATTERY` 是**全局阈值覆盖**（`heuristic-scheduling-solver.ts:395`
--      `effectiveMinBattery = minBatteryOverride ?? config.minBatteryPct`、`cp-sat-scheduling-solver.ts:258-259`），
--      本类型没有"每台设备一条阈值"的表达法 ⇒ …-002 归一为全局 30%，…-003（第二台设备那条）删除，
--      并把设备工号留在 reason 里可追溯。
--
-- 幂等：迁移与种子都按同一批**固定 id**（69000000-…-001/002/004）写；…-003 只由本迁移删除，
-- 种子文本不再含它 ⇒ 修完之后重跑种子（`--seed-standalone-scheduling`）不再插入任何行。
--
-- 回滚语义：把三行写回旧形状、并把 …-003 按旧写法补回（只还原数据形状，不还原任何求解结果）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

-- 1) LOCKED_PERSON（…-001）：personId 换档案主键、task_id 换生产任务主键、键形换 camelCase。
--    解析锚：任务按标题（种子与库内一致的人读桥），人员按 employee_no —— 二者任一解析不到 ⇒ 走第 5 步删除。
UPDATE __EWOH_SCHEMA__.ewoh_scheduling_constraint
   SET value_json = jsonb_build_object(
         'personId', p.id,
         'operator', 'operator-li',
         'reason',   'LINE-B 外观装配（原叙述 TASK-128／P008）锁定该档案人员执行'),
       task_id     = t.id::text,
       _updated_at = CURRENT_TIMESTAMP
  FROM __EWOH_SCHEMA__.ewoh_production_task t
  JOIN __EWOH_SCHEMA__.ewoh_personnel p
    ON p.employee_no = 'P008' AND p.org_id = t.org_id
 WHERE ewoh_scheduling_constraint.id = '69000000-0000-4000-8000-000000000001'
   AND t.title = 'LINE-B外观装配'
   AND (ewoh_scheduling_constraint.value_json ? 'person_id'
        OR ewoh_scheduling_constraint.task_id IS DISTINCT FROM t.id::text);

-- 2) MIN_BATTERY（…-002）：归一为全局阈值覆盖，value 是数值（V366 起 value 随行往返）。
UPDATE __EWOH_SCHEMA__.ewoh_scheduling_constraint
   SET value_json = jsonb_build_object(
         'value', 30,
         'operator', 'operator-li',
         'reason', '演示：低于 30% 的设备一律不进候选（原两行 per-device 写法在本类型里不成立；工号 DEV-02）'),
       _updated_at = CURRENT_TIMESTAMP
 WHERE id = '69000000-0000-4000-8000-000000000002'
   AND value_json ? 'min_battery';

-- 3) LOCKED_TIME（…-004）：task_id 换生产任务主键，窗口换成建库时刻现算的数值毫秒。
UPDATE __EWOH_SCHEMA__.ewoh_scheduling_constraint
   SET value_json = jsonb_build_object(
         'startMs', floor(extract(epoch FROM now() + interval '5 minutes')  * 1000)::bigint,
         'endMs',   floor(extract(epoch FROM now() + interval '40 minutes') * 1000)::bigint,
         'operator', 'operator-li',
         'reason',   'LINE-B 模组装配-1（原叙述 TASK-126）锁进 5–40 分钟窗口'),
       task_id     = t.id::text,
       _updated_at = CURRENT_TIMESTAMP
  FROM __EWOH_SCHEMA__.ewoh_production_task t
 WHERE ewoh_scheduling_constraint.id = '69000000-0000-4000-8000-000000000004'
   AND t.title = 'LINE-B模组装配-1'
   AND (ewoh_scheduling_constraint.value_json ? 'start'
        OR ewoh_scheduling_constraint.task_id IS DISTINCT FROM t.id::text);

-- 4) 第二台设备那条 per-device MIN_BATTERY（…-003）：本类型表达不了 per-device ⇒ 删除（意图已并入 …-002 的 reason）。
DELETE FROM __EWOH_SCHEMA__.ewoh_scheduling_constraint
 WHERE id = '69000000-0000-4000-8000-000000000003';

-- 5) 兜底：任何"引用不到真实行"或"还留着旧键形"的种子约束行一律删掉。
--    理由：留着它们的代价是"库里有一行自称锁、求解那一刻无声消失"——SKW-01 的病灶正是这个；
--    演示少一条锁是可接受的，一条永不生效也不记 violation 的锁不是。
DELETE FROM __EWOH_SCHEMA__.ewoh_scheduling_constraint c
 WHERE c.id IN ('69000000-0000-4000-8000-000000000001',
                '69000000-0000-4000-8000-000000000002',
                '69000000-0000-4000-8000-000000000004')
   AND (
     -- 旧键形还在
     (c.value_json ? 'person_id' OR c.value_json ? 'device_id'
      OR c.value_json ? 'min_battery' OR c.value_json ? 'start' OR c.value_json ? 'end')
     -- 或 task_id 不是 ewoh_production_task 的主键（NULL 的 MIN_BATTERY 是合法全局行，不参与此判）
     OR (c.task_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM __EWOH_SCHEMA__.ewoh_production_task t WHERE t.id::text = c.task_id))
     -- 或 LOCKED_PERSON 的 personId 不是 ewoh_personnel 的主键
     OR (c.type = 'LOCKED_PERSON' AND NOT EXISTS (
          SELECT 1 FROM __EWOH_SCHEMA__.ewoh_personnel p
           WHERE p.id::text = (c.value_json ->> 'personId')))
   );
