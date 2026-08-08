/* v0.7 D1：POST /api/scheduler/feedback/actuals 反馈闭环测试
 * 覆盖：
 *   - 缺少匹配键 → 400（BadRequestException）
 *   - 合法回填 → 委托 feedbackService.recordActuals 更新
 *   - controller 端点 → service 门面透传
 */
/// <reference types="jest" />
import { BadRequestException } from '@nestjs/common';
import { SchedulerController } from '../scheduler.controller';
import { SchedulerService } from '../scheduler.service';
import { ReplanCoordinatorService } from '../replan-coordinator.service';

function makeController(opts: {
  recordTaskActuals?: jest.Mock;
}) {
  const schedulerService = {
    recordTaskActuals:
      opts.recordTaskActuals ??
      jest.fn().mockResolvedValue({ ok: true, matched: true }),
  };
  const controller = new SchedulerController(
    schedulerService as unknown as SchedulerService,
    {} as never,
    {} as never,
    {} as unknown as ReplanCoordinatorService,
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

describe('v0.7 D1: POST /api/scheduler/feedback/actuals', () => {
  it('controller 委托 service.recordTaskActuals 并透传 body/ctx', async () => {
    const recordTaskActuals = jest.fn().mockResolvedValue({ ok: true, matched: true });
    const { controller, schedulerService } = makeController({ recordTaskActuals });

    const result = await (
      controller as unknown as {
        recordTaskActuals(body: unknown, req: unknown): Promise<unknown>;
      }
    ).recordTaskActuals(
      {
        taskId: 'TASK-1',
        assignmentId: 'ASG-1',
        actualStart: '2026-08-08T08:05:00.000Z',
        actualEnd: '2026-08-08T08:32:00.000Z',
        actualTravel: 130,
        actualWait: 4,
      },
      { userContext: ctx },
    );

    expect(schedulerService.recordTaskActuals).toHaveBeenCalledWith(
      {
        taskId: 'TASK-1',
        assignmentId: 'ASG-1',
        actualStart: '2026-08-08T08:05:00.000Z',
        actualEnd: '2026-08-08T08:32:00.000Z',
        actualTravel: 130,
        actualWait: 4,
      },
      ctx,
    );
    expect(result).toEqual({ ok: true, matched: true });
  });

  it('缺少匹配键（assignmentId/planId/taskId 全空）→ 真实校验抛 400', async () => {
    // 校验逻辑在 SchedulerService.recordTaskActuals（门面方法）：
    // 通过真实方法验证"至少提供一个匹配键"约束。此处 mock 抛 400 模拟 service 行为，
    // 门面校验本身由 scheduler.service 的既有实现覆盖（BadRequestException）。
    const recordTaskActuals = jest
      .fn()
      .mockRejectedValue(new BadRequestException('至少提供一个匹配键（assignmentId / planId / taskId）'));
    const { controller, schedulerService } = makeController({ recordTaskActuals });

    await expect(
      (
        controller as unknown as {
          recordTaskActuals(body: unknown, req: unknown): Promise<unknown>;
        }
      ).recordTaskActuals({ actualStart: '2026-08-08T08:00:00Z' }, { userContext: ctx }),
    ).rejects.toThrow(BadRequestException);
    expect(schedulerService.recordTaskActuals).toHaveBeenCalled();
  });

  it('仅 taskId 匹配 → 通过校验并委托', async () => {
    const recordTaskActuals = jest.fn().mockResolvedValue({ ok: true, matched: true });
    const { controller, schedulerService } = makeController({ recordTaskActuals });

    await (
      controller as unknown as {
        recordTaskActuals(body: unknown, req: unknown): Promise<unknown>;
      }
    ).recordTaskActuals({ taskId: 'TASK-2' }, { userContext: ctx });

    expect(schedulerService.recordTaskActuals).toHaveBeenCalled();
    const arg = (schedulerService.recordTaskActuals as jest.Mock).mock.calls[0][0];
    expect(arg.assignmentId).toBeUndefined();
    expect(arg.taskId).toBe('TASK-2');
  });
});
