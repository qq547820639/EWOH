import type { ArgumentsHost } from '@nestjs/common';
import { GlobalExceptionFilter } from '../../../server/common/filters/exception.filter';

describe('GlobalExceptionFilter', () => {
  function createHost() {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const response = { headersSent: false, status };
    const host = {
      switchToHttp: () => ({ getResponse: () => response }),
    } as unknown as ArgumentsHost;
    return { host, status, json };
  }

  afterEach(() => {
    delete process.env.NODE_ENV;
  });

  it('does not expose diagnostics for unknown production errors', () => {
    process.env.NODE_ENV = 'production';
    const { host, json } = createHost();

    new GlobalExceptionFilter().catch(new Error('database password leaked'), host);

    expect(json).toHaveBeenCalledWith({
      error: expect.not.objectContaining({ stack: expect.anything(), cause: expect.anything() }),
    });
    expect(json.mock.calls[0][0].error.message).toBe('服务器内部错误');
  });

  it('keeps diagnostics in non-production development responses', () => {
    process.env.NODE_ENV = 'development';
    const { host, json } = createHost();

    new GlobalExceptionFilter().catch(new Error('debug me'), host);

    expect(json.mock.calls[0][0].error.stack).toContain('debug me');
  });
});
