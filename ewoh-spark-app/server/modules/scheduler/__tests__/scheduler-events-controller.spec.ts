/* v0.7 B2：POST /api/scheduler/events 事件注入端点测试
 * 覆盖：
 *   - trigger 缺失 → 400（BadRequestException）
 *   - 合法事件 → 委托 ReplanCoordinator.handleTrigger 局部重排
 *   - 冷却去抖（evaluate 返回 null）→ 返回 debounced:true
 * 复用既有 ReplanCoordinatorService mock 模式。
 */
/// <reference types="jest" />
import { BadRequestException } from '@nestjs/common';
import { SchedulerController } from '../scheduler.controller';
import { ReplanCoordinatorService } from '../replan-coordinator.service';
import type { SchedulingTrigger } from '@shared/api.interface';

function makeController(opts: {
  handleTrigger?: jest.Mock;
}) {
  const replanCoordinator = {
    handleTrigger:
      opts.handleTrigger ??
      jest.fn().mockResolvedValue({ run: null, plans: [], debounced: true }),
  };
  const controller = new SchedulerController(
    {} as never, // schedulerService
    {} as never, // schedulerStreamService
    {} as never, // resourceProjectionService
    replanCoordinator as unknown as ReplanCoordinatorService,
  );
  return { controller, replanCoordinator };
}

const ctx = {
  userId: 'u1',
  primaryOrgId: 'org1',
  role: 'dispatcher',
  accessibleOrgIds: ['org1'],
  isGlobalAdmin: false,
};

describe('v0.7 B2: POST /api/scheduler/events 事件注入端点', () => {
  it('trigger 缺失 → 400 BadRequest', async () => {
    const { controller } = makeController({});
    await expect(
      (controller as unknown as {
        injectSchedulingEvent(body: unknown, req: unknown): Promise<unknown>;
      }).injectSchedulingEvent({} as never, { userContext: ctx }),
    ).rejects.toThrow(BadRequestException);
  });

  it('合法事件（DEVICE_OFFLINE）→ 委托 handleTrigger 局部重排', async () => {
    const handleTrigger = jest.fn().mockResolvedValue({
      run: { runId: 'RUN-E1', triggerType: 'DEVICE_OFFLINE', status: 'succeeded' },
      plans: [{ planId: 'RUN-E1A', status: 'shadow' }],
      debounced: false,
    });
    const { controller, replanCoordinator } = makeController({ handleTrigger });

    const result = await (
      controller as unknown as {
        injectSchedulingEvent(body: unknown, req: unknown): Promise<unknown>;
      }
    ).injectSchedulingEvent(
      { trigger: 'DEVICE_OFFLINE' as SchedulingTrigger, entityId: 'd1', reason: '设备离线' },
      { userContext: ctx },
    );

    expect(replanCoordinator.handleTrigger).toHaveBeenCalledWith(
      'DEVICE_OFFLINE',
      'd1',
      ctx,
    );
    expect(result).toMatchObject({
      run: { runId: 'RUN-E1' },
      plans: [{ planId: 'RUN-E1A' }],
      debounced: false,
    });
  });

  it('冷却去抖命中（evaluate 返回 null）→ 返回 debounced:true，不重复求解', async () => {
    const handleTrigger = jest.fn().mockResolvedValue({
      run: null,
      plans: [],
      debounced: true,
    });
    const { controller, replanCoordinator } = makeController({ handleTrigger });

    const result = await (
      controller as unknown as {
        injectSchedulingEvent(body: unknown, req: unknown): Promise<unknown>;
      }
    ).injectSchedulingEvent(
      { trigger: 'ROUTE_BLOCKED' as SchedulingTrigger, entityId: 'edge-9' },
      { userContext: ctx },
    );

    expect(replanCoordinator.handleTrigger).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ run: null, plans: [], debounced: true });
  });

  it('entityId 可空（全局触发）→ 透传 null', async () => {
    const handleTrigger = jest.fn().mockResolvedValue({ run: null, plans: [], debounced: true });
    const { controller, replanCoordinator } = makeController({ handleTrigger });

    await (
      controller as unknown as {
        injectSchedulingEvent(body: unknown, req: unknown): Promise<unknown>;
      }
    ).injectSchedulingEvent({ trigger: 'SAFETY_EVENT' as SchedulingTrigger }, { userContext: ctx });

    expect(replanCoordinator.handleTrigger).toHaveBeenCalledWith('SAFETY_EVENT', null, ctx);
  });
});
