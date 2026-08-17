SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

-- 审计 SQL-108 修复（2026-08-17）：org 选择改为确定性排序（ORDER BY id 主键，
-- 替代非确定性的 ORDER BY _created_at——多 org 行 _created_at 相同时绑定哪个
-- org 未定义）。
-- 审计 SQL-110 文档化：ON CONFLICT (username) DO NOTHING——同名用户已存在时
-- 静默跳过（不更新 password_hash/display_name）。重跑 seed 不会轮换密码；
-- 运维需轮换密码时先 DELETE 该用户行再重跑，或直接 UPDATE password_hash。
-- 不改用 DO UPDATE：避免「用旧 env 值静默覆盖人工改过的账号」。
INSERT INTO __EWOH_SCHEMA__.ewoh_user
  (username, password_hash, display_name, org_id, roles, is_global_admin, status)
SELECT
  '__EWOH_ADMIN_USERNAME__',
  '__EWOH_ADMIN_PASSWORD_HASH__',
  '__EWOH_ADMIN_DISPLAY_NAME__',
  COALESCE((SELECT org_id FROM __EWOH_SCHEMA__.ewoh_organization ORDER BY id LIMIT 1), '00000000-0000-4000-8000-000000000001'::uuid),
  '["global_admin"]'::jsonb,
  true,
  'active'
ON CONFLICT (username) DO NOTHING;
