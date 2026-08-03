import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv from 'ajv';
import { load } from 'js-yaml';

describe('EWOH Mapping DSL contract', () => {
  const schema = JSON.parse(
    readFileSync(
      resolve(process.cwd(), '../contracts/mapping/mapping-schema.json'),
      'utf8',
    ),
  );
  const example = load(
    readFileSync(
      resolve(
        process.cwd(),
        '../contracts/mapping/examples/exoskeleton-telemetry.yaml',
      ),
      'utf8',
    ),
  ) as {
    mappingId?: string;
    name?: string;
    version?: string;
    source?: { system?: string; schemaRef?: string };
    target?: { system?: string; schemaRef?: string };
    rules?: Array<{ from?: string; to?: string; required?: boolean }>;
  };

  it('defines the mapping schema with mandatory fields', () => {
    expect(schema.$id).toBe('ewoh:///mapping/v1');
    expect(schema.required).toEqual(
      expect.arrayContaining([
        'mappingId',
        'name',
        'version',
        'source',
        'target',
        'rules',
      ]),
    );
  });

  it('validates the exoskeleton telemetry example', () => {
    const ajv = new Ajv({ allErrors: true, strict: false });
    const valid = ajv.validate(schema, example);
    expect(valid).toBe(true);
    expect(ajv.errors).toBeNull();
  });

  it('keeps rule keys unique and marks an identity rule required', () => {
    const fromKeys = example.rules?.map((rule) => rule.from) ?? [];
    const toKeys = example.rules?.map((rule) => rule.to) ?? [];
    expect(new Set(fromKeys).size).toBe(fromKeys.length);
    expect(new Set(toKeys).size).toBe(toKeys.length);
    expect(example.rules?.some((rule) => rule.required === true)).toBe(true);
  });
});
