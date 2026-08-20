-- =====================================================================
-- standalone_059：设备绑定人员数据迁移（2026-08-20）
-- 背景：设备中心绑定人员从「手动输入姓名(ewoh_device.worker_name)」改为
-- 「从人员与外骨骼档案下拉选择」后，需把存量文本绑定迁移为结构化绑定
-- （spatial person.extra.device_id ↔ device.extra.worker_id 双向引用）。
--
-- 身份体系说明（历史遗留，三套并存）：
--   A. spatial person P001-P024（指挥地图/世界快照/绑定原生身份）
--   B. ewoh_personnel UUID 档案（人员与外骨骼页面，employee_no 为 P0xx 风格工号）
--   C. ewoh_device.worker_name 自由文本（本次废弃）
-- 档案 employee_no 与 spatial entity_id 序号同源但人名存在错位（如档案
-- P024=田磊 vs spatial P024=秦川）——故绑定身份一律「按姓名匹配 spatial
-- person」，无同名者用档案 UUID 实体（本脚本补建，与 createPersonnel 同步逻辑一致）。
--
-- 可重入：全部 ON CONFLICT DO NOTHING / 条件更新，重复执行无副作用。
-- =====================================================================

-- ===== 1. 补建档案人员的 spatial person 实体 =====
-- 仅当档案姓名在 spatial 中无同名 person 时补建（entity_id = 档案 UUID，
-- 与 createPersonnel 2026-08-20 新增逻辑一致）。
INSERT INTO public.ewoh_spatial_entity
  (entity_id, entity_type, parent_id, name, x, y, yaw, bbox_w, bbox_h,
   status, source_type, confidence, version, extra, org_id, _created_at, _updated_at)
SELECT
  p.id::varchar,
  'person',
  NULL,
  p.name,
  0, 0, 0, 12, 12,
  COALESCE(p.status, 'active'),
  'seed',
  1.0, 1,
  jsonb_build_object('employee_no', p.employee_no),
  p.org_id,
  now(), now()
FROM public.ewoh_personnel p
WHERE NOT EXISTS (
  SELECT 1 FROM public.ewoh_spatial_entity s
  WHERE s.entity_type = 'person' AND s.name = p.name
)
AND p.org_id IS NOT NULL
ON CONFLICT (org_id, entity_id) DO NOTHING;

-- ===== 2. 设备端 worker_id：按姓名匹配 spatial person（P0xx 优先、UUID 次之） =====
-- 每台设备只取一个匹配（同名取 entity_id 最短的 P0xx 风格，避免多匹配脏写）。
UPDATE public.ewoh_spatial_entity d
SET extra = jsonb_set(COALESCE(d.extra, '{}'::jsonb), '{worker_id}',
        to_jsonb(sub.person_id), true),
    _updated_at = now()
FROM public.ewoh_device dev
JOIN LATERAL (
  SELECT s.entity_id AS person_id
  FROM public.ewoh_spatial_entity s
  WHERE s.entity_type = 'person' AND s.name = dev.worker_name
  ORDER BY length(s.entity_id), s.entity_id
  LIMIT 1
) sub ON true
WHERE d.entity_type = 'device'
  AND d.entity_id = dev.device_id
  AND dev.worker_name IS NOT NULL AND dev.worker_name <> ''
  AND d.extra->>'worker_id' IS NULL;

-- ===== 3. person 端 device_id 反向引用 =====
-- 以设备端 worker_id 为准回填 person.extra.device_id（防多设备指向同人的竞态，
-- 每台设备逐个处理：已有人占用的 person 只补第一个，冲突留待第 5 步校验报告）。
UPDATE public.ewoh_spatial_entity p
SET extra = jsonb_set(COALESCE(p.extra, '{}'::jsonb), '{device_id}',
        to_jsonb(d.entity_id), true),
    _updated_at = now()
FROM public.ewoh_spatial_entity d
WHERE p.entity_type = 'person'
  AND d.entity_type = 'device'
  AND d.extra->>'worker_id' = p.entity_id
  AND p.extra->>'device_id' IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.ewoh_spatial_entity other
    WHERE other.entity_type = 'device'
      AND other.extra->>'worker_id' = p.entity_id
      AND other.entity_id < d.entity_id
  );

-- ===== 4. 清空 worker_name 文本（双源消除；列保留向后兼容） =====
UPDATE public.ewoh_device
SET worker_name = NULL
WHERE worker_name IS NOT NULL AND worker_name <> ''
  AND EXISTS (
    SELECT 1 FROM public.ewoh_spatial_entity d
    WHERE d.entity_type = 'device' AND d.entity_id = ewoh_device.device_id
      AND d.extra->>'worker_id' IS NOT NULL
  );

-- ===== 5. 可验证输出 =====
-- SELECT d.entity_id AS device, d.extra->>'worker_id' AS worker,
--        p.name AS worker_name, p.extra->>'device_id' AS person_device
-- FROM ewoh_spatial_entity d
-- LEFT JOIN ewoh_spatial_entity p ON p.entity_type='person'
--   AND p.entity_id = d.extra->>'worker_id'
-- WHERE d.entity_type='device' AND d.extra->>'worker_id' IS NOT NULL
-- ORDER BY d.entity_id;
--
-- -- 冲突校验（应返回 0 行）：
-- -- a) 同一 person 被多台设备绑定
-- SELECT extra->>'device_id' AS dev, count(*) FROM ewoh_spatial_entity
-- WHERE entity_type='person' AND extra->>'device_id' IS NOT NULL
-- GROUP BY 1 HAVING count(*) > 1;
-- -- b) 同一 device 被多 person 指向
-- SELECT entity_id, count(*) FROM ewoh_spatial_entity
-- WHERE entity_type='device' AND extra->>'worker_id' IS NOT NULL
-- GROUP BY 1 HAVING count(*) > 1;
