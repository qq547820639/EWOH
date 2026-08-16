/* SimulationRun 契约测试（ADR-025 / NO-12a，§13 Digital Twin Simulation）。
 *
 * 覆盖：kind/status 封闭注册表（未知拒绝）、isolation 强制（§13 三层强制的
 * 契约面）、baseRef/parameters/engineVersion 必填、completed 必须 results、
 * failed 必须 failureReason、auditTrail 必须 true；四类确定性评估器与
 * Python 端逐项一致（Golden #19 跨语言仲裁）。
 */
/// <reference types="jest" />
import {
  validateSimulationRun,
  evaluateWhatIf,
  evaluateCapacity,
  evaluateLayout,
  evaluateMaterialFlow,
} from './simulation-run';

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: 'sim:1234:abcd',
    kind: 'what_if',
    status: 'created',
    isSimulation: true,
    baseRef: { snapshotVersion: 3 },
    parameters: {},
    engineVersion: '1.0.0',
    auditTrail: true,
    ...overrides,
  };
}

describe('validateSimulationRun（ADR-025 契约）', () => {
  it('合法 created 通过', () => {
    expect(validateSimulationRun(record())).toEqual([]);
  });

  it('合法 completed（带 results）通过', () => {
    expect(
      validateSimulationRun(
        record({ kind: 'capacity', status: 'completed', results: { overloaded: true } }),
      ),
    ).toEqual([]);
  });

  it('合法 failed（带 failureReason）通过', () => {
    expect(
      validateSimulationRun(
        record({ kind: 'layout', status: 'failed', failureReason: '参数契约违规：stations 为空数组' }),
      ),
    ).toEqual([]);
  });

  it('isSimulation=false → isolation_required（§13 模拟数据必须显式标记）', () => {
    expect(validateSimulationRun(record({ isSimulation: false }))[0]).toBe('isolation_required');
  });

  it('未知 kind → unknown_kind（绝不注册无引擎空类型）', () => {
    expect(validateSimulationRun(record({ kind: 'teleport' }))[0]).toBe('unknown_kind');
  });

  it('completed 缺 results → results_required', () => {
    expect(validateSimulationRun(record({ status: 'completed' }))[0]).toBe('results_required');
  });

  it('failed 缺 failureReason → failure_reason_required（§33 不静默）', () => {
    expect(validateSimulationRun(record({ status: 'failed' }))[0]).toBe('failure_reason_required');
  });

  it('baseRef.snapshotVersion 非负整数强制', () => {
    expect(validateSimulationRun(record({ baseRef: { snapshotVersion: -1 } }))[0]).toBe('bad_base_ref');
  });

  it('auditTrail=false → audit_required', () => {
    expect(validateSimulationRun(record({ auditTrail: false }))[0]).toBe('audit_required');
  });
});

describe('确定性评估器（ADR-025 §评估器矩阵）', () => {
  it('evaluateCapacity 求瓶颈 + 线产能 + 过载', () => {
    const result = evaluateCapacity(
      [
        { stationId: 'station:s1', capacityPerHour: 10 },
        { stationId: 'station:s2', capacityPerHour: 25 },
      ],
      12,
    );
    expect(result).toEqual({
      bottleneckStationId: 'station:s1',
      lineThroughputPerHour: 10,
      utilization: 1.2,
      overloaded: true,
    });
  });

  it('evaluateLayout 欧氏距离 × 趟次累计', () => {
    const result = evaluateLayout(
      [
        { stationId: 'station:s1', x: 0, y: 0 },
        { stationId: 'station:s2', x: 3, y: 4 },
      ],
      [{ fromStationId: 'station:s1', toStationId: 'station:s2', trips: 10 }],
    );
    expect(result.totalTravelDistance).toBe(50);
    expect(result.routes[0].distance).toBe(5);
  });

  it('evaluateMaterialFlow 载荷比与瓶颈', () => {
    const result = evaluateMaterialFlow([
      { stationId: 'station:s1', capacityPerHour: 10, inflowPerHour: 8 },
      { stationId: 'station:s2', capacityPerHour: 20, inflowPerHour: 25.5 },
    ]);
    expect(result.bottleneckStationId).toBe('station:s2');
    expect(result.bottleneckLoadRatio).toBe(1.275);
    expect(result.stations[1].overloaded).toBe(true);
  });

  it('evaluateWhatIf 结论差集（added/removed/changed）', () => {
    const base = [
      { ruleId: 'rule:r1', subjectId: 'station:s1', conclusion: 'overload', confidence: 0.8 },
      { ruleId: 'rule:r1', subjectId: 'station:s2', conclusion: 'overload', confidence: 0.6 },
    ];
    const delta = [
      { ruleId: 'rule:r1', subjectId: 'station:s1', conclusion: 'overload', confidence: 0.95 },
      { ruleId: 'rule:r2', subjectId: 'station:s3', conclusion: 'normal', confidence: 0.9 },
    ];
    const result = evaluateWhatIf('trace:whatif:1', base, delta);
    expect(result.baseCount).toBe(2);
    expect(result.scenarioCount).toBe(2);
    expect(result.added).toEqual([
      { ruleId: 'rule:r2', subjectId: 'station:s3', conclusion: 'normal', confidence: 0.9 },
    ]);
    expect(result.removed).toEqual([
      { ruleId: 'rule:r1', subjectId: 'station:s2', conclusion: 'overload', confidence: 0.6 },
    ]);
    expect(result.changed).toEqual([
      {
        ruleId: 'rule:r1',
        subjectId: 'station:s1',
        conclusion: 'overload',
        baseConfidence: 0.8,
        scenarioConfidence: 0.95,
      },
    ]);
  });

  it('评估器非法输入 fail-closed 抛错', () => {
    expect(() => evaluateCapacity([], 10)).toThrow();
    expect(() => evaluateMaterialFlow([{ stationId: 'station:s1', capacityPerHour: 0, inflowPerHour: 1 }])).toThrow();
    expect(() =>
      evaluateLayout(
        [{ stationId: 'station:s1', x: 0, y: 0 }],
        [{ fromStationId: 'station:s1', toStationId: 'station:ghost', trips: 1 }],
      ),
    ).toThrow();
  });
});
