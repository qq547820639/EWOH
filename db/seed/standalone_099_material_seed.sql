-- 物料一等实体演示种子（P4-material-master / 议题 R-2，与 standalone_099 配套）
-- Schema: public (standalone)。可重入：ON CONFLICT (org_id, <业务键>) DO NOTHING。
--
-- 目的：给演示租户（默认 org 00000000-0000-4000-8000-000000000001）插入**可复现**的
--   物料主数据 / 库存事实 / 需求阈值样本，让 /api/materials 的一等实体读面
--   （materials.service.ts → ewoh_material/stock/requirement）有真实数据可投影。
--
-- 覆盖四种缺口结论（现场要能一眼看全）：
--   · MAT-MODULE-A   库存 120，阈值 50 → 正常（ok）
--   · MAT-WELD-WIRE  库存 8.5 kg，阈值 20 kg → 低于再订货点（below_threshold）
--   · MAT-COVER-EXT  库存 30，订单需求 60 → 不足以覆盖未完工订单（below_demand）
--   · MAT-PACK-BOX   库存**读不到**（quantity_status='unknown'）→ 库存未知，
--                    绝不落 0（下方那条 unknown 行就是"读不到"的样本；服务层
--                    会把它投影成 onHand=null + unparsable 显式列出，而不是 0）
--
-- 依赖：standalone_099_material_entity.sql 已应用（三表存在）。

SELECT set_config('search_path', 'public, pg_temp', false);

-- ===== 1) 物料主数据 =====
INSERT INTO public.ewoh_material
  (org_id, material_id, material_code, name, unit, category, status, source)
VALUES
  ('00000000-0000-4000-8000-000000000001', 'MAT-MODULE-A', 'MAT-MODULE-A', '模组 A', '件', '结构件', 'active', 'real'),
  ('00000000-0000-4000-8000-000000000001', 'MAT-WELD-WIRE', 'MAT-WELD-WIRE', '焊丝', 'kg', '耗材', 'active', 'real'),
  ('00000000-0000-4000-8000-000000000001', 'MAT-COVER-EXT', 'MAT-COVER-EXT', '外观件', '件', '外观件', 'active', 'real'),
  ('00000000-0000-4000-8000-000000000001', 'MAT-PACK-BOX', 'MAT-PACK-BOX', '包装箱', '件', '包装', 'active', 'real')
ON CONFLICT (org_id, material_id) DO NOTHING;

-- ===== 2) 库存事实（物料 × 库位 × 数量 × 时间戳）=====
-- 最后一条刻意用 quantity_status='unknown' + quantity NULL：这是"读不到"的
-- 一等表达。种子本身不允许写 0（DB CHECK 会拒），演示的就是"未知 ≠ 0"。
INSERT INTO public.ewoh_material_stock
  (org_id, stock_id, material_id, location_id, location_kind, quantity, unit,
   quantity_status, source_kind, source_ref, observed_at)
VALUES
  ('00000000-0000-4000-8000-000000000001', 'STK-MAT-MODULE-A-WH-A', 'MAT-MODULE-A', 'WH-A', 'warehouse', 120, '件',
   'known', 'erp_receipt', 'SEED-RCPT-001', now() - interval '2 hours'),
  ('00000000-0000-4000-8000-000000000001', 'STK-MAT-WELD-WIRE-WH-B', 'MAT-WELD-WIRE', 'WH-B', 'warehouse', 8.5, 'kg',
   'known', 'erp_receipt', 'SEED-RCPT-002', now() - interval '3 hours'),
  ('00000000-0000-4000-8000-000000000001', 'STK-MAT-COVER-EXT-LINE-B', 'MAT-COVER-EXT', 'LINE-B', 'station', 30, '件',
   'known', 'manual_count', 'SEED-COUNT-003', now() - interval '1 hour'),
  ('00000000-0000-4000-8000-000000000001', 'STK-MAT-PACK-BOX-WH-C', 'MAT-PACK-BOX', 'WH-C', 'warehouse', NULL, '件',
   'unknown', 'manual_count', 'SEED-COUNT-004', now() - interval '30 minutes')
ON CONFLICT (org_id, stock_id) DO NOTHING;

-- ===== 3) 需求 / 阈值 / 来源 =====
INSERT INTO public.ewoh_material_requirement
  (org_id, requirement_id, material_id, requirement_type, quantity, unit,
   quantity_status, source_kind, source_ref, due_at, effective_at, status)
VALUES
  -- 再订货点阈值（主数据）：模块 A 阈值 50，库存 120 → 正常
  ('00000000-0000-4000-8000-000000000001', 'REQ-MAT-MODULE-A-THR', 'MAT-MODULE-A', 'threshold', 50, '件',
   'known', 'erp_master', NULL, NULL, now() - interval '1 day', 'open'),
  -- 再订货点阈值：焊丝阈值 20，库存 8.5 → 低于再订货点
  ('00000000-0000-4000-8000-000000000001', 'REQ-MAT-WELD-WIRE-THR', 'MAT-WELD-WIRE', 'threshold', 20, 'kg',
   'known', 'erp_master', NULL, NULL, now() - interval '1 day', 'open'),
  -- 订单需求：外观件 60 件（订单 MO-2026-0918），库存 30 → 需求缺口
  ('00000000-0000-4000-8000-000000000001', 'REQ-MAT-COVER-EXT-MO0918', 'MAT-COVER-EXT', 'demand', 60, '件',
   'known', 'erp_order', 'MO-2026-0918', now() + interval '6 hours', now() - interval '2 hours', 'open'),
  -- 包装箱阈值：库存读不到（上方 unknown 行）→ 现场看到"库存未知"，不是 0
  ('00000000-0000-4000-8000-000000000001', 'REQ-MAT-PACK-BOX-THR', 'MAT-PACK-BOX', 'threshold', 100, '件',
   'known', 'erp_master', NULL, NULL, now() - interval '1 day', 'open')
ON CONFLICT (org_id, requirement_id) DO NOTHING;
