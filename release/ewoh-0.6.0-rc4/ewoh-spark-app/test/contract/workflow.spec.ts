import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv from 'ajv';
import { load } from 'js-yaml';

describe('EWOH Workflow contract', () => {
  const schema = JSON.parse(
    readFileSync(
      resolve(process.cwd(), '../contracts/workflow/workflow-schema.json'),
      'utf8',
    ),
  );
  const example = load(
    readFileSync(
      resolve(
        process.cwd(),
        '../contracts/workflow/examples/mes-execution.yaml',
      ),
      'utf8',
    ),
  ) as {
    workflowId?: string;
    version?: string;
    start?: string;
    steps?: Array<{ name?: string; next?: string[] }>;
  };

  it('defines the workflow schema with mandatory fields', () => {
    expect(schema.$id).toBe('ewoh:///workflow/v1');
    expect(schema.required).toEqual(
      expect.arrayContaining(['workflowId', 'version', 'start', 'steps']),
    );
  });

  it('validates the MES execution example', () => {
    const ajv = new Ajv({ allErrors: true, strict: false });
    const valid = ajv.validate(schema, example);
    expect(valid).toBe(true);
    expect(ajv.errors).toBeNull();
  });

  it('keeps step names unique and next references resolvable', () => {
    const names = example.steps?.map((step) => step.name) ?? [];
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain(example.start);
    for (const step of example.steps ?? []) {
      for (const next of step.next ?? []) {
        expect(names).toContain(next);
      }
    }
  });
});
