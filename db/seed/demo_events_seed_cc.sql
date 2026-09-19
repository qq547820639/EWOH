-- EWOH 演示事件播种（source_type='seed-cc'）
-- Schema: public（standalone 链）
--
-- 用途：指挥中心「近期事件」/ 工作台 NOW 面板等演示面需要 24h 窗口内有数据。
-- 背景：RetentionService 每小时清理 —— ewoh_event 保留 7 天
--   （server/modules/simulator/retention.service.ts，CLEAN_INTERVAL_MS=1h），
--   且「近期事件」API 默认只看 24h 窗口。因此**绝对时间戳的种子必然过期**，
--   本脚本一律用 `now() - interval` 相对值，保证执行后即有 22 条落在 24h 内。
--
-- 何时重跑：演示前。种子数据在播种后约 7 天被保留策略删除；
--   即使未删除，其 created_at 也会滑出 24h 窗口而不再显示。
--
-- 回滚（整体、精确）：DELETE FROM public.ewoh_event WHERE source_type = 'seed-cc';
--
-- 纪律：
--   1) event_type 必须用事件目录内的**规范类型名**
--      （contracts/events/event-catalog.yaml 与 RULE_EVENT_TYPE_MAP 对齐），
--      否则依赖类型白名单的聚合端点（如 /api/dashboard/now）会"静默恒空"。
--   2) 幂等：先删同 source_type 的旧种子再插入，可反复执行。
--   3) gen_random_uuid() 直接写在 SELECT 列表（volatile 逐行求值）；
--      放进 `CROSS JOIN LATERAL (SELECT gen_random_uuid())` 会被折叠成同一值
--      → 30 行撞同一主键。

SELECT set_config('search_path', 'public, pg_temp', false);

DELETE FROM public.ewoh_event WHERE source_type = 'seed-cc';

INSERT INTO public.ewoh_event
  (event_id, device_id, event_code, event_type, severity, title, status, org_id,
   source_type, created_at, occurred_at, observed_at, received_at, evidence_json)
SELECT
  'SEED-' || gen_random_uuid()::text,
  d, code, etype, sev, ttl, st,
  '00000000-0000-4000-8000-000000000001',
  'seed-cc',
  now() - (off_h || ' hours')::interval,
  now() - (off_h || ' hours')::interval,
  now() - (off_h || ' hours')::interval,
  now() - (off_h || ' hours')::interval,
  '{"source":"demo-seed"}'::jsonb
FROM (VALUES
  -- ── 24h 窗口内（22 条）──────────────────────────────────────────────
  ('EXO-104','LOW_BATTERY','DeviceLowBattery','high','外骨骼电量低于 20%','open',1.5),
  ('EXO-105','POSTURE_RISK','WorkerPostureRisk','high','搬运姿态风险告警','open',2.2),
  ('EXO-106','HIGH_LOAD','WorkerHighLoad','critical','负载峰值超限','open',3.0),
  ('EXO-107','DEVICE_OFFLINE','DeviceOffline','critical','设备离线','open',4.1),
  ('EXO-108','DATA_DEGRADED','DataDegraded','medium','数据质量降级','open',5.4),
  ('EXO-104','POSTURE_RISK','WorkerPostureRisk','medium','久坐/持续弯腰提示','acknowledged',6.3),
  ('EXO-105','LOW_BATTERY','DeviceLowBattery','high','外骨骼电量低于 20%','acknowledged',7.6),
  ('EXO-106','HIGH_LOAD','WorkerHighLoad','high','连续高负载作业','resolved',8.9),
  ('EXO-107','POSTURE_RISK','WorkerPostureRisk','critical','高风险姿态（急停）','open',10.2),
  ('EXO-108','DEVICE_OFFLINE','DeviceOffline','high','心跳丢失 3 分钟','resolved',11.5),
  ('EXO-109','LOW_BATTERY','DeviceLowBattery','high','外骨骼电量低于 20%','open',12.8),
  ('EXO-110','DATA_DEGRADED','DataDegraded','medium','遥测字段缺失','open',14.0),
  ('AGV-01','DEVICE_OFFLINE','DeviceOffline','critical','AGV 通信中断','open',15.3),
  ('AGV-02','DATA_DEGRADED','DataDegraded','medium','定位漂移超阈值','open',16.6),
  ('EXO-101','HIGH_LOAD','WorkerHighLoad','medium','负载接近上限','resolved',17.9),
  ('EXO-102','POSTURE_RISK','WorkerPostureRisk','high','重复弯腰次数超限','open',19.1),
  ('EXO-103','LOW_BATTERY','DeviceLowBattery','high','外骨骼电量低于 20%','acknowledged',20.4),
  ('EXO-104','HIGH_LOAD','WorkerHighLoad','medium','短时负载尖峰','resolved',21.7),
  ('EXO-105','DEVICE_OFFLINE','DeviceOffline','high','设备离线（换班）','resolved',22.5),
  ('EXO-106','LOW_BATTERY','DeviceLowBattery','high','外骨骼电量低于 20%','open',23.2),
  ('AGV-03','DATA_DEGRADED','DataDegraded','low','传感器噪声偏高','resolved',23.8),
  ('EXO-107','POSTURE_RISK','WorkerPostureRisk','medium','姿态评分下降','open',23.95),
  -- ── 24h 窗口外（8 条，用于验证窗口边界与趋势）──────────────────────
  ('EXO-108','LOW_BATTERY','DeviceLowBattery','high','外骨骼电量低于 20%','open',26.0),
  ('EXO-109','HIGH_LOAD','WorkerHighLoad','critical','负载峰值超限','resolved',30.5),
  ('EXO-110','DEVICE_OFFLINE','DeviceOffline','high','设备离线','resolved',38.0),
  ('AGV-04','DATA_DEGRADED','DataDegraded','medium','里程计偏差','resolved',50.0),
  ('EXO-101','POSTURE_RISK','WorkerPostureRisk','high','高风险姿态','resolved',66.0),
  ('EXO-102','LOW_BATTERY','DeviceLowBattery','high','外骨骼电量低于 20%','resolved',90.0),
  ('AGV-05','DEVICE_OFFLINE','DeviceOffline','critical','AGV 通信中断','resolved',120.0),
  ('EXO-103','HIGH_LOAD','WorkerHighLoad','medium','负载接近上限','resolved',150.0)
) AS v(d, code, etype, sev, ttl, st, off_h);
