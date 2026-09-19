/// <reference types="jest" />
/* NO-92a：SOC 合理性闸门服务级行为测试（ingestActuator 接线）。
 *
 * 纯函数判据见 soc-plausibility.spec.ts；这里钉死服务级契约：
 * - 拒绝路径释放幂等认领（重放同帧再次显式拒绝），且**不写**世界状态/台账；
 * - 连击达阈值的再锚定帧：正常写入 + soc_reanchored 标记；
 * - battery_pct 缺帧闸门完全不参与（不读锚点）；
 * - 越界无条件拒绝；无锚点首帧如实接受。
 */
import { SensorIngestService } from '../sensor-ingest.service';

const ORG = 'org-soc';

function makeHarness(opts: { deviceRows?: Array<Record<string, unknown>> } = {}) {
  const inserted: Array<Record<string, unknown>> = [];
  const deleted: Array<unknown> = [];
  const selectCalls: Array<Record<string, unknown>> = [];
  const db = {
    insert: jest.fn(() => ({
      values: jest.fn((v: Record<string, unknown>) => {
        inserted.push(v);
        const p = Promise.resolve(undefined) as Promise<void> & {
          onConflictDoNothing: () => { returning: () => Promise<unknown[]> };
        };
        p.onConflictDoNothing = () => ({ returning: () => Promise.resolve([{ id: 1 }]) });
        return p;
      }),
    })),
    delete: jest.fn(() => ({
      where: jest.fn(() => {
        deleted.push(1);
        return Promise.resolve();
      }),
    })),
    select: jest.fn(() => ({
      from: () => ({
        where: () => {
          selectCalls.push({});
          return Promise.resolve(opts.deviceRows ?? []);
        },
      }),
    })),
  };
  const service = new SensorIngestService(db as never);
  return { service, inserted, deleted, selectCalls };
}

function frame(overrides: Record<string, unknown>) {
  return {
    device_id: 'agv-soc-1',
    event_time: new Date().toISOString(),
    state: 'idle',
    battery_pct: 95,
    ...overrides,
  } as never;
}

describe('SensorIngestService.ingestActuator：SOC 合理性闸门（NO-92a）', () => {
  it('坏传感回跳 8→95 → 显式拒绝（SOC_JUMP_IMPLAUSIBLE），不写台账/世界状态，认领被释放', async () => {
    const h = makeHarness({
      deviceRows: [{ batteryPct: 8, lastTelemetryAt: new Date(Date.now() - 60_000) }],
    });
    const response = await h.service.ingestActuator(frame({ record_id: 'soc-rej-1' }), ORG);
    expect(response.accepted).toBe(false);
    expect(response.data_quality).toBe('invalid');
    expect(String(response.error)).toContain('SOC_JUMP_IMPLAUSIBLE');
    expect(String(response.error)).toContain('8→95');
    expect(response.retryable).toBeUndefined();
    // 无半条事实：世界状态/台账都没写；幂等认领被释放（重放同帧再次显式拒绝）
    expect(h.inserted.filter((v) => 'stateJson' in v)).toHaveLength(0);
    expect(h.deleted).toHaveLength(1);
  });

  it('连击达阈值 → 再锚定接受：写入正常执行并标记 soc_reanchored=true', async () => {
    const h = makeHarness({
      deviceRows: [{ batteryPct: 8, lastTelemetryAt: new Date(Date.now() - 60_000) }],
    });
    const r1 = await h.service.ingestActuator(frame({ record_id: 'soc-a-1' }), ORG);
    const r2 = await h.service.ingestActuator(frame({ record_id: 'soc-a-2' }), ORG);
    expect(r1.accepted).toBe(false);
    expect(r2.accepted).toBe(false);
    const r3 = await h.service.ingestActuator(frame({ record_id: 'soc-a-3' }), ORG);
    expect(r3.accepted).toBe(true);
    expect(r3.soc_reanchored).toBe(true);
    // 再锚定帧是世界状态真写入（stateJson 存在）
    expect(h.inserted.filter((v) => 'stateJson' in v)).toHaveLength(1);
    expect(h.deleted).toHaveLength(2); // 前两帧拒绝各释放一次
  });

  it('同 record_id 重放被拒帧 → 拒绝重现但连击不虚增（1 帧毛刺重放 3 次不得再锚定）', async () => {
    const h = makeHarness({
      deviceRows: [{ batteryPct: 8, lastTelemetryAt: new Date(Date.now() - 60_000) }],
    });
    const r1 = await h.service.ingestActuator(frame({ record_id: 'soc-replay' }), ORG);
    const r2 = await h.service.ingestActuator(frame({ record_id: 'soc-replay' }), ORG);
    const r3 = await h.service.ingestActuator(frame({ record_id: 'soc-replay' }), ORG);
    expect(r1.accepted).toBe(false);
    expect(r2.accepted).toBe(false);
    expect(r3.accepted).toBe(false);
    expect(String(r3.error)).toContain('重放不连击');
    // 三次都是同一次观测：台账/世界状态仍一字未写
    expect(h.inserted.filter((v) => 'stateJson' in v)).toHaveLength(0);
    // 换一条新 record_id 才是"新观测"：连击 2/3，仍拒绝（未达 3）
    const r4 = await h.service.ingestActuator(frame({ record_id: 'soc-fresh' }), ORG);
    expect(r4.accepted).toBe(false);
    expect(String(r4.error)).toContain('连击 2/3');
  });

  it('battery_pct 缺帧 → 闸门完全不参与（不读锚点），正常受理', async () => {
    const h = makeHarness();
    const response = await h.service.ingestActuator(frame({ battery_pct: undefined, record_id: 'soc-nb' }), ORG);
    expect(response.accepted).toBe(true);
    expect(h.selectCalls).toHaveLength(0);
    expect(response.soc_reanchored).toBeUndefined();
  });

  it('越界电量 150 → 无条件拒绝（SOC_OUT_OF_RANGE）', async () => {
    const h = makeHarness({
      deviceRows: [{ batteryPct: 90, lastTelemetryAt: new Date(Date.now() - 60_000) }],
    });
    const response = await h.service.ingestActuator(frame({ battery_pct: 150, record_id: 'soc-oob' }), ORG);
    expect(response.accepted).toBe(false);
    expect(String(response.error)).toContain('SOC_OUT_OF_RANGE');
    expect(h.inserted.filter((v) => 'stateJson' in v)).toHaveLength(0);
  });

  it('无锚点首帧 → 如实接受（无 soc_reanchored 标记）', async () => {
    const h = makeHarness({ deviceRows: [] });
    const response = await h.service.ingestActuator(frame({ record_id: 'soc-first' }), ORG);
    expect(response.accepted).toBe(true);
    expect(response.soc_reanchored).toBeUndefined();
  });

  it('合理增量 8→9（量化噪声下限内）→ 正常受理', async () => {
    const h = makeHarness({
      deviceRows: [{ batteryPct: 8, lastTelemetryAt: new Date(Date.now() - 60_000) }],
    });
    const response = await h.service.ingestActuator(frame({ battery_pct: 9, record_id: 'soc-inc' }), ORG);
    expect(response.accepted).toBe(true);
    expect(response.soc_reanchored).toBeUndefined();
  });
});
