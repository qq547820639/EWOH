/// <reference types="jest" />
/* 回归（FR4 对抗审查 2026-09-13）：执行机构帧 event_time 不可解析 → 显式拒绝。
 *
 * 缺陷：/api/ingest/actuator 的控制器只做存在性校验（device_id/event_time/state
 * 非空），而 sensor-ingest 的 frameSemantics 对不可解析时间返回"无漂移"放行，
 * 直到 `new Date(garbage)` 以 Invalid Date 落库才在驱动层抛错——被兜底 catch
 * 归类为「写入失败 retryable:true」。按 IngestResponse 契约，retryable=true
 * 表示"瞬时故障可重试"，边缘会对一条**永远无效**的帧无限重试（每次还空转
 * 幂等认领/释放）。environment/camera/location 三路径在控制器有
 * assertParsableTime 把关，actuator 的可解析性只能由服务层 fail-closed。
 */
import { SensorIngestService } from '../sensor-ingest.service';

const ORG = 'org-1';

interface InsertCapable {
  onConflictDoNothing: () => { returning: () => Promise<unknown[]> };
}

function makeSensorHarness(opts: { failWorldStateInsert?: boolean } = {}) {
  const inserted: Array<Record<string, unknown>> = [];
  const deleted: Array<unknown> = [];
  const db = {
    insert: jest.fn(() => ({
      values: jest.fn((v: Record<string, unknown>) => {
        inserted.push(v);
        // 只让 world_state 行失败（模拟驱动层拒绝 Invalid Date ts）；
        // 幂等认领行必须成功，否则走不到「写入失败 retryable」的兜底路径。
        const failThis = opts.failWorldStateInsert && 'stateJson' in v;
        const p = (failThis
          ? Promise.reject(new Error('db down: invalid date'))
          : Promise.resolve(undefined)) as Promise<void> & InsertCapable;
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
  };
  const service = new SensorIngestService(db as never);
  return { service, inserted, deleted };
}

describe('SensorIngestService.ingestActuator：event_time 不可解析 fail-closed', () => {
  it('event_time 为乱码 → 拒绝（invalid），且不可重试（不触发无限重试）', async () => {
    // failWorldStateInsert 模拟生产驱动层对 Invalid Date 的拒绝
    // （修复前该帧走到这里 → 兜底 catch 误报「写入失败 retryable:true」）。
    const { service, inserted } = makeSensorHarness({ failWorldStateInsert: true });
    const response = await service.ingestActuator(
      {
        device_id: 'agv-1',
        event_time: 'not-a-timestamp',
        state: 'moving',
        x: 1,
        y: 2,
        record_id: 'rec-1',
      } as never,
      ORG,
    );
    expect(response.accepted).toBe(false);
    expect(response.skipped).toBe(false);
    expect(response.data_quality).toBe('invalid');
    expect(String(response.error)).toContain('BAD_EVENT_TIME');
    // 契约：缺省 retryable = 保守不重试（永久非法帧转死信，而不是无限重投）
    expect(response.retryable).toBeUndefined();
    // 拒绝发生在写库/幂等认领之前，不产生半条事实
    expect(inserted).toHaveLength(0);
  });

  it('空字符串 event_time 已被前置存在性校验拒绝（既有行为不回归）', async () => {
    const { service } = makeSensorHarness();
    const response = await service.ingestActuator(
      { device_id: 'agv-1', event_time: '', state: 'idle' } as never,
      ORG,
    );
    expect(response.accepted).toBe(false);
    expect(String(response.error)).toContain('必填');
  });

  it('可解析时间不受影响：正常接受', async () => {
    const { service } = makeSensorHarness();
    const response = await service.ingestActuator(
      {
        device_id: 'agv-1',
        event_time: new Date().toISOString(),
        state: 'idle',
        record_id: 'rec-ok',
      } as never,
      ORG,
    );
    expect(response.accepted).toBe(true);
  });
});
