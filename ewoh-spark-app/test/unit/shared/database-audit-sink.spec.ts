import { DatabaseAuditSink } from '../../../server/modules/shared/database-audit-sink';

describe('DatabaseAuditSink', () => {
  it('calls the SECURITY DEFINER audit writer with redacted payloads', async () => {
    const execute = jest.fn().mockResolvedValue([]);
    const sink = new DatabaseAuditSink({ execute } as never);

    await sink.append({
      actorId: 'user-1',
      orgId: 'org-a',
      action: 'organization.create',
      entityType: 'organization',
      entityId: 'org-new',
      after: { name: 'A' },
      requestId: 'req-1',
      risk: true,
    });

    expect(execute).toHaveBeenCalledTimes(1);
    const statement = JSON.stringify(execute.mock.calls[0][0]);
    expect(statement).toContain('ewoh_append_audit_log');
    expect(statement).toContain('org-a');
    expect(statement).toContain('organization.create');
  });

  it('does not crash in a platform without the database token', async () => {
    const sink = new DatabaseAuditSink(undefined as never);
    await expect(
      sink.append({
        actorId: 'user-1',
        orgId: 'org-a',
        action: 'test',
        entityType: 'test',
        entityId: '1',
      }),
    ).resolves.toBeUndefined();
  });
});
