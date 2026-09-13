/* ERP 出站物料流动契约测试（NO-27a）。
 *
 * 写路径的三种行为必须区分清楚（否则要么破坏历史集成，要么写进脏事实）：
 *   · 合法物料载荷 → 规范化后写进 evidence.materialMovement（库存投影只认它）；
 *   · 历史自由格式（完全不含物料字段）→ 放行，但标注 materialMovementParse='legacy'；
 *   · 含物料字段却形状非法 → 400 逐条说明（fail-closed），不写库。
 */
/// <reference types="jest" />
import { BadRequestException } from '@nestjs/common';
import { ErpService } from '@server/modules/erp/erp.service';
import { ewohEvent } from '@server/database/schema';

const ORG = '11111111-1111-4111-8111-111111111111';
const ACTOR = { userId: 'erp.bot', primaryOrgId: ORG, roles: ['dispatcher'] } as never;

function createHarness() {
  const inserted: Array<Record<string, unknown>> = [];
  const db = {
    // findByEvidence（幂等检查）：返回空 → 不是重复
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({ limit: jest.fn().mockResolvedValue([]) })),
      })),
    })),
    insert: jest.fn(() => ({
      values: jest.fn((values: Record<string, unknown>) => {
        inserted.push(values);
        return { returning: jest.fn().mockResolvedValue([values]) };
      }),
    })),
  };
  const audit = { appendAuditLog: jest.fn(async () => undefined) };
  const mes = { writeScheduleOrder: jest.fn(async () => ({ scheduleTaskId: 'WO-ERP-test' })) };
  const service = new ErpService(db as never, audit as never, mes as never);
  return { service, inserted };
}

const outbound = (payload: Record<string, unknown>, type = 'inventory_receipt') => ({
  outboundId: `OUT-${Math.random().toString(36).slice(2, 8)}`,
  type: type as never,
  externalOrderId: 'SO-1',
  payload,
});

describe('ERP 订单 · BOM 口径（NO-28a）', () => {
  it('未声明口径 → 默认 per_unit 但**写明**在事件里（需求可核对）', async () => {
    const { service, inserted } = createHarness();
    await service.receiveOrder(
      { externalOrderId: 'SO-1', productCode: 'P-1', quantity: 10, bom: [{ materialId: 'MAT-1', quantity: 2 }] },
      ACTOR,
    );
    const evidence = inserted[0].evidenceJson as Record<string, unknown>;
    expect(evidence.bomBasis).toBe('per_unit');
    expect(evidence.bom).toEqual([{ materialId: 'MAT-1', quantity: 2 }]);
  });

  it('显式 per_order 被接受并原样落库', async () => {
    const { service, inserted } = createHarness();
    await service.receiveOrder(
      {
        externalOrderId: 'SO-2',
        productCode: 'P-1',
        quantity: 10,
        bom: [{ materialId: 'MAT-1', quantity: 20 }],
        bomBasis: 'per_order',
      },
      ACTOR,
    );
    expect((inserted[0].evidenceJson as Record<string, unknown>).bomBasis).toBe('per_order');
  });

  it('非法口径 → 400（不静默取默认：口径错会把需求算成几倍）', async () => {
    const { service, inserted } = createHarness();
    const error = await service
      .receiveOrder(
        {
          externalOrderId: 'SO-3',
          productCode: 'P-1',
          quantity: 10,
          bom: [{ materialId: 'MAT-1', quantity: 2 }],
          bomBasis: 'per_kilo' as never, // 非法口径（故意）
        },
        ACTOR,
      )
      .catch((e) => e);
    expect(String(error.message)).toContain('bomBasis 必须是 per_unit');
    expect(inserted).toHaveLength(0);
  });
});

describe('ERP 订单 · BOM 行单位（NO-29b）', () => {
  it('合法单位被接受', async () => {
    const { service, inserted } = createHarness();
    await service.receiveOrder(
      {
        externalOrderId: 'SO-U1',
        productCode: 'P-1',
        quantity: 5,
        bom: [{ materialId: 'MAT-1', quantity: 2, unit: 'kg' }],
      },
      ACTOR,
    );
    expect((inserted[0].evidenceJson as Record<string, unknown>).bom).toEqual([
      { materialId: 'MAT-1', quantity: 2, unit: 'kg' },
    ]);
  });

  it('非法单位（空串）→ 400，不写库', async () => {
    const { service, inserted } = createHarness();
    const error = await service
      .receiveOrder(
        {
          externalOrderId: 'SO-U2',
          productCode: 'P-1',
          quantity: 5,
          bom: [{ materialId: 'MAT-1', quantity: 2, unit: '   ' }],
        },
        ACTOR,
      )
      .catch((e) => e);
    expect(String(error.message)).toContain('bom[0].unit 必须是合法的非空字符串');
    expect(inserted).toHaveLength(0);
  });
});

describe('ERP 出站 · 物料流动契约（NO-27a）', () => {
  it('合法物料载荷 → 规范化写入 evidence.materialMovement', async () => {
    const { service, inserted } = createHarness();
    await service.receiveOutbound(
      outbound({ materialId: 'MAT-1', quantity: 100, unit: 'kg', minThreshold: 40 }),
      ACTOR,
    );

    const evidence = inserted[0].evidenceJson as Record<string, unknown>;
    expect(evidence.materialMovementParse).toBe('ok');
    expect(evidence.materialMovement).toMatchObject({
      materialId: 'MAT-1',
      quantity: 100,
      unit: 'kg',
      minThreshold: 40,
      type: 'inventory_receipt',
    });
  });

  it('历史自由格式载荷 → 放行但标注 legacy（不猜、不破坏既有集成）', async () => {
    const { service, inserted } = createHarness();
    await service.receiveOutbound(outbound({ note: 'MES 汇总', rows: 3 }, 'material_consumption'), ACTOR);
    const evidence = inserted[0].evidenceJson as Record<string, unknown>;
    expect(evidence.materialMovementParse).toBe('legacy');
    expect(evidence.materialMovement).toBeNull();
  });

  it('含物料字段但非法 → 400 且不写库（fail-closed）', async () => {
    const { service, inserted } = createHarness();
    const error = await service
      .receiveOutbound(outbound({ materialId: 'MAT-1', quantity: -5 }), ACTOR)
      .catch((e) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(String(error.message)).toContain('物料流动载荷不符合契约');
    expect(String(error.message)).toContain('quantity 必须为正数');
    expect(inserted).toHaveLength(0);
  });

  it('非物料类型不受影响（production_report 的任意载荷照旧）', async () => {
    const { service, inserted } = createHarness();
    await service.receiveOutbound(outbound({ anything: { nested: true } }, 'production_report'), ACTOR);
    const evidence = inserted[0].evidenceJson as Record<string, unknown>;
    expect(evidence.materialMovementParse).toBe('legacy');
  });
});
