-- 107: 控制请求状态词表收敛到契约（REQST-01）
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: 先删后建同名 CHECK；存量若有本迁移未覆盖的词表外值，ADD CONSTRAINT 会显式失败而不是静默保留。
--
-- 背景（V296 登记 REQST-01，先例 standalone_071_task_status_contract.sql）：
-- `ewoh_control_request.status` 的 DDL 与 ORM 默认都是 `draft`，而 `contracts/state-machines/control.yaml:3-13`
-- 声明的 10 个**请求级**态里没有它；这一列此前没有任何 CHECK（同仓对 `ewoh_production_task` 是加了 CHECK 的）。
-- 于是"省略 status 的写入"会静默落进一个状态机不认识的值：产品码那唯一一处 INSERT
-- （`control.service.ts:465`）总是显式给 `pending_approval`/`created`，但链上常驻用例的三条 raw INSERT
-- （`test/e2e/backlog-snapshot-failure-boundary.e2e.spec.ts`）就是省略该列写的。
-- 同一次取证还显式写入了 `gateway_received` 并被接受——那一态在契约里声明了却没有任何请求级写者，
-- 属裁决项 R23；本迁移按**契约现词表**加约束（含 `gateway_received`），R23 若拍"删该态"再同步收窄。
--
-- 归一化只处理这一个**已确认的别名**（`draft` ← DDL 默认值），语义上它就是"请求已创建、还没有 attempt"，
-- 即契约初态 `created`；不猜测、不改写其它未知自定义值——那些会在下一步的 ADD CONSTRAINT 上响亮失败。
--
-- 回滚语义：DROP CONSTRAINT ＋ 默认值改回 `draft`（不修改任何现场事实；已按新词表写入的行不受影响）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

-- 1) 存量：词表外默认值 `draft` → 契约初态 `created`
UPDATE __EWOH_SCHEMA__.ewoh_control_request
   SET status = 'created',
       _updated_at = CURRENT_TIMESTAMP
 WHERE status = 'draft';

-- 2) 默认值脱离词表外：省略 status 的写入落进契约初态，而不是一个状态机不认识的值
ALTER TABLE __EWOH_SCHEMA__.ewoh_control_request
  ALTER COLUMN status SET DEFAULT 'created';

-- 3) 把请求级词表钉进库：新写入必须走状态机
DO $$
BEGIN
  ALTER TABLE __EWOH_SCHEMA__.ewoh_control_request
    DROP CONSTRAINT IF EXISTS ck_control_request_status_contract;
  ALTER TABLE __EWOH_SCHEMA__.ewoh_control_request
    ADD CONSTRAINT ck_control_request_status_contract CHECK (
      status IN (
        'created', 'pending_approval', 'approved', 'pending_gateway', 'gateway_received',
        'executed', 'partial_success', 'failed', 'timeout', 'revoked'
      )
    );
END $$;
