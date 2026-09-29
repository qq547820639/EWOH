/**
 * AgentTask 状态推进的**读-写窗口**实测（真实 Nest + 真实 PostgreSQL）。
 *
 * 为什么单独立一个文件：`AgentOrchestratorService.transition()` 是全仓第 4 个
 * "单一写者 + CAS + 0 行冲突"样本，也是唯一长在链外模块的那个。它的 fail-closed
 * 半边此前**只有一行注释**：抛出点 `task_state_changed_concurrently` 在整仓没有任何
 * 断言（grep 只命中 product 代码里的那次 `throw`）。⇒ "0 行 = 并发冲突显式失败、
 * 不覆盖别人的事实、不留状态痕迹"这句话从没被观测过。
 *
 * 怎么把窗口撑开（不用假 DB、不用 sleep）：请求级事务里那句守卫读是**无锁快照读**，
 * 行锁直到 UPDATE 才申请。所以让第二个 service_role 会话先 `UPDATE … status='cancelled'`
 * 且**不提交**，应用的 UPDATE 就会在行锁上排队；测试从 `pg_stat_activity` 确认"确实有一个
 * 属于本应用的 UPDATE 正在等 Lock"（效力断言，不成立即失败，绝不静默降级成 happy path），
 * 再放行提交。锁释放后 PostgreSQL 以 READ COMMITTED 重读该行 ⇒ CAS 谓词落空 ⇒ 0 行。
 * ⇒ 交错由 DB 自己的锁管理器产生，与真实世界"另一个写者抢先提交"是同一条机制。
 *
 * 三条用例是一组对照：AC-01 注入必须开火；AC-02 撤掉干预必须不开火（同一请求、同一夹具
 * 形状 ⇒ 201 且恰好一条状态审计，排除"400 其实是夹具/鉴权坏了"这种假正面）；AC-03 用两个
 * 真实并发请求只断言不变量（唯一一次生效、唯一一条痕迹），并如实写明它**不保证**命中 CAS
 * 窗口——命中与否由 AC-01 确定性负责。
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { resolveE2EConfig } from '../helpers/e2e-config';
import {
  cleanupE2EFixture,
  connectOwner,
  createE2EFixture,
  type E2EFixture,
  type OwnerSql,
} from '../helpers/e2e-db';
import { startE2EApp, type E2EAppHandle } from '../helpers/e2e-app';
import { apiRequest, jsonHeaders, login } from '../helpers/e2e-http';

const config = resolveE2EConfig();

/** 合法契约体（validateAgentTask fail-closed：必填字段 + 规范身份 + budget 三项 + auditTrail）。 */
function taskContract(): Record<string, unknown> {
  return {
    taskId: `task:${randomUUID()}`,
    name: 'E2E CAS 读-写窗口任务',
    version: 1,
    kind: 'analysis',
    assignedRole: 'Scheduling',
    dependencies: [],
    inputContract: { schemaRef: 'contracts/agent-task/agent-task.schema.json' },
    outputContract: { schemaRef: 'contracts/agent-task/agent-task.schema.json' },
    priority: 'medium',
    createdAt: new Date().toISOString(),
    budget: { maxSteps: 10, maxTokens: 1000, maxDurationSec: 60 },
    status: 'created',
    auditTrail: true,
  };
}

type ActivityRow = {
  pid: string | number;
  wait_event_type: string | null;
  wait_event: string | null;
  state: string;
  query: string;
};

(config ? describe : describe.skip)(
  'AgentTask CAS 读-写窗口 E2E（真实 PostgreSQL）',
  () => {
    let owner: OwnerSql;
    let fixture: E2EFixture;
    let handle: E2EAppHandle;
    let token: string;

    beforeAll(async () => {
      owner = await connectOwner(config!.ownerDatabaseUrl);
    });
    beforeEach(async () => {
      fixture = await createE2EFixture(owner);
      handle = await startE2EApp(config!, fixture.orgA.id);
      const auth = await login(
        handle.baseUrl,
        fixture.dispatcherA.username,
        fixture.dispatcherA.password,
      );
      expect(auth.status).toBe(201);
      token = auth.body.accessToken;
    });
    afterEach(async () => {
      try {
        await handle?.close();
      } finally {
        if (fixture) await cleanupE2EFixture(owner, fixture);
      }
    });
    afterAll(async () => {
      await owner?.end();
    });

    async function createTask(): Promise<string> {
      const body = taskContract();
      const created = await apiRequest<{ taskId?: string }>(
        handle.baseUrl,
        '/api/agents/tasks',
        { method: 'POST', headers: jsonHeaders(token), body: JSON.stringify(body) },
      );
      expect(created.status).toBe(201);
      expect(created.body?.taskId).toBe(body.taskId);
      return String(body.taskId);
    }

    /**
     * 错误包络取消息。实测形状（本轮读到，`server/common/filters/exception.filter.ts`）：
     * `{"error":{"code":"BAD_REQUEST","message":"<异常消息>","retryable":false,
     *   "recommendedAction":"请检查请求参数后重试"}}` —— 顶层没有 message。
     * `retryable` 由 HTTP 状态白名单（429/500/502/503/504）算出 ⇒ 读-写竞态被标成
     * "不可重试 + 去检查参数"，这条语义是否得当已单独登记（不在本用例里当作正确行为钉住）。
     */
    const errorText = (body: unknown) =>
      JSON.stringify((body as { error?: Record<string, unknown> })?.error ?? body ?? '');

    const dispatch = (taskId: string) =>
      apiRequest<{ error?: { code?: string; message?: string } }>(
        handle.baseUrl,
        `/api/agents/tasks/${encodeURIComponent(taskId)}/dispatch`,
        { method: 'POST', headers: jsonHeaders(token) },
      );

    /** 行终态 + 状态审计 + 事件：转移"发生过吗"的三面独立读数（org 谓词一律转 text）。 */
    async function readBack(taskId: string) {
      const rows =
        await owner`SELECT status FROM ewoh_agent_task
                     WHERE org_id::text = ${fixture.orgA.id} AND task_id = ${taskId}`;
      const audits =
        await owner`SELECT action, count(*)::int AS n FROM ewoh_audit_log
                     WHERE org_id::text = ${fixture.orgA.id}
                       AND entity_type = 'agent_task' AND entity_id = ${taskId}
                     GROUP BY action`;
      const events =
        await owner`SELECT event_code, count(*)::int AS n FROM ewoh_event
                     WHERE org_id::text = ${fixture.orgA.id}
                       AND title LIKE ${`agent-task:${taskId}%`}
                     GROUP BY event_code`;
      const countOf = (action: string) =>
        (audits as unknown as Array<{ action: string; n: number }>).reduce(
          (n, r) => (r.action === action ? n + r.n : n),
          0,
        );
      return {
        status: (rows[0] as { status?: string } | undefined)?.status,
        createdAudit: countOf('agent.task.created'),
        dispatchedAudit: countOf('agent.task.dispatched'),
        events: (events as unknown as Array<{ event_code: string; n: number }>).map(
          (e) => `${e.event_code}=${e.n}`,
        ),
      };
    }

    /**
     * 持有一个**未提交**的状态改写（即"另一个写者"），返回释放句柄。
     * 返回前必须确认 UPDATE 已命中 1 行：0 行就什么都没锁住，AC-01 会静默退化成 AC-02，
     * 而那条 400 也就不是并发冲突的裁决——这是本用例唯一的失效模式。
     */
    async function holdUncommittedRewrite(taskId: string, target: string) {
      const session = postgres(config!.runtimeDatabaseUrl, { max: 1 });
      let releaseGate!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      let markHeld!: () => void;
      const heldSignal = new Promise<void>((resolve) => {
        markHeld = resolve;
      });
      let heldRows = 0;
      const transaction = session
        .begin(async (tx) => {
          await tx`select set_config('app.current_org_id', ${fixture.orgA.id}, true)`;
          const rows =
            await tx`UPDATE ewoh_agent_task SET status = ${target}
                       WHERE org_id::text = ${fixture.orgA.id}
                         AND task_id = ${taskId} AND status = 'created'
                       RETURNING task_id`;
          heldRows = rows.length;
          markHeld();
          if (rows.length !== 1) {
            throw new Error(`干预会话未命中行（行锁并未持有）：${rows.length} 行`);
          }
          await gate;
          return heldRows;
        })
        .then(
          () => ({ error: null as string | null }),
          (error: unknown) => ({ error: String(error) }),
        );
      // 只等"UPDATE 已执行"，不等事务结束（事务结束正是要制造的临界点）
      await Promise.race([
        heldSignal,
        transaction.then((r) => {
          throw new Error(`干预事务提前结束：${r.error ?? '已提交'}`);
        }),
      ]);
      return {
        heldRows,
        release: async () => {
          releaseGate();
          return transaction;
        },
        close: async () => {
          releaseGate();
          await transaction;
          await session.end({ timeout: 5 });
        },
      };
    }

    /** 效力断言：必须看到"本应用的 UPDATE 正在等行锁"，否则本轮不出结论。 */
    async function waitLockedUpdate(appName: string, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      const observed: string[] = [];
      for (;;) {
        const rows = (await owner`
          SELECT pid, wait_event_type, wait_event, state, left(query, 140) AS query
            FROM pg_stat_activity
           WHERE application_name = ${appName}
             AND position('update "ewoh_agent_task"' in lower(query)) > 0`) as ActivityRow[];
        for (const r of rows) {
          observed.push(`${r.pid}:${r.state}/${r.wait_event_type ?? '-'}`);
        }
        const blocked = rows.find((r) => r.wait_event_type === 'Lock');
        if (blocked) {
          return { pid: Number(blocked.pid), waitEvent: String(blocked.wait_event) };
        }
        if (Date.now() > deadline) {
          throw new Error(
            `前提未成立：${timeoutMs}ms 内没有观测到应用侧被行锁阻塞的 UPDATE ewoh_agent_task`
              + `（application_name=${appName}）⇒ 读-写窗口未被撑开，不得把结果当成"已实测"。`
              + `期间活动会话=${observed.length ? observed.join(', ') : '（一个都没有）'}`,
          );
        }
        await new Promise((r) => setTimeout(r, 25));
      }
    }

    it('AC-01: 读当前态与 CAS 写之间被另一写者提交 ⇒ 0 行冲突 400、行终态是别人的值、不留状态痕迹', async () => {
      const taskId = await createTask();
      const writer = await holdUncommittedRewrite(taskId, 'cancelled');
      expect(writer.heldRows).toBe(1);
      // 先把失败形态收敛成「一个可断言的读数」：任何未处理的 fetch/连接异常都会变成
      // status=0 + fetchError 文本，而不是一个游离的 rejected promise（那会让失败原因只剩堆栈）。
      let fetchError = '';
      const pending: Promise<{ status: number; body: unknown }> = dispatch(taskId).then(
        (r) => ({ status: r.status, body: r.body }),
        (error: unknown) => {
          fetchError = String(error);
          return { status: 0, body: null };
        },
      );
      try {
        const blocked = await waitLockedUpdate(handle.databaseApplicationName);
        expect(String(blocked.waitEvent)).toBeTruthy();
        const verdict = await writer.release();
        expect(verdict.error).toBeNull();
        const response = await pending;
        expect(fetchError).toBe('');
        expect(response.status).toBe(400);
        expect(errorText(response.body)).toContain('task_state_changed_concurrently');
      } finally {
        await writer.close();
      }
      const after = await readBack(taskId);
      // 服务没有把自己的目标态盖回去：赢者的事实存活。若 CAS 谓词丢失即变成盲写，此行必红。
      expect(after.status).toBe('cancelled');
      // 失败腿不写状态痕迹（auditAppend 在 throw 之后），创建腿的痕迹仍在
      expect(after.dispatchedAudit).toBe(0);
      expect(after.createdAudit).toBe(1);
      expect(after.events).toEqual(['AGENT_TASK_CREATED=1']);
    });

    it('AC-02: 撤掉干预（同一请求、同一夹具）⇒ 201 且恰好一次状态转移（对照组，判据不得开火）', async () => {
      const taskId = await createTask();
      const response = await dispatch(taskId);
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ taskId, status: 'dispatched' });
      const after = await readBack(taskId);
      expect(after.status).toBe('dispatched');
      expect(after.dispatchedAudit).toBe(1);
      expect(after.createdAudit).toBe(1);
      expect(after.events).toEqual(['AGENT_TASK_CREATED=1']);
    });

    it('AC-03: 两个真实并发 dispatch ⇒ 恰好一次生效、恰好一条状态审计（只断言不变量）', async () => {
      const taskId = await createTask();
      const responses = await Promise.all([dispatch(taskId), dispatch(taskId)]);
      const statuses = responses.map((r) => r.status);
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      for (const status of statuses) expect([201, 400]).toContain(status);
      const loser = responses.find((r) => r.status === 400);
      // 输家有两种合法裁决，取决于它的守卫读落在赢者提交前还是提交后：
      // 读在前 ⇒ CAS 落空（task_state_changed_concurrently）；读在后 ⇒ 转移表直接拒绝。
      // 本用例不保证命中哪一种（确定性命中是 AC-01 的职责），只保证「唯一一次生效」。
      expect(errorText(loser?.body)).toMatch(
        /task_state_changed_concurrently|invalid_transition:/,
      );
      const after = await readBack(taskId);
      expect(after.status).toBe('dispatched');
      expect(after.dispatchedAudit).toBe(1);
    });
  },
);
