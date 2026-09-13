-- EWOH 班次域 (standalone_074, DR-2 班次工作台)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS /
--            DROP POLICY IF EXISTS / ENABLE ROW LEVEL SECURITY（幂等可重复执行）。
--
-- 背景（目标三"班次工作台"）：
--   1) 班次(Shift)是工厂现场的第一组织事实——异常、任务、审批、交接都发生在
--      "某个班"内；此前 personnel.shift 只是自由文本，无法支撑"当班视角"聚合；
--   2) 交接班(Handover)是班次运行记忆的节点：遗留事项(open_items)显式结构化，
--      不允许"口头交接、系统无痕"；
--   3) 租户边界：TENANT_SCOPED（org_id NOT NULL + RLS shift_org_isolation /
--      shift_handover_org_isolation）。
--
-- 回滚语义：两张表均为全新（additive）；回滚 = DROP TABLE。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_shift (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar(255) NOT NULL,
  shift_id varchar(255) NOT NULL,
  name varchar(255) NOT NULL,
  code varchar(32),
  start_time time NOT NULL,
  end_time time NOT NULL,
  crosses_midnight boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  lead_user_id uuid,
  description text,
  _created_at timestamptz NOT NULL DEFAULT now(),
  _updated_at timestamptz NOT NULL DEFAULT now(),
  _created_by uuid,
  _updated_by uuid,
  CONSTRAINT chk_ewoh_shift_window CHECK (start_time <> end_time),
  CONSTRAINT uq_ewoh_shift UNIQUE (org_id, shift_id)
);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_shift IS
  '班次定义（DR-2 班次工作台）。一天内的循环时段窗口：start_time/end_time 为本地时区 time，跨零点班次（如夜班 22:00-06:00）以 crosses_midnight 显式标记，由服务端 resolveShiftAt 判定归属，不在查询侧隐式推断。TENANT_SCOPED（RLS shift_org_isolation）。';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_shift.crosses_midnight IS '窗口是否跨零点（22:00-06:00 类）；判定语义：start<=t<end（普通）或 t>=start OR t<end（跨零点）';

CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_shift_handover (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar(255) NOT NULL,
  handover_id varchar(255) NOT NULL,
  shift_id varchar(255) NOT NULL,
  shift_date date NOT NULL,
  from_user_id uuid,
  to_user_id uuid NOT NULL,
  open_items_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes text,
  status varchar(32) NOT NULL DEFAULT 'confirmed',
  confirmed_at timestamptz,
  _created_at timestamptz NOT NULL DEFAULT now(),
  _updated_at timestamptz NOT NULL DEFAULT now(),
  _created_by uuid,
  _updated_by uuid,
  CONSTRAINT chk_ewoh_shift_handover_status CHECK (status IN ('pending', 'confirmed')),
  CONSTRAINT chk_ewoh_shift_handover_items CHECK (jsonb_typeof(open_items_json) = 'array'),
  CONSTRAINT uq_ewoh_shift_handover UNIQUE (org_id, handover_id)
);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_shift_handover IS
  '交接班记录（DR-2）。遗留事项 open_items_json 结构化数组（[{title, severity, relatedObjectType, relatedObjectId, note}]），交接事实（from/to/确认时间）完整留痕；pending 状态允许接班人确认后置 confirmed（可审计的两步交接）。TENANT_SCOPED（RLS shift_handover_org_isolation）。';

CREATE INDEX IF NOT EXISTS idx_ewoh_shift_active
  ON __EWOH_SCHEMA__.ewoh_shift (org_id, active);
CREATE INDEX IF NOT EXISTS idx_ewoh_shift_handover_date
  ON __EWOH_SCHEMA__.ewoh_shift_handover (org_id, shift_date DESC);

ALTER TABLE __EWOH_SCHEMA__.ewoh_shift ENABLE ROW LEVEL SECURITY;
ALTER TABLE __EWOH_SCHEMA__.ewoh_shift_handover ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS shift_org_isolation ON __EWOH_SCHEMA__.ewoh_shift;
CREATE POLICY shift_org_isolation
  ON __EWOH_SCHEMA__.ewoh_shift
  FOR ALL
  TO service_role
  USING (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
  )
  WITH CHECK (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
  );

DROP POLICY IF EXISTS shift_handover_org_isolation ON __EWOH_SCHEMA__.ewoh_shift_handover;
CREATE POLICY shift_handover_org_isolation
  ON __EWOH_SCHEMA__.ewoh_shift_handover
  FOR ALL
  TO service_role
  USING (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
  )
  WITH CHECK (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_shift TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_shift_handover TO service_role;
