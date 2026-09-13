/// <reference types="jest" />
/* 回归（UR4 对抗审查 2026-09-13）：边缘安灯事件落库的 deviceId 不得伪造。
 *
 * 场景：边缘上行 AndonRaised 载荷缺 deviceId 时，原实现
 * `String(andonPayload.deviceId ?? null)` 把事件行的 device_id 写成字面量
 * 字符串 'null'——凭空造出一个名为 "null" 的设备引用（违反"缺失数据不得
 * 伪造成确定事实"的最高纪律）。修复后缺失 → NULL。
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

describe('ingestEventBatch：边缘安灯 deviceId 缺失不伪造', () => {
  it('载荷缺 deviceId → 事件行 device_id 为 null（而非字符串 "null"）', async () => {
    const { service, inserted } = makeEventBatchHarness();
    const response = await service.ingestEventBatch(
      [
        {
          eventId: 'E-ANDON-1',
          eventType: 'AndonRaised',
          schemaVersion: '1.0.0',
          occurredAt: new Date().toISOString(),
          source: 'edge:bridge-1',
          payload: { title: '堵料停机', level: 'high' },
        } as never,
      ],
      ORG_CTX as never,
    );
    expect(response.accepted).toBe(1);
    const eventRow = inserted.find((v) => v.eventCode === 'ANDON');
    expect(eventRow).toBeDefined();
    expect(eventRow?.deviceId).toBeNull();
  });

  it('载荷带 deviceId → 如实落值', async () => {
    const { service, inserted } = makeEventBatchHarness();
    await service.ingestEventBatch(
      [
        {
          eventId: 'E-ANDON-2',
          eventType: 'AndonRaised',
          schemaVersion: '1.0.0',
          occurredAt: new Date().toISOString(),
          source: 'edge:bridge-1',
          payload: { title: '堵料停机', level: 'high', deviceId: 'agv-7' },
        } as never,
      ],
      ORG_CTX as never,
    );
    const eventRow = inserted.find((v) => v.eventCode === 'ANDON');
    expect(eventRow?.deviceId).toBe('agv-7');
  });
});
