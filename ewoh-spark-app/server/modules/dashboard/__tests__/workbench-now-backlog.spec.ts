/**
 * WorkbenchNow 投递积压聚合项（NO-77a）。
 *
 * 契约：积压（实时快照，判定与巡检同一实现）必须作为"现在需要我做什么"的一条
 * 出现在工作台——升级（≥3× SLA）priority 1 / severity critical，普通积压 priority 2；
 * 带聚合数字与处置路由（/devices）；快照失败时**不阻塞**其余事实（如实缺项）。
 */
import { ControlService } from '../../control/control.service';
import { WorkbenchNowService } from '../workbench-now.service';

const ORG = { userId: 'tester', primaryOrgId: '00000000-0000-4000-8000-000000000001' } as never;

function makeService(backlog: Record<string, unknown> | null) {
  const controlService = {
    getDeliveryBacklogSnapshot: jest.fn().mockResolvedValue(backlog),
  } as unknown as ControlService;
  const db = {
    execute: jest.fn().mockResolvedValue([]),
    select: jest.fn(),
  } as never;
  return { service: new WorkbenchNowService(db, controlService), controlService };
}

describe('WorkbenchNow 投递积压聚合项（NO-77a）', () => {
  it('升级积压 → priority 1 / critical，带聚合数字与 /devices 路由', async () => {
    const { service } = makeService({
      slaMs: 300_000,
      escalationMultiplier: 3,
      totals: {
        devices: 2, commands: 5, undelivered: 3, receivedNotExecuted: 2,
        escalatedDevices: 1, oldestWaitingMs: 30 * 60_000,
      },
      devices: [],
      checkedAt: new Date().toISOString(),
    });
    const now = await service.getNow(ORG);
    const item = now.items.find((i) => i.ref === 'delivery-backlog');
    expect(item).toBeDefined();
    expect(item?.priority).toBe(1);
    expect(item?.severity).toBe('critical');
    expect(item?.route).toBe('/devices');
    expect(item?.title).toContain('2 台设备 5 条命令');
    expect(item?.title).toContain('1 台已升级');
    expect(item?.detail).toContain('未交付 3 / 已投未回执 2');
    expect(item?.detail).toContain('SLA 5 分钟');
  });

  it('普通积压（未达升级）→ priority 2 / high', async () => {
    const { service } = makeService({
      slaMs: 300_000,
      escalationMultiplier: 3,
      totals: {
        devices: 1, commands: 1, undelivered: 1, receivedNotExecuted: 0,
        escalatedDevices: 0, oldestWaitingMs: 6 * 60_000,
      },
      devices: [],
      checkedAt: new Date().toISOString(),
    });
    const now = await service.getNow(ORG);
    const item = now.items.find((i) => i.ref === 'delivery-backlog');
    expect(item?.priority).toBe(2);
    expect(item?.severity).toBe('high');
    expect(item?.title).not.toContain('已升级');
  });

  it('无积压 → 不产生积压项（不伪造"需要处置"）', async () => {
    const { service } = makeService({
      slaMs: 300_000,
      escalationMultiplier: 3,
      totals: {
        devices: 0, commands: 0, undelivered: 0, receivedNotExecuted: 0,
        escalatedDevices: 0, oldestWaitingMs: null,
      },
      devices: [],
      checkedAt: new Date().toISOString(),
    });
    const now = await service.getNow(ORG);
    expect(now.items.find((i) => i.ref === 'delivery-backlog')).toBeUndefined();
  });

  it('快照失败 → 工作台其余事实照常返回（积压项如实缺项）', async () => {
    const controlService = {
      getDeliveryBacklogSnapshot: jest.fn().mockRejectedValue(new Error('boom')),
    } as unknown as ControlService;
    const db = { execute: jest.fn().mockResolvedValue([]), select: jest.fn() } as never;
    const service = new WorkbenchNowService(db, controlService);
    const now = await service.getNow(ORG);
    expect(Array.isArray(now.items)).toBe(true);
    expect(now.items.find((i) => i.ref === 'delivery-backlog')).toBeUndefined();
    expect(now.generatedAt).toBeTruthy();
  });
});
