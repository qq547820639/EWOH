// simulationConsoleLogic.ts — 仿真运行控制台纯逻辑（node 可测，R-57 / ADR-036）。
//
// L6 仿真决策支持面：把 ADR-025 SimulationRun 体系（契约 + 台账 + 事件 +
// 四类确定性评估器）接入 Factory Operating Console 的展示装配层。
// 边界：本文件只做展示层文案/状态色/结果摘要与参数预检（UX 预检，服务端
// validateSimulationRun + 评估器仍为权威 fail-closed），绝不重算仿真结果、
// 绝不伪造数据；未知/缺失字段显式 '—'。

export type ConsoleTone = 'positive' | 'negative' | 'warning' | 'neutral';

/** 可见性修复（2026-08-19 审计 D13，P1 lint 收口）：状态文字用 risk-* 语义
 * token（暗色自动提亮，浅色/深色两主题可读）；neutral 直接用主题 token
 * text-muted-foreground。chip 用半透明 risk-*（浅色/深色主题都成立），
 * 消除"亮块 + 深字"的突兀观感。 */
export const TONE_TEXT: Record<ConsoleTone, string> = {
  positive: 'text-risk-normal',
  negative: 'text-risk-blocked',
  warning: 'text-risk-degraded',
  neutral: 'text-muted-foreground',
};

export const TONE_BORDER: Record<ConsoleTone, string> = {
  positive: 'border-risk-normal/30 bg-risk-normal/10',
  negative: 'border-risk-blocked/30 bg-risk-blocked/10',
  warning: 'border-risk-degraded/30 bg-risk-degraded/10',
  neutral: 'border-border bg-muted',
};

export const SIMULATION_KIND_LABELS: Record<string, string> = {
  what_if: 'What-if 方案推演',
  capacity: '产能评估',
  layout: '布局行程',
  material_flow: '物料流载荷',
};

export const SIMULATION_STATUS_LABELS: Record<string, string> = {
  created: '已创建',
  running: '评估中',
  completed: '已完成',
  failed: '失败',
};

export const SIMULATION_STATUS_TONES: Record<string, ConsoleTone> = {
  created: 'neutral',
  running: 'neutral',
  completed: 'positive',
  failed: 'negative',
};

/** 参数模板（示例；预填进参数编辑器，标注"示例"由操作员改写）。 */
export const SIMULATION_PARAMETER_EXAMPLES: Record<string, string> = {
  what_if: `{
  "baseFacts": [
    { "ruleId": "fatigue_check", "subjectId": "person:worker-01", "conclusion": "risk_high", "confidence": 1 }
  ],
  "deltaFacts": [
    { "ruleId": "fatigue_check", "subjectId": "person:worker-01", "conclusion": "risk_low", "confidence": 1 }
  ]
}`,
  capacity: `{
  "stations": [
    { "stationId": "ST-1", "capacityPerHour": 40 },
    { "stationId": "ST-2", "capacityPerHour": 25 }
  ],
  "demandPerHour": 30
}`,
  layout: `{
  "stations": [
    { "stationId": "ST-1", "x": 0, "y": 0 },
    { "stationId": "ST-2", "x": 30, "y": 40 }
  ],
  "moves": [
    { "fromStationId": "ST-1", "toStationId": "ST-2", "trips": 8 }
  ]
}`,
  material_flow: `{
  "stations": [
    { "stationId": "ST-1", "capacityPerHour": 40, "inflowPerHour": 45 },
    { "stationId": "ST-2", "capacityPerHour": 25, "inflowPerHour": 10 }
  ]
}`,
};

function isObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 参数预检（UX 预检，镜像评估器输入契约；服务端仍权威 fail-closed）。
 * 返回错误码列表（空 = 通过）。未知 kind → ['unknown_kind']。
 */
export function validateSimulationParameters(kind: string, parameters: unknown): string[] {
  switch (kind) {
    case 'what_if': {
      if (!isObject(parameters)) return ['parameters_must_be_object'];
      const { baseFacts, deltaFacts } = parameters;
      if (!Array.isArray(baseFacts) || !Array.isArray(deltaFacts)) {
        return ['what_if_requires_baseFacts_deltaFacts_arrays'];
      }
      for (const [name, facts] of [['baseFacts', baseFacts], ['deltaFacts', deltaFacts]] as const) {
        for (const f of facts) {
          if (!isObject(f)) return [`${name}_fact_must_be_object`];
          if (typeof f.ruleId !== 'string' || f.ruleId.trim() === '') return [`${name}_fact_missing_ruleId`];
          if (typeof f.subjectId !== 'string' || f.subjectId.trim() === '') return [`${name}_fact_missing_subjectId`];
          if (typeof f.conclusion !== 'string' || f.conclusion.trim() === '') return [`${name}_fact_missing_conclusion`];
          if (typeof f.confidence !== 'number' || Number.isNaN(f.confidence)) return [`${name}_fact_bad_confidence`];
        }
      }
      return [];
    }
    case 'capacity': {
      if (!isObject(parameters)) return ['parameters_must_be_object'];
      const { stations, demandPerHour } = parameters;
      if (!Array.isArray(stations) || stations.length === 0) return ['stations_must_be_nonempty_array'];
      for (const s of stations) {
        if (!isObject(s)) return ['station_must_be_object'];
        if (typeof s.stationId !== 'string' || s.stationId.trim() === '') return ['station_missing_stationId'];
        if (typeof s.capacityPerHour !== 'number' || Number.isNaN(s.capacityPerHour) || s.capacityPerHour <= 0) return ['station_capacity_must_be_positive'];
      }
      if (typeof demandPerHour !== 'number' || Number.isNaN(demandPerHour) || demandPerHour <= 0) return ['demandPerHour_must_be_positive'];
      return [];
    }
    case 'layout': {
      if (!isObject(parameters)) return ['parameters_must_be_object'];
      const { stations, moves } = parameters;
      if (!Array.isArray(stations) || stations.length === 0) return ['stations_must_be_nonempty_array'];
      const ids = new Set<string>();
      for (const s of stations) {
        if (!isObject(s)) return ['station_must_be_object'];
        if (typeof s.stationId !== 'string' || s.stationId.trim() === '') return ['station_missing_stationId'];
        if (typeof s.x !== 'number' || typeof s.y !== 'number') return ['station_x_y_must_be_numbers'];
        ids.add(s.stationId);
      }
      if (!Array.isArray(moves)) return ['moves_must_be_array'];
      for (const m of moves) {
        if (!isObject(m)) return ['move_must_be_object'];
        if (typeof m.fromStationId !== 'string' || !ids.has(m.fromStationId)) return ['move_unknown_fromStationId'];
        if (typeof m.toStationId !== 'string' || !ids.has(m.toStationId)) return ['move_unknown_toStationId'];
        if (typeof m.trips !== 'number' || !Number.isInteger(m.trips) || m.trips < 1) return ['move_trips_must_be_positive_integer'];
      }
      return [];
    }
    case 'material_flow': {
      if (!isObject(parameters)) return ['parameters_must_be_object'];
      const { stations } = parameters;
      if (!Array.isArray(stations) || stations.length === 0) return ['stations_must_be_nonempty_array'];
      for (const s of stations) {
        if (!isObject(s)) return ['station_must_be_object'];
        if (typeof s.stationId !== 'string' || s.stationId.trim() === '') return ['station_missing_stationId'];
        if (typeof s.capacityPerHour !== 'number' || Number.isNaN(s.capacityPerHour) || s.capacityPerHour <= 0) return ['station_capacity_must_be_positive'];
        if (typeof s.inflowPerHour !== 'number' || Number.isNaN(s.inflowPerHour) || s.inflowPerHour < 0) return ['station_inflow_must_be_nonnegative'];
      }
      return [];
    }
    default:
      return ['unknown_kind'];
  }
}

/** JSON 文本 → 参数对象（解析失败显式错误，不静默透传）。 */
export function parseParametersJson(text: string): { parameters: unknown; errors: string[] } {
  const trimmed = text.trim();
  if (trimmed === '') return { parameters: undefined, errors: ['参数不能为空'] };
  try {
    const parsed = JSON.parse(trimmed);
    if (!isObject(parsed)) return { parameters: undefined, errors: ['参数必须是 JSON 对象'] };
    return { parameters: parsed, errors: [] };
  } catch {
    return { parameters: undefined, errors: ['参数必须是合法 JSON'] };
  }
}

export interface SummaryRow {
  label: string;
  value: string;
  tone: ConsoleTone;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function pct(v: number | null, digits = 1): string {
  return v == null ? '—' : `${(v * 100).toFixed(digits)}%`;
}

/** 结果摘要（展示层；字段缺失 → '—'，绝不伪造）。 */
export function buildResultSummary(kind: string, results: unknown): SummaryRow[] {
  if (!isObject(results)) return [{ label: '结果', value: '—', tone: 'neutral' }];
  const r = results;
  switch (kind) {
    case 'what_if': {
      const baseCount = num(r.baseCount);
      const scenarioCount = num(r.scenarioCount);
      const added = Array.isArray(r.added) ? r.added.length : null;
      const removed = Array.isArray(r.removed) ? r.removed.length : null;
      const changed = Array.isArray(r.changed) ? r.changed.length : null;
      const diffTone: ConsoleTone = ((added ?? 0) + (removed ?? 0) + (changed ?? 0)) > 0 ? 'warning' : 'positive';
      return [
        { label: '基线结论', value: baseCount == null ? '—' : String(baseCount), tone: 'neutral' },
        { label: '推演结论', value: scenarioCount == null ? '—' : String(scenarioCount), tone: 'neutral' },
        { label: '新增 / 移除 / 变更', value: `${added ?? '—'} / ${removed ?? '—'} / ${changed ?? '—'}`, tone: diffTone },
      ];
    }
    case 'capacity': {
      const bottleneck = typeof r.bottleneckStationId === 'string' ? r.bottleneckStationId : null;
      const throughput = num(r.lineThroughputPerHour);
      const utilization = num(r.utilization);
      const overloaded = r.overloaded === true;
      return [
        { label: '瓶颈工位', value: bottleneck ?? '—', tone: overloaded ? 'negative' : 'neutral' },
        { label: '线产能（件/时）', value: throughput == null ? '—' : String(throughput), tone: 'neutral' },
        { label: '利用率', value: pct(utilization), tone: overloaded ? 'negative' : 'positive' },
        { label: '过载', value: overloaded ? '是' : '否', tone: overloaded ? 'negative' : 'positive' },
      ];
    }
    case 'layout': {
      const total = num(r.totalTravelDistance);
      const routes = Array.isArray(r.routes) ? r.routes : [];
      let maxDistance: number | null = null;
      for (const route of routes) {
        if (isObject(route)) {
          const d = num(route.totalDistance);
          if (d != null && (maxDistance == null || d > maxDistance)) maxDistance = d;
        }
      }
      return [
        { label: '总搬运行程（m）', value: total == null ? '—' : total.toFixed(1), tone: 'neutral' },
        { label: '路线数', value: String(routes.length), tone: 'neutral' },
        { label: '最大单线行程（m）', value: maxDistance == null ? '—' : maxDistance.toFixed(1), tone: 'neutral' },
      ];
    }
    case 'material_flow': {
      const bottleneck = typeof r.bottleneckStationId === 'string' ? r.bottleneckStationId : null;
      const ratio = num(r.bottleneckLoadRatio);
      const stations = Array.isArray(r.stations) ? r.stations : [];
      const overloadedCount = stations.filter((s) => isObject(s) && s.overloaded === true).length;
      const tone: ConsoleTone = overloadedCount > 0 ? 'negative' : 'positive';
      return [
        { label: '瓶颈工位', value: bottleneck ?? '—', tone },
        { label: '瓶颈载荷比', value: pct(ratio), tone },
        { label: '过载工位数', value: String(overloadedCount), tone },
      ];
    }
    default:
      return [{ label: '结果', value: `unknown_kind:${kind}`, tone: 'neutral' }];
  }
}

export interface SimulationRunLike {
  runId: string;
  kind: string;
  status: string;
  engineVersion?: string;
  results?: Record<string, unknown>;
  failureReason?: string;
}

export interface RunListRow {
  runId: string;
  kind: string;
  kindLabel: string;
  status: string;
  statusLabel: string;
  tone: ConsoleTone;
  headline: string;
  failureReason: string | null;
}

/** 运行列表行（展示层：状态文案/语调 + 结果摘要头条；保持服务端返回顺序）。 */
export function buildRunListRows(runs: SimulationRunLike[] | null | undefined): RunListRow[] {
  const list = runs ?? [];
  return list.map((run) => {
    const kindLabel = SIMULATION_KIND_LABELS[run.kind] ?? run.kind;
    const statusLabel = SIMULATION_STATUS_LABELS[run.status] ?? run.status;
    const tone = SIMULATION_STATUS_TONES[run.status] ?? 'neutral';
    const failureReason =
      typeof run.failureReason === 'string' && run.failureReason.trim() !== '' ? run.failureReason : null;
    let headline: string;
    if (failureReason) {
      headline = failureReason;
    } else if (run.results) {
      const summary = buildResultSummary(run.kind, run.results);
      headline = summary.map((row) => `${row.label} ${row.value}`).join(' · ');
    } else {
      headline = '—';
    }
    return {
      runId: run.runId,
      kind: run.kind,
      kindLabel,
      status: run.status,
      statusLabel,
      tone,
      headline,
      failureReason,
    };
  });
}
