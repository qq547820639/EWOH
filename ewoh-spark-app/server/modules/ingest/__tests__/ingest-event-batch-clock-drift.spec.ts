/// <reference types="jest" />
/* 回归（FR4 对抗审查 2026-09-13）：事件上行路径的坏时钟必须能被云端发现。
 *
 * 缺陷：ingestEventBatch 直接采信信封里的 receivedAt 计算 clockDrift/isLate，
 * 而 receivedAt 是边缘用**同一块可能漂移的时钟**自报的（缺省时没有可比对象）。
 * 边缘时钟超前 1h 时：occurred - received ≈ 0 → clockDrift=false → 事件被照常
 * 接受，且事件行以未来时间落 createdAt/occurredAt——长期霸占事件流顶部
 * （world recentEvents / timeline 按 createdAt desc），台账里 clockDrift=false
 * 还摧毁了"全链路可审计"。其余帧入口（外骨骼/执行机构/环境/摄像头/定位）的
 * 坏时钟判定全部锚在服务端时钟，唯独事件入口例外。
 *
 * 修复后：时间语义锚定云端接收时刻（ADR-009 对 receivedAt 的定义就是
 * 「云端接收时刻」）；occurred 超前云端超过 5min 容忍界 → fail-closed 拒绝
 * （且发生在幂等认领之前，重试不会被误判 duplicate）；迟到的缓冲补传事件
 * 仍接受但如实标记 is_late（标记不丢弃）。
 */
import { IngestService } from '../ingest.service';

const ORG_CTX = {
  userId: 'ingest',
  primaryOrgId: 'org-1',
  accessibleOrgIds: ['org-1'],
  isGlobalAdmin: false,
};

interface InsertCapable {
  onConflictDoNothing: () => { returning: () => Promise<unknown[]> };
  returning: () => Promise<unknown[]>;
}

function makeEventBatchHarness() {
  const inserted: Array<Record<string, unknown>> = [];
  const db = {
    insert: jest.fn(() => ({
      values: jest.fn((v: Record<string, unknown>) => {
        inserted.push(v);
        const p = Promise.resolve() as Promise<void> & InsertCapable;
        p.onConflictDoNothing = () => ({ returning: () => Promise.resolve([{ id: 1 }]) });
        p.returning = () => Promise.resolve([{ id: 1 }]);
        return p;
      }),
    })),
  };
  const service = new IngestService(
    db as never,
    {} as never,
    {} as never,
    {} as never,
    { handleTrigger: jest.fn() } as never,
    {} as never,
  );
  return { service, inserted };
}

describe('ingestEventBatch：坏时钟事件 fail-closed（锚定云端接收时刻）', () => {
  it('边缘时钟超前（receivedAt 与 occurredAt 同为未来）→ 拒绝且 clock_drift=true，不落事件行', async () => {
    const { service, inserted } = makeEventBatchHarness();
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const response = await service.ingestEventBatch(
      [
        {
          eventId: 'E-SKEW-1',
          eventType: 'AndonRaised',
          schemaVersion: '1.0.0',
          occurredAt: future,
          receivedAt: future, // 边缘自报：同一块超前时钟打的接收时刻
          source: 'edge:bridge-1',
          payload: { title: '堵料停机', level: 'high', deviceId: 'agv-7' },
        } as never,
      ],
      ORG_CTX as never,
    );
    expect(response.rejected).toBe(1);
    expect(response.accepted).toBe(0);
    expect(response.results[0]?.accepted).toBe(false);
    expect(response.results[0]?.clock_drift).toBe(true);
    expect(String(response.results[0]?.error)).toContain('CLOCK_DRIFT');
    // 事件事实行绝不落库（未来时间的事件会伪造"最新事实"）
    expect(inserted).toHaveLength(0);
  });

  it('信封缺 receivedAt（无可比对象）→ 同样以云端时钟拒绝', async () => {
    const { service, inserted } = makeEventBatchHarness();
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const response = await service.ingestEventBatch(
      [
        {
          eventId: 'E-SKEW-2',
          eventType: 'AndonRaised',
          schemaVersion: '1.0.0',
          occurredAt: future,
          source: 'edge:bridge-1',
          payload: { title: '堵料停机', level: 'high', deviceId: 'agv-7' },
        } as never,
      ],
      ORG_CTX as never,
    );
    expect(response.rejected).toBe(1);
    expect(response.results[0]?.clock_drift).toBe(true);
    expect(inserted).toHaveLength(0);
  });

  it('迟到（缓冲补传 2h 前）→ 照常接受但如实标记 is_late（标记不丢弃）', async () => {
    const { service, inserted } = makeEventBatchHarness();
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const response = await service.ingestEventBatch(
      [
        {
          eventId: 'E-LATE-1',
          eventType: 'AndonRaised',
          schemaVersion: '1.0.0',
          occurredAt: past,
          source: 'edge:bridge-1',
          payload: { title: '堵料停机', level: 'high', deviceId: 'agv-7' },
        } as never,
      ],
      ORG_CTX as never,
    );
    expect(response.accepted).toBe(1);
    expect(response.results[0]?.is_late).toBe(true);
    expect(response.results[0]?.clock_drift).toBe(false);
    const eventRow = inserted.find((v) => v.eventCode === 'ANDON');
    expect(eventRow).toBeDefined();
  });

  it('正常时钟事件不受影响：接受且不误标', async () => {
    const { service } = makeEventBatchHarness();
    const response = await service.ingestEventBatch(
      [
        {
          eventId: 'E-OK-1',
          eventType: 'AndonRaised',
          schemaVersion: '1.0.0',
          occurredAt: new Date().toISOString(),
          source: 'edge:bridge-1',
          payload: { title: '堵料停机', level: 'high', deviceId: 'agv-7' },
        } as never,
      ],
      ORG_CTX as never,
    );
    expect(response.accepted).toBe(1);
    expect(response.results[0]?.is_late).toBe(false);
    expect(response.results[0]?.clock_drift).toBe(false);
  });
});
