/* Event Envelope 接线测试（ADR-009 / NO-04b，云侧 RuleEngine）。
 *
 * 断言：规则引擎写出的 ewoh_event 事件类型收敛到 Canonical Event Catalog
 * （LOW_BATTERY→DeviceLowBattery 等）+ evidenceJson 内嵌 envelope 与
 * envelopeSemantics（契约时间语义，云侧本地生成 → 无漂移无迟到）。
 */
/// <reference types="jest" />
import { RuleEngineService } from '../rule-engine.service';

type Row = Record<string, unknown>;

function makeFakeDb() {
  const state = { rows: [] as Row[] };
  const thenable = Promise.resolve(state.rows) as Promise<Row[]> & { limit: jest.Mock };
  thenable.limit = jest.fn(() => Promise.resolve(state.rows));
  const fake = {
    select: jest.fn(() => fake),
    from: jest.fn(() => fake),
    where: jest.fn(() => thenable),
    insert: jest.fn(() => ({
      values: jest.fn((v: Row) => {
        state.rows.push({ ...v });
        return Promise.resolve([{ ...v }]);
      }),
    })),
    __state: state,
  };
  return fake;
}

describe('RuleEngine Event Envelope 接线（ADR-009 / NO-04b）', () => {
  it('LOW_BATTERY 事件类型收敛为 DeviceLowBattery 且内嵌信封', async () => {
    const fake = makeFakeDb();
    const service = new RuleEngineService(fake as never);
    const triggered = await service.evaluate({
      deviceId: 'EXO-1',
      batteryPct: 8,
      sourceType: 'real',
      recordId: 'rec-1',
      dataQuality: 'good',
    });
    expect(triggered).toBeGreaterThan(0);
    const eventRows = fake.__state.rows.filter((r) => String(r.eventCode) === 'LOW_BATTERY');
    expect(eventRows).toHaveLength(1);
    const row = eventRows[0];
    expect(row.eventType).toBe('DeviceLowBattery');
    const evidence = row.evidenceJson as Row;
    const envelope = evidence.envelope as Row;
    expect(envelope.eventType).toBe('DeviceLowBattery');
    expect(envelope.schemaVersion).toBe('1.0.0');
    expect(envelope.source).toBe('cloud:rule-engine');
    expect(envelope.subject).toBe('device:EXO-1');
    expect(envelope.occurredAt).toBeTruthy();
    expect(envelope.observedAt).toBe(envelope.occurredAt);
    expect(envelope.receivedAt).toBe(envelope.occurredAt);
    const semantics = evidence.envelopeSemantics as Row;
    expect(semantics).toEqual({ clockDrift: false, isLate: false });
  });

  it('HIGH_LOAD 事件类型收敛为 WorkerHighLoad', async () => {
    const fake = makeFakeDb();
    const service = new RuleEngineService(fake as never);
    await service.evaluate({
      deviceId: 'EXO-2',
      loadScore: 0.95,
      sourceType: 'real',
      recordId: 'rec-2',
      dataQuality: 'good',
    });
    const row = fake.__state.rows.find((r) => String(r.eventCode) === 'HIGH_LOAD');
    expect(row?.eventType).toBe('WorkerHighLoad');
  });
});
