import {
  decodeCursor,
  encodeCursor,
  parseCursorQuery,
  parsePageQuery,
  toCursorResponse,
  toPageResponse,
} from '../../../server/modules/shared/pagination';
import {
  buildErrorPayload,
  StateNotAllowedException,
} from '../../../server/modules/shared/errors';

describe('pagination helpers', () => {
  it('parses and clamps page/pageSize queries', () => {
    expect(parsePageQuery({})).toEqual({ page: 1, pageSize: 20 });
    expect(parsePageQuery({ page: 2, pageSize: 10 })).toEqual({ page: 2, pageSize: 10 });
    expect(parsePageQuery({ page: 0, pageSize: 1000 }, { maxPageSize: 50 })).toEqual({
      page: 1,
      pageSize: 50,
    });
  });

  it('parses cursor/limit queries', () => {
    expect(parseCursorQuery({})).toEqual({ cursor: undefined, limit: 50 });
    expect(parseCursorQuery({ cursor: 'abc', limit: 25 })).toEqual({ cursor: 'abc', limit: 25 });
    expect(parseCursorQuery({ cursor: '', limit: 9999 }, { maxLimit: 100 })).toEqual({
      cursor: undefined,
      limit: 100,
    });
  });

  it('builds unified page and cursor responses', () => {
    expect(toPageResponse(['a', 'b'], 5, 1, 2)).toEqual({
      items: ['a', 'b'],
      total: 5,
      page: 1,
      pageSize: 2,
      hasMore: true,
    });
    expect(toCursorResponse([1, 2], 'next-token')).toEqual({
      items: [1, 2],
      nextCursor: 'next-token',
      hasMore: true,
    });
    expect(toCursorResponse([1, 2], 'ignored', false)).toEqual({
      items: [1, 2],
      nextCursor: undefined,
      hasMore: false,
    });
  });

  it('round-trips opaque cursors', () => {
    const cursor = encodeCursor({ offset: 42, orgId: 'org-1' });
    expect(decodeCursor(cursor)).toEqual({ offset: 42, orgId: 'org-1' });
    expect(decodeCursor('not-valid')).toBeUndefined();
  });
});

describe('error helpers', () => {
  it('builds the unified error payload', () => {
    const payload = buildErrorPayload('STATE_NOT_ALLOWED', 'bad transition', { from: 'a' });
    expect(payload.error.code).toBe('STATE_NOT_ALLOWED');
    expect(payload.error.message).toBe('bad transition');
    expect(payload.error.details).toEqual({ from: 'a' });
    expect(typeof payload.error.timestamp).toBe('number');
  });

  it('exposes state machine conflicts as 409 STATE_NOT_ALLOWED', () => {
    const error = new StateNotAllowedException('open -> closed is not allowed');
    expect(error.getStatus()).toBe(409);
    expect(error.getResponse()).toMatchObject({
      error: {
        code: 'STATE_NOT_ALLOWED',
        message: 'open -> closed is not allowed',
      },
    });
  });
});
