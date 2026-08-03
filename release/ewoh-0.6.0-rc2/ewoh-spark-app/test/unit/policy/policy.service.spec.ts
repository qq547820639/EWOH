import { PolicyService } from '@server/modules/policy/policy.service';

describe('PolicyService', () => {
  it('denies when every policy rule matches', () => {
    const service = new PolicyService();
    const result = service.evaluate(
      {
        policyId: 'deny-dispatch-high-risk',
        version: '1.0.0',
        effect: 'deny',
        rules: [
          { field: 'plan.riskLevel', operator: 'in', value: ['high', 'critical'] },
          { field: 'plan.requiresApproval', operator: 'eq', value: true },
        ],
      },
      {
        plan: {
          riskLevel: 'critical',
          requiresApproval: true,
        },
      },
    );

    expect(result.decision).toBe('deny');
    expect(result.matched).toBe(true);
    expect(result.reasons).toHaveLength(2);
  });

  it('allows when a rule does not match', () => {
    const service = new PolicyService();
    const result = service.evaluate(
      {
        policyId: 'deny-dispatch-high-risk',
        version: '1.0.0',
        effect: 'deny',
        rules: [
          { field: 'plan.riskLevel', operator: 'in', value: ['high', 'critical'] },
          { field: 'plan.requiresApproval', operator: 'eq', value: true },
        ],
      },
      {
        plan: {
          riskLevel: 'low',
          requiresApproval: true,
        },
      },
    );

    expect(result.decision).toBe('allow');
    expect(result.matched).toBe(false);
  });

  it('rejects policies that do not conform to the schema', () => {
    const service = new PolicyService();
    expect(() =>
      service.evaluate(
        { policyId: 'broken' },
        { plan: { riskLevel: 'high' } },
      ),
    ).toThrow('does not conform');
  });

  it('loads the canonical example and evaluates risky vs safe contexts', () => {
    const service = new PolicyService();
    const example = service.getExample();
    expect(example.policyId).toBe('deny-dispatch-high-risk');

    const risky = service.evaluate(example, {
      plan: { riskLevel: 'high', requiresApproval: true },
    });
    expect(risky.decision).toBe('deny');

    const safe = service.evaluate(example, {
      plan: { riskLevel: 'low', requiresApproval: true },
    });
    expect(safe.decision).toBe('allow');
  });
});
