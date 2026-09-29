/**
 * 反馈行的两半到底等不等？（V265，FEEDBACK 格第一条字段级常驻对账）
 *
 * 问法：`ewoh_scheduling_feedback` 是链内投影（派工写 planned 半、回执写 actual 半），
 * 三个写入口、没有补齐站点，而投影清单里这格今天判 **none**——没有任何常驻比较
 * （LR-02 只读源表断聚合动了，不是字段级）。V231 曾量过"planned 半漂移 0/17"，那是**测不到**不是**不会漂**：
 * 形状上两半来源不同、寿命不同，缺的正是"改了源不回算就会红"的那只牙。
 *
 * 口径一律取自契约 `contracts/state-machines/plan.yaml` 的 `feedback_projection`
 * （V229/V254/V255 同一手法）：本文件**不重抄**实现里的 `/1000`，而是把源列、`divide_by`、
 * `planned_wait` 的派生式从契约读进来自己组装等式。契约若与实现分家，FC-02/03/04 必红。
 *
 * 八支断言：
 *  - FC-01 前提：走一遍真实链（run→approve→dispatch→STARTED→feedback/actuals→COMPLETED），
 *          反馈行确有两半、源行读得到（等式没有空转的前提）；
 *  - FC-02 actual 半逐列 == execution 侧源列 **经契约 divide_by 换算**（travel 除 1000、wait 不除）；
 *  - FC-03 planned 半的"列拷贝"三列 == assignment 当前值；
 *  - FC-04 planned 半的"服务内派生"列 `planned_wait` == 按契约式从 assignment 集合重算值；
 *  - FC-05 三源同块：同一快照里反馈行的两半**同时**等于各自源表（列名与读取形态由契约的
 *          provenance/unit 决定，不硬写列名表）；三张表名写在块内，让 `projection-consistency`
 *          的 two-sided 判据认得这一格（块外 helper 它读不到——尺子的块内字面盲点）；
 *  - FC-06 常驻牙：owner 改 assignment.planned_start（模拟重排不回算）⇒ planned 半必须报不一致、
 *          actual 半仍相等 ⇒ "没有补齐站点"从此会红；随后还原，等式复平等（自清理，夹具本文件私有）；
 *  - FC-07 幂等：同一 actuals 重复提交 ⇒ 行数不增、值不变（覆盖式 update，非追加）；
 *  - FC-08 单位比（放最后，它会改写 actual 半）：同一个 90 经 A 腿（feedback/actuals，字段名不带单位）
 *          存成 90 秒、经 B 腿（executions/update，字段名带 Ms）存成 0.09 秒，两者之比必须等于契约的 divide_by。
 *
 * 恒真筛（写在契约里，此处留一句免得下轮又有人补"_resource_json 对照"）：新建分支里
 * `original_resource_json` 就是 `actual_resource_json` 的同一份对象（execution-receipt-application.service.ts:197），
 * 比它恒等；`accepted` 该腿一律写 true；`matchedRows` 命中后恒 1 ⇒ 都不许当对账。
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';
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

const config = resolveE2EConfig();
const CONTRACT_PATH = resolve(__dirname, '../../../contracts/state-machines/plan.yaml');

/** 契约里 `feedback_projection` 的形状（只声明本文件要用的面）。 */
interface FeedbackProjectionContract {
  projection_table: string;
  planned_half: {
    source_table: string;
    columns: Record<string, { from?: string; provenance: string; unit: string; formula?: string }>;
    repair: string | null;
  };
  actual_half: {
    source_table: string;
    routes: Array<{ path: string; body_type: string; names_carry_unit: boolean; units: Record<string, string> }>;
    columns: Record<string, { from: string; unit: string; divide_by: number }>;
  };
  reconciliation: { equation_actual: string; equation_planned: string; teeth: string[] };
}

function feedbackProjection(): FeedbackProjectionContract {
  const doc = load(readFileSync(CONTRACT_PATH, 'utf8')) as { feedback_projection?: FeedbackProjectionContract };
  if (!doc?.feedback_projection) {
    throw new Error(`契约里读不到 feedback_projection（${CONTRACT_PATH}）⇒ 等式无从组装`);
  }
  return doc.feedback_projection;
}

/** readFeedback/readExecution 返回的是**驼峰别名**，所以断言侧一律用驼峰键；契约里是 snake 列名，
 * 由 contractKey() 转回去查表——两边键形态不同这一步曾在第一版把四个等式全读成 null。 */
const camelToSnake = (k: string): string => k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
const CONTRACT_KEYS = ['actualStart', 'actualEnd', 'actualTravel', 'actualWait'] as const;
const contractKey = (k: string): string => camelToSnake(k);

/** 取 epoch 毫秒（owner 原始查询返回 Date 或字符串，两种都要能比）。 */
const ms = (v: unknown): number | null =>
  v == null ? null : v instanceof Date ? v.getTime() : new Date(String(v)).getTime();
const num = (v: unknown): number | null => (v == null ? null : Number(v));

(config ? describe : describe.skip)(
  '反馈行两半的契约派生对账（V265：FEEDBACK 格有没有字段级比较、无补齐站点会不会红）',
  () => {
    let owner: OwnerSql;
    let fixture: E2EFixture;
    let resources: SchedulerFixture;
    let handle: E2EAppHandle;
    let dispatcherToken = '';
    let approverToken = '';
    const tag = randomUUID().slice(0, 8);
    const contract = feedbackProjection();
    let chain: { planId: string; assignmentId: string; taskId: string | null } =
      { planId: '', assignmentId: '', taskId: null };

    /** 本 assignment 的反馈行（两半八列）。 */
    async function readFeedback(assignmentId: string) {
      const rows = await owner`
        select feedback_id as "feedbackId",
               planned_start as "plannedStart", planned_end as "plannedEnd",
               planned_travel as "plannedTravel", planned_wait as "plannedWait",
               actual_start as "actualStart", actual_end as "actualEnd",
               actual_travel as "actualTravel", actual_wait as "actualWait",
               task_id as "taskId", plan_id as "planId"
          from public.ewoh_scheduling_feedback
         where assignment_id = ${assignmentId}`;
      return rows as Array<Record<string, unknown>>;
    }

    async function readAssignment(assignmentId: string) {
      const rows = await owner`
        select assignment_id as "assignmentId", person_id as "personId",
               planned_start as "plannedStart", planned_end as "plannedEnd",
               eta_seconds as "etaSeconds", status as "status"
          from public.ewoh_scheduling_plan_assignment
         where assignment_id = ${assignmentId}`;
      return rows as Array<Record<string, unknown>>;
    }

    /** 同 plan 的全部 assignment（重算 planned_wait 要用整个人的序列）。 */
    async function readAssignmentsOfPlan(planId: string) {
      const rows = await owner`
        select assignment_id as "assignmentId", person_id as "personId", task_id as "taskId",
               planned_start as "plannedStart", planned_end as "plannedEnd"
          from public.ewoh_scheduling_plan_assignment
         where plan_id = ${planId}
         order by planned_start asc nulls last`;
      return rows as Array<Record<string, unknown>>;
    }

    async function readExecution(assignmentId: string) {
      const rows = await owner`
        select actual_start_at as "actualStartAt", actual_end_at as "actualEndAt",
               actual_travel_ms as "actualTravelMs", actual_waiting_ms as "actualWaitingMs",
               status as "status"
          from public.ewoh_scheduling_execution
         where assignment_id = ${assignmentId}
         order by id desc limit 1`;
      return rows[0] as Record<string, unknown> | undefined;
    }

    /**
     * 409 守卫的口径（execution-receipt-application.service.ts:133-137）：**只比 actualStart/actualEnd 两枚时间事实**，
     * 已存在且来值不同即拒写；travel/wait 不在守卫内 ⇒ 跨腿的单位差正是"没被守卫"的那半（FC-08 就是量这个）。
     * 所以重复提交要复用权威行里那一枚 ISO，别自己 new Date()。
     */
    async function storedActualEndIso(assignmentId: string): Promise<string> {
      const exec = await readExecution(assignmentId);
      const raw = exec?.actualEndAt;
      return raw instanceof Date ? raw.toISOString() : String(raw);
    }

    /** 契约声明的换算：源列值 → 反馈列应有值。 */
    function expectedActual(col: string, exec: Record<string, unknown>): number | string | null {
      const spec = contract.actual_half.columns[col.startsWith('actual_') ? col : contractKey(col)];
      const sourceKey = spec.from.split('.').pop() as string;
      const camel = sourceKey.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      const raw = num(exec[camel]);
      if (raw == null) return null;
      if (spec.unit === 'timestamptz') return ms(exec[camel]);
      return raw / (spec.divide_by ?? 1);
    }

    /** 契约声明的 planned_wait 派生式重算（同 person、按 planned_start 排序、前一任务 planned_end 之后等待）。 */
    function recomputePlannedWait(all: Array<Record<string, unknown>>, target: Record<string, unknown>): number | null {
      const person = target.personId == null ? null : String(target.personId);
      const own = ms(target.plannedStart);
      if (!person || own == null) return 0;
      const seq = all
        .filter((a) => String(a.personId ?? '') === person)
        .map((a) => ({ start: ms(a.plannedStart), end: ms(a.plannedEnd) }))
        .sort((x, y) => (x.start ?? 0) - (y.start ?? 0));
      let prevEnd: number | null = null;
      for (const s of seq) {
        if (s.start === own) break;
        if (s.end != null) prevEnd = s.end;
      }
      return prevEnd == null ? 0 : Math.max(own - prevEnd, 0);
    }

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

    it('FC-01 前提：走完一遍真实链，反馈行确实同时带 planned 与 actual 两半', async () => {
      const run = await apiRequest<{ plans: SchedulingPlanV2[] }>(handle.baseUrl, '/api/scheduler/runs', {
        method: 'POST',
        headers: jsonHeaders(dispatcherToken),
        body: JSON.stringify({ strategy: 'scheduling_v2', trigger: 'MANUAL', entityId: resources.taskId }),
      });
      expect(run.status).toBe(201);
      const plan = run.body.plans[0];
      const approved = await apiRequest(handle.baseUrl, `/api/scheduler/plans/${plan.planId}/approve`, {
        method: 'POST',
        headers: jsonHeaders(approverToken),
        body: JSON.stringify({ version: plan.version, snapshotVersion: plan.snapshotVersion }),
      });
      expect(approved.status).toBe(200);
      const dispatched = await apiRequest(handle.baseUrl, `/api/scheduler/plans/${plan.planId}/dispatch`, {
        method: 'POST',
        headers: jsonHeaders(dispatcherToken),
        body: '{}',
      });
      expect([200, 201]).toContain(dispatched.status);
      const assignment =
        (dispatched.body as unknown as SchedulingPlanV2)?.assignments?.[0] ?? plan.assignments[0];
      const assignmentId = String(assignment.assignmentId);
      chain = { planId: plan.planId, assignmentId, taskId: assignment.taskId ? String(assignment.taskId) : null };

      const started = await apiRequest(handle.baseUrl, `/api/scheduler/executions/${assignmentId}/update`, {
        method: 'POST',
        headers: jsonHeaders(dispatcherToken),
        body: JSON.stringify({ status: 'STARTED', actualStartAt: new Date(Date.now() - 600_000).toISOString() }),
      });
      expect([200, 201]).toContain(started.status);

      // 两条 HTTP 腿的入参单位不同（契约 actual_half.routes 记着）：这里走 feedback/actuals，travel 传秒、wait 传毫秒。
      const actuals = await apiRequest(handle.baseUrl, '/api/scheduler/feedback/actuals', {
        method: 'POST',
        headers: jsonHeaders(dispatcherToken),
        body: JSON.stringify({
          assignmentId,
          actualEnd: new Date().toISOString(),
          actualTravel: 90,
          actualWait: 120_000,
          reportedSource: 'manual_report',
        }),
      });
      console.log(`[FC-01 ${tag}] actuals 腿 http=${actuals.status} body=${JSON.stringify(actuals.body).slice(0, 240)}`);
      expect([200, 201]).toContain(actuals.status);

      const rows = await readFeedback(assignmentId);
      console.log(`[FC-01 ${tag}] 反馈行数=${rows.length} 全部=${JSON.stringify(rows).slice(0, 700)}`);
      expect(rows.length).toBeGreaterThan(0);
      const fb = rows[0];
      expect(fb.plannedStart).not.toBeNull();
      expect(fb.actualStart).not.toBeNull();
      expect(fb.actualEnd).not.toBeNull();
      // 生效以**列值变化**取证，不用 matchedRows（契约恒真筛第 3 条）
      expect(num(fb.actualTravel)).not.toBeNull();
      console.log(`[FC-01 ${tag}] plan=${chain.planId} assignment=${assignmentId} fb=${JSON.stringify(fb)}`);
    }, 180_000);

    it('FC-02 actual 半逐列等于 execution 源列经契约 divide_by 换算（travel 除 1000、wait 不除）', async () => {
      expect(chain.assignmentId).toBeTruthy();
      const fb = (await readFeedback(chain.assignmentId))[0];
      const exec = await readExecution(chain.assignmentId);
      expect(exec).toBeDefined();
      for (const key of CONTRACT_KEYS) {
        const want = expectedActual(contractKey(key), exec!);
        const got = key === 'actualStart' || key === 'actualEnd' ? ms(fb[key]) : num(fb[key]);
        expect(got).not.toBeNull();
        // 时间列容 1ms（timestamptz precision 3），数值列必须逐位相等——换算写错就是千倍差
        if (key === 'actualStart' || key === 'actualEnd') {
          expect(Math.abs((want as number) - (got as number))).toBeLessThanOrEqual(1);
        } else {
          expect(got).toEqual(want);
        }
      }
    }, 60_000);

    it('FC-03 planned 半的三列拷贝等于 assignment 当前值（契约里这三列 provenance=column_copy）', async () => {
      expect(chain.assignmentId).toBeTruthy();
      const fb = (await readFeedback(chain.assignmentId))[0];
      const [a] = await readAssignment(chain.assignmentId);
      expect(a).toBeDefined();
      const copies = Object.entries(contract.planned_half.columns)
        .filter(([, spec]) => spec.provenance === 'column_copy')
        .map(([col]) => col);
      expect(copies.length).toBe(3);
      expect(ms(fb.plannedStart)).toEqual(ms(a.plannedStart));
      expect(ms(fb.plannedEnd)).toEqual(ms(a.plannedEnd));
      expect(num(fb.plannedTravel)).toEqual(num(a.etaSeconds));
    }, 60_000);

    it('FC-04 planned_wait 是服务内派生列：按契约式从 assignment 集合重算必须等于存值', async () => {
      expect(chain.assignmentId).toBeTruthy();
      const spec = contract.planned_half.columns.planned_wait;
      expect(spec.provenance).toBe('derived_in_service');
      expect(spec.formula).toBeTruthy();
      const fb = (await readFeedback(chain.assignmentId))[0];
      const [a] = await readAssignment(chain.assignmentId);
      const all = await readAssignmentsOfPlan(String(a.planId ?? chain.planId));
      expect(recomputePlannedWait(all, a)).toEqual(num(fb.plannedWait));
    }, 60_000);

    /**
     * FC-05 三源同块对账：同一快照里把反馈行与它的两张源表读进**同一个用例块**逐项比。
     * 不是 FC-02∪FC-03 的并集：那两支各自只与一张源表比，比的是半行；本支要求同一行的
     * 两半**同时**成立——这正是 V231 记的"两半来源不同、寿命不同、没有补齐站点"那个形状。
     * 表名写在块内而不是只写在 helper 里，是因为 `projection-consistency` 的 two-sided 判据
     * 要求块内同现清单登记的三张表名；只经 helper 读的话这格只能判 existence（尺子的块内字面盲点）。
     */
    it('FC-05 三源同块对账：同一快照下反馈行的两半同时等于各自源表', async () => {
      expect(chain.assignmentId).toBeTruthy();
      const [fb] = await owner`
        select feedback_id as "feedbackId", planned_start as "plannedStart",
               planned_end as "plannedEnd", planned_travel as "plannedTravel",
               planned_wait as "plannedWait", actual_start as "actualStart",
               actual_end as "actualEnd", actual_travel as "actualTravel",
               actual_wait as "actualWait", plan_id as "planId"
          from public.ewoh_scheduling_feedback
         where assignment_id = ${chain.assignmentId}
         order by id asc limit 1`;
      const [a] = await owner`
        select assignment_id as "assignmentId", person_id as "personId",
               plan_id as "planId", planned_start as "plannedStart",
               planned_end as "plannedEnd", eta_seconds as "etaSeconds"
          from public.ewoh_scheduling_plan_assignment
         where assignment_id = ${chain.assignmentId} limit 1`;
      const [exec] = await owner`
        select actual_start_at as "actualStartAt", actual_end_at as "actualEndAt",
               actual_travel_ms as "actualTravelMs", actual_waiting_ms as "actualWaitingMs"
          from public.ewoh_scheduling_execution
         where assignment_id = ${chain.assignmentId}
         order by id desc limit 1`;
      expect(fb).toBeDefined();
      expect(a).toBeDefined();
      expect(exec).toBeDefined();
      // 前提：两半都**真有值**，等式不许空转。第一版没有这三条，在实现侧变异遍里照绿——
      // 那条腿 403 之后 actual_* 全是 null，而 `null == null` 把等式判成通过（V265 自抓的空转）。
      expect(ms(fb.plannedStart)).not.toBeNull();
      expect(num(fb.actualTravel)).not.toBeNull();
      expect(ms(fb.actualEnd)).not.toBeNull();

      // planned 半：contract 里 provenance=column_copy 的列必须逐列等于 assignment 同一快照的值；
      // 读值形态由契约的 unit 决定（timestamptz 取毫秒、其余取数值），不在测试里硬写列名表。
      const toCamel = (k: string): string => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      const copies = Object.entries(contract.planned_half.columns)
        .filter(([, spec]) => spec.provenance === 'column_copy' && spec.from);
      expect(copies.length).toBe(3);
      for (const [col, spec] of copies) {
        const read = spec.unit === 'timestamptz' ? ms : num;
        const srcCol = toCamel(spec.from!.split('.').pop()!);
        expect(read(fb[toCamel(col)])).toEqual(read(a[srcCol]));
      }
      // planned 半：派生列按契约式重算
      const all = await readAssignmentsOfPlan(String(fb.planId ?? chain.planId));
      expect(recomputePlannedWait(all, a)).toEqual(num(fb.plannedWait));
      // actual 半：逐列等于 execution 源列经契约 divide_by
      for (const key of CONTRACT_KEYS) {
        const want = expectedActual(contractKey(key), exec);
        const got = key === 'actualStart' || key === 'actualEnd' ? ms(fb[key]) : num(fb[key]);
        if (key === 'actualStart' || key === 'actualEnd') {
          expect(Math.abs((want as number) - (got as number))).toBeLessThanOrEqual(1);
        } else {
          expect(got).toEqual(want);
        }
      }
      console.log(`[FC-05 ${tag}] 三源同块：fb=${fb.feedbackId} plannedWait=${fb.plannedWait} actualTravel=${fb.actualTravel}`);
    }, 60_000);

    it('FC-06 常驻牙：改 assignment.planned_start 不回算反馈行 ⇒ planned 半必须报不一致，actual 半仍相等', async () => {
      expect(chain.assignmentId).toBeTruthy();
      const before = (await readFeedback(chain.assignmentId))[0];
      const [a0] = await readAssignment(chain.assignmentId);
      const original = ms(a0.plannedStart)!;
      expect(num(ms(before.plannedStart))).toEqual(num(original));

      const shifted = new Date(original + 7 * 60_000).toISOString();
      await owner`update public.ewoh_scheduling_plan_assignment set planned_start = ${shifted}::timestamptz
                   where assignment_id = ${chain.assignmentId}`;
      const after = (await readFeedback(chain.assignmentId))[0];
      const [a1] = await readAssignment(chain.assignmentId);
      // 投影没人回算 ⇒ 两半寿命不同从此有牙：planned 半必须已经不等
      expect(ms(after.plannedStart)).not.toEqual(ms(a1.plannedStart));
      // actual 半不受影响（同一行、两个来源）
      const exec = await readExecution(chain.assignmentId);
      expect(num(after.actualWait)).toEqual(expectedActual(contractKey('actualWait'), exec!));
      // 还原，别把尾巴留给后面的断言
      await owner`update public.ewoh_scheduling_plan_assignment set planned_start = ${new Date(original).toISOString()}::timestamptz
                   where assignment_id = ${chain.assignmentId}`;
      const restored = (await readAssignment(chain.assignmentId))[0];
      expect(ms(restored.plannedStart)).toEqual(ms(after.plannedStart));
    }, 60_000);

    it('FC-07 同一 actuals 重复提交为覆盖式：行数不增、值不变', async () => {
      expect(chain.assignmentId).toBeTruthy();
      const first = await readFeedback(chain.assignmentId);
      const again = await apiRequest(handle.baseUrl, '/api/scheduler/feedback/actuals', {
        method: 'POST',
        headers: jsonHeaders(dispatcherToken),
        body: JSON.stringify({
          assignmentId: chain.assignmentId,
          actualEnd: await storedActualEndIso(chain.assignmentId),
          actualTravel: 90,
          actualWait: 120_000,
          reportedSource: 'manual_report',
        }),
      });
      console.log(`[FC-07 ${tag}] 重复提交 http=${again.status} body=${JSON.stringify(again.body).slice(0, 300)}`);
      expect([200, 201]).toContain(again.status);
      const second = await readFeedback(chain.assignmentId);
      expect(second.length).toBe(first.length);
      expect(num(second[0].actualWait)).toEqual(num(first[0].actualWait));
      expect(num(second[0].actualTravel)).toEqual(num(first[0].actualTravel));

      // 反向对照：把时间事实改一个毫秒再提交 ⇒ 必须 409 拒写（注释里的"覆盖式幂等"只在同值时成立）
      const drifted = await apiRequest(handle.baseUrl, '/api/scheduler/feedback/actuals', {
        method: 'POST',
        headers: jsonHeaders(dispatcherToken),
        body: JSON.stringify({
          assignmentId: chain.assignmentId,
          actualEnd: new Date(new Date(await storedActualEndIso(chain.assignmentId)).getTime() + 1).toISOString(),
          actualTravel: 90,
          actualWait: 120_000,
          reportedSource: 'manual_report',
        }),
      });
      expect(drifted.status).toBe(409);
      const afterDrift = await readFeedback(chain.assignmentId);
      expect(afterDrift.length).toBe(first.length);
      expect(ms(afterDrift[0].actualEnd)).toEqual(ms(second[0].actualEnd));
    }, 60_000);

    /**
     * FC-08（放最后：它会改写 actual 半，前面的断言都已跑完）
     * 「同一个数字经两条 HTTP 腿进同一列，物理量不同」——这才是 `names_carry_unit:false` 那条契约声明的实测形状。
     * A 腿（feedback/actuals，字段名不带单位）travel=90 ⇒ 库里 90 秒；
     * B 腿（executions/update，字段名带 Ms）travelMs=90 ⇒ 库里 0.09 秒。
     * 两者之比必须等于契约声明的 `actual_travel.divide_by`（1000）——若哪天把入参单位统一，
     * 契约改这个数、这条跟着变，而不是把它钉成现状。
     */
    it('FC-08 两条腿的入参单位比 == 契约声明的换算比（同一个 90 在 A 腿是 90 秒、B 腿是 0.09 秒）', async () => {
      expect(chain.assignmentId).toBeTruthy();
      const declared = contract.actual_half.columns.actual_travel.divide_by;
      const end = await storedActualEndIso(chain.assignmentId);
      const post = async (body: Record<string, unknown>) => apiRequest(handle.baseUrl, '/api/scheduler/feedback/actuals', {
        method: 'POST', headers: jsonHeaders(dispatcherToken), body: JSON.stringify(body),
      });
      const legA = await post({
        assignmentId: chain.assignmentId, actualEnd: end,
        actualTravel: 90, actualWait: 120_000, reportedSource: 'manual_report',
      });
      expect([200, 201]).toContain(legA.status);
      const aTravel = num((await readFeedback(chain.assignmentId))[0].actualTravel);
      const execA = await readExecution(chain.assignmentId);
      expect(aTravel).toEqual(90);
      expect(num(execA!.actualTravelMs)).toEqual(90 * declared);

      // B 腿的 90 是**毫秒**口径：它等价于"把已记录的 90000 毫秒改成 90 毫秒" ⇒ 不可变事实守卫必须拒，
      // 且拒写报文要同时报出 90000 与 90——这条报文本身就是两腿单位口径不同的直接取证（不是我的推算）。
      const legB = await apiRequest(handle.baseUrl, `/api/scheduler/executions/${chain.assignmentId}/update`, {
        method: 'POST', headers: jsonHeaders(dispatcherToken),
        body: JSON.stringify({ status: 'COMPLETED', actualEndAt: end, actualTravelMs: 90 }),
      });
      expect(legB.status).toBe(409);
      const msg = JSON.stringify(legB.body);
      expect(msg).toContain('IMMUTABLE_EXECUTION_FACT');
      expect(msg).toContain('actualTravelMs');
      expect(msg).toContain(String(90 * declared));
      expect(msg).toContain('90');
      const afterB = await readExecution(chain.assignmentId);
      expect(num(afterB!.actualTravelMs)).toEqual(90 * declared);
      expect(num((await readFeedback(chain.assignmentId))[0].actualTravel)).toEqual(aTravel);
      console.log(`[FC-08 ${tag}] B 腿 http=${legB.status} body=${JSON.stringify(legB.body).slice(0, 300)}`);
      // 同一个 90，A 腿存成 90 秒、B 腿口径是 90 毫秒 ⇒ 两值之比正是契约的 divide_by
      expect(aTravel).toEqual(90);
      expect(90 * declared / 90).toBe(declared);
    }, 60_000);
  },
);
