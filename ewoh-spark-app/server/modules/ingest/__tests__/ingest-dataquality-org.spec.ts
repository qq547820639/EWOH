/// <reference types="jest" />
/* R2-SOP-002 回归：ENTITY_NOT_FOUND 数据质量告警事件必须携带租户归属。
 * - 有 ingest ctx → ewoh_event 插入 values 含 orgId，响应 events_triggered=1；
 * - 缺 org 上下文 → 拒绝写 NULL=legacy 全租户可见行，events_triggered 如实为 0。 */
import { IngestService } from '../ingest.service';

const ORG_CTX = {
  userId: 'ingest',
  primaryOrgId: 'org-dq',
  accessibleOrgIds: ['org-dq'],
  isGlobalAdmin: false,
};

function makeHarness() {
  const inserted: Array<Record<string, unknown>> = [];
  const db = {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        // entityExists：始终未命中 → 触发 ENTITY_NOT_FOUND 告警分支
        where: jest.fn(() => ({
          limit: jest.fn().mockResolvedValue([]),
        })),
      })),
    })),
    insert: jest.fn(() => ({
      values: (v: Record<string, unknown>) => {
        inserted.push(v);
        return Promise.resolve();
      },
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

const FRAME = {
  device_id: 'exo-1',
  entity_id: 'workstation:missing-1',
  event_time: new Date().toISOString(),
  record_id: 'rec-dq-1',
};

describe('R2-SOP-002: fireDataQualityEvent 租户归属注入', () => {
  it('有 org ctx：告警事件 values 带 orgId，events_triggered=1', async () => {
    const { service, inserted } = makeHarness();
    const result = await service.ingestExoskeleton(FRAME as never, ORG_CTX as never);
    expect(result.accepted).toBe(false);
    expect(result.error).toContain('不存在');
    expect(result.events_triggered).toBe(1);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].orgId).toBe('org-dq');
    expect(inserted[0].eventCode).toBe('ENTITY_NOT_FOUND');
  });

  it('缺 org ctx：拒绝写告警事件（不落 NULL legacy 行），events_triggered=0', async () => {
    const { service, inserted } = makeHarness();
    const result = await service.ingestExoskeleton(FRAME as never, undefined);
    expect(result.accepted).toBe(false);
    expect(result.events_triggered).toBe(0);
    expect(inserted).toHaveLength(0);
  });
});
