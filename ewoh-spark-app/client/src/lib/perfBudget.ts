/**
 * UX-008「性能工程」— 前端性能预算常量与校验函数。
 *
 * 本模块定义 EWOH 前端的性能预算表（budget），覆盖 spec UX-008 所列的十个维度：
 * 首屏资源 / 路由切换 / 大表格 / 大型 Work Graph / 世界回放 / 移动端离线队列 /
 * 图片处理 / API p95 / 慢查询 / 低端工业平板。
 *
 * 设计约定：
 * - 预算为"上限"（limit），测量值 ≤ limit + tolerance 视为通过（pass）。
 * - 纯逻辑类（graph layout、离线队列、渐进列表）可在 node 环境实测
 *   （可由 scripts/perf-bench.mjs 产出），其余项需真实浏览器/真实环境，
 *   在无实测数据时校验结果标记为 pending。
 * - 校验函数为纯函数，便于单测；scripts/perf-budget.mjs 复用同一套阈值语义
 *   在 CI 中判定是否超预算。
 */

export type PerfCategory =
  | 'first-screen'
  | 'route-switch'
  | 'large-table'
  | 'work-graph'
  | 'world-replay'
  | 'offline-queue'
  | 'image'
  | 'api-p95'
  | 'slow-query'
  | 'low-end-tablet';

export type PerfUnit = 'ms' | 'kb' | 'mb' | 'rows' | 'nodes';

export interface PerfBudget {
  /** 稳定标识，供 CI 与测量结果按 key 对齐。 */
  key: string;
  category: PerfCategory;
  /** 中文标签。 */
  label: string;
  unit: PerfUnit;
  /** 预算上限（按 unit）。 */
  limit: number;
  /** 抖动容差（按 unit），用于抑制 CI 波动造成的误报。 */
  tolerance: number;
  /** 测量方法说明。 */
  measure: string;
  /** 是否可在 node 环境实测（false 表示需要真实浏览器/真实环境）。 */
  measurableInNode: boolean;
}

export const PERF_BUDGETS: PerfBudget[] = [
  {
    key: 'first-screen-js-gzip',
    category: 'first-screen',
    label: '首屏资源（JS 传送体积 gzip）',
    unit: 'kb',
    limit: 420,
    tolerance: 40,
    measure: '构建后路由级 chunk 经 gzip 的体积（需真实浏览器/构建产物）',
    measurableInNode: false,
  },
  {
    key: 'single-async-chunk-gzip',
    category: 'first-screen',
    label: '单块异步/路由 chunk（gzip）',
    unit: 'kb',
    limit: 480,
    tolerance: 40,
    measure: '构建产物中体积最大的单块异步/路由 chunk 的 gzip 体积（由 scripts/bundle-budget.mjs 实测）',
    measurableInNode: true,
  },
  {
    key: 'first-interactive-time',
    category: 'first-screen',
    label: '首屏交互可用时间（TTI）',
    unit: 'ms',
    limit: 3500,
    tolerance: 500,
    measure: '页面加载到首屏可交互时间 TTI（需真实浏览器）',
    measurableInNode: false,
  },
  {
    key: 'route-switch-interactive',
    category: 'route-switch',
    label: '路由切换至可交互',
    unit: 'ms',
    limit: 300,
    tolerance: 80,
    measure: '路由切换后首帧可交互时间（需真实浏览器）',
    measurableInNode: false,
  },
  {
    key: 'large-table-5000-render',
    category: 'large-table',
    label: '大表格 5000 行首屏渲染',
    unit: 'ms',
    limit: 500,
    tolerance: 100,
    measure: '5000 行表格首屏渲染耗时（虚拟化后，需真实浏览器）',
    measurableInNode: false,
  },
  {
    key: 'work-graph-3000-layout',
    category: 'work-graph',
    label: 'Work Graph 3000 节点布局',
    unit: 'ms',
    limit: 450,
    tolerance: 80,
    measure: 'buildGraphLayout 3000 节点布局耗时中位数（node 可实测）',
    measurableInNode: true,
  },
  {
    key: 'world-replay-frame',
    category: 'world-replay',
    label: '世界回放流畅帧预算',
    unit: 'ms',
    limit: 16.7,
    tolerance: 3,
    measure: '单帧渲染 ≤ 16.7ms（60fps，需真实浏览器）',
    measurableInNode: false,
  },
  {
    key: 'offline-queue-flush-100',
    category: 'offline-queue',
    label: '移动端离线队列 flush 100 条',
    unit: 'ms',
    limit: 200,
    tolerance: 50,
    measure: 'flushPendingQueue 处理 100 条待同步动作耗时中位数（node 可实测）',
    measurableInNode: true,
  },
  {
    key: 'image-attachment-process',
    category: 'image',
    label: '图片/附件处理',
    unit: 'ms',
    limit: 300,
    tolerance: 80,
    measure: '图片压缩/DataURL 转换耗时（需真实浏览器）',
    measurableInNode: false,
  },
  {
    key: 'api-p95',
    category: 'api-p95',
    label: 'API p95 响应',
    unit: 'ms',
    limit: 800,
    tolerance: 200,
    measure: '核心接口 p95 响应时长（需真实服务/环境）',
    measurableInNode: false,
  },
  {
    key: 'slow-query',
    category: 'slow-query',
    label: '慢查询耗时',
    unit: 'ms',
    limit: 1000,
    tolerance: 200,
    measure: '数据库慢查询阈值（需真实数据库）',
    measurableInNode: false,
  },
  {
    key: 'low-end-tablet-frame',
    category: 'low-end-tablet',
    label: '低端工业平板交互帧',
    unit: 'ms',
    limit: 50,
    tolerance: 10,
    measure: '低端平板单帧预算（20fps，需真实设备）',
    measurableInNode: false,
  },
  {
    key: 'low-end-tablet-memory-peak',
    category: 'low-end-tablet',
    label: '低端平板内存峰值',
    unit: 'mb',
    limit: 400,
    tolerance: 50,
    measure: '低端工业平板运行峰值内存（需真实设备）',
    measurableInNode: false,
  },
];

export type BudgetStatus = 'pass' | 'fail' | 'pending';

export interface BudgetResult {
  key: string;
  category: PerfCategory;
  label: string;
  unit: PerfUnit;
  limit: number;
  measured: number | null;
  delta: number | null;
  within: boolean;
  status: BudgetStatus;
}

/**
 * 校验单条预算。measured 为 null 或非有限数时视为 pender（无实测数据）。
 */
export function evaluateBudget(budget: PerfBudget, measured: number | null): BudgetResult {
  const base: BudgetResult = {
    key: budget.key,
    category: budget.category,
    label: budget.label,
    unit: budget.unit,
    limit: budget.limit,
    measured: null,
    delta: null,
    within: false,
    status: 'pending',
  };
  if (measured === null || measured === undefined || !Number.isFinite(measured)) {
    return base;
  }
  const effectiveLimit = budget.limit + budget.tolerance;
  const within = measured <= effectiveLimit;
  return {
    ...base,
    measured,
    delta: measured - budget.limit,
    within,
    status: within ? 'pass' : 'fail',
  };
}

/**
 * 批量校验。measuredByKey 以 budget.key 为键，缺失的项标记为 pending。
 */
export function evaluateAllBudgets(
  measuredByKey: Record<string, number | null>,
): BudgetResult[] {
  return PERF_BUDGETS.map((budget) =>
    evaluateBudget(budget, measuredByKey[budget.key] ?? null),
  );
}

export interface BudgetSummary {
  total: number;
  pass: number;
  fail: number;
  pending: number;
  /** 是否整体通过（存在 fail 即失败）。 */
  ok: boolean;
}

export function budgetSummary(results: BudgetResult[]): BudgetSummary {
  const summary = results.reduce<Omit<BudgetSummary, 'ok'>>(
    (acc, result) => {
      acc.total += 1;
      if (result.status === 'pass') acc.pass += 1;
      else if (result.status === 'fail') acc.fail += 1;
      else acc.pending += 1;
      return acc;
    },
    { total: 0, pass: 0, fail: 0, pending: 0 },
  );
  return { ...summary, ok: summary.fail === 0 };
}

export function getBudgetByKey(key: string): PerfBudget | undefined {
  return PERF_BUDGETS.find((budget) => budget.key === key);
}