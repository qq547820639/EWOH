import { buildExceptionBody } from './exceptionPayload';

describe('buildExceptionBody', () => {
  it('builds a text-only exception body', () => {
    expect(buildExceptionBody('缺料')).toEqual({
      code: 'MOBILE_EXCEPTION',
      note: '缺料',
    });
  });

  it('attaches an uploaded photo reference when present', () => {
    const body = buildExceptionBody('划伤', {
      id: 'FILE-1',
      filename: 'scratch.jpg',
      contentType: 'image/jpeg',
    });
    expect(body.attachments).toEqual([
      { id: 'FILE-1', filename: 'scratch.jpg', contentType: 'image/jpeg' },
    ]);
  });
});
