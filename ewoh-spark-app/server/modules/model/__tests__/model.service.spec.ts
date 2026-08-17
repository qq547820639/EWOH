/* ModelService 注册元数据对齐测试（NO-08b / ADR-013）。
 *
 * 覆盖：registerModel 必填校验 fail-closed；inputVersion 落 cardJson.inputVersion
 * （无独立列，Model Card 为版本治理载体）；缺省不伪造 inputVersion；
 * NEST-411 org 上下文强制；NEST-446 状态机 candidate→reviewing→shadow→
 * active→retired 全链 + CAS 冲突 409。
 */
/// <reference types="jest" />
import { ModelService, nextModelStatus } from '../model.service';

type Row = Record<string, unknown>;

function makeFakeDb(rows: Row[] = []) {
  const state = { rows: [...rows] };
  const inserted: Array<Record<string, unknown>> = [];
  const fake = {
    select: jest.fn(() => fake),
    from: jest.fn(() => fake),
    where: jest.fn(() => Promise.resolve(state.rows)),
    orderBy: jest.fn(() => Promise.resolve(state.rows)),
    insert: jest.fn(() => ({
      values: jest.fn((v: Record<string, unknown>) => {
        inserted.push(v);
        return { returning: jest.fn(() => Promise.resolve([v])) };
      }),
    })),
    update: jest.fn(() => ({
      set: jest.fn((v: Record<string, unknown>) => ({
        where: jest.fn(() => ({
          // CAS 命中：返回更新后行（合并 set）。
          returning: jest.fn(() => {
            const updated = { ...state.rows[0], ...v };
            return Promise.resolve([updated]);
          }),
        })),
      })),
    })),
    __inserted: inserted,
    __state: state,
  };
  return fake;
}

const AUDIT = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
const ACTOR = { userId: 'user-1', primaryOrgId: 'org-1', roles: [] };

const REGISTER_INPUT = {
  modelId: 'action-classifier',
  modelName: '动作分类',
  version: 'v3',
  type: 'action-classifier',
};

describe('ModelService（NO-08b 注册元数据对齐）', () => {
  it('缺必填字段 → BadRequest（fail-closed）', async () => {
    const service = new ModelService(makeFakeDb() as never, AUDIT as never);
    await expect(
      service.registerModel(
        {
          ...REGISTER_INPUT,
          modelId: '',
        },
        ACTOR,
      ),
    ).rejects.toThrow(/required/);
  });

  it('NEST-411：缺 org 上下文注册 401', async () => {
    const service = new ModelService(makeFakeDb() as never, AUDIT as never);
    await expect(service.registerModel(REGISTER_INPUT)).rejects.toThrow(/org 上下文缺失/);
  });

  it('inputVersion 落 cardJson.inputVersion（ADR-013 元数据对齐）+ orgId 注入', async () => {
    const fake = makeFakeDb();
    const service = new ModelService(fake as never, AUDIT as never);
    const row = await service.registerModel(
      {
        ...REGISTER_INPUT,
        inputVersion: 'features-v7',
        cardJson: { intendedUse: '动作识别' },
      },
      ACTOR,
    );
    expect((row as { cardJson: Record<string, unknown> }).cardJson).toEqual({
      intendedUse: '动作识别',
      inputVersion: 'features-v7',
    });
    // NEST-411：写入显式携带 orgId。
    expect(fake.__inserted[0]).toMatchObject({ orgId: 'org-1', status: 'candidate' });
  });

  it('inputVersion 缺省不伪造（cardJson 不注入）', async () => {
    const fake = makeFakeDb();
    const service = new ModelService(fake as never, AUDIT as never);
    const row = await service.registerModel(REGISTER_INPUT, ACTOR);
    expect((row as { cardJson: Record<string, unknown> }).cardJson).toEqual({});
  });
});

describe('NEST-446：Model 状态机（candidate→reviewing→shadow→active→retired）', () => {
  const id = '00000000-0000-4000-8000-0000000000aa';

  function seedRow(status: string): Row {
    return {
      id,
      modelId: 'action-classifier',
      status,
      orgId: 'org-1',
      createdAt: new Date(),
    };
  }

  it('walks candidate → reviewing → shadow → active → retired（合法链全绿）', async () => {
    const fake = makeFakeDb([seedRow('candidate')]);
    const service = new ModelService(fake as never, AUDIT as never);
    const chain = [
      ['submit_review', 'reviewing'],
      ['approve_review', 'shadow'],
      ['activate', 'active'],
      ['retire', 'retired'],
    ] as const;
    for (const [action, expected] of chain) {
      // 每次 CAS 后 fake.__state.rows[0] 更新为合并行。
      const row = await service.transitionStatus(id, action, ACTOR);
      expect((row as { status: string }).status).toBe(expected);
      fake.__state.rows[0] = { ...fake.__state.rows[0], status: expected };
    }
  });

  it('拒绝非法跳转（candidate 直接 activate 维持原状态 → BadRequest）', async () => {
    const service = new ModelService(
      makeFakeDb([seedRow('candidate')]) as never,
      AUDIT as never,
    );
    await expect(
      service.transitionStatus(id, 'activate', ACTOR),
    ).rejects.toThrow(/not allowed/);
  });

  it('并发 CAS 冲突（update 命中 0 行）→ ConflictException 409', async () => {
    const fake = makeFakeDb([seedRow('candidate')]);
    // CAS 落空：update returning 空数组。
    fake.update = jest.fn(() => ({
      set: jest.fn(() => ({
        where: jest.fn(() => ({ returning: jest.fn(() => Promise.resolve([])) })),
      })),
    }));
    const service = new ModelService(fake as never, AUDIT as never);
    await expect(
      service.transitionStatus(id, 'submit_review', ACTOR),
    ).rejects.toThrow(/STATE_CONFLICT/);
  });

  it('nextModelStatus 纯函数：terminal（retired）不再转移', () => {
    expect(nextModelStatus('retired', 'activate')).toBe('retired');
    expect(nextModelStatus('candidate', 'retire')).toBe('candidate');
  });
});
