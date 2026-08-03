import { AuditChainService } from '../../../server/modules/shared/audit-chain.service';

describe('audit hash chain', () => {
  it('keeps per-org chains continuous and detects tampering', () => {
    const service = new AuditChainService();
    service.append({ orgId: 'org-a', actorId: 'u1', action: 'create', entityType: 'device', entityId: 'd1', ts: 't1' });
    service.append({ orgId: 'org-a', actorId: 'u2', action: 'approve', entityType: 'plan', entityId: 'p1', ts: 't2' });
    service.append({ orgId: 'org-b', actorId: 'u3', action: 'create', entityType: 'task', entityId: 't1', ts: 't3' });

    expect(service.verifyChain('org-a')).toEqual({ valid: true, entries: 2 });
    expect(service.verifyChain('org-b')).toEqual({ valid: true, entries: 1 });

    const chain = (service as unknown as { chains: Map<string, Array<{ hash: string }>> }).chains.get('org-a')!;
    chain[1].hash = '0'.repeat(64);
    expect(service.verifyChain('org-a').valid).toBe(false);
  });

  it('keeps a 100-entry per-org chain continuous under batched appends', async () => {
    const service = new AuditChainService();
    await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        Promise.resolve().then(() =>
          service.append({
            orgId: 'org-concurrent',
            actorId: `u-${index % 5}`,
            action: 'append',
            entityType: 'audit_entry',
            entityId: `entry-${index}`,
            ts: `t-${index}`,
          }),
        ),
      ),
    );
    const result = service.verifyChain('org-concurrent');
    expect(result).toEqual({ valid: true, entries: 100 });
  });
});
