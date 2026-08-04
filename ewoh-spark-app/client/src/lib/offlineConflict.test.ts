import {
  buildConflictModel,
  diffValues,
  parseConflictPayload,
  type ConflictModel,
} from './offlineConflict';

describe('offlineConflict', () => {
  it('parses a serverValue from a 409 conflict error', () => {
    const payload = parseConflictPayload({
      response: {
        status: 409,
        data: { message: 'STATE_CONFLICT', serverValue: { status: 'reported' } },
      },
    });
    expect(payload).toEqual({ serverValue: { status: 'reported' } });
  });

  it('returns null for non-conflict errors or missing serverValue', () => {
    expect(parseConflictPayload({ response: { status: 500 } })).toBeNull();
    expect(
      parseConflictPayload({
        response: { status: 409, data: { message: 'STATE_CONFLICT' } },
      }),
    ).toBeNull();
  });

  it('diffs scalar values', () => {
    expect(diffValues(1, 2)).toEqual([{ path: '', local: 1, server: 2 }]);
    expect(diffValues('a', 'a')).toEqual([]);
  });

  it('diffs nested object values by path', () => {
    const diffs = diffValues(
      { quantity: 10, note: 'a' },
      { quantity: 12, note: 'a', extra: true },
    );
    expect(diffs).toEqual([
      { path: 'quantity', local: 10, server: 12 },
      { path: 'extra', local: undefined, server: true },
    ]);
  });

  it('builds a conflict model with a recommendation', () => {
    const model: ConflictModel = buildConflictModel(
      { status: 'pending' },
      { status: 'reported' },
    );
    expect(model.recommended).toBe('server');
    expect(model.diff).toHaveLength(1);
    expect(model.diff[0].path).toBe('status');
  });

  it('recommends local when the server value is empty', () => {
    expect(buildConflictModel('x', null).recommended).toBe('local');
    expect(buildConflictModel('x', undefined).recommended).toBe('local');
  });
});