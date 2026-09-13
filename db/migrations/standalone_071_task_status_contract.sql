-- 071: 生产任务状态词表收敛到契约（contracts/state-machines/task.yaml）
--
-- 背景（2026-09-10 交付闭环审计）：
-- demo seed（db/seed/standalone_006_scheduling_seed.sql）向
-- `ewoh_production_task.status` 写入了 `pending` / `queued`，但这两个状态
-- **不在** task.yaml 状态机里（契约的派发前状态是 `pending_dispatch`）。
-- 同时 `TaskLifecycle.isDispatchable` 只接受契约状态，于是存量为
-- pending/queued 的任务可以被排程、被审批，却永远无法派发：
-- dispatch 抛 PLAN_TASK_NOT_DISPATCHABLE，方案停在 approved，任务卡死，
-- 且没有提示说明原因——一条被半程状态迁移堵死的死路。
--
-- 本迁移把存量行归一化到契约状态，使旧库与新库语义一致。派发路径同时保留
-- 运行期兼容（见 dispatch-coordinator.service.ts），即使本迁移未执行，
-- 存量任务也能被派发并自动收敛，不会再静默死锁。
--
-- 注意：`ewoh_schedule_task` 是 MES 工单镜像表，词表来自 ADR-012 契约
-- （created/scheduled/in_progress/completed/closed/cancelled，MES 侧写作
-- draft/released/in_progress/completed/cancelled）。同一 seed 也写过
-- `queued`（MES 无法识别），一并收敛为 `released`（= 契约 scheduled）。
-- 未识别的自定义状态不会被本迁移改动——只处理这两个已确认的别名。

-- 1) 生产任务：契约外派发前状态 → pending_dispatch
UPDATE __EWOH_SCHEMA__.ewoh_production_task
   SET status = 'pending_dispatch',
       _updated_at = CURRENT_TIMESTAMP
 WHERE status IN ('pending', 'queued');

-- 2) MES 工单镜像：queued → released（仅当该表存在且使用该词表时）
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = '__EWOH_SCHEMA__'
      AND table_name = 'ewoh_schedule_task'
      AND column_name = 'status'
  ) THEN
    UPDATE __EWOH_SCHEMA__.ewoh_schedule_task
       SET status = 'released',
           _updated_at = CURRENT_TIMESTAMP
     WHERE status = 'queued';
  END IF;
END $$;

-- 3) 防止再次写入契约外状态（新写入必须走状态机）。
--    使用 NOT VALID 语义的等价做法：先加约束，失败则说明仍有脏数据，
--    由运维决定是继续归一化还是保留。这里直接加硬约束——若上面的 UPDATE
--    已覆盖全部已知别名，则约束必然可加；历史自定义状态会在此显式失败，
--    而不是继续静默存在。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '__EWOH_SCHEMA__.ewoh_production_task'::regclass
      AND conname = 'ck_production_task_status_contract'
  ) THEN
    ALTER TABLE __EWOH_SCHEMA__.ewoh_production_task
      ADD CONSTRAINT ck_production_task_status_contract CHECK (
        status IN (
          'draft', 'pending_confirm', 'pending_approval', 'pending_dispatch',
          'dispatched', 'received', 'executing', 'paused', 'exception',
          'completed', 'cancelled'
        )
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_production_task_status_contract
  ON __EWOH_SCHEMA__.ewoh_production_task (org_id, status);
