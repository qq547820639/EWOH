/* 观测事实投影测试（NO-25a）。
 *
 * 钉死的语义（每条都对应"感知→理解"之间会踩的坑）：
 *   1. 只有**新鲜且可信**的读数**且**设备声明了对应观测能力，才产出事实；
 *   2. 过期读数不产出事实，但必须出现在 `skipped`（现场要知道数据为什么没被采用）；
 *   3. 阈值以下属正常观测：既不产生事实，也不进 skipped 噪音；
 *   4. 多条超标读数合并为一条事实但保留全部证据（"连续几次都超标"必须看得见）；
 *   5. 资源类事实（人员负荷/电量/工位质量阻塞/告警）只在世界模型真有值时产出。
 */
/// <reference types="jest" />
import {
  OBSERVATION_LIMITS,
  collectResourceFacts,
  projectObservationFacts,
} from './observation-facts';
import type { WorldStateSnapshot } from './scheduler';

const NOW = Date.parse('2026-09-12T10:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

function snapshot(overrides: Partial<WorldStateSnapshot> = {}): WorldStateSnapshot {
  return {
    snapshotVersion: 'WS-TEST',
    ts: iso(NOW),
    worldVersion: 1,
    entityVersions: {},
    reservations: [],
    persons: [],
    devices: [],
    tasks: [],
    stations: [],
    ...overrides,
  } as unknown as WorldStateSnapshot;
}

const sensorDevice = (businessId: string, observed: string[] = ['observe.vibration']) => ({
  id: `uuid-${businessId}`,
  deviceId: businessId,
  workerName: null,
  deviceModel: 'VIB-SENSOR',
  batteryPct: null,
  online: true,
  status: 'AVAILABLE',
  observedCapabilities: observed,
});

const reading = (overrides: Record<string, unknown> = {}) => ({
  sensorId: 'ENV-1',
  entityId: 'ENV-1',
  vibration: 9.2,
  ts: iso(NOW - 60_000),
  sourceType: 'real',
  dataConfidence: 1,
  ...overrides,
});

describe('projectObservationFacts', () => {
  it('新鲜 + 高置信 + 已声明能力 + 超标 → 产出一条 machine 事实与可追溯证据', () => {
    const result = projectObservationFacts({
      snapshot: snapshot({ devices: [sensorDevice('ENV-1')] as never }),
      readings: [reading()] as never,
      nowMs: NOW,
    });

    expect(result.skipped).toEqual([]);
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]).toMatchObject({
      subjectId: 'device:ENV-1',
      kind: 'machine',
      values: { vibration: 9.2, vibrationExceeded: true, threshold: OBSERVATION_LIMITS.vibrationMmPerSec },
    });
    expect(result.evidence[0]).toMatchObject({
      subjectId: 'device:ENV-1',
      capability: 'observe.vibration',
      value: 9.2,
      threshold: 7.1,
      unit: 'mm/s',
      dataQuality: 'FRESH',
      sourceType: 'real',
    });
    // evidenceIds 必须是规范身份（推理契约要求）
    // kind 必须是 identity 注册表里的 sensor（自造 kind 会被 fail-closed 拒绝）
    expect(result.facts[0].evidenceIds[0]).toMatch(/^sensor:[A-Za-z0-9][A-Za-z0-9._~@-]*-\d+$/);
  });

  it('阈值以下属正常观测：不产出事实也不进 skipped（不制造噪音）', () => {
    const result = projectObservationFacts({
      snapshot: snapshot({ devices: [sensorDevice('ENV-1')] as never }),
      readings: [reading({ vibration: 4.5 })] as never,
      nowMs: NOW,
    });
    expect(result.facts).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.evidence).toEqual([]);
  });

  it('过期读数 → 不产出事实，但如实进 skipped（原则 7）', () => {
    const result = projectObservationFacts({
      snapshot: snapshot({ devices: [sensorDevice('ENV-1')] as never }),
      readings: [reading({ ts: iso(NOW - 30 * 60_000) })] as never,
      nowMs: NOW,
    });
    expect(result.facts).toEqual([]);
    expect(result.skipped).toEqual([
      expect.objectContaining({ reason: 'stale_reading', subjectId: 'ENV-1' }),
    ]);
    expect(result.skipped[0].detail).toContain('30 分钟');
  });

  it('置信度缺失或过低 → 不产出事实，原因写清（不把不确定数据当事实）', () => {
    const missing = projectObservationFacts({
      snapshot: snapshot({ devices: [sensorDevice('ENV-1')] as never }),
      readings: [reading({ dataConfidence: null })] as never,
      nowMs: NOW,
    });
    expect(missing.facts).toEqual([]);
    expect(missing.skipped[0]).toMatchObject({ reason: 'low_confidence' });
    expect(missing.skipped[0].detail).toContain('未声明');

    const low = projectObservationFacts({
      snapshot: snapshot({ devices: [sensorDevice('ENV-1')] as never }),
      readings: [reading({ dataConfidence: 0.3 })] as never,
      nowMs: NOW,
    });
    expect(low.facts).toEqual([]);
    expect(low.skipped[0].reason).toBe('low_confidence');
  });

  it('世界模型没有该设备 → unknown_subject；未声明观测能力 → capability_not_declared', () => {
    const unknown = projectObservationFacts({
      snapshot: snapshot({ devices: [] }),
      readings: [reading()] as never,
      nowMs: NOW,
    });
    expect(unknown.facts).toEqual([]);
    expect(unknown.skipped[0].reason).toBe('unknown_subject');

    const notDeclared = projectObservationFacts({
      snapshot: snapshot({ devices: [sensorDevice('ENV-1', ['observe.temperature'])] as never }),
      readings: [reading()] as never,
      nowMs: NOW,
    });
    expect(notDeclared.facts).toEqual([]);
    expect(notDeclared.skipped[0].reason).toBe('capability_not_declared');
    expect(notDeclared.skipped[0].detail).toContain('能力模型权威');
  });

  it('同一设备多条超标读数 → 一条事实 + 全部证据（连续超标看得见）', () => {
    const result = projectObservationFacts({
      snapshot: snapshot({ devices: [sensorDevice('ENV-1')] as never }),
      readings: [
        reading({ ts: iso(NOW - 3 * 60_000), vibration: 8.1 }),
        reading({ ts: iso(NOW - 60_000), vibration: 9.9 }),
      ] as never,
      nowMs: NOW,
    });
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].evidenceIds).toHaveLength(2);
    expect(result.evidence).toHaveLength(2);
    expect(result.facts[0].values.vibration).toBe(9.9);
  });

  it('无 vibration 字段 → no_value（区别于"正常"）', () => {
    const result = projectObservationFacts({
      snapshot: snapshot({ devices: [sensorDevice('ENV-1')] as never }),
      readings: [reading({ vibration: null })] as never,
      nowMs: NOW,
    });
    expect(result.facts).toEqual([]);
    expect(result.skipped[0].reason).toBe('no_value');
  });

  it('阈值可覆盖（现场标定），并把生效阈值回传', () => {
    const result = projectObservationFacts({
      snapshot: snapshot({ devices: [sensorDevice('ENV-1')] as never }),
      readings: [reading({ vibration: 5 })] as never,
      nowMs: NOW,
      limits: { vibrationMmPerSec: 4.5 },
    });
    expect(result.limits.vibrationMmPerSec).toBe(4.5);
    expect(result.facts).toHaveLength(1);
    expect(result.evidence[0].threshold).toBe(4.5);
  });
});

describe('collectResourceFacts', () => {
  it('人员负荷事实：缺值不产出（也不猜 0）', () => {
    const { facts, skipped } = collectResourceFacts(
      snapshot({
        persons: [
          { id: 'P-1', name: '张三', workload: 0.9, fatigueLevel: 0.8, loadLevel: 0.9 },
          { id: 'P-2', name: '李四', loadLevel: null, fatigueLevel: null },
        ] as never,
      }),
    );
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ subjectId: 'person:P-1', kind: 'person' });
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ subjectId: 'person:P-2', reason: 'no_value' });
  });

  it('设备电量：无电池设备不产出电池事实（不伪装成 0%）', () => {
    const { facts } = collectResourceFacts(
      snapshot({
        devices: [
          { id: 'u1', deviceId: 'EXO-1', deviceModel: 'NyExo-A1', batteryPct: 15 },
          { id: 'u2', deviceId: 'ENV-1', deviceModel: 'VIB', batteryPct: null },
        ] as never,
      }),
    );
    // EXO-1 → exo 事实（触发 exo-low-battery），ENV-1 无电量 → 不产出
    expect(facts.map((f) => f.subjectId)).toEqual(['device:EXO-1']);
    expect(facts[0].kind).toBe('exo');
  });

  it('工位质量阻塞：critical/high 且未关闭 → qualityBlocked', () => {
    const { facts } = collectResourceFacts(
      snapshot({
        stations: [
          { id: 'ST-1', qualityFindings: [{ severity: 'high', status: 'open' }] },
          { id: 'ST-2', qualityFindings: [{ severity: 'low', status: 'open' }] },
          { id: 'ST-3', qualityFindings: [{ severity: 'critical', status: 'closed' }] },
        ] as never,
      }),
    );
    expect(facts.map((f) => f.subjectId)).toEqual(['station:ST-1']);
    expect(facts[0].values).toMatchObject({ qualityBlocked: true });
  });

  it('只有"未处置的高等级告警"才产出 alert 事实', () => {
    const { facts } = collectResourceFacts(
      snapshot({
        events: [
          { id: 'E-1', severity: 'critical', status: 'open' },
          { id: 'E-2', severity: 'low', status: 'open' },
          { id: 'E-3', severity: 'high', status: 'closed' },
        ] as never,
      }),
    );
    expect(facts.map((f) => f.subjectId)).toEqual(['alert:E-1']);
    expect(facts[0].values).toMatchObject({ andonRaised: true });
  });

  it('空快照 → 无事实（不报错）', () => {
    expect(collectResourceFacts(null)).toEqual({ facts: [], skipped: [] });
  });
});
