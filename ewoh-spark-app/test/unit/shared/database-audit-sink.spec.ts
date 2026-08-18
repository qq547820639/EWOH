import { DatabaseAuditSink } from '../../../server/modules/shared/database-audit-sink';

// P0 #8（2026-08-19 审计）：审计写入前 orgId UUID 校验——测试数据用固定 UUID。
const ORG_UUID = '11111111-2222-4333-8444-555555555555';

describe('DatabaseAuditSink', () => {
  it('calls the SECURITY DEFINER audit writer with redacted payloads', async () => {
    const execute = jest.fn().mockResolvedValue([]);
    const sink = new DatabaseAuditSink({ execute } as never);

    await sink.append({
      actorId: 'user-1',
      orgId: ORG_UUID,
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
    expect(statement).toContain(ORG_UUID);
    expect(statement).toContain('organization.create');
  });

  it('P0 #8：非 UUID orgId 跳过 DB 持久化（不触发 22P02 回滚业务写）', async () => {
    const execute = jest.fn().mockResolvedValue([]);
    const sink = new DatabaseAuditSink({ execute } as never);

    await sink.append({
      actorId: 'user-1',
      orgId: 'org-a', // 非 UUID——跳过而非崩溃/回滚
      action: 'organization.create',
      entityType: 'organization',
      entityId: 'org-new',
    });

    expect(execute).not.toHaveBeenCalled();
  });

  it('does not crash in a platform without the database token', async () => {
    const sink = new DatabaseAuditSink(undefined as never);
    await expect(
      sink.append({
        actorId: 'user-1',
        orgId: ORG_UUID,
        action: 'test',
        entityType: 'test',
        entityId: '1',
      }),
    ).resolves.toBeUndefined();
  });
});
