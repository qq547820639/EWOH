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
    const execute = jest
      .fn()
      .mockResolvedValueOnce([{ total: 1 }])
      .mockResolvedValueOnce([
        {
          id: 'audit-1',
          org_id: 'org-a',
          audit_seq: 1,
          actor_id: 'user-1',
          action: 'organization.create',
          entity_type: 'organization',
          entity_id: 'org-new',
          before_json: null,
          after_json: { name: 'A' },
          reason: null,
          client_ip: null,
          request_id: null,
          risk_level: 'normal',
          is_high_risk: false,
          occurred_at: '2026-08-03T00:00:00Z',
          chain_seq: 1,
          prev_hash: '0'.repeat(64),
          hash: 'a'.repeat(64),
        },
      ]);
    const service = new AuditQueryService({ execute } as never);

    const result = await service.list({
      entityType: 'organization',
      limit: 10,
      offset: 0,
    });

    expect(result.total).toBe(1);
    expect(result.items[0].action).toBe('organization.create');
    expect(result.items[0].orgId).toBe('org-a');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('masks client_ip unless the caller is an admin', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce([{ total: 1 }])
      .mockResolvedValueOnce([rowWithIp()]);
    const service = new AuditQueryService({ execute } as never);

    const masked = await service.list({ limit: 10, offset: 0, includeClientIp: false });
    expect(masked.items[0].clientIp).toBeNull();

    const adminExecute = jest
      .fn()
      .mockResolvedValueOnce([{ total: 1 }])
      .mockResolvedValueOnce([rowWithIp()]);
    const adminService = new AuditQueryService({ execute: adminExecute } as never);
    const visible = await adminService.list({ limit: 10, offset: 0, includeClientIp: true });
    expect(visible.items[0].clientIp).toBe('203.0.113.7');
  });
});
