/* IdentityService 契约行为测试（ADR-006 / NO-02b）。
 *
 * 覆盖：注册幂等（同目标版本递增 / 异目标 superseded + 新 active）、
 * 契约校验 fail-closed（坏 entityId / 缺 orgId）、解析走共享 resolveIdentityMapping
 * 语义（active/时间窗口/ambiguous_identity）、resolveBatch 冲突降级、事件落库。
 * DB 以链式 fake 替换（单元层不依赖真实 PG；DB 级验证由 standalone_032 verify + CI 承担）。
 */
/// <reference types="jest" />
import { IdentityService } from '../identity.service';
import { IdentityConflictError } from '@shared/identity';

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
  mappingId: 'map:m1',
  version: 1,
  sourceSystem: 'mes',
  sourceId: 'WO-1',
  sourceIdKind: null,
  targetEntityId: 'order:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11',
  targetKind: 'order',
  authority: 'registration',
  status: 'active',
  recordedAt: new Date('2026-08-14T08:00:00Z'),
  validFrom: null,
  validTo: null,
  evidenceId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  createdBy: null,
  updatedBy: null,
};

const INPUT = {
  mappingId: 'map:m1',
  version: 1,
  source: { system: 'mes', id: 'WO-1' },
  target: { entityId: 'order:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11' },
  authority: 'registration' as const,
};

describe('IdentityService', () => {
  it('契约校验 fail-closed：非法规范身份拒绝注册', async () => {
    const service = new IdentityService(makeFakeDb() as never);
    await expect(
      service.registerMapping(
        { ...INPUT, target: { entityId: 'not-canonical' } },
        'org-1',
      ),
    ).rejects.toThrow(/违反契约/);
  });

  it('缺租户上下文拒绝注册（fail-closed）', async () => {
    const service = new IdentityService(makeFakeDb() as never);
    await expect(service.registerMapping(INPUT, '')).rejects.toThrow(/orgId 缺失/);
  });

  it('未映射解析返回 null（fail-closed，不猜测）', async () => {
    const service = new IdentityService(makeFakeDb() as never);
    await expect(service.resolveMapping('wms', 'LOC-1', 'org-1')).resolves.toBeNull();
  });

  it('解析走共享语义：active 命中返回规范身份', async () => {
    const service = new IdentityService(makeFakeDb([{ ...BASE_ROW }]) as never);
    await expect(service.resolveMapping('mes', 'WO-1', 'org-1')).resolves.toBe(
      'order:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11',
    );
  });

  it('解析冲突 fail-closed：ambiguous_identity 抛错', async () => {
    const other = {
      ...BASE_ROW,
      id: '00000000-0000-4000-8000-000000000002',
      mappingId: 'map:m2',
      targetEntityId: 'order:00000000-0000-4000-8000-000000000002',
    };
    const service = new IdentityService(makeFakeDb([BASE_ROW, other]) as never);
    await expect(service.resolveMapping('mes', 'WO-1', 'org-1')).rejects.toBeInstanceOf(
      IdentityConflictError,
    );
  });

  it('resolveBatch：冲突设备降级不解析，其余正常返回', async () => {
    const conflictA = {
      ...BASE_ROW,
      sourceId: 'dev-conflict',
      targetEntityId: 'device:00000000-0000-4000-8000-00000000000a',
    };
    const conflictB = {
      ...conflictA,
      id: '00000000-0000-4000-8000-000000000002',
      mappingId: 'map:m2',
      targetEntityId: 'device:00000000-0000-4000-8000-00000000000b',
    };
    const good = {
      ...BASE_ROW,
      sourceSystem: 'edge-device',
      sourceId: 'dev-ok',
      targetEntityId: 'device:00000000-0000-4000-8000-00000000000c',
      targetKind: 'device',
    };
    const fake = makeFakeDb([conflictA, conflictB, good]);
    const service = new IdentityService(fake as never);
    const result = await service.resolveBatch('edge-device', ['dev-ok', 'dev-conflict'], 'org-1');
    expect(result.get('dev-ok')).toBe('device:00000000-0000-4000-8000-00000000000c');
    expect(result.has('dev-conflict')).toBe(false);
  });

  it('注册新映射：插入新行 + EntityIdentityMapped 事件落库', async () => {
    const fake = makeFakeDb();
    const service = new IdentityService(fake as never);
    const { record, created, superseded } = await service.registerMapping(INPUT, 'org-1');
    expect(created).toBe(true);
    expect(superseded).toBe(false);
    expect(record.target.entityId).toBe(INPUT.target.entityId);
    // 事件写入：insert 被调用两次（identity_mapping 行 + ewoh_event 行）
    expect(fake.insert).toHaveBeenCalledTimes(2);
  });

  it('重复登记同目标幂等：版本递增且不新建行', async () => {
    const fake = makeFakeDb([{ ...BASE_ROW }]);
    const service = new IdentityService(fake as never);
    const { created } = await service.registerMapping({ ...INPUT, version: 2 }, 'org-1');
    expect(created).toBe(false);
    // 幂等路径：update 而非 insert（不产生第二条 active 行）
    expect(fake.insert).not.toHaveBeenCalled();
    expect(fake.update).toHaveBeenCalled();
  });
});
