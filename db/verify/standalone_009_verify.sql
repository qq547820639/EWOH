-- EWOH Dispatch atomic preemption — DB guard verification (Task 2)
-- Returns a single row with:
--   reservation_no_overlap_guard — 1 if the no-overlap exclusion guard exists
-- A result of 1 means the migration applied cleanly.
--
-- 最终形态说明（2026-09-11 修复：全新安装验证失败）：
-- standalone_009 在全新库上先于 017（建表）执行，DO 块以 to_regclass 守卫静默跳过；
-- standalone_022 随后显式 DROP 旧约束 ewoh_resource_reservation_no_overlap，并以
-- ewoh_resource_reservation_no_overlap_person_device（EXCLUDE USING gist）承接最终形态
-- （station 容量>1 由应用层容量感知 + advisory lock 承接，见 022 约束注释）。
-- 因此本验证接受任一形态：旧库（009 直接生效且 022 尚未 drop 的过渡态）或
-- 最终形态（022 已应用）均视为 guard=1。
SELECT
  (SELECT count(*)::bigint
     FROM pg_constraint c
    WHERE c.conname IN (
            'ewoh_resource_reservation_no_overlap',
            'ewoh_resource_reservation_no_overlap_person_device'
          )
      AND c.conrelid = '__EWOH_SCHEMA__.ewoh_resource_reservation'::regclass
  ) AS reservation_no_overlap_guard;
