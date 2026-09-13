/// <reference types="jest" />
/* 回归（UR4 对抗审查 2026-09-13）：MES 工单上行的传输级幂等。
 *
 * 场景：边缘上行是 at-least-once（断网缓冲补传、超时重试——模块头注释）。
 * ingestMes 是全部摄入写入路径中唯一没有幂等的一个：同一 order_id 重发时
 * ewoh_schedule_task.schedule_task_id 全局唯一约束（23505）→ 恒 502，
 * 上游按传输失败无限重试，工单永远无法确认（对账持续报错）。
 * 修复后 23505 = 此前已落账 → 按传输级幂等语义回 skipped（与环境/相机路径
 * duplicateResponse 同口径），绝不把"已处理"当成失败。
 */
import { IngestService } from '../ingest.service';

const ORG_CTX = {
  userId: 'ingest',
  primaryOrgId: 'org-1',
  accessibleOrgIds: ['org-1'],
  isGlobalAdmin: false,
};

function makeHarness(rejectWith: unknown) {
  const mesService = { createWorkOrder: jest.fn().mockRejectedValue(rejectWith) };
  const service = new IngestService(
    {} as never,
    {} as never,
    mesService as never,
    {} as never,
    { handleTrigger: jest.fn() } as never,
    {} as never,
  );
  return { service, mesService };
}

describe('ingestMes：唯一约束冲突按幂等重放处理', () => {
  it('createWorkOrder 抛 23505 → skipped:true（不抛 502）', async () => {
    const dup = Object.assign(
      new Error('duplicate key value violates unique constraint "ewoh_schedule_task_schedule_task_id_key"'),
      { code: '23505' },
    );
    const { service } = makeHarness(dup);
    await expect(
      service.ingestMes({ order_id: 'ORD-1' } as never, ORG_CTX as never),
    ).resolves.toMatchObject({ accepted: false, skipped: true, data_quality: 'good' });
  });

  it('其它写失败仍显式抛错（NEST-215 语义不回归）', async () => {
    const { service } = makeHarness(new Error('connection refused'));
    await expect(
      service.ingestMes({ order_id: 'ORD-2' } as never, ORG_CTX as never),
    ).rejects.toBeDefined();
  });
});
