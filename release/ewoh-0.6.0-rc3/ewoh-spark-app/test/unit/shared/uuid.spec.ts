import { isValidUuid } from '../../../server/common/uuid';

describe('uuid validation', () => {
  it('accepts valid uuids and rejects others', () => {
    expect(isValidUuid('f3bdfae3-88d0-49f7-9088-fd7b8df80b8c')).toBe(true);
    expect(isValidUuid('not-a-uuid')).toBe(false);
    expect(isValidUuid('')).toBe(false);
  });
});
