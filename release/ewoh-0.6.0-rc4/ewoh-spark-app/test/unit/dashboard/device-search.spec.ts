import { normalizePagination } from '../../../server/modules/dashboard/dashboard.service';

describe('device search pagination', () => {
  it('defaults to page 1 and size 20', () => {
    expect(normalizePagination()).toEqual({ page: 1, pageSize: 20 });
  });

  it('clamps page size to 100 and ignores non-positive pages', () => {
    expect(normalizePagination(0, 999)).toEqual({ page: 1, pageSize: 100 });
    expect(normalizePagination(-3, 0)).toEqual({ page: 1, pageSize: 1 });
  });
});
