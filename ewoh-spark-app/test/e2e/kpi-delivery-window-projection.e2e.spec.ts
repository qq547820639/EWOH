/**
 * KPI 的 delivery 块 ↔ 权威执行表：窗口口径提到契约后的常驻对账（V254·PROJ-05／KPIRATE-01 的前半）。
 *
 * 登记册的原话一直是「在测试里重抄实现的 WHERE 公式不算对账」（V229 为投递积压立的那条规矩）。
 * 所以本例的取数条件**一条都不写在测试里**：窗口列与算子、可测量谓词、准时谓词、迟到表达式、
 * 三块各自的分母、逐列回退方向、percentile 口径全部由 `contracts/state-machines/plan.yaml` 的
 * `kpi_delivery_window` 解析得来，拼成一条独立聚合 SQL 去读权威表 `ewoh_scheduling_execution`，
 * 再与实现落到 `ewoh_scheduling_kpi.kpi_json->'delivery'` 的那份逐项比。
 * 红法两条且各自独立：①实现改了窗口/口径而契约没改 ⇒ 两边不等；②契约改了而实现没跟上 ⇒ 同样不等。
 *
 * 六条用例（KC-03／KC-04／KC-06 是本例的牙齿，缺一条就成了"看起来像对账的恒真断言"）：
 *   KC-01 前提：播种四条执行行（三种回退方向都覆盖），走 `GET /api/scheduler/kpi?persist=1`，
 *               用**播种前后落库行数差**证明这一条聚合真写了行（不看绝对值，残留行会让绝对值假绿）。
 *   KC-02 对账：契约重算的 8 个 delivery 指标 == 落库那份（HTTP 响应那份也一起比）。
 *   KC-03 漂移必须被看见：手工把落库 JSON 里的 onTimeRate 改一个错值 ⇒ 同一比较必须报不一致，
 *               还原后必须复绿（证明本断言能红，而不是恒真）。
 *   KC-04 源侧移动必须被看见：把一条迟到行挪出窗口（改 `_updated_at`）⇒ 契约重算变化，
 *               而**落库那份一字不动** ⇒ 钉住"快照是读时的函数、没有自动刷新"这一现状
 *               （这是 as-is 断言，不主张它是最优语义；要不要改成读时刷新属待拍，见 §5.4 PROJ-05）。
 *   KC-05 三源同块对账（V255）：一份新快照里把 delivery（执行表）＋run 窗口计数＋feedback 半
 *               （`solver.heuristicFallbackRate`／`solver.solverLatencyAvgMs`）一次比完。feedback 那半的
 *               契约口径是**无时间窗**（`feedback_window: none`），所以块里另钉一条前提：落库 period 内
 *               只有 1 条反馈行，无窗给 500、有窗给 100 ⇒ 两个候选值可区分，否则相等是恒真。
 *               这条前提同时就是 KPIWINDOW-01 的实测证据（同一份快照混两种窗口）。
 *   KC-06 牙齿：feedback 半单独漂移必须被同一比较看见（改落库的 solverLatencyAvgMs ⇒ 点名报 latency；
 *               还原 ⇒ 复绿）。契约侧的红法不写进用例，由外部变异各量一次并留日志。
 *
 * 契约里两条容易写错、本例专门覆盖的口径：
 *   · 三块分母不同——on_time/lateness 用可测量行，completion 与三个 average 用窗口内全部行；
 *   · 平均量的回退方向逐列不同——waiting 取 `planned ?? actual`，travel/distance 取 `actual ?? planned`。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { load } from 'js-yaml';
import { resolveE2EConfig } from '../helpers/e2e-config';
import {
  cleanupE2EFixture,
  connectOwner,
  createE2EFixture,
  type E2EFixture,
  type OwnerSql,
} from '../helpers/e2e-db';
import { startE2EApp, type E2EAppHandle } from '../helpers/e2e-app';
import { apiRequest, login } from '../helpers/e2e-http';

const config = resolveE2EConfig();
const TOL = 1e-6;

type WindowContract = {
  version: number;
  source_table: string;
  projection_table: string;
  projection_json_column: string;
  projection_json_path: string;
  window_column: string;
  window_lower_operator: string;
  window_upper_operator: string;
  default_window_ms: number;
  org_scope: string;
  completion_status: string;
  measurable_filter: string;
  ontime_predicate: string;
  lateness_ms_expr: string;
  on_time_denominator: string;
  completion_denominator: string;
  averages_denominator: string;
  average_waiting_expr: string;
  average_travel_expr: string;
  average_distance_expr: string;
  percentile_method: string;
  percentile_positions: { p50: number; p95: number };
  replan_run_source: string;
  replan_run_window_column: string;
  replan_trigger_excludes: string;
  // V255：feedback 半（solver 两格）的口径
  feedback_source_table: string;
  feedback_window: string;
  feedback_scope: string;
  feedback_scope_note: string;
  fallback_numerator_filter: string;
  fallback_denominator: string;
  runtime_measure_filter: string;
  runtime_aggregate: string;
  runtime_empty_value: string;
};

const CONTRACT: WindowContract = (
  load(
    readFileSync(resolve(__dirname, '../../../contracts/state-machines/plan.yaml'), 'utf8'),
  ) as { kpi_delivery_window?: WindowContract }
).kpi_delivery_window as WindowContract;

(config ? describe : describe.skip)(
  'KPI delivery 块与执行表的契约对账（V254：窗口口径进契约 + 两条牙齿）',
  () => {
    let owner: OwnerSql;
    let fixture: E2EFixture;
    let handle: E2EAppHandle;
    let token = '';
    const runId = randomUUID().slice(0, 8);
    const tag = `KC-${runId}`;
    const org = () => fixture.orgA.id;

    /** 权威表侧的独立重算：全部片段出自契约，测试不补任何条件。 */
    async function recomputeFromContract(startIso: string, endIso: string) {
      const w = CONTRACT;
      const rows = (await owner.unsafe(
        `SELECT count(*)::int AS window_rows,`
          + `       count(*) FILTER (WHERE (${w.measurable_filter}))::int AS measurable_rows,`
          + `       count(*) FILTER (WHERE (${w.measurable_filter}) AND (${w.ontime_predicate}))::int AS on_time_rows,`
          + `       count(*) FILTER (WHERE execution.status = $4)::int AS completed_rows,`
          + `       avg(${w.average_waiting_expr})::float8 AS avg_waiting,`
          + `       avg(${w.average_travel_expr})::float8 AS avg_travel,`
          + `       avg(${w.average_distance_expr})::float8 AS avg_distance,`
          + `       array_agg(${w.lateness_ms_expr} ORDER BY ${w.lateness_ms_expr} ASC)`
          + `         FILTER (WHERE (${w.measurable_filter})) AS lateness_sorted`
          + `  FROM public.${w.source_table} execution`
          + ` WHERE (${w.org_scope.replace(':actor_org', '$1::varchar')})`
          // 窗口两侧都由契约拼：`window_column` 与两个算子各是一块，测试不补列名也不补算子。
          + `   AND (${w.window_column} ${w.window_lower_operator})`
          + `   AND (${w.window_column} ${w.window_upper_operator})`,
        [org(), startIso, endIso, w.completion_status],
      )) as Array<Record<string, number | number[] | null>>;
      const r = rows[0] ?? {};
      const windowRows = Number(r.window_rows ?? 0);
      const measurable = Number(r.measurable_rows ?? 0);
      const onTime = Number(r.on_time_rows ?? 0);
      const completed = Number(r.completed_rows ?? 0);
      const sorted = ((r.lateness_sorted ?? []) as number[]).map(Number);
      // 契约声明的 percentile 口径＝JS 侧最近秩 `min(ceil(n*p)-1, n-1)`（不是 SQL 的 continuous 插值）。
      const rank = (p: number) => (sorted.length === 0
        ? null
        : sorted[Math.min(Math.ceil(sorted.length * p) - 1, sorted.length - 1)]);
      if (CONTRACT.percentile_method !== 'nearest_rank_ceil') {
        throw new Error(`契约的 percentile_method 变了（${CONTRACT.percentile_method}）⇒ 本例的取秩方式要同批改`);
      }
      return {
        windowRows,
        measurable,
        onTime,
        completed,
        delivery: {
          onTimeRate: measurable > 0 ? onTime / measurable : null,
          completionRate: windowRows > 0 ? completed / windowRows : null,
          latenessP50Ms: rank(CONTRACT.percentile_positions.p50),
          latenessP95Ms: rank(CONTRACT.percentile_positions.p95),
          latenessMaxMs: sorted.length > 0 ? sorted[sorted.length - 1] : null,
          averageWaitingMs: r.avg_waiting == null ? null : Number(r.avg_waiting),
          averageTravelMs: r.avg_travel == null ? null : Number(r.avg_travel),
          averageTravelDistanceM: r.avg_distance == null ? null : Number(r.avg_distance),
        },
      };
    }

    /** 落库投影与契约重算的逐项差集（空数组＝一致）。KC-03 复用同一函数，不另写一份判据。 */
    function diffDelivery(persisted: Record<string, number | null>, expected: Record<string, number | null>) {
      const bad: string[] = [];
      for (const key of Object.keys(expected)) {
        const a = persisted?.[key];
        const b = expected[key];
        if (a === null || b === null || typeof a !== 'number' || typeof b !== 'number') {
          if (a !== b) bad.push(`${key}: 投影 ${JSON.stringify(a)} vs 契约 ${JSON.stringify(b)}`);
          continue;
        }
        if (Math.abs(a - b) > TOL) bad.push(`${key}: 投影 ${a} vs 契约 ${b}`);
      }
      return bad;
    }

    beforeAll(async () => {
      owner = await connectOwner(config!.ownerDatabaseUrl);
      fixture = await createE2EFixture(owner);
      process.env.EWOH_SOLVER_ACTIVATION = 'OFF';
      handle = await startE2EApp(config!, fixture.orgA.id);
      const d = await login(handle.baseUrl, fixture.dispatcherA.username, fixture.dispatcherA.password);
      expect(d.status).toBe(201);
      token = d.body.accessToken;
      // 前提：本 org 里没有任何既有执行行会混进窗口（否则 window_rows 分母就不是播种的那四条）。
      const pre = (await owner.unsafe(
        `SELECT count(*)::int AS n FROM public.ewoh_scheduling_execution WHERE org_id = $1`,
        [org()],
      )) as Array<{ n: number }>;
      expect(Number(pre[0]?.n ?? 0)).toBe(0);
    }, 180_000);

    afterAll(async () => {
      try {
        await owner.unsafe(`DELETE FROM public.ewoh_scheduling_execution WHERE execution_id LIKE $1`, [`${tag}-%`]);
        await owner.unsafe(`DELETE FROM public.ewoh_scheduling_run WHERE run_id LIKE $1`, [`${tag}-run-%`]);
        await owner.unsafe(`DELETE FROM public.ewoh_scheduling_feedback WHERE feedback_id LIKE $1`, [`${tag}-fb-%`]);
        await owner.unsafe(`DELETE FROM public.ewoh_scheduling_kpi WHERE org_id = $1`, [org()]);
      } finally {
        try {
          await handle?.close();
        } finally {
          if (fixture && owner) await cleanupE2EFixture(owner, fixture);
        }
        await owner?.end();
      }
    });

    /** 四条行：三种回退方向 + 两种分母都要能被区分开。 */
    async function seedExecutions() {
      const base = Date.parse(`${new Date().toISOString().slice(0, 11)}00:00:00.000Z`);
      const at = (mins: number) => new Date(base + mins * 60_000).toISOString();
      const rows: Array<{
        key: string; status: string; ps: string | null; pe: string | null;
        as: string | null; ae: string | null;
        waitP: number | null; waitA: number | null;
        travelP: number | null; travelA: number | null;
        distP: number | null; distA: number | null;
      }> = [
        // 可测量 + 准时（lateness 0），actual/planned 都有值 ⇒ 三列各取各自的优先侧
        { key: 'ontime', status: 'COMPLETED', ps: at(60), pe: at(120), as: at(60), ae: at(120),
          waitP: 6000, waitA: 5000, travelP: 600_000, travelA: 610_000, distP: 120, distA: 125 },
        // 可测量 + 迟到 600s
        { key: 'late', status: 'COMPLETED', ps: at(200), pe: at(260), as: at(200), ae: at(270),
          waitP: 10_000, waitA: 15_000, travelP: 90_000, travelA: 95_000, distP: 200, distA: 210 },
        // 可测量 + 迟到 300s，但 actual 的 waiting/travel/distance 为 NULL ⇒ 三列各走一次回退方向
        { key: 'fallback', status: 'COMPLETED', ps: at(300), pe: at(330), as: at(305), ae: at(335),
          waitP: 8000, waitA: null, travelP: 30_000, travelA: null, distP: 50, distA: null },
        // 不可测量（缺 actual 两列）且非 COMPLETED ⇒ 只进 window_rows 与 averages 的分母
        { key: 'planned', status: 'PLANNED', ps: at(400), pe: at(460), as: null, ae: null,
          waitP: 20_000, waitA: null, travelP: 40_000, travelA: null, distP: 80, distA: null },
      ];
      for (const r of rows) {
        const id = `${tag}-${r.key}`;
        await owner.unsafe(
          `INSERT INTO public.ewoh_scheduling_execution`
            + ` (execution_id, org_id, run_id, plan_id, assignment_id, task_id, status,`
            + `  planned_start_at, planned_end_at, actual_start_at, actual_end_at,`
            + `  planned_waiting_ms, actual_waiting_ms, planned_travel_ms, actual_travel_ms,`
            + `  planned_distance_m, actual_distance_m, source, _created_at, _updated_at)`
            + ` VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'e2e',now(),now())`,
          [id, org(), `${tag}-run`, `${tag}-plan`, `${id}-assign`, `${id}-task`, r.status,
            r.ps, r.pe, r.as, r.ae, r.waitP, r.waitA, r.travelP, r.travelA, r.distP, r.distA],
        );
      }
    }

    /** 两条 run：一条非 MANUAL（计入 replanTriggerCount）、一条 MANUAL（只计入 replanCount）。 */
    async function seedRuns() {
      const runs = [
        { runId: `${tag}-run-offline`, triggerType: 'DEVICE_OFFLINE', status: 'succeeded' },
        { runId: `${tag}-run-manual`, triggerType: 'MANUAL', status: 'succeeded' },
      ];
      for (const r of runs) {
        await owner.unsafe(
          `INSERT INTO public.ewoh_scheduling_run (run_id, trigger_type, status, org_id, _created_at, _updated_at)`
            + ` VALUES ($1,$2,$3,$4,now(),now())`,
          [r.runId, r.triggerType, r.status, org()],
        );
      }
    }

    /** 两条反馈行：一条在快照窗口内、一条在窗口外 30 天——两格的值刻意做成"无窗/有窗"可区分。 */
    async function seedFeedback() {
      const rows = [
        { key: 'fb-in', fallback: true, runtime: 100, ts: new Date() },
        { key: 'fb-out', fallback: false, runtime: 900, ts: new Date(Date.now() - 30 * 86_400_000) },
      ];
      for (const r of rows) {
        await owner.unsafe(
          `INSERT INTO public.ewoh_scheduling_feedback`
            + ` (feedback_id, org_id, run_id, plan_id, solver_fallback, solver_runtime,`
            + `  ts, _created_at, _updated_at)`
            + ` VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$7)`,
          [`${tag}-${r.key}`, org(), `${tag}-run`, `${tag}-plan`, r.fallback, r.runtime, r.ts.toISOString()],
        );
      }
    }

    /** feedback 半的独立重算：口径全部出自契约（含"无窗"这一条），测试不补 WHERE。 */
    async function recomputeFeedbackFromContract() {
      const w = CONTRACT;
      if (w.feedback_window !== 'none') {
        throw new Error(`契约的 feedback_window 已改成 ${w.feedback_window} ⇒ KC-05 的比较式与 KPIWINDOW-01 要同批改`);
      }
      if (w.runtime_aggregate !== 'avg') {
        throw new Error(`契约的 runtime_aggregate 不再是 avg（${w.runtime_aggregate}）⇒ 下面的聚合式要同批改`);
      }
      const rows = (await owner.unsafe(
        `SELECT count(*)::int AS scope_rows,`
          + `       count(*) FILTER (WHERE ${w.fallback_numerator_filter})::int AS fallback_rows,`
          + `       avg(feedback.solver_runtime) FILTER (WHERE (${w.runtime_measure_filter}))::float8 AS runtime_avg`
          + `  FROM public.${w.feedback_source_table} feedback`
          + ` WHERE ${w.feedback_scope}`,
        [org()],
      )) as Array<{ scope_rows: number; fallback_rows: number; runtime_avg: number | null }>;
      const r = rows[0] ?? { scope_rows: 0, fallback_rows: 0, runtime_avg: null };
      return {
        scopeRows: Number(r.scope_rows),
        fallbackRows: Number(r.fallback_rows),
        // 契约声明：分母＝范围内全部行；无行时实现给 0（`total > 0 ? … : 0`），不是 null。
        heuristicFallbackRate: r.scope_rows > 0 ? Number(r.fallback_rows) / Number(r.scope_rows) : Number(w.runtime_empty_value),
        solverLatencyAvgMs: r.runtime_avg == null ? Number(w.runtime_empty_value) : Number(r.runtime_avg),
      };
    }

    async function readPersistedKpi() {
      const rows = (await owner.unsafe(
        `SELECT kpi_id, period_start, period_end, kpi_json FROM public.ewoh_scheduling_kpi`
          + ` WHERE org_id = $1 ORDER BY period_end DESC LIMIT 1`,
        [org()],
      )) as Array<{ kpi_id: string; period_start: Date; period_end: Date; kpi_json: Record<string, unknown> }>;
      return rows[0];
    }

    it('KC-01 走产品入口聚合并落库：落库行数的增量证明这一条路径真写了投影', async () => {
      await seedExecutions();
      await seedRuns();
      const before = (await owner.unsafe(
        `SELECT count(*)::int AS n FROM public.ewoh_scheduling_kpi WHERE org_id = $1`, [org()],
      )) as Array<{ n: number }>;
      const got = await apiRequest<{ delivery?: Record<string, number | null> }>(
        handle.baseUrl, '/api/scheduler/kpi?persist=1',
        { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      );
      expect(got.status).toBe(200);
      expect(got.body?.delivery).toBeTruthy();
      const after = (await owner.unsafe(
        `SELECT count(*)::int AS n FROM public.ewoh_scheduling_kpi WHERE org_id = $1`, [org()],
      )) as Array<{ n: number }>;
      // 用增量而不是绝对值：前一遍残留的行会让"绝对值 ≥1"假绿（V229 的 runId 教训同族）。
      expect(Number(after[0]?.n ?? 0) - Number(before[0]?.n ?? 0)).toBe(1);
    }, 180_000);

    it('KC-02 契约独立重算 == 落库的 delivery 块（逐项，且 HTTP 响应与落库一致）', async () => {
      const row = await readPersistedKpi();
      expect(row).toBeTruthy();
      const persisted = (row!.kpi_json as { delivery: Record<string, number | null> }).delivery;
      const { delivery } = await recomputeFromContract(
        new Date(row!.period_start).toISOString(),
        new Date(row!.period_end).toISOString(),
      );
      expect(diffDelivery(persisted, delivery)).toEqual([]);
      // 三条分母口径必须在场（少一条就退化成"只比了一个数"）：
      expect(delivery.completionRate).toBeCloseTo(3 / 4, 6);      // completion 分母＝窗口内全部行
      expect(delivery.onTimeRate).toBeCloseTo(1 / 3, 6);         // on_time 分母＝可测量行
      expect(delivery.averageWaitingMs).not.toBeNull();          // 平均量分母＝窗口内全部行（含不可测量那条）
      const got = await apiRequest<{ delivery?: Record<string, number | null> }>(
        handle.baseUrl, '/api/scheduler/kpi',
        { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      );
      expect(diffDelivery(got.body?.delivery ?? {}, persisted)).toEqual([]);
      // ── stability 可重算的那半（run 窗口计数）同样由契约独立重算；gauge 那半刻意不比（PROJ-05）
      const stability = (row!.kpi_json as { stability?: Record<string, number | null> }).stability ?? {};
      const runRows = (await owner.unsafe(
        `SELECT count(*)::int AS runs,`
          + `       count(*) FILTER (WHERE run.trigger_type IS NOT NULL AND run.trigger_type <> $4)::int AS triggers`
          + `  FROM public.${CONTRACT.replan_run_source} run`
          + ` WHERE run.org_id = $1::varchar`
          + `   AND (${CONTRACT.replan_run_window_column} >= $2::timestamptz)`
          + `   AND (${CONTRACT.replan_run_window_column} <= $3::timestamptz)`,
        [org(), new Date(row!.period_start).toISOString(), new Date(row!.period_end).toISOString(),
          CONTRACT.replan_trigger_excludes],
      )) as Array<{ runs: number; triggers: number }>;
      // 前提：两条播种都在窗口内被数到（否则下面的相等就是 0==0 的恒真）
      expect(Number(runRows[0]?.runs ?? 0)).toBe(2);
      expect(Number(runRows[0]?.triggers ?? 0)).toBe(1);
      expect(stability.replanCount).toBe(Number(runRows[0]?.runs ?? -1));
      expect(stability.replanTriggerCount).toBe(Number(runRows[0]?.triggers ?? -1));
      // KPIRATE-01 的形状也在这里现形：契约/实现都没算的那支被覆盖成 null
      expect(stability.conflictRate).toBeNull();
    }, 180_000);

    it('KC-03 牙齿：投影与源漂开必须被同一比较看见，还原后必须复绿', async () => {
      const row = await readPersistedKpi();
      const { delivery } = await recomputeFromContract(
        new Date(row!.period_start).toISOString(),
        new Date(row!.period_end).toISOString(),
      );
      expect(delivery.onTimeRate).not.toBeNull();
      const drifted = (delivery.onTimeRate as number) + 0.25;
      await owner.unsafe(
        `UPDATE public.ewoh_scheduling_kpi`
          + `   SET kpi_json = jsonb_set(kpi_json, '{delivery,onTimeRate}', to_jsonb($2::double precision))`
          + ` WHERE kpi_id = $1 AND org_id = $3`,
        [row!.kpi_id, String(drifted), org()],
      );
      const bad = await readPersistedKpi();
      const diffs = diffDelivery(
        (bad!.kpi_json as { delivery: Record<string, number | null> }).delivery,
        delivery,
      );
      expect(diffs.some((x) => x.startsWith('onTimeRate'))).toBe(true);
      // 还原用**同一条表达式回填原值**（而不是整块 JSON 覆写）：驱动会把 text 参数按
      // jsonb 字符串标量落进去，整块覆写反而造出第二种形状（实测：还原后 kpi_json 变字符串标量）。
      await owner.unsafe(
        `UPDATE public.ewoh_scheduling_kpi`
          + `   SET kpi_json = jsonb_set(kpi_json, '{delivery,onTimeRate}', to_jsonb($2::double precision))`
          + ` WHERE kpi_id = $1 AND org_id = $3`,
        [row!.kpi_id, String(delivery.onTimeRate as number), org()],
      );
      const restored = await readPersistedKpi();
      expect(typeof restored!.kpi_json).toBe('object');
      expect(diffDelivery(
        (restored!.kpi_json as { delivery: Record<string, number | null> }).delivery,
        delivery,
      )).toEqual([]);
    }, 180_000);

    it('KC-04 牙齿：源行挪出窗口后契约重算变化而落库快照一字不动（钉现状，不主张应然）', async () => {
      const before = await readPersistedKpi();
      const startIso = new Date(before!.period_start).toISOString();
      const endIso = new Date(before!.period_end).toISOString();
      const first = await recomputeFromContract(startIso, endIso);
      const snapshotBefore = JSON.stringify(before!.kpi_json);
      // 把"迟到那条"的可更新时间挪到窗口之外 ⇒ 它退出窗口与可测量两个集合。
      await owner.unsafe(
        `UPDATE public.ewoh_scheduling_execution`
          + `   SET _updated_at = $2::timestamptz - interval '1 ms'`
          + ` WHERE execution_id = $1`,
        [`${tag}-late`, startIso],
      );
      const after = await recomputeFromContract(startIso, endIso);
      expect(after.windowRows).toBe(first.windowRows - 1);
      expect(after.measurable).toBe(first.measurable - 1);
      // 迟到那行的 600s 离开后，on_time_rate 的分母从 3 变 2 ⇒ 值必须移动（否则比较是恒真）
      expect(after.delivery.onTimeRate).not.toBeCloseTo(first.delivery.onTimeRate as number, 9);
      const frozen = await readPersistedKpi();
      expect(JSON.stringify(frozen!.kpi_json)).toBe(snapshotBefore);
    }, 180_000);
    it('KC-05 三源同块对账：delivery（执行表）＋run 计数＋feedback 半一次比完', async () => {
      await seedFeedback();
      // 重新聚合一份新快照：KC-04 把一条源行挪出了窗口，旧快照与源本就该不等（那正是它钉的现状）。
      const got = await apiRequest<{ solver?: Record<string, number | null> }>(
        handle.baseUrl, '/api/scheduler/kpi?persist=1',
        { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      );
      expect(got.status).toBe(200);
      const row = await readPersistedKpi();
      expect(row).toBeTruthy();
      const json = row!.kpi_json as {
        delivery: Record<string, number | null>;
        stability?: Record<string, number | null>;
        solver?: Record<string, number | null>;
      };
      const startIso = new Date(row!.period_start).toISOString();
      const endIso = new Date(row!.period_end).toISOString();

      // 前提：三份源表在这一份快照里各有行在场（少一张，"三源对账"就退化成两源，档位也就该降回去）。
      const src = (await owner.unsafe(
        `SELECT (SELECT count(*) FROM public.ewoh_scheduling_execution execution WHERE execution.org_id = $1)::int AS exec_rows,`
          + `       (SELECT count(*) FROM public.ewoh_scheduling_run run WHERE run.org_id = $1)::int AS run_rows,`
          + `       (SELECT count(*) FROM public.ewoh_scheduling_feedback feedback WHERE feedback.org_id = $1)::int AS fb_rows,`
          + `       (SELECT count(*) FROM public.ewoh_scheduling_kpi WHERE org_id = $1)::int AS kpi_rows`,
        [org()],
      )) as Array<{ exec_rows: number; run_rows: number; fb_rows: number; kpi_rows: number }>;
      expect(Number(src[0]?.exec_rows ?? 0)).toBeGreaterThan(0);
      expect(Number(src[0]?.run_rows ?? 0)).toBe(2);
      expect(Number(src[0]?.fb_rows ?? 0)).toBe(2);

      // ① delivery 半（执行表，按窗口）
      const { delivery } = await recomputeFromContract(startIso, endIso);
      expect(diffDelivery(json.delivery, delivery)).toEqual([]);
      // ② stability 的可重算半（run 窗口计数）
      const runRows = (await owner.unsafe(
        `SELECT count(*)::int AS runs,`
          + `       count(*) FILTER (WHERE run.trigger_type IS NOT NULL AND run.trigger_type <> $4)::int AS triggers`
          + `  FROM public.${CONTRACT.replan_run_source} run`
          + ` WHERE run.org_id = $1::varchar`
          + `   AND (${CONTRACT.replan_run_window_column} >= $2::timestamptz)`
          + `   AND (${CONTRACT.replan_run_window_column} <= $3::timestamptz)`,
        [org(), startIso, endIso, CONTRACT.replan_trigger_excludes],
      )) as Array<{ runs: number; triggers: number }>;
      expect(Number(runRows[0]?.runs ?? 0)).toBe(2);
      expect(json.stability?.replanCount).toBe(Number(runRows[0]?.runs ?? -1));
      // ③ feedback 半（solver 两格）——契约声明的这一支**没有时间窗**
      const fb = await recomputeFeedbackFromContract();
      expect(fb.scopeRows).toBe(2);
      expect(fb.fallbackRows).toBe(1);
      expect(json.solver?.heuristicFallbackRate).toBeCloseTo(fb.heuristicFallbackRate, 6);
      expect(json.solver?.solverLatencyAvgMs).toBeCloseTo(fb.solverLatencyAvgMs, 6);
      // 关键前提：落库快照声明的 period 里只有**一条**反馈行 ⇒ "无窗"与"有窗"两个候选值必须可区分，
      // 否则上面两个 toBeCloseTo 就是恒真。这条也是 KPIWINDOW-01 的实测证据：
      // 同一份快照的 delivery 按 period 取数、solver 这两格把 30 天前的行一起算了进来。
      const win = (await owner.unsafe(
        `SELECT count(*)::int AS n, COALESCE(avg(feedback.solver_runtime), 0)::float8 AS avg_runtime`
          + `  FROM public.ewoh_scheduling_feedback feedback`
          + ` WHERE feedback.org_id = $1 AND feedback.ts >= $2::timestamptz AND feedback.ts <= $3::timestamptz`,
        [org(), startIso, endIso],
      )) as Array<{ n: number; avg_runtime: number }>;
      expect(Number(win[0]?.n ?? 0)).toBe(1);
      expect(Number(win[0]?.avg_runtime ?? 0)).not.toBeCloseTo(fb.solverLatencyAvgMs, 9);
      expect(fb.solverLatencyAvgMs).toBeCloseTo(500, 6);   // (100+900)/2，全天候
      expect(Number(win[0]?.avg_runtime ?? 0)).toBeCloseTo(100, 6); // 窗口内那一支会给的值
    }, 180_000);

    it('KC-06 牙齿：feedback 半漂移必须被同一比较看见，还原后复绿', async () => {
      const row = await readPersistedKpi();
      expect(row).toBeTruthy();
      const fb = await recomputeFeedbackFromContract();
      const diffSolver = (persisted: Record<string, number | null> | undefined) => diffDelivery(
        { latency: persisted?.solverLatencyAvgMs ?? null, fallback: persisted?.heuristicFallbackRate ?? null },
        { latency: fb.solverLatencyAvgMs, fallback: fb.heuristicFallbackRate },
      );
      const solverOf = async () => ((await readPersistedKpi())!.kpi_json as { solver?: Record<string, number | null> }).solver;
      expect(diffSolver(await solverOf())).toEqual([]);
      const write = (v: number) => owner.unsafe(
        `UPDATE public.ewoh_scheduling_kpi`
          + `   SET kpi_json = jsonb_set(kpi_json, '{solver,solverLatencyAvgMs}', to_jsonb($2::double precision))`
          + ` WHERE kpi_id = $1 AND org_id = $3`,
        [row!.kpi_id, String(v), org()],
      );
      await write(fb.solverLatencyAvgMs + 400);
      expect(diffSolver(await solverOf()).some((x) => x.startsWith('latency'))).toBe(true);
      await write(fb.solverLatencyAvgMs);
      expect(diffSolver(await solverOf())).toEqual([]);
      expect(typeof (await readPersistedKpi())!.kpi_json).toBe('object');
    }, 180_000);
  },
);
