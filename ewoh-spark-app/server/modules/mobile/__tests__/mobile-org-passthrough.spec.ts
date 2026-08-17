/// <reference types="jest" />
/* R2-SAM-002 回归：
 * 1) MesService.orgCondition 对 undefined actor fail-closed（不再"信任
 *    undefined 不过滤"——requireOrgId 抛 400）；
 * 2) MobileService scan/scanOrder/getOrder 透传租户上下文给 MesService。 */
import { BadRequestException } from '@nestjs/common';
import { MesService } from '../../mes/mes.service';
import { MobileService } from '../mobile.service';

const ORG_CTX = {
  userId: 'worker-1',
  primaryOrgId: 'org-m',
  accessibleOrgIds: ['org-m'],
  roles: ['worker'],
  isGlobalAdmin: false,
};

describe('R2-SAM-002: MES orgCondition fail-closed + mobile scan/order 透传', () => {
  it('MesService：undefined actor → orgCondition 收敛为 400（无 org 过滤的旁路关闭）', async () => {
    const mes = new MesService({} as never, {} as never);
    await expect(mes.getWorkOrder('WO-1', undefined)).rejects.toThrow(BadRequestException);
    await expect(mes.listWorkOrders(undefined)).rejects.toThrow(
      'org context missing: mes operations require tenant context',
    );
  });

  it('MesService：global_admin 不加 org 过滤（谓词为 undefined 分支保留）', () => {
    const mes = new MesService(
      {
        select: jest.fn(() => ({
          from: jest.fn(() => ({
            where: jest.fn(() => ({ orderBy: jest.fn().mockResolvedValue([]) })),
          })),
        })),
      } as never,
      {} as never,
    );
    const admin = { ...ORG_CTX, isGlobalAdmin: true } as never;
    void expect(mes.listWorkOrders(admin)).resolves.toEqual([]);
  });

  it('MobileService.getOrder：透传 actor 给 mesService.getWorkOrder', async () => {
    const getWorkOrder = jest.fn().mockResolvedValue({ workOrder: { scheduleTaskId: 'WO-1' } });
    const mobile = new MobileService({} as never, { getWorkOrder } as never);
    await mobile.getOrder('WO-1', ORG_CTX as never);
    expect(getWorkOrder).toHaveBeenCalledWith('WO-1', ORG_CTX);
  });

  it('MobileService.scan（工单前缀）：scanOrder 透传 actor', async () => {
    const getWorkOrder = jest.fn().mockResolvedValue({ workOrder: { scheduleTaskId: 'WO-9' } });
    const mobile = new MobileService({} as never, { getWorkOrder } as never);
    await mobile.scan('WO:WO-9', ORG_CTX as never);
    expect(getWorkOrder).toHaveBeenCalledWith('WO-9', ORG_CTX);
  });

  it('MobileService.scan（STEP: 前缀）：getStep/getWorkOrder 均透传 actor', async () => {
    const getStep = jest.fn().mockResolvedValue({ stepId: 'S-1', scheduleTaskId: 'WO-9' });
    const getWorkOrder = jest.fn().mockResolvedValue({ workOrder: { scheduleTaskId: 'WO-9' } });
    const mobile = new MobileService({} as never, { getStep, getWorkOrder } as never);
    const result = await mobile.scan('STEP:S-1', ORG_CTX as never);
    expect(getStep).toHaveBeenCalledWith('S-1', ORG_CTX);
    expect(getWorkOrder).toHaveBeenCalledWith('WO-9', ORG_CTX);
    expect(result).toMatchObject({ scanType: 'step' });
  });
});
