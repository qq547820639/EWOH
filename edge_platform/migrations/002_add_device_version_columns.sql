-- 002: 为 telemetry 表补充 device_model / firmware_version / protocol_version 列
-- 说明（重要）：
--   SQLite 的 ALTER TABLE 不支持 IF NOT EXISTS 语法，也不支持 ADD COLUMN IF NOT EXISTS，
--   因此在 SQLite 路径下请由 Storage._migrate_columns() 通过 PRAGMA table_info 检查
--   列是否存在后再决定是否执行 ADD COLUMN，避免迁移失败。
--   本脚本主要面向 postgres 迁移场景；postgres 中可用 IF NOT EXISTS（9.6+），
--   但为保持脚本通用，下面写成幂等查询，重复执行不报错。

-- device_model：设备型号冗余列（加速查询，避免每次 join device）
ALTER TABLE telemetry ADD COLUMN IF NOT EXISTS device_model TEXT;

-- firmware_version：固件版本（采集时记录，便于按版本回归分析）
ALTER TABLE telemetry ADD COLUMN IF NOT EXISTS firmware_version TEXT;

-- protocol_version：线协议版本（不同固件可能携带不同协议版本字段）
ALTER TABLE telemetry ADD COLUMN IF NOT EXISTS protocol_version TEXT;

-- raw_ref：原始帧引用（关联 raw_frame.record_id，便于从消息回溯字节）
ALTER TABLE telemetry ADD COLUMN IF NOT EXISTS raw_ref TEXT;

-- 同步为 device 表补充 device_model / protocol_version 冗余列
ALTER TABLE device ADD COLUMN IF NOT EXISTS device_model TEXT;
ALTER TABLE device ADD COLUMN IF NOT EXISTS protocol_version TEXT;
