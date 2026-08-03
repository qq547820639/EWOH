import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv from 'ajv';
import { load } from 'js-yaml';

describe('EWOH Policy contract', () => {
  const schema = JSON.parse(
    readFileSync(
      resolve(process.cwd(), '../contracts/policy/policy-schema.json'),
      'utf8',
    ),
  );
  const example = load(
    readFileSync(
      resolve(
        process.cwd(),
        '../contracts/policy/examples/operator-safety.yaml',
      ),
      'utf8',
    ),
  ) as {
    policyId?: string;
    version?: string;
    effect?: string;
    rules?: Array<{ field?: string; operator?: string; value?: unknown }>;
  };

  it('defines the policy schema with mandatory fields', () => {
    expect(schema.$id).toBe('ewoh:///policy/v1');
    expect(schema.required).toEqual(
      expect.arrayContaining(['policyId', 'version', 'effect', 'rules']),
    );
  });

  it('validates the operator-safety example', () => {
    const ajv = new Ajv({ allErrors: true, strict: false });
    const valid = ajv.validate(schema, example);
    expect(valid).toBe(true);
    expect(ajv.errors).toBeNull();
  });

  it('uses a deny effect with at least two rules', () => {
    expect(example.effect).toBe('deny');
    expect(example.rules?.length).toBeGreaterThanOrEqual(2);
    expect(example.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
