// simulationConsoleLogic.test.ts — 仿真运行控制台纯逻辑测试（node 可测，R-57 / ADR-036）。
//
// 覆盖：参数预检（四类评估器输入契约镜像，fail-closed 预检）、JSON 解析、
// 结果摘要（字段缺失 '—' 不伪造）、运行列表行（状态文案/语调/失败理由显式）。
import {
  SIMULATION_PARAMETER_EXAMPLES,
  buildResultSummary,
  buildRunListRows,
  parseParametersJson,
  validateSimulationParameters,
} from './simulationConsoleLogic';

describe('validateSimulationParameters（参数预检，镜像评估器输入契约）', () => {
  it('what_if：baseFacts/deltaFacts 数组 + 事实字段完备 → 通过', () => {
    expect(
      validateSimulationParameters('what_if', {
        baseFacts: [{ ruleId: 'r1', subjectId: 's1', conclusion: 'c1', confidence: 1 }],
        deltaFacts: [{ ruleId: 'r1', subjectId: 's1', conclusion: 'c2', confidence: 0.9 }],
      }),
    ).toEqual([]);
  });

  it('what_if：缺数组/事实字段缺失/confidence 非数值 → 显式错误码', () => {
    expect(validateSimulationParameters('what_if', {})).toEqual([
      'what_if_requires_baseFacts_deltaFacts_arrays',
    ]);
    expect(
      validateSimulationParameters('what_if', {
        baseFacts: [],
        deltaFacts: [{ ruleId: 'r1', subjectId: 's1', conclusion: 'c1', confidence: 'x' }],
      }),
    ).toEqual(['deltaFacts_fact_bad_confidence']);
    expect(
      validateSimulationParameters('what_if', { baseFacts: [null], deltaFacts: [] }),
    ).toEqual(['baseFacts_fact_must_be_object']);
  });

  it('capacity：工位字段/容量/demand 校验', () => {
    expect(
      validateSimulationParameters('capacity', {
        stations: [{ stationId: 'ST-1', capacityPerHour: 40 }],
        demandPerHour: 30,
      }),
    ).toEqual([]);
    expect(validateSimulationParameters('capacity', { stations: [], demandPerHour: 30 })).toEqual([
      'stations_must_be_nonempty_array',
    ]);
    expect(
      validateSimulationParameters('capacity', {
        stations: [{ stationId: 'ST-1', capacityPerHour: 0 }],
        demandPerHour: 30,
      }),
    ).toEqual(['station_capacity_must_be_positive']);
    expect(
      validateSimulationParameters('capacity', {
        stations: [{ stationId: 'ST-1', capacityPerHour: 40 }],
        demandPerHour: -1,
      }),
    ).toEqual(['demandPerHour_must_be_positive']);
  });

  it('layout：工位坐标/未知端点/trips 整数校验', () => {
    expect(
      validateSimulationParameters('layout', {
        stations: [{ stationId: 'ST-1', x: 0, y: 0 }],
        moves: [{ fromStationId: 'ST-1', toStationId: 'ST-1', trips: 1 }],
      }),
    ).toEqual([]);
    expect(
      validateSimulationParameters('layout', {
        stations: [{ stationId: 'ST-1', x: 0, y: 0 }],
        moves: [{ fromStationId: 'ST-1', toStationId: 'ST-9', trips: 1 }],
      }),
    ).toEqual(['move_unknown_toStationId']);
    expect(
      validateSimulationParameters('layout', {
        stations: [{ stationId: 'ST-1', x: 0, y: 0 }],
        moves: [{ fromStationId: 'ST-1', toStationId: 'ST-1', trips: 0.5 }],
      }),
    ).toEqual(['move_trips_must_be_positive_integer']);
  });

  it('material_flow：capacity>0 / inflow≥0 校验', () => {
    expect(
      validateSimulationParameters('material_flow', {
        stations: [{ stationId: 'ST-1', capacityPerHour: 40, inflowPerHour: 0 }],
      }),
    ).toEqual([]);
    expect(
      validateSimulationParameters('material_flow', {
        stations: [{ stationId: 'ST-1', capacityPerHour: 40, inflowPerHour: -1 }],
      }),
    ).toEqual(['station_inflow_must_be_nonnegative']);
  });

  it('未知 kind → unknown_kind；非对象参数 → 显式错误', () => {
    expect(validateSimulationParameters('unknown_kind_x', {})).toEqual(['unknown_kind']);
    expect(validateSimulationParameters('capacity', null)).toEqual(['parameters_must_be_object']);
  });

  it('四类示例模板本身必须通过预检（示例不能教用户写非法参数）', () => {
    for (const [kind, example] of Object.entries(SIMULATION_PARAMETER_EXAMPLES)) {
      const parsed = parseParametersJson(example);
      expect(parsed.errors).toEqual([]);
      expect(validateSimulationParameters(kind, parsed.parameters)).toEqual([]);
    }
  });
});

describe('parseParametersJson', () => {
  it('合法 JSON 对象 → 解析成功', () => {
    const parsed = parseParametersJson('{ "a": 1 }');
    expect(parsed.errors).toEqual([]);
    expect(parsed.parameters).toEqual({ a: 1 });
  });

  it('空/非法 JSON/非对象 → 显式错误（不静默透传）', () => {
    expect(parseParametersJson('').errors).toEqual(['参数不能为空']);
    expect(parseParametersJson('{bad').errors).toEqual(['参数必须是合法 JSON']);
    expect(parseParametersJson('[1,2]').errors).toEqual(['参数必须是 JSON 对象']);
  });
});

describe('buildResultSummary（结果摘要，字段缺失不伪造）', () => {
  it('what_if：基线/推演结论数 + 新增移除变更差集（有差异 → warning）', () => {
    const rows = buildResultSummary('what_if', {
      baseCount: 3,
      scenarioCount: 4,
      added: [{}, {}],
      removed: [],
      changed: [{}],
    });
    expect(rows).toEqual([
      { label: '基线结论', value: '3', tone: 'neutral' },
      { label: '推演结论', value: '4', tone: 'neutral' },
      { label: '新增 / 移除 / 变更', value: '2 / 0 / 1', tone: 'warning' },
    ]);
  });

  it('capacity：过载 → 瓶颈/利用率 negative 语调', () => {
    const rows = buildResultSummary('capacity', {
      bottleneckStationId: 'ST-2',
      lineThroughputPerHour: 25,
      utilization: 1.2,
      overloaded: true,
    });
    expect(rows[0].value).toBe('ST-2');
    expect(rows[2]).toEqual({ label: '利用率', value: '120.0%', tone: 'negative' });
    expect(rows[3].value).toBe('是');
  });

  it('layout：总行程/路线数/最大单线（round 展示层不重算）', () => {
    const rows = buildResultSummary('layout', {
      totalTravelDistance: 500.25,
      routes: [{ totalDistance: 300.5 }, { totalDistance: 199.75 }],
    });
    expect(rows[0].value).toBe('500.3');
    expect(rows[1].value).toBe('2');
    expect(rows[2].value).toBe('300.5');
  });

  it('material_flow：瓶颈载荷比 + 过载工位数', () => {
    const rows = buildResultSummary('material_flow', {
      bottleneckStationId: 'ST-1',
      bottleneckLoadRatio: 1.125,
      stations: [{ overloaded: true }, { overloaded: false }, { overloaded: true }],
    });
    expect(rows[0].value).toBe('ST-1');
    expect(rows[1]).toEqual({ label: '瓶颈载荷比', value: '112.5%', tone: 'negative' });
    expect(rows[2].value).toBe('2');
  });

  it('结果字段缺失 → 显式 —（不伪造 0/空值）', () => {
    const rows = buildResultSummary('capacity', {});
    expect(rows.map((r) => r.value)).toEqual(['—', '—', '—', '否']);
  });

  it('未知 kind → 显式透出（不当作正常）', () => {
    const rows = buildResultSummary('unknown_kind_x', {});
    expect(rows[0].value).toBe('unknown_kind:unknown_kind_x');
  });
});

describe('buildRunListRows（运行列表行）', () => {
  it('状态文案/语调 + completed 摘要头条', () => {
    const rows = buildRunListRows([
      {
        runId: 'sim:abc',
        kind: 'capacity',
        status: 'completed',
        engineVersion: '1.0.0',
        results: { bottleneckStationId: 'ST-2', lineThroughputPerHour: 25, utilization: 1.2, overloaded: true },
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kindLabel).toBe('产能评估');
    expect(rows[0].statusLabel).toBe('已完成');
    expect(rows[0].tone).toBe('positive');
    expect(rows[0].headline).toContain('瓶颈工位 ST-2');
    expect(rows[0].failureReason).toBeNull();
  });

  it('failed → 失败理由为头条（显式呈现），negative 语调', () => {
    const rows = buildRunListRows([
      { runId: 'sim:x', kind: 'layout', status: 'failed', failureReason: 'stations 必须是非空列表' },
    ]);
    expect(rows[0].tone).toBe('negative');
    expect(rows[0].headline).toBe('stations 必须是非空列表');
    expect(rows[0].failureReason).toBe('stations 必须是非空列表');
  });

  it('空/未知状态 → 空列表/原样透出状态', () => {
    expect(buildRunListRows([])).toEqual([]);
    expect(buildRunListRows(null)).toEqual([]);
    const rows = buildRunListRows([{ runId: 'sim:y', kind: 'what_if', status: 'weird' }]);
    expect(rows[0].statusLabel).toBe('weird');
    expect(rows[0].tone).toBe('neutral');
  });
});
