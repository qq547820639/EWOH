import {
  DEFAULT_MAPPING_RULES,
  buildImportPreview,
  applyMappingTransform,
  parseImportText,
  runMappingDryRun,
} from './siteReadinessMapping';

describe('siteReadinessMapping', () => {
  it('applies transforms', () => {
    expect(applyMappingTransform('  abc  ', 'trim')).toEqual({ value: 'abc' });
    expect(applyMappingTransform('abc', 'upper')).toEqual({ value: 'ABC' });
    expect(applyMappingTransform('12', 'number')).toEqual({ value: 12 });
    expect(applyMappingTransform('x', 'number').error).toBeDefined();
    expect(applyMappingTransform(undefined, 'default:UNKNOWN')).toEqual({
      value: 'UNKNOWN',
    });
  });

  it('runs a local dry-run and reports missing required fields', () => {
    const result = runMappingDryRun({ order_no: 'SO-1' }, DEFAULT_MAPPING_RULES);
    expect(result.passed).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'REQUIRED_FIELD_MISSING', sourceField: 'device_no' }),
    );
    expect(result.mapped.erpOrderId).toBe('SO-1');
  });

  it('passes a dry-run with a complete sample', () => {
    const result = runMappingDryRun(
      { order_no: 'SO-1', device_no: 'D-1', org: 'acme', id: 'u-1' },
      DEFAULT_MAPPING_RULES,
    );
    expect(result.passed).toBe(true);
    expect(result.mapped.organization).toBe('ACME');
  });

  it('parses JSON arrays and objects', () => {
    expect(parseImportText('[{"a":1}]').records).toHaveLength(1);
    expect(parseImportText('{"a":1}').records).toHaveLength(1);
    expect(parseImportText('not json').error).toBeDefined();
  });

  it('builds an import before/after diff preview', () => {
    const preview = buildImportPreview(
      '[{"order_no":" SO-1 ","device_no":"D-1"}]',
      DEFAULT_MAPPING_RULES,
    );
    expect(preview.recordCount).toBe(1);
    expect(preview.changedCount).toBe(1);
    expect(preview.rows[0].after.erpOrderId).toBe('SO-1');
    expect(preview.rows[0].changed).toBe(true);
  });
});