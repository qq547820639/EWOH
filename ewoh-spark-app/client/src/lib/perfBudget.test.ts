import {
  PERF_BUDGETS,
  budgetSummary,
  evaluateAllBudgets,
  evaluateBudget,
  getBudgetByKey,
} from './perfBudget';

describe('perfBudget', () => {
  it('defines budgets covering all ten UX-008 categories', () => {
    const categories = new Set(PERF_BUDGETS.map((budget) => budget.category));
    expect(categories.size).toBe(10);
    expect(categories.has('first-screen')).toBe(true);
    expect(categories.has('route-switch')).toBe(true);
    expect(categories.has('large-table')).toBe(true);
    expect(categories.has('work-graph')).toBe(true);
    expect(categories.has('world-replay')).toBe(true);
    expect(categories.has('offline-queue')).toBe(true);
    expect(categories.has('image')).toBe(true);
    expect(categories.has('api-p95')).toBe(true);
    expect(categories.has('slow-query')).toBe(true);
    expect(categories.has('low-end-tablet')).toBe(true);
  });

  it('covers every required spec budget dimension by key', () => {
    const requiredKeys = [
      'first-screen-js-gzip', // 初始 JS 体积
      'single-async-chunk-gzip', // 单块异步 chunk 体积
      'first-interactive-time', // 首屏可交互时间 TTI
      'large-table-5000-render', // 大表格操作延迟
      'image-attachment-process', // 大图渲染
      'low-end-tablet-memory-peak', // 低端平板内存峰值
      'offline-queue-flush-100', // 离线恢复与队列回放
    ];
    for (const key of requiredKeys) {
      expect(getBudgetByKey(key)).toBeDefined();
    }
  });

  it('marks a budget as pass when measured is within limit + tolerance', () => {
    const budget = getBudgetByKey('work-graph-3000-layout')!;
    const result = evaluateBudget(budget, budget.limit + budget.tolerance / 2);
    expect(result.status).toBe('pass');
    expect(result.within).toBe(true);
    expect(result.measured).toBe(budget.limit + budget.tolerance / 2);
  });

  it('marks a budget as fail when measured exceeds limit + tolerance', () => {
    const budget = getBudgetByKey('work-graph-3000-layout')!;
    const result = evaluateBudget(budget, budget.limit + budget.tolerance + 1);
    expect(result.status).toBe('fail');
    expect(result.within).toBe(false);
    expect(result.delta).toBeGreaterThan(budget.tolerance);
  });

  it('evaluates the single async chunk budget pass/fail', () => {
    const budget = getBudgetByKey('single-async-chunk-gzip')!;
    expect(
      evaluateBudget(budget, budget.limit + budget.tolerance / 2).status,
    ).toBe('pass');
    expect(
      evaluateBudget(budget, budget.limit + budget.tolerance + 10).status,
    ).toBe('fail');
  });

  it('marks a budget as pending when there is no measured data', () => {
    const budget = getBudgetByKey('api-p95')!;
    expect(evaluateBudget(budget, null).status).toBe('pending');
    expect(evaluateBudget(budget, Number.NaN).status).toBe('pending');
  });

  it('evaluates all budgets and treats missing entries as pending', () => {
    const results = evaluateAllBudgets({});
    expect(results).toHaveLength(PERF_BUDGETS.length);
    expect(results.filter((result) => result.status === 'pending')).toHaveLength(
      PERF_BUDGETS.length,
    );
  });

  it('summarizes pass/fail/pending and flags ok=false when any fail', () => {
    const results = evaluateAllBudgets({
      'work-graph-3000-layout': 0,
      'offline-queue-flush-100': 0,
      'api-p95': 999999,
    });
    const summary = budgetSummary(results);
    expect(summary.pass).toBe(2);
    expect(summary.fail).toBe(1);
    expect(summary.pending).toBe(PERF_BUDGETS.length - 3);
    expect(summary.ok).toBe(false);
  });

  it('summary is ok when failures are absent even with pending items', () => {
    const results = evaluateAllBudgets({});
    expect(budgetSummary(results).ok).toBe(true);
  });
});