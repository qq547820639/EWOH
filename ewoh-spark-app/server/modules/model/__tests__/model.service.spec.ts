/* ModelService 注册元数据对齐测试（NO-08b / ADR-013）。
 *
 * 覆盖：registerModel 必填校验 fail-closed；inputVersion 落 cardJson.inputVersion
 * （无独立列，Model Card 为版本治理载体）；缺省不伪造 inputVersion。
 */
/// <reference types="jest" />
import { ModelService } from '../model.service';

function makeFakeDb() {
  const inserted: Array<Record<string, unknown>> = [];
  const fake = {
    select: jest.fn(() => fake),
    from: jest.fn(() => fake),
    where: jest.fn(() => Promise.resolve([])),
    orderBy: jest.fn(() => Promise.resolve([])),
    insert: jest.fn(() => ({
      values: jest.fn((v: Record<string, unknown>) => {
        inserted.push(v);
        return { returning: jest.fn(() => Promise.resolve([v])) };
      }),
    })),
    __inserted: inserted,
  };
  return fake;
}

const AUDIT = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };

describe('ModelService（NO-08b 注册元数据对齐）', () => {
  it('缺必填字段 → BadRequest（fail-closed）', async () => {
    const service = new ModelService(makeFakeDb() as never, AUDIT as never);
    await expect(
      service.registerModel({
        modelId: '',
        modelName: 'x',
        version: 'v1',
        type: 'action-classifier',
      }),
    ).rejects.toThrow(/required/);
  });

  it('inputVersion 落 cardJson.inputVersion（ADR-013 元数据对齐）', async () => {
    const fake = makeFakeDb();
    const service = new ModelService(fake as never, AUDIT as never);
    const row = await service.registerModel({
      modelId: 'action-classifier',
      modelName: '动作分类',
      version: 'v3',
      type: 'action-classifier',
      inputVersion: 'features-v7',
      cardJson: { intendedUse: '动作识别' },
    });
    expect((row as { cardJson: Record<string, unknown> }).cardJson).toEqual({
      intendedUse: '动作识别',
      inputVersion: 'features-v7',
    });
  });

  it('inputVersion 缺省不伪造（cardJson 不注入）', async () => {
    const fake = makeFakeDb();
    const service = new ModelService(fake as never, AUDIT as never);
    const row = await service.registerModel({
      modelId: 'action-classifier',
      modelName: '动作分类',
      version: 'v3',
      type: 'action-classifier',
    });
    expect((row as { cardJson: Record<string, unknown> }).cardJson).toEqual({});
  });
});
