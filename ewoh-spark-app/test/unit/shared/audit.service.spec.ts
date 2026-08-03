import { AuditService, InMemoryAuditSink } from '../../../server/modules/shared/audit.service';

describe('AuditService', () => {
  it('deep-redacts sensitive fields without mutating the source payload', async () => {
    const sink = new InMemoryAuditSink();
    const service = new AuditService(sink);
    const after = {
      username: 'alice',
      password: 'hunter2',
      apiKey: 'ak_live',
      authConfig: {
        issuer: 'https://auth.example',
        clientSecret: 'client-secret',
      },
      health: {
        controlCredential: 'control-cred',
        healthToken: 'health-token',
      },
      nested: {
        privateKey: 'private-key',
        keyVersion: 3,
      },
      connection: 'postgres://app:dbpass@db:5432/ewoh',
      ok: true,
    };
    const snapshot = JSON.parse(JSON.stringify(after));

    await service.appendAuditLog({
      actorId: 'user-1',
      orgId: 'org-root',
      action: 'device.update',
      entityType: 'device',
      entityId: 'dev-1',
      after,
    });

    expect(after).toEqual(snapshot);
    expect(sink.entries).toHaveLength(1);
    const entry = sink.entries[0];
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('ak_live');
    expect(serialized).not.toContain('client-secret');
    expect(serialized).not.toContain('control-cred');
    expect(serialized).not.toContain('health-token');
    expect(serialized).not.toContain('private-key');
    expect(serialized).not.toContain('dbpass');
    const redacted = entry.after as {
      password: string;
      authConfig: { clientSecret: string };
      health: { controlCredential: string };
      nested: { keyVersion: number };
      username: string;
    };
    expect(redacted.password).toBe('[REDACTED]');
    expect(redacted.authConfig.clientSecret).toBe('[REDACTED]');
    expect(redacted.health.controlCredential).toBe('[REDACTED]');
    expect(redacted.nested.keyVersion).toBe(3);
    expect(redacted.username).toBe('alice');
  });
});
