/**
 * PolicyGatePanel 渲染测试（NO-87b，零网络）。
 *
 * 三态语义（与 golden 场景一致）：
 *   · 全部通过且证据齐 → "可激活（无需确认）"；
 *   · 有 skipped 检查 → "可激活，但需显式确认（缺数据）"；
 *   · 有 failed 检查 → "已拒绝（不达标）——ack 无法豁免"。
 * 每条检查行必须展示 实际值 vs 阈值 与三态结论（通过/缺数据/不达标）。
 */
import { renderToStaticMarkup } from 'react-dom/server';

jest.mock('@tanstack/react-query', () => ({
  // 按 queryKey 区分：gate 主查询用 mockState，history 查询单独控制
  useQuery: (options: { queryKey?: unknown[] } = {}) => {
    const key = String(options?.queryKey?.[0] ?? '');
    if (key === 'policy-gate-history') return { data: mockState.history, isLoading: mockState.historyLoading, isError: false, error: null };
    return { data: mockState.data, isLoading: mockState.isLoading, isError: mockState.isError, error: mockState.error };
  },
}));

jest.mock('../../api/scheduler', () => ({
  evaluatePolicyGate: jest.fn(),
  getKpiHistory: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const schedulerApi = require('../../api/scheduler');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PolicyGatePanel } = require('./PolicyGatePanel');

const mockState: {
  data: unknown; isLoading: boolean; isError: boolean; error: unknown;
  history: unknown; historyLoading: boolean;
} = {
  data: undefined, isLoading: false, isError: false, error: null,
  history: [], historyLoading: false,
};

function gate(checks: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  return {
    passed: checks.every((c) => c.skipped || c.ok),
    checks,
    replayId: null,
    insufficientEvidence: checks.some((c) => c.skipped),
    evidence: { evaluated: checks.filter((c) => !c.skipped).length, skipped: checks.filter((c) => c.skipped).length, skippedChecks: [], candidatePolicyExists: true },
    ...extra,
  };
}

const PASS_CHECK = { name: 'on_time_rate', ok: true, actual: 0.92, threshold: 0.8, skipped: false };
const FAIL_CHECK = { name: 'on_time_rate', ok: false, actual: 0.75, threshold: 0.8, skipped: false };
const SKIP_CHECK = { name: 'conflict_rate', ok: true, actual: null, threshold: 0.05, skipped: true };

describe('PolicyGatePanel（NO-87b）', () => {
  afterEach(() => {
    mockState.data = undefined;
    mockState.isLoading = false;
    mockState.isError = false;
    mockState.error = null;
    schedulerApi.getKpiHistory.mockReset();
    mockState.history = [];
  });

  function mockHistory(entries: Array<Record<string, unknown>>) {
    schedulerApi.getKpiHistory.mockResolvedValue(entries);
    mockState.history = entries;
  }

  it('全通过 → "可激活（无需确认）"，检查行展示实际 vs 阈值', () => {
    mockState.data = gate([PASS_CHECK]);
    const markup = renderToStaticMarkup(<PolicyGatePanel />);
    expect(markup).toContain('可激活（全部检查通过）');
    expect(markup).toContain('on_time_rate');
    expect(markup).toContain('通过');
  });

  it('缺数据 → "需显式确认"徽章 + 检查行标注"缺数据（未验证）"', () => {
    mockState.data = gate([SKIP_CHECK]);
    const markup = renderToStaticMarkup(<PolicyGatePanel />);
    expect(markup).toContain('需显式确认');
    expect(markup).toContain('证据不足');
    expect(markup).toContain('缺数据（未验证）');
    expect(markup).toContain('未验证 ≠ 通过');
  });

  it('不达标 → "已拒绝（指标不达标）"徽章 + 不达标行加粗标红', () => {
    mockState.data = gate([FAIL_CHECK]);
    const markup = renderToStaticMarkup(<PolicyGatePanel />);
    expect(markup).toContain('已拒绝（指标不达标）');
    expect(markup).toContain('不达标');
    expect(markup).toContain('0.75');
    expect(markup).toContain('0.8');
  });

  it('NO-89a 趋势：有快照序列时展示 on-time/lateness 随周期变化', () => {
    mockState.data = gate([PASS_CHECK]);
    mockHistory([
      { periodStart: 'p2', periodEnd: '2026-09-16T12:00:00Z', createdAt: 'x', kpi: { onTimeRate: 0.75, latenessP95Ms: 8575850, periodStart: 'p2', periodEnd: 'e2' } },
      { periodStart: 'p1', periodEnd: '2026-09-15T12:00:00Z', createdAt: 'x', kpi: { onTimeRate: 0.9, latenessP95Ms: 900000, periodStart: 'p1', periodEnd: 'e1' } },
    ]);
    const markup = renderToStaticMarkup(<PolicyGatePanel />);
    expect(markup).toContain('KPI 趋势（最近 2 个快照');
    expect(markup).toContain('0.75');
    expect(markup).toContain('8575850');
    expect(markup).toContain('0.90');
    expect(markup).toContain('2026-09-15 12:00');
    // NO-90b sparkline：两个已知点 → 一段折线（缺数据点会断开）
    expect(markup).toContain('<polyline');
    expect(markup).toContain('stroke-dasharray="3 3"');
    // NO-99b tooltip：悬停可读每个周期的值（title 原生可达）
    expect(markup).toContain('on-time 趋势（旧→新）');
    expect(markup).toContain('on-time=0.9');
  });

  it('NO-89a 趋势：无快照（如清库后）如实缺项，不伪造趋势', () => {
    mockHistory([]);
    const markup = renderToStaticMarkup(<PolicyGatePanel />);
    expect(markup).not.toContain('KPI 趋势');
  });

  it('读失败显式报错（不显示"一切正常"）', () => {
    mockState.isError = true;
    mockState.error = new Error('HTTP 403');
    const markup = renderToStaticMarkup(<PolicyGatePanel />);
    expect(markup).toContain('策略门禁读取失败');
    expect(markup).toContain('HTTP 403');
  });

  it('加载中显式提示', () => {
    mockState.isLoading = true;
    const markup = renderToStaticMarkup(<PolicyGatePanel />);
    expect(markup).toContain('正在评估策略门禁');
  });
});
