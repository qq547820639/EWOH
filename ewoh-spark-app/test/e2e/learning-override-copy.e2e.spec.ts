/**
 * 学习台账读的是哪一份事实？（V106 探针，PROJ-01 第①格）
 *
 * 普查（V102）把"学习/KPI 侧跨事务读 feedback/execution 副本"列为待测，V104 收了 KPI 半边。
 * 这一格要回答的是问句本身：**学习侧到底会不会算错**。走读先给了三条形状：
 *  1) `learning.service.ts:226-250` 的 `humanOverrideRate = sum(override_count)/count(*)`，
 *     过滤条件只有 `ts` 窗口 + orgId（不看 actual 是否齐全）；
 *  2) `override_count` 的**唯一生产写者**是 `scheduling-feedback.service.ts` 的 `recordBaseline`，
 *     而它在生产里只被 `dispatch-coordinator.service.ts:765` 调一次，且 `opts` 传的是 `undefined`；
 *  3) 真人覆盖这件事**确实有权威面**：`POST /api/scheduler/plans/:id/overrides`
 *     → `ewoh_schedule_audit(action='override.apply')` + 审计 `scheduler.plan.override`。
 * ⇒ 待测命题：同一件"人工覆盖"事实，权威面有行、副本面恒 0、台账因此报 0，
 *   而"0"与"真的没有人覆盖过"在台账里不可区分。
 *
 * 探针阶段读数（已确认，据此填写最终断言）：真实覆盖 ⇒ 审计面 1 行 / 副本面 sum=0 / 台账 0；
 * 用产品自己的写者补记 1 次覆盖 ⇒ 副本 0→1、台账同一项立刻变 1（消费侧没有坏）。
 * 已知陷阱（会直接影响读法）：`evalId = le:{type}:{periodStart}`（`learning.service.ts:58`）
 * 是**确定性**的，同 periodStart 第二次调用会命中唯一键冲突并**回读旧行**（:126-139，created:false），
 * 所以每一臂必须用不同的 periodStartMs，否则"数字没变"其实是没重算。
 * 另一处读 SQL 的细节：raw `owner` 查询返回的列名是**小写**（`planid` 而非 `planId`），
 * 别名驼峰不会保留——第一版 LR-02 因此打印出 `planIds=[null]`，是探针读数错，不是数据缺失。
 */
import { randomUUID } from 'node:crypto';
import type { SchedulingPlanV2 } from '../../shared/api.interface';
import { resolveE2EConfig } from '../helpers/e2e-config';
import {
  cleanupE2EFixture,
  connectOwner,
  createE2EFixture,
  seedSchedulerFixture,
  type E2EFixture,
  type OwnerSql,
  type SchedulerFixture,
} from '../helpers/e2e-db';
import { startE2EApp, type E2EAppHandle } from '../helpers/e2e-app';
import { apiRequest, jsonHeaders, login } from '../helpers/e2e-http';
import { buildGucSettings } from '../../server/modules/shared/org-context.interceptor';
import { RequestDatabaseContext } from '../../server/database/request-database-context';
import { SchedulingFeedbackService } from '../../server/modules/scheduler/scheduling-feedback.service';

const config = resolveE2EConfig();

(config ? describe : describe.skip)(
  '学习台账×人工覆盖副本基线 E2E（V106：override_count 有没有写者）',
  () => {
    let owner: OwnerSql;
    let fixture: E2EFixture;
    let resources: SchedulerFixture;
    let handle: E2EAppHandle;
    let dispatcherToken = '';
    let approverToken = '';
    const runId = randomUUID().slice(0, 8);
    let arm = 0;
    let chain: { planId: string; dispatchedPlanId: string; assignmentId: string } =
      { planId: '', dispatchedPlanId: '', assignmentId: '' };

    beforeAll(async () => {
      owner = await connectOwner(config!.ownerDatabaseUrl);
      fixture = await createE2EFixture(owner);
      resources = await seedSchedulerFixture(owner, fixture.orgA.id);
      process.env.EWOH_SOLVER_ACTIVATION = 'OFF';
      handle = await startE2EApp(config!, fixture.orgA.id);
      const d = await login(handle.baseUrl, fixture.dispatcherA.username, fixture.dispatcherA.password);
      expect(d.status).toBe(201);
      dispatcherToken = d.body.accessToken;
      const a = await login(handle.baseUrl, fixture.approverA.username, fixture.approverA.password);
      expect(a.status).toBe(201);
      approverToken = a.body.accessToken;
    }, 180_000);

    afterAll(async () => {
      try {
        await handle?.close();
      } finally {
        if (fixture && owner) await cleanupE2EFixture(owner, fixture);
      }
      await owner?.end();
    });

    const org = () => fixture.orgA.id;

    /** 每臂一个新鲜窗口（避开 periodStart 决定的幂等回读）。 */
    async function evaluate(tag: string) {
      const endMs = Date.now() + 60_000;
      const startMs = endMs - 3_600_000 - arm;
      arm += 1;
      const res = await apiRequest<{ record?: { metrics?: Record<string, number | null> }; created?: boolean }>(
        handle.baseUrl,
        '/api/learning/evaluate',
        {
          method: 'POST',
          headers: jsonHeaders(dispatcherToken),
          body: JSON.stringify({ evaluationType: 'on_demand', periodStartMs: startMs, periodEndMs: endMs }),
        },
      );
      const m = res.body?.record?.metrics ?? {};
      console.log(
        `[${tag}] evaluate http=${res.status} created=${String(res.body?.created)} `
        + `humanOverrideRate=${String(m.humanOverrideRate)} planSuccessRate=${String(m.planSuccessRate)} `
        + `riskOutcomeRate=${String(m.riskOutcomeRate)} modelAccuracy=${String(m.modelAccuracy)}`,
      );
      return { status: res.status, metrics: m, body: res.body };
    }

    const feedbackFacts = async () => {
      const rows = await owner`
        select count(*)::int as n,
               coalesce(sum(override_count), 0)::int as overrides,
               count(*) filter (where actual_end is null)::int as unfinished,
               count(*) filter (where accepted is null)::int as "acceptedNull"
          from public.ewoh_scheduling_feedback
         where org_id::text = ${org()}`;
      const r = rows[0] as Record<string, unknown>;
      return {
        n: Number(r.n), overrides: Number(r.overrides),
        unfinished: Number(r.unfinished), acceptedNull: Number(r.acceptedNull),
      };
    };

    const overrideAuditCount = async (planId: string) => {
      const rows = await owner`
        select count(*)::int as n from public.ewoh_schedule_audit
         where plan_id = ${planId} and action = 'override.apply'`;
      return Number((rows[0] as Record<string, unknown>).n);
    };

    /** 走完一遍真实链：run → approve → （可选 override）→ dispatch → 开工回执。 */
    async function runChain(tag: string, withOverride: boolean) {
      const run = await apiRequest<{ plans: SchedulingPlanV2[] }>(
        handle.baseUrl,
        '/api/scheduler/runs',
        {
          method: 'POST',
          headers: jsonHeaders(dispatcherToken),
          body: JSON.stringify({
            strategy: 'scheduling_v2', trigger: 'MANUAL', entityId: resources.taskId,
          }),
        },
      );
      expect(run.status).toBe(201);
      const plan = run.body.plans[0];
      let target = plan;

      const approved = await apiRequest(
        handle.baseUrl, `/api/scheduler/plans/${plan.planId}/approve`,
        {
          method: 'POST', headers: jsonHeaders(approverToken),
          body: JSON.stringify({ version: plan.version, snapshotVersion: plan.snapshotVersion }),
        },
      );
      expect(approved.status).toBe(200);
      console.log(`[${tag}] P1=${plan.planId} approve=${approved.status}`);

      if (withOverride) {
        const ov = await apiRequest<Record<string, unknown>>(
          handle.baseUrl, `/api/scheduler/plans/${plan.planId}/overrides`,
          {
            method: 'POST', headers: jsonHeaders(dispatcherToken),
            body: JSON.stringify({
              actions: [{ kind: 'BOOST', taskId: resources.taskId, reason: `e2e LR ${runId}` }],
              reason: `e2e LR ${runId}`,
            }),
          },
        );
        console.log(
          `[${tag}] override http=${ov.status} keys=${Object.keys(ov.body ?? {}).join(',')}`,
        );
        const after = ov.body?.after as { planId?: string; version?: number; snapshotVersion?: string } | undefined;
        console.log(
          `[${tag}] override.after planId=${String(after?.planId)} version=${String(after?.version)} `
          + `snapshotVersion=${String(after?.snapshotVersion)}`,
        );
        if (after?.planId && after.planId !== plan.planId) {
          const reapproved = await apiRequest(
            handle.baseUrl, `/api/scheduler/plans/${after.planId}/approve`,
            {
              method: 'POST', headers: jsonHeaders(approverToken),
              body: JSON.stringify({
                version: after.version, snapshotVersion: after.snapshotVersion ?? '',
              }),
            },
          );
          console.log(`[${tag}] P2=${after.planId} approve=${reapproved.status}`);
          const p2 = reapproved.body as unknown as SchedulingPlanV2;
          target = { ...p2, planId: after.planId, assignments: p2?.assignments ?? target.assignments };
        }
      }

      const dispatched = await apiRequest(
        handle.baseUrl, `/api/scheduler/plans/${target.planId}/dispatch`,
        { method: 'POST', headers: jsonHeaders(dispatcherToken), body: '{}' },
      );
      expect([200, 201]).toContain(dispatched.status);
      const assignment = (dispatched.body as unknown as SchedulingPlanV2)?.assignments?.[0]
        ?? target.assignments[0];
      const assignmentId = String(assignment.assignmentId);
      const started = await apiRequest(
        handle.baseUrl, `/api/scheduler/executions/${assignmentId}/update`,
        {
          method: 'POST', headers: jsonHeaders(dispatcherToken),
          body: JSON.stringify({ status: 'STARTED', actualStartAt: new Date().toISOString() }),
        },
      );
      expect([200, 201]).toContain(started.status);
      console.log(
        `[${tag}] dispatch=${dispatched.status} plan=${target.planId} assignment=${assignmentId} start=${started.status}`,
      );
      return { planId: plan.planId, dispatchedPlanId: target.planId, assignmentId };
    }

    it('LR-01 真实人工覆盖：权威面有行、副本面恒 0、台账读到 0（三段各自取证）', async () => {
      chain = await runChain('LR-01', true);
      const { planId } = chain;
      const audit = await overrideAuditCount(planId);
      const fb = await feedbackFacts();
      const ev = await evaluate('LR-01');
      console.log(
        `[LR-01] override.apply 审计行=${audit}｜feedback 行=${fb.n}（其中未完工 ${fb.unfinished}）`
        + ` sum(override_count)=${fb.overrides}｜台账 humanOverrideRate=${String(ev.metrics.humanOverrideRate)}`,
      );
      // 前提：这一步真的产生了 feedback 副本行，且窗口数得到它（否则下面的"0"是空窗口）。
      expect(fb.n).toBeGreaterThan(0);
      // 三段读数，缺一即不可归因：
      //  ① 权威面记了这次人工覆盖；
      expect(audit).toBeGreaterThan(0);
      //  ② 副本面（台账唯一读的那一份）什么都没记到；
      expect(fb.overrides).toBe(0);
      //  ③ 台账因此报 0——而且**不是 null**：`aggregateOverrideRate` 在 total=0 时返回 null
      //     （learning.service.ts:243-244），所以这个 0 恰好证明"分母非空但分子恒 0"，
      //     即"有人覆盖过"与"没人覆盖过"在台账里不可区分。
      expect(ev.metrics.humanOverrideRate).toBe(0);
    }, 240_000);

    it('LR-02 量程对照：用产品自己的写者补上 override_count，同一聚合必须动', async () => {
      const fb0 = await feedbackFacts();
      expect(fb0.n).toBeGreaterThan(0);
      const rdc = handle.app.get(RequestDatabaseContext);
      const svc = handle.app.get(SchedulingFeedbackService);
      const k = fb0.n; // 每行记 1 次覆盖 ⇒ 期望恰为 k/n = 1
      const fbPlans = await owner`select plan_id as planId, assignment_id as "assignmentId"
         from public.ewoh_scheduling_feedback where org_id::text = ${org()}`;
      const planRows = await owner`select plan_id as planId, status, org_id::text as orgId,
         (select count(*)::int from public.ewoh_scheduling_plan_assignment a
            where a.plan_id = public.ewoh_schedule_plan.plan_id) as assignments
         from public.ewoh_schedule_plan
        where plan_id in (${chain.planId}, ${chain.dispatchedPlanId})`;
      console.log(
        `[LR-02] feedback 副本 planId 列=${JSON.stringify((fbPlans as Array<Record<string, unknown>>).map((r) => r.planid ?? r.planId))}`
        + `｜P1=${chain.planId}｜P2=${chain.dispatchedPlanId}`
        + `｜方案面=${JSON.stringify(planRows)}`,
      );
      const written = await rdc.runInTransaction(
        buildGucSettings({ userId: 'system:lr-baseline', primaryOrgId: org() }),
        () => svc.recordBaseline(
          chain.dispatchedPlanId,
          { overrideCount: k },
          { userId: 'system:lr-baseline', primaryOrgId: org() } as never,
        ),
      );
      const fb1 = await feedbackFacts();
      const ev = await evaluate('LR-02');
      console.log(
        `[LR-02] recordBaseline written=${String(written)} override_count ${fb0.overrides}→${fb1.overrides}`
        + `（该写者同时回填 accepted：null 行数=${fb1.acceptedNull}）`
        + `｜台账 humanOverrideRate=${String(ev.metrics.humanOverrideRate)}`,
      );
      // 量程证明：同一份聚合、同一批行，只改 override_count 就必须动。
      // 这一臂是 LR-01 那个 0 的**反向控制**——没有它，"0"既可能是"没人写"也可能是"读侧坏了"。
      expect(Number(written)).toBeGreaterThan(0);
      expect(fb1.overrides).toBeGreaterThan(fb0.overrides);
      expect(ev.metrics.humanOverrideRate).toBeCloseTo(fb1.overrides / fb1.n, 9);
    }, 240_000);

    it('LR-03 分母口径：未完工的半具行照样进分母，且与同一行台账里的完成率互相矛盾', async () => {
      const fb = await feedbackFacts();
      const ev = await evaluate('LR-03');
      console.log(
        `[LR-03] feedback n=${fb.n}（未完工 ${fb.unfinished}）sum=${fb.overrides}`
        + `｜台账 humanOverrideRate=${String(ev.metrics.humanOverrideRate)}`
        + `（若"只数完工样本"，本org完工数=${fb.n - fb.unfinished} ⇒ 该当 null）`
        + `｜同一行 planSuccessRate=${String(ev.metrics.planSuccessRate)}`,
      );
      // 前提：窗口里的样本**全部**是没完工的半具行（F-13 的形状）。
      expect(fb.n).toBeGreaterThan(0);
      expect(fb.unfinished).toBe(fb.n);
      // 读数：override 比率仍然把它们的分母算进去了（LR-02 刚把分子记上，所以这里 >0）；
      // 而同一行台账的 planSuccessRate 走的是 KPI 完成率（V104 实测的同一口径），
      // 对同一批样本给的是 0 ⇒ **一行台账里两个指标对"什么算一个样本"没有共同口径**。
      expect(Number(ev.metrics.humanOverrideRate)).toBeGreaterThan(0);
      expect(Number(ev.metrics.planSuccessRate)).toBe(0);
    }, 240_000);

    /**
     * LR-04 归因：让现场真的回来（今天唯一的出口=完工回执），看两个指标各自动不动。
     * 目的不是重复 V104，而是钉住**分母由谁决定**：完工之后 override 比率不变，
     * 说明那个分母在"开工"那一刻就已经定下（副本行是开工时建的，完工只补列）。
     */
    it('LR-04 归因：完工回执让 planSuccessRate 追平，而 humanOverrideRate 的分母一动没动', async () => {
      const before = await feedbackFacts();
      const stored = await owner`
        select actual_start_at as "actualStartAt" from public.ewoh_scheduling_execution
         where org_id::text = ${org()} and assignment_id = ${chain.assignmentId} limit 1`;
      const storedStart = (stored[0] as Record<string, unknown>).actualStartAt;
      expect(storedStart).toBeTruthy();
      const done = await apiRequest(
        handle.baseUrl, `/api/scheduler/executions/${chain.assignmentId}/update`,
        {
          method: 'POST', headers: jsonHeaders(dispatcherToken),
          body: JSON.stringify({
            status: 'COMPLETED',
            // 实测事实不可覆写（V104：自编时刻会拿 409），这里回传库里既有值。
            actualStartAt: new Date(storedStart as string).toISOString(),
            actualEndAt: new Date().toISOString(),
          }),
        },
      );
      expect([200, 201]).toContain(done.status);
      const after = await feedbackFacts();
      const ev = await evaluate('LR-04');
      console.log(
        `[LR-04] 完工回执 http=${done.status}｜feedback n ${before.n}→${after.n}`
        + ` 未完工 ${before.unfinished}→${after.unfinished} sum ${before.overrides}→${after.overrides}`
        + `｜台账 humanOverrideRate=${String(ev.metrics.humanOverrideRate)}`
        + ` planSuccessRate=${String(ev.metrics.planSuccessRate)}`,
      );
      // 完工把半具行补齐（分母里的"未完工"归零）……
      expect(after.unfinished).toBe(0);
      // ……但既不新增行也不改变 override 的分母 ⇒ 分母在开工时就定了。
      expect(after.n).toBe(before.n);
      expect(Number(ev.metrics.humanOverrideRate)).toBeCloseTo(after.overrides / after.n, 9);
      // 同一批数据补齐后，完成率这一项追平到 1 ⇒ LR-03 的"矛盾"确实只来自那一批未完工样本。
      expect(Number(ev.metrics.planSuccessRate)).toBe(1);
    }, 240_000);
  },
);
