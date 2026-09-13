-- standalone_069 verify：ewoh_schedule_plan.created_by 列存在 + 长度自证。
--
-- 2026-09-12（NO-58 烧账）：原文件用 psql 专属 `\gset` + `:var` 拼装，
-- node 迁移 runner（postgres.js）无法执行 → 全链 verify 永远失败。改为**纯 SQL 自证**：
-- 断言成立才返回 `standalone_069_verified = 1` 一行，否则不返回行（runner 判 FAIL）。
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

SELECT 1 AS standalone_069_verified
 WHERE (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'ewoh_schedule_plan'
           AND column_name = 'created_by') = 1
   AND (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'ewoh_schedule_plan'
           AND column_name = 'created_by'
           AND character_maximum_length = 255) = 1;
