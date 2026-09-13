-- EWOH 物料一等实体（P4-material-master / 议题 R-2，standalone_099）
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS /
--            DROP POLICY IF EXISTS / ENABLE ROW LEVEL SECURITY（幂等可重复执行）。
--
-- 背景（议题 R-2：物料/订单在数据层没有一等实体 —— 世界模型最实质的空白）：
--   全仓 grep 不到任何 `CREATE TABLE ... material`。client/src/pages/Materials 与
--   server/modules/materials/materials.service.ts 实际读 ewoh_event（ERP 出站事件）
--   与调度表，注释写明「MES 建单时 schedule_task_id = 订单号」。即物料主数据、
--   库存事实、需求/阈值都没有一等实体——只能从自由格式事件载荷**投影**。
--   投影的致命缺陷是 `Number(null ?? 0) === 0`：**读不到**会被静默呈现为
--   「库存 0」。现场据此判断「没料了」或「够用」，两个方向的错误决策都会发生
--   （最高纪律 1 / 原则 7 红线：缺失数据不得被伪造成确定事实）。
--
-- 本迁移落地**最小**一等实体（三张表，不做全套 MRP）：
--   1) ewoh_material              物料主数据（编码 / 名称 / 单位 / 类别 / org）
--   2) ewoh_material_stock        库存事实（物料 × 库位/工位 × 数量 × 时间戳）
--   3) ewoh_material_requirement  缺口投影输入（需求 / 阈值 / 来源）
--
-- 核心不变量（DB 层强制，不依赖「应用层自觉」）：
--     quantity_status='known'   ⟺  quantity IS NOT NULL
--     quantity_status='unknown' ⟹  quantity IS NULL
--   ——未知库存**没有任何数字**可被当成 0；应用层想「把读不到写成 0」会被
--   CHECK 拒绝（fail-closed），而不是悄悄留在表里等人误读。
--
-- 租户边界：三表 TENANT_SCOPED（org_id NOT NULL + RLS）。policy 表达式照抄
--   standalone_060 idempotency_org_isolation / standalone_057 调度族：org 匹配
--   当前 GUC（app.current_org_id，回退 app.primary_org_id）或 global_admin，
--   **不保留** `OR org_id IS NULL` 放行分支 → GUC 全缺且非管理员时表达式为 NULL
--   → fail-closed 全拒（否则 NULL 行对所有租户可见可写）。
--
-- 与契约的关系：物料/库存/需求在本仓最接近的既有实体契约是 ADR-008 world-state 的
--   entityTypeRegistry（material / inventory / order 三类）与 ADR-015 entityKindRegistry；
--   本表是这三类实体在**关系层**的落地存储（source 列沿用 ADR-008 sourceTypeRegistry
--   {real,simulated,derived}，模拟数据显式标记、绝不冒充 real）。
--
-- 回滚语义：全新表（additive）：回滚 = DROP TABLE（索引/约束/RLS 随表级联）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

-- ============================================================================
-- 1) ewoh_material：物料主数据
-- ============================================================================
CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_material (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar(255) NOT NULL,
  material_id varchar(180) NOT NULL,
  material_code varchar(180) NOT NULL,
  name varchar(255) NOT NULL,
  unit varchar(32),
  category varchar(64),
  status varchar(16) NOT NULL DEFAULT 'active',
  source varchar(16) NOT NULL DEFAULT 'real',
  _created_at timestamptz NOT NULL DEFAULT now(),
  _updated_at timestamptz NOT NULL DEFAULT now(),
  _created_by uuid,
  _updated_by uuid,
  CONSTRAINT chk_ewoh_material_keys CHECK (
    material_id <> '' AND material_code <> '' AND name <> ''
  ),
  -- 单位可空：ERP 主数据没给单位时 NULL 是诚实值，不填一个猜的默认单位
  --（NULL 与 '' 语义不同，空串一律拒绝）。
  CONSTRAINT chk_ewoh_material_unit CHECK (unit IS NULL OR unit <> ''),
  CONSTRAINT chk_ewoh_material_status CHECK (status IN ('active','archived')),
  CONSTRAINT chk_ewoh_material_source CHECK (source IN ('real','simulated','derived')),
  CONSTRAINT uq_ewoh_material_org_id UNIQUE (org_id, material_id)
);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_material IS
  '物料主数据（R-2/P4，standalone_099）：编码/名称/单位/类别 + org。TENANT_SCOPED（RLS material_org_isolation）。此前物料主数据无一等实体，只能从事件载荷里"认出"物料号。';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_material.material_id IS
  'EWOH 内部物料规范 ID（material:... 的值部分，ADR-006）；与外部物料编码分离';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_material.material_code IS
  '外部物料编码（ERP/MES 物料号）alias——绝不充当内部 ID（ADR-006）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_material.unit IS
  '计量单位；NULL = 主数据未声明（不猜默认单位，读出即"未知"）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_material.source IS
  '来源 sourceTypeRegistry real/simulated/derived（ADR-008 §13：模拟数据显式标记，绝不冒充 real）';

CREATE INDEX IF NOT EXISTS idx_ewoh_material_org_status
  ON __EWOH_SCHEMA__.ewoh_material (org_id, status);
CREATE INDEX IF NOT EXISTS idx_ewoh_material_org_code
  ON __EWOH_SCHEMA__.ewoh_material (org_id, material_code);

-- ============================================================================
-- 2) ewoh_material_stock：库存事实（物料 × 库位/工位 × 数量 × 时间戳）
--    同一 (材料, 库位) 可有多条历史事实；"当前库存" = 每库位按 observed_at
--    取最新一条后跨库位求和（读侧投影，见 materials.service.ts）。
-- ============================================================================
CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_material_stock (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar(255) NOT NULL,
  stock_id varchar(180) NOT NULL,
  material_id varchar(180) NOT NULL,
  location_id varchar(180) NOT NULL,
  location_kind varchar(32) NOT NULL,
  quantity numeric(20,6),
  unit varchar(32),
  quantity_status varchar(16) NOT NULL,
  source_kind varchar(32) NOT NULL,
  source_ref varchar(255),
  observed_at timestamptz NOT NULL,
  note text,
  _created_at timestamptz NOT NULL DEFAULT now(),
  _updated_at timestamptz NOT NULL DEFAULT now(),
  _created_by uuid,
  _updated_by uuid,
  -- ★ 核心不变量：数量与"是否已知"绑定。known 必须有数、unknown 必须无数字。
  --   这一条让"读不到"在数据层就不可能被写成 0（0 会被本约束判为 known 的伪值）。
  CONSTRAINT chk_ewoh_material_stock_quantity CHECK (
    (quantity_status = 'known' AND quantity IS NOT NULL)
    OR (quantity_status = 'unknown' AND quantity IS NULL)
  ),
  CONSTRAINT chk_ewoh_material_stock_qty_status CHECK (quantity_status IN ('known','unknown')),
  -- location_kind 允许 'unknown'（诚实值）：来源没给库位类型时显式标注，
  -- 而不是替它猜一个 warehouse。
  CONSTRAINT chk_ewoh_material_stock_loc_kind CHECK (
    location_kind IN ('warehouse','station','buffer','unknown')
  ),
  CONSTRAINT chk_ewoh_material_stock_source_kind CHECK (
    source_kind IN ('erp_receipt','erp_consumption','manual_count','sensor')
  ),
  CONSTRAINT chk_ewoh_material_stock_unit CHECK (unit IS NULL OR unit <> ''),
  CONSTRAINT chk_ewoh_material_stock_keys CHECK (
    stock_id <> '' AND material_id <> '' AND location_id <> ''
  ),
  CONSTRAINT uq_ewoh_material_stock_org_id UNIQUE (org_id, stock_id)
);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_material_stock IS
  '库存事实（R-2/P4，standalone_099）：物料 × 库位/工位 × 数量 × 时间戳 + 来源单据。TENANT_SCOPED（RLS material_stock_org_isolation）。CHECK 强制 quantity_status 与 quantity 绑定：未知库存无数字可被当成 0。';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_material_stock.stock_id IS
  '库存事实业务键（外部单据号或确定性派生；UNIQUE (org_id, stock_id) 保证幂等重放不重复计量）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_material_stock.quantity_status IS
  'known=数量可信；unknown=读不到（此时 quantity 必为 NULL）——"未知 ≠ 0"在 DB 层被强制';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_material_stock.observed_at IS
  '事实观察时间（双时态语义的 valid time 落点；同一库位取最新一条为当前值）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_material_stock.location_kind IS
  '库位类型 warehouse/station/buffer/unknown（unknown=来源未分类，诚实值不猜）';

CREATE INDEX IF NOT EXISTS idx_ewoh_material_stock_material
  ON __EWOH_SCHEMA__.ewoh_material_stock (org_id, material_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_ewoh_material_stock_location
  ON __EWOH_SCHEMA__.ewoh_material_stock (org_id, location_id);

-- ============================================================================
-- 3) ewoh_material_requirement：需求 / 阈值 / 来源（缺口投影输入）
--    threshold = 再订货点（主数据）；demand = 未完工订单需求（BOM 展开后）。
--    与库存同款：quantity_status 绑定 quantity，未声明就是 NULL 而不是 0。
-- ============================================================================
CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_material_requirement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar(255) NOT NULL,
  requirement_id varchar(180) NOT NULL,
  material_id varchar(180) NOT NULL,
  requirement_type varchar(32) NOT NULL,
  quantity numeric(20,6),
  quantity_status varchar(16) NOT NULL,
  unit varchar(32),
  source_kind varchar(32) NOT NULL,
  source_ref varchar(255),
  due_at timestamptz,
  effective_at timestamptz NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'open',
  note text,
  _created_at timestamptz NOT NULL DEFAULT now(),
  _updated_at timestamptz NOT NULL DEFAULT now(),
  _created_by uuid,
  _updated_by uuid,
  -- 与 ewoh_material_stock 同款核心不变量（阈值/需求"读不到"同样不得写成 0）。
  CONSTRAINT chk_ewoh_material_req_quantity CHECK (
    (quantity_status = 'known' AND quantity IS NOT NULL)
    OR (quantity_status = 'unknown' AND quantity IS NULL)
  ),
  CONSTRAINT chk_ewoh_material_req_type CHECK (requirement_type IN ('threshold','demand')),
  CONSTRAINT chk_ewoh_material_req_qty_status CHECK (quantity_status IN ('known','unknown')),
  CONSTRAINT chk_ewoh_material_req_source_kind CHECK (source_kind IN ('erp_master','erp_order','manual')),
  CONSTRAINT chk_ewoh_material_req_status CHECK (status IN ('open','closed')),
  CONSTRAINT chk_ewoh_material_req_unit CHECK (unit IS NULL OR unit <> ''),
  CONSTRAINT chk_ewoh_material_req_keys CHECK (requirement_id <> '' AND material_id <> ''),
  CONSTRAINT uq_ewoh_material_req_org_id UNIQUE (org_id, requirement_id)
);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_material_requirement IS
  '物料需求/阈值台账（R-2/P4，standalone_099）：缺口投影的输入（需求 / 再订货点阈值 / 来源单据）。TENANT_SCOPED（RLS material_requirement_org_isolation）。';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_material_requirement.requirement_type IS
  'threshold=再订货点（主数据）；demand=未完工订单需求（BOM 展开）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_material_requirement.source_kind IS
  '来源：erp_master（主数据推送）/ erp_order（订单）/ manual（人工录入）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_material_requirement.source_ref IS
  '来源单据号（订单号等，可追溯）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_material_requirement.quantity_status IS
  'known=数量可信；unknown=读不到（quantity 必为 NULL）——阈值未声明时读出"未声明"，不是 0';

CREATE INDEX IF NOT EXISTS idx_ewoh_material_req_material
  ON __EWOH_SCHEMA__.ewoh_material_requirement (org_id, material_id, requirement_type, status);
CREATE INDEX IF NOT EXISTS idx_ewoh_material_req_source
  ON __EWOH_SCHEMA__.ewoh_material_requirement (org_id, source_ref);

-- ============================================================================
-- 4) RLS + 授权（三表同款；表达式与 standalone_057/060/098 同形）
--    幂等：DROP POLICY IF EXISTS 后重建，policy 名固定，verify 断言不漂移。
-- ============================================================================

ALTER TABLE __EWOH_SCHEMA__.ewoh_material ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS material_org_isolation ON __EWOH_SCHEMA__.ewoh_material;
CREATE POLICY material_org_isolation ON __EWOH_SCHEMA__.ewoh_material
  FOR ALL TO service_role
  USING (
    org_id::text = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR COALESCE(NULLIF(current_setting('app.is_global_admin', true), ''), 'false') = 'true'
  )
  WITH CHECK (
    org_id::text = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR COALESCE(NULLIF(current_setting('app.is_global_admin', true), ''), 'false') = 'true'
  );

ALTER TABLE __EWOH_SCHEMA__.ewoh_material_stock ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS material_stock_org_isolation ON __EWOH_SCHEMA__.ewoh_material_stock;
CREATE POLICY material_stock_org_isolation ON __EWOH_SCHEMA__.ewoh_material_stock
  FOR ALL TO service_role
  USING (
    org_id::text = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR COALESCE(NULLIF(current_setting('app.is_global_admin', true), ''), 'false') = 'true'
  )
  WITH CHECK (
    org_id::text = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR COALESCE(NULLIF(current_setting('app.is_global_admin', true), ''), 'false') = 'true'
  );

ALTER TABLE __EWOH_SCHEMA__.ewoh_material_requirement ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS material_requirement_org_isolation ON __EWOH_SCHEMA__.ewoh_material_requirement;
CREATE POLICY material_requirement_org_isolation ON __EWOH_SCHEMA__.ewoh_material_requirement
  FOR ALL TO service_role
  USING (
    org_id::text = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR COALESCE(NULLIF(current_setting('app.is_global_admin', true), ''), 'false') = 'true'
  )
  WITH CHECK (
    org_id::text = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR COALESCE(NULLIF(current_setting('app.is_global_admin', true), ''), 'false') = 'true'
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_material TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_material_stock TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_material_requirement TO service_role;
