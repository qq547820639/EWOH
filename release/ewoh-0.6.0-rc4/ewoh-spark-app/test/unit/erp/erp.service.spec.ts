import { ErpService } from '../../../server/modules/erp/erp.service';
import {
  ewohEvent,
  ewohScheduleTask,
  ewohScheduleTaskStep,
} from '@server/database/schema';

function createInsertMock(returnRows: unknown[] = []) {
  const entries: Array<{ table: unknown; rows: unknown }> = [];
  const insert = jest.fn((table: unknown) => ({
    values: jest.fn((rows: unknown) => {
      entries.push({ table, rows });
      return { returning: jest.fn().mockResolvedValue(returnRows) };
    }),
  }));
  return { insert, entries };
}

describe('ErpService inbound orders', () => {
  it('creates a work order and ERP order event with audit', async () => {
    const orderRow = {
      eventId: 'ERP-O-1',
      eventCode: 'ERP_ORDER',
      status: 'received',
    };
    const { insert, entries } = createInsertMock([orderRow]);
    const execute = jest.fn().mockResolvedValue([]);
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new ErpService(
      { execute, insert } as never,
      audit as never,
    );

    const result = await service.receiveOrder(
      {
        externalOrderId: 'SO-100',
        productCode: 'P-1',
        quantity: 10,
        bom: [{ materialId: 'M-1', quantity: 2 }],
      },
      { userId: 'user-1', primaryOrgId: 'org-1' },
    );

    expect(result.duplicate).toBe(false);
    expect(result.order.eventId).toBe('ERP-O-1');
    expect(entries.map((entry) => entry.table)).toEqual([
      ewohScheduleTask,
      ewohScheduleTaskStep,
      ewohEvent,
    ]);
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'erp.order.receive' }),
    );
  });

  it('is idempotent for duplicate external order ids', async () => {
    const existing = { eventId: 'ERP-O-1', status: 'received' };
    const execute = jest.fn().mockResolvedValue([existing]);
    const audit = { appendAuditLog: jest.fn() };
    const service = new ErpService(
      { execute, insert: jest.fn() } as never,
      audit as never,
    );

    const result = await service.receiveOrder({
      externalOrderId: 'SO-100',
      productCode: 'P-1',
      quantity: 10,
    });

    expect(result.duplicate).toBe(true);
    expect(result.order.eventId).toBe('ERP-O-1');
  });
});

describe('ErpService outbound queue', () => {
  it('queues an outbound message and acknowledges it as sent', async () => {
    const outboundRow = {
      eventId: 'ERP-X-1',
      status: 'pending',
      evidenceJson: { outboundId: 'OB-1', attempts: 0 },
    };
    const { insert, entries } = createInsertMock([outboundRow]);
    const execute = jest.fn().mockResolvedValue([]);
    const selectWhere = jest.fn().mockResolvedValue([
      {
        eventId: 'ERP-X-1',
        eventCode: 'ERP_OUTBOUND',
        status: 'pending',
        evidenceJson: { outboundId: 'OB-1', attempts: 0 },
      },
    ]);
    const updateReturning = jest.fn().mockResolvedValue([
      { eventId: 'ERP-X-1', status: 'sent' },
    ]);
    const db = {
      execute,
      insert,
      select: jest.fn(() => ({
        from: jest.fn(() => ({ where: selectWhere })),
      })),
      update: jest.fn(() => ({
        set: jest.fn(() => ({
          where: jest.fn(() => ({ returning: updateReturning })),
        })),
      })),
    };
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new ErpService(db as never, audit as never);

    const queued = await service.receiveOutbound({
      outboundId: 'OB-1',
      type: 'production_report',
      externalOrderId: 'SO-100',
      payload: { quantity: 10 },
    });
    expect(queued.duplicate).toBe(false);
    expect(entries[0].table).toBe(ewohEvent);

    const acked = await service.ackOutbound(
      'ERP-X-1',
      { success: true },
      { userId: 'user-1', primaryOrgId: 'org-1' },
    );
    expect(acked.status).toBe('sent');
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'erp.outbound.ack' }),
    );
  });

  it('rejects unknown outbound acknowledgments', async () => {
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({ where: jest.fn().mockResolvedValue([]) })),
      })),
    };
    const service = new ErpService(
      db as never,
      { appendAuditLog: jest.fn() } as never,
    );
    await expect(
      service.ackOutbound('missing', { success: true }),
    ).rejects.toThrow('not found');
  });
});

describe('ErpService reconcile', () => {
  it('summarizes orders, outbound, and completed ERP work orders', async () => {
    const select = jest.fn(() => ({
      from: jest.fn((table: unknown) => ({
        where: jest.fn(() => {
          if (table === ewohEvent) {
            return {
              orderBy: jest.fn().mockResolvedValue([
                { status: 'received' },
                { status: 'sent' },
              ]),
            };
          }
          return [{ status: 'completed' }];
        }),
      })),
    }));
    const service = new ErpService(
      { select } as never,
      { appendAuditLog: jest.fn() } as never,
    );

    const report = await service.reconcile();

    expect(report.orders.total).toBe(2);
    expect(report.orders.byStatus.received).toBe(1);
    expect(report.outbound.byStatus.sent).toBe(1);
    expect(report.completedErpWorkOrders).toBe(1);
  });
});
