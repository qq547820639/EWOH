/* QualityService 契约行为测试（ADR-010 / NO-05b）。
 *
 * 覆盖：契约校验 fail-closed（未知 findingType / 坏 link）、缺租户上下文拒绝、
 * severity 归一化（L2→high）、生命周期顺序强制（open→under_review→dispositioned→closed）、
 * dispositioned 必须带合法 disposition（与 standalone_034 CHECK 双强制）、
 * 事件落库（detected/dispositioned 写 ewoh_event，信封 ADR-009）。
 * DB 以链式 fake 替换（单元层不依赖真实 PG；DB 级验证由 standalone_034 verify + CI 承担）。
 */
/// <reference types="jest" />
import { QualityService } from '../quality.service';

type Row = Record<string, unknown>;

function makeFakeDb(rows: Row[] = []) {
  const state = { rows: [...rows] };
  const selectResult = () => {
    const thenable = Promise.resolve(state.rows) as Promise<Row[]> & {
      limit: jest.Mock;
    };
    thenable.limit = jest.fn(() => Promise.resolve(state.rows));
    return thenable;
  };
  const fake = {
    select: jest.fn(() => fake),
    from: jest.fn(() => fake),
    where: jest.fn(() => selectResult()),
    insert: jest.fn(() => ({
      values: jest.fn((v: Row) => ({
        returning: jest.fn(() => {
          const row = { ...v };
          state.rows.push(row);
          return Promise.resolve([row]);
        }),
        onConflictDoUpdate: jest.fn(() => Promise.resolve([])),
      })),
    })),
    update: jest.fn(() => ({
      set: jest.fn(() => ({
        where: jest.fn(() => Promise.resolve([])),
      })),
    })),
    __state: state,
  };
  return fake;
}

const BASE_ROW = {
  id: '00000000-0000-4000-8000-000000000001',
  orgId: 'org-1',
  findingId: 'qf:1',
  findingType: 'defect',
  severity: 'high',
  status: 'open',
  disposition: null,
  links: [],
  detectedAt: new Date('2026-08-14T08:00:00Z'),
  dispositionedAt: null,
  evidenceId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  createdBy: null,
  updatedBy: null,
};

const INPUT = {
  findingId: 'qf:1',
  findingType: 'defect',
  severity: 'high',
};

function makeWorkOrderService() {
  return {
    createWorkOrder: jest.fn().mockResolvedValue({ record: {}, created: true }),
  };
}

describe('QualityService', () => {
  it('契约校验 fail-closed：未知 findingType 拒绝', async () => {
    const service = new QualityService(makeFakeDb() as never, makeWorkOrderService() as never);
    await expect(
      service.createFinding({ ...INPUT, findingType: 'unknown_type' }, 'org-1'),
    ).rejects.toThrow(/违反契约/);
  });

  it('契约校验 fail-closed：link 非规范身份拒绝', async () => {
    const service = new QualityService(makeFakeDb() as never, makeWorkOrderService() as never);
    await expect(
      service.createFinding({ ...INPUT, links: ['not-canonical'] }, 'org-1'),
    ).rejects.toThrow(/违反契约/);
  });

  it('缺租户上下文拒绝（fail-closed）', async () => {
    const service = new QualityService(makeFakeDb() as never, makeWorkOrderService() as never);
    await expect(service.createFinding(INPUT, '')).rejects.toThrow(/orgId 缺失/);
  });

  it('创建：插入发现行 + QualityFindingDetected 事件；severity 归一化（L2→high）', async () => {
    const fake = makeFakeDb();
    const service = new QualityService(fake as never, makeWorkOrderService() as never);
    const row = await service.createFinding({ ...INPUT, severity: 'L2' }, 'org-1');
    expect(row.severity).toBe('high');
    expect(fake.insert).toHaveBeenCalledTimes(2);
  });

  it('非法转移拒绝：open → dispositioned 直接跳（契约 lifecycle 顺序强制）', async () => {
    const service = new QualityService(makeFakeDb([{ ...BASE_ROW }]) as never, makeWorkOrderService() as never);
    await expect(
      service.transitionFinding('qf:1', { to: 'dispositioned', disposition: 'scrap' }, 'org-1'),
    ).rejects.toThrow(/非法状态转移/);
  });

  it('dispositioned 必须带合法 disposition：缺省/非法均拒绝', async () => {
    const underReview = { ...BASE_ROW, status: 'under_review' };
    const missing = new QualityService(makeFakeDb([underReview]) as never, makeWorkOrderService() as never);
    await expect(
      missing.transitionFinding('qf:1', { to: 'dispositioned' }, 'org-1'),
    ).rejects.toThrow(/违反契约/);

    const bad = new QualityService(makeFakeDb([underReview]) as never, makeWorkOrderService() as never);
    await expect(
      bad.transitionFinding('qf:1', { to: 'dispositioned', disposition: 'nonsense' }, 'org-1'),
    ).rejects.toThrow(/违反契约/);
  });

  it('dispositioned 转移（合法 disposition）写 QualityFindingDispositioned 事件', async () => {
    const fake = makeFakeDb([{ ...BASE_ROW, status: 'under_review' }]);
    const service = new QualityService(fake as never, makeWorkOrderService() as never);
    const result = await service.transitionFinding(
      'qf:1',
      { to: 'dispositioned', disposition: 'rework' },
      'org-1',
    );
    expect(result).toEqual({
      findingId: 'qf:1',
      from: 'under_review',
      to: 'dispositioned',
      disposition: 'rework',
    });
    expect(fake.update).toHaveBeenCalled();
    // links 为空 → 无工单执行落点，仅 Dispositioned 事件（不伪造工单）
    expect(fake.insert).toHaveBeenCalledTimes(1);
  });

  it('NO-05e-b（ADR-012）：rework 处置且 links 有落点 → 委托 WorkOrderService 建单', async () => {
    const fake = makeFakeDb([
      {
        ...BASE_ROW,
        status: 'under_review',
        links: ['station:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11'],
      },
    ]);
    const workOrderService = makeWorkOrderService();
    const service = new QualityService(fake as never, workOrderService as never);
    await service.transitionFinding('qf:1', { to: 'dispositioned', disposition: 'rework' }, 'org-1');
    // 仅 Dispositioned 事件由本服务写；工单走唯一权威写路径
    expect(fake.insert).toHaveBeenCalledTimes(1);
    expect(workOrderService.createWorkOrder).toHaveBeenCalledTimes(1);
    const [inputArg, orgArg] = (workOrderService.createWorkOrder as jest.Mock).mock.calls[0];
    expect(orgArg).toBe('org-1');
    expect(inputArg).toMatchObject({
      workOrderId: expect.stringMatching(/^wo:[0-9a-f]{12}$/),
      workOrderType: 'quality_rework',
      origin: { kind: 'quality_finding', id: 'qf:1' },
      subjectEntityId: 'station:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11',
      severity: 'high',
    });
  });

  it('NO-05e-b（ADR-012）：scrap 处置不建工单', async () => {
    const fake = makeFakeDb([
      {
        ...BASE_ROW,
        status: 'under_review',
        links: ['station:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11'],
      },
    ]);
    const workOrderService = makeWorkOrderService();
    const service = new QualityService(fake as never, workOrderService as never);
    await service.transitionFinding('qf:1', { to: 'dispositioned', disposition: 'scrap' }, 'org-1');
    expect(fake.insert).toHaveBeenCalledTimes(1);
    expect(workOrderService.createWorkOrder).not.toHaveBeenCalled();
    const valuesFn = (fake.insert.mock.results[0].value as { values: jest.Mock }).values;
    expect((valuesFn.mock.calls[0][0] as Record<string, unknown>).eventType).toBe(
      'QualityFindingDispositioned',
    );
  });

  it('合法转移：open → under_review 不产生事件', async () => {
    const fake = makeFakeDb([{ ...BASE_ROW }]);
    const service = new QualityService(fake as never, makeWorkOrderService() as never);
    const result = await service.transitionFinding('qf:1', { to: 'under_review' }, 'org-1');
    expect(result).toEqual({ findingId: 'qf:1', from: 'open', to: 'under_review', disposition: null });
    expect(fake.update).toHaveBeenCalled();
    expect(fake.insert).not.toHaveBeenCalled();
  });
});
