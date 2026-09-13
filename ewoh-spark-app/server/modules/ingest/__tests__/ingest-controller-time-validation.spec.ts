/// <reference types="jest" />
/* 回归（UR4 对抗审查 2026-09-13）：环境/相机/定位三个摄入端点的
 * event_time / ts 必须可解析（与外骨骼端点 validateExoskeletonFrame 同口径）。
 *
 * 场景：边缘时钟故障上行 "not-a-date"。原控制器只查真值不查可解析性，
 * 服务层对 Invalid Date 的语义判定自动跳过 → 放行 → 插入 Invalid Date 抛
 * DB 错 → 被当成瞬时写失败回报——把**永久坏数据**当成**瞬时故障**，
 * 边缘按 retry 语义无限重试同一帧。
 * 修复后入口直接 400 invalid（fail-closed，与非可解析时间显式区分）。
 */
import { BadRequestException } from '@nestjs/common';
import { IngestController } from '../ingest.controller';

const CTX = {
  userContext: {
    userId: 'ingest',
    primaryOrgId: 'org-1',
    accessibleOrgIds: ['org-1'],
    isGlobalAdmin: false,
  },
};

function makeController() {
  const service = {
    ingestExoskeleton: jest.fn(),
    ingestExoskeletonBatch: jest.fn(),
    ingestMes: jest.fn(),
    ingestEventBatch: jest.fn(),
    ingestEnvironment: jest.fn().mockResolvedValue({ accepted: true }),
    ingestCamera: jest.fn().mockResolvedValue({ accepted: true }),
    ingestLocation: jest.fn().mockResolvedValue({ accepted: true }),
    ingestSpatialScan: jest.fn(),
  };
  // 控制器含第二个依赖（设备执行事实接入）；时间校验用例不触达它，给最小替身。
  const controller = new IngestController(
    service as never,
    { recordFact: jest.fn() } as never,
  );
  return { controller, service };
}

describe('摄入端点时间可解析性校验（fail-closed）', () => {
  it('environment：event_time 不可解析 → 400', async () => {
    const { controller, service } = makeController();
    await expect(
      controller.ingestEnvironment(
        { sensor_id: 's1', event_time: 'not-a-date' } as never,
        CTX as never,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(service.ingestEnvironment).not.toHaveBeenCalled();
  });

  it('camera：event_time 不可解析 → 400', async () => {
    const { controller, service } = makeController();
    await expect(
      controller.ingestCamera(
        { camera_id: 'cam-1', event_time: '2026-13-45T99:00:00Z', detections: [] } as never,
        CTX as never,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(service.ingestCamera).not.toHaveBeenCalled();
  });

  it('location：ts 不可解析 → 400', async () => {
    const { controller, service } = makeController();
    await expect(
      controller.ingestLocation(
        { entity_id: 'p-1', locator: 'uwb', ts: 'not-a-date', x: 1, y: 2 } as never,
        CTX as never,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(service.ingestLocation).not.toHaveBeenCalled();
  });

  it('合法时间不受影响（照常透传服务层）', async () => {
    const { controller, service } = makeController();
    await controller.ingestEnvironment(
      { sensor_id: 's1', event_time: new Date().toISOString() } as never,
      CTX as never,
    );
    expect(service.ingestEnvironment).toHaveBeenCalledTimes(1);
  });
});
