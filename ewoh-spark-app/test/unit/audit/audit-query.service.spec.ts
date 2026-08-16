import { AuditQueryService } from '../../../server/modules/audit/audit.service';

describe('AuditQueryService', () => {
  function rowWithIp() {
    return {
      id: 'audit-2',
      org_id: 'org-a',
      audit_seq: 2,
      actor_id: 'user-1',
      action: 'organization.update',
      entity_type: 'organization',
      entity_id: 'org-a',
      before_json: null,
      after_json: null,
      reason: null,
      client_ip: '203.0.113.7',
      request_id: null,
      risk_level: 'normal',
      is_high_risk: false,
      occurred_at: '2026-08-03T00:00:01Z',
      chain_seq: 2,
      prev_hash: 'b'.repeat(64),
      hash: 'c'.repeat(64),
    };
  }

  it('returns paginated audit rows with filters', async () => {
    const rows = [
      {
        id: 'audit-1',
        orgId: 'org-a',
        auditSeq: 1,
        actorId: 'user-1',
        action: 'organization.create',
        entityType: 'organization',
        entityId: 'org-new',
        beforeJson: null,
        afterJson: { name: 'A' },
        reason: null,
        clientIp: null,
        requestId: null,
        riskLevel: 'normal',
        isHighRisk: false,
        occurredAt: '2026-08-03T00:00:00Z',
        chainSeq: 1,
        prevHash: '0'.repeat(64),
        hash: 'a'.repeat(64),
      },
    ];
    // ADR-078：drizzle 链式假库（select 双面：count 行 + 数据行）。
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => {
          const q: any = Promise.resolve(rows);
          q.where = () => {
            // count 查询 await 返回；数据查询链 orderBy→limit→offset。
            const w: any = Promise.resolve([{ total: 1 }]);
            w.orderBy = () => w;
            w.limit = () => w;
            w.offset = () => Promise.resolve(rows);
            return w;
          };
          return q;
        }),
      })),
    };
    const service = new AuditQueryService(db as never);

    const result = await service.list({
      entityType: 'organization',
      limit: 10,
      offset: 0,
    });

    expect(result.total).toBe(1);
    expect(result.items[0].action).toBe('organization.create');
    expect(result.items[0].orgId).toBe('org-a');
  });

  it('masks client_ip unless the caller is an admin', async () => {
    const ipRow = {
      id: 'audit-2',
      orgId: 'org-a',
      auditSeq: 2,
      actorId: 'user-1',
      action: 'organization.update',
      entityType: 'organization',
      entityId: 'org-a',
      beforeJson: null,
      afterJson: null,
      reason: null,
      clientIp: '203.0.113.7',
      requestId: null,
      riskLevel: 'normal',
      isHighRisk: false,
      occurredAt: '2026-08-03T00:00:01Z',
      chainSeq: 2,
      prevHash: 'b'.repeat(64),
      hash: 'c'.repeat(64),
    };
    const makeDb = () => ({
      select: jest.fn(() => ({
        from: jest.fn(() => {
          const q: any = Promise.resolve([ipRow]);
          q.where = () => {
            const w: any = Promise.resolve([{ total: 1 }]);
            w.orderBy = () => w;
            w.limit = () => w;
            w.offset = () => Promise.resolve([ipRow]);
            return w;
          };
          return q;
        }),
      })),
    });
    const service = new AuditQueryService(makeDb() as never);

    const masked = await service.list({ limit: 10, offset: 0, includeClientIp: false });
    expect(masked.items[0].clientIp).toBeNull();
    const adminService = new AuditQueryService(makeDb() as never);
    const visible = await adminService.list({ limit: 10, offset: 0, includeClientIp: true });
    expect(visible.items[0].clientIp).toBe('203.0.113.7');
  });
});
