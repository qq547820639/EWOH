/* v0.7 B2/Batch6.1：POST /api/scheduler/events 事件注入端点测试
 * 覆盖：
 *   - trigger 缺失 → 400（BadRequestException）
 *   - 合法事件 → 委托 SchedulerService.injectSchedulingEvent（事件→局部重排→级联）
 *   - 冷却去抖 → 返回 debounced:true
 */
/// <reference types="jest" />
import { BadRequestException } from '@nestjs/common';
import { SchedulerController } from '../scheduler.controller';
import { SchedulerService } from '../scheduler.service';
import type { SchedulingTrigger } from '@shared/api.interface';

function makeController(opts: {
  injectSchedulingEvent?: jest.Mock;
}) {
  const schedulerService = {
    injectSchedulingEvent:
      opts.injectSchedulingEvent ??
      jest.fn().mockResolvedValue({ run: null, plans: [], debounced: true, cascaded: [] }),
  };
  const controller = new SchedulerController(
    schedulerService as unknown as SchedulerService,
    {} as never, // schedulerStreamService
    {} as never, // resourceProjectionService
    {} as never, // replanCoordinatorService（controller 不再直连）
  );
  return { controller, schedulerService };
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

  it('合法事件（DEVICE_OFFLINE）→ 委托 service.injectSchedulingEvent（局部重排 + 级联）', async () => {
    const injectSchedulingEvent = jest.fn().mockResolvedValue({
      run: { runId: 'RUN-E1', triggerType: 'DEVICE_OFFLINE', status: 'succeeded' },
      plans: [{ planId: 'RUN-E1A', status: 'shadow' }],
      debounced: false,
      cascaded: ['ROUTE_BLOCKED'],
    });
    const { controller, schedulerService } = makeController({ injectSchedulingEvent });

    const result = await (
      controller as unknown as {
        injectSchedulingEvent(body: unknown, req: unknown): Promise<unknown>;
      }
    ).injectSchedulingEvent(
      { trigger: 'DEVICE_OFFLINE' as SchedulingTrigger, entityId: 'd1', reason: '设备离线' },
      { userContext: ctx },
    );

    expect(schedulerService.injectSchedulingEvent).toHaveBeenCalledWith(
      { trigger: 'DEVICE_OFFLINE', entityId: 'd1', reason: '设备离线' },
      ctx,
    );
    expect(result).toMatchObject({
      run: { runId: 'RUN-E1' },
      plans: [{ planId: 'RUN-E1A' }],
      debounced: false,
      cascaded: ['ROUTE_BLOCKED'],
    });
  });

  it('冷却去抖命中 → 返回 debounced:true，不重复求解', async () => {
    const injectSchedulingEvent = jest.fn().mockResolvedValue({
      run: null,
      plans: [],
      debounced: true,
      cascaded: [],
    });
    const { controller, schedulerService } = makeController({ injectSchedulingEvent });

    const result = await (
      controller as unknown as {
        injectSchedulingEvent(body: unknown, req: unknown): Promise<unknown>;
      }
    ).injectSchedulingEvent(
      { trigger: 'ROUTE_BLOCKED' as SchedulingTrigger, entityId: 'edge-9' },
      { userContext: ctx },
    );

    expect(schedulerService.injectSchedulingEvent).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ run: null, plans: [], debounced: true, cascaded: [] });
  });

  it('entityId 可空（全局触发）→ 透传 body 原样', async () => {
    const injectSchedulingEvent = jest.fn().mockResolvedValue({
      run: null,
      plans: [],
      debounced: true,
      cascaded: [],
    });
    const { controller, schedulerService } = makeController({ injectSchedulingEvent });

    await (
      controller as unknown as {
        injectSchedulingEvent(body: unknown, req: unknown): Promise<unknown>;
      }
    ).injectSchedulingEvent({ trigger: 'SAFETY_EVENT' as SchedulingTrigger }, { userContext: ctx });

    expect(schedulerService.injectSchedulingEvent).toHaveBeenCalledWith(
      { trigger: 'SAFETY_EVENT' },
      ctx,
    );
  });
});
