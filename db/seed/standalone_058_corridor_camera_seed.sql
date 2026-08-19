-- 通道实体 + 监控朝向修复种子（2026-08-20）
-- Schema: public (standalone)。可重入：ON CONFLICT (entity_id) DO UPDATE。
--
-- 背景与根因：
--   1) 「真实车间布局重排」时只注入了 route_node/route_edge 拓扑（画细线），
--      未生成任何可见通道实体（corridor）——且前端 STATIC_ORDER 白名单不含
--      corridor，即使有数据也不渲染 → 「通道生成未生效/看不出口别」。
--   2) 摄像头 CAM-01..04 yaw 全 0（yaw=0 朝右）且 extra 为空（fov/range 走
--      前端默认）→ 全部监控视锥统一朝右。
--
-- 本种子：
--   A) 生成 6 条 corridor 通道实体（车间间连接走廊，坐标对齐车间边界与
--      route 拓扑边走向，肉眼可辨的带状区域）；
--   B) 摄像头朝向改为指向工厂中心 (450,300)——4 个分布于四角/边缘的摄像头
--      视锥从四个方向扇形展开联合覆盖车间主体；补 extra.fov_deg/range
--      （前端像素半径，range_m 为旧字段名由前端兼容）。
--
-- 布局参照（workshop 中心坐标）：
--   hy-quality(150,245) hy-stamping(150,450) hy-welding(370,450)
--   hy-assembly(610,450) hy-logistics(610,245)，工厂 hy-factory(450,300) 900×600。

SELECT set_config('search_path', 'public, pg_temp', false);

-- ===== A. 通道实体（corridor）：6 条，对齐 route 拓扑走廊 =====
INSERT INTO public.ewoh_spatial_entity
  (entity_id, entity_type, parent_id, name, x, y, yaw, bbox_w, bbox_h,
   status, source_type, confidence, version, extra, org_id)
VALUES
  -- 质检↔冲压 纵向通道（y 310-380 空带，对齐 NODE-QC-01→NODE-PRS-01 走向）
  ('COR-QC-PR', 'corridor', 'hy-factory', '通道·质检-冲压', 150, 345, 0, 70, 70,
   'active', 'seed', 1.0, 1,
   '{"corridor_kind":"vertical","connects":["hy-quality","hy-stamping"],"width_m":7}'::jsonb,
   '00000000-0000-4000-8000-000000000001'),
  -- 中部枢纽 纵向通道（x=250，对齐 EDGE-H1-H2：NODE-HUB-01↔NODE-HUB-02）
  ('COR-HUB', 'corridor', 'hy-factory', '通道·中部枢纽', 250, 382, 0, 36, 145,
   'active', 'seed', 1.0, 1,
   '{"corridor_kind":"vertical","connects":["hy-quality","hy-stamping","hy-welding"],"width_m":3.6}'::jsonb,
   '00000000-0000-4000-8000-000000000001'),
  -- 冲压↔焊接 横向通道（x 240-280 空带，对齐 EDGE-PR-W1）
  ('COR-PR-WL', 'corridor', 'hy-factory', '通道·冲压-焊接', 265, 455, 0, 50, 60,
   'active', 'seed', 1.0, 1,
   '{"corridor_kind":"horizontal","connects":["hy-stamping","hy-welding"],"width_m":5}'::jsonb,
   '00000000-0000-4000-8000-000000000001'),
  -- 焊接↔总装 通道（x 460-500 空带 + 斜向 EDGE-W2-AL1 走廊，y 368-478）
  ('COR-WL-AS', 'corridor', 'hy-factory', '通道·焊接-总装', 485, 423, 0, 50, 110,
   'active', 'seed', 1.0, 1,
   '{"corridor_kind":"diagonal","connects":["hy-welding","hy-assembly"],"width_m":5}'::jsonb,
   '00000000-0000-4000-8000-000000000001'),
  -- 质检↔物流 横向主通道（x 240-500 空带，对齐 EDGE-H2-CH 走向）
  ('COR-QC-LO', 'corridor', 'hy-factory', '通道·质检-物流主通道', 370, 289, 0, 260, 42,
   'active', 'seed', 1.0, 1,
   '{"corridor_kind":"horizontal","connects":["hy-quality","hy-logistics"],"width_m":26,"main":true}'::jsonb,
   '00000000-0000-4000-8000-000000000001'),
  -- 物流↔总装 纵向通道（y 310-360 空带，对齐 EDGE-RM-H1/CH→总装线走向）
  ('COR-LO-AS', 'corridor', 'hy-factory', '通道·物流-总装', 610, 335, 0, 70, 50,
   'active', 'seed', 1.0, 1,
   '{"corridor_kind":"vertical","connects":["hy-logistics","hy-assembly"],"width_m":7}'::jsonb,
   '00000000-0000-4000-8000-000000000001')
ON CONFLICT (org_id, entity_id) DO UPDATE
  SET x = EXCLUDED.x, y = EXCLUDED.y, bbox_w = EXCLUDED.bbox_w, bbox_h = EXCLUDED.bbox_h,
      name = EXCLUDED.name, extra = EXCLUDED.extra, _updated_at = now();

-- ===== B. 摄像头：视锥沿车间两条边张开，统一型号（yaw=45/fov=90/range=300）=====
-- 语义（2026-08-20 终版）：一车间一摄像头（布置在车间左上角），视锥两条边界
-- 恰与车间上边（0°）和左边（90°）重合——yaw=45（车间对角线，视锥角平分线）、
-- fov=90（恰等于车间矩形从角落的视角），每台摄像头视觉完全一致（斜 45° 张开、
-- 罩住整个车间、不多不少）；range=300 ≥ 最大车间（总装 220×180）对角线 284。
-- 质检车间原无监控，补 CAM-05（左上角同构布置）。
--   CAM-01 冲压 (62,382) / CAM-02 总装 (502,362) / CAM-03 焊接 (282,382)
--   CAM-04 物流 (502,182) / CAM-05 质检 (62,182) —— 全部 yaw=45
UPDATE public.ewoh_spatial_entity
  SET yaw = 45, extra = jsonb_build_object('fov_deg', 90, 'range', 300, 'height_m', 3.5, 'floor', 1),
      _updated_at = now()
WHERE entity_id = 'CAM-01' AND entity_type = 'camera';

UPDATE public.ewoh_spatial_entity
  SET yaw = 45, extra = jsonb_build_object('fov_deg', 90, 'range', 300, 'height_m', 3.5, 'floor', 1),
      _updated_at = now()
WHERE entity_id = 'CAM-02' AND entity_type = 'camera';

UPDATE public.ewoh_spatial_entity
  SET yaw = 45, extra = jsonb_build_object('fov_deg', 90, 'range', 300, 'height_m', 3.5, 'floor', 1),
      _updated_at = now()
WHERE entity_id = 'CAM-03' AND entity_type = 'camera';

UPDATE public.ewoh_spatial_entity
  SET yaw = 45, extra = jsonb_build_object('fov_deg', 90, 'range', 300, 'height_m', 3.5, 'floor', 1),
      _updated_at = now()
WHERE entity_id = 'CAM-04' AND entity_type = 'camera';

-- 质检车间补装 CAM-05（车间左上角，与其它车间摄像头同构）
INSERT INTO public.ewoh_spatial_entity
  (entity_id, entity_type, parent_id, name, x, y, yaw, bbox_w, bbox_h,
   status, source_type, confidence, version, extra, org_id)
VALUES
  ('CAM-05', 'camera', 'hy-quality', '质检车间监控 CAM-05', 62, 182, 45, 12, 12,
   'online', 'seed', 1.0, 1,
   '{"fov_deg":90,"range":300,"height_m":3.5,"floor":1}'::jsonb,
   '00000000-0000-4000-8000-000000000001')
ON CONFLICT (org_id, entity_id) DO UPDATE
  SET x = EXCLUDED.x, y = EXCLUDED.y, yaw = EXCLUDED.yaw, extra = EXCLUDED.extra,
      name = EXCLUDED.name, _updated_at = now();

-- ===== 可验证输出：通道数量/位置 + 摄像头朝向 =====
-- SELECT entity_id, name, x, y, bbox_w, bbox_h FROM ewoh_spatial_entity WHERE entity_type='corridor' ORDER BY entity_id;
-- SELECT c.entity_id, c.name, c.yaw, c.extra->>'fov_deg' AS fov, c.extra->>'range' AS rng, p.name AS workshop
--   FROM ewoh_spatial_entity c LEFT JOIN ewoh_spatial_entity p ON c.parent_id = p.entity_id
--   WHERE c.entity_type='camera' ORDER BY c.entity_id;
