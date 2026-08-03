import {
  BadRequestException,
  HttpException,
  HttpStatus,
  type ArgumentsHost,
} from '@nestjs/common';
import { GlobalExceptionFilter } from '../../../server/common/filters/exception.filter';

describe('GlobalExceptionFilter', () => {
  function createHost() {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const setHeader = jest.fn();
    const getHeader = jest.fn().mockReturnValue(undefined);
    const response = { headersSent: false, status, setHeader, getHeader };
    const request = { headers: {}, id: 'req-test' };
    const host = {
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
    } as unknown as ArgumentsHost;
    return { host, status, json, setHeader, getHeader, request };
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

  it('adds requestId, retryable, and recommendedAction to every error response', () => {
    process.env.NODE_ENV = 'production';
    const { host, json, setHeader } = createHost();

    new GlobalExceptionFilter().catch(new BadRequestException('bad payload'), host);

    expect(json.mock.calls[0][0].error).toEqual(
      expect.objectContaining({
        code: 'BAD_REQUEST',
        errorCode: 'BAD_REQUEST',
        requestId: 'req-test',
        retryable: false,
        recommendedAction: '请检查请求参数后重试',
      }),
    );
    expect(setHeader).toHaveBeenCalledWith('x-request-id', 'req-test');
  });

  it('marks server and rate-limit errors as retryable', () => {
    process.env.NODE_ENV = 'production';
    const { host, json } = createHost();

    new GlobalExceptionFilter().catch(
      new HttpException('slow down', HttpStatus.TOO_MANY_REQUESTS),
      host,
    );

    expect(json.mock.calls[0][0].error.retryable).toBe(true);
    expect(json.mock.calls[0][0].error.recommendedAction).toBe('请稍后重试');
  });

  it('falls back to a generated request id when no id header exists', () => {
    process.env.NODE_ENV = 'production';
    const { host, json, request } = createHost();
    request.headers = {};
    request.id = undefined;

    new GlobalExceptionFilter().catch(new Error('boom'), host);

    expect(json.mock.calls[0][0].error.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('correlates requestId with the tracing x-trace-id response header', () => {
    process.env.NODE_ENV = 'production';
    const { host, json, getHeader } = createHost();
    getHeader.mockReturnValue('trace-abc');

    new GlobalExceptionFilter().catch(new Error('boom'), host);

    expect(json.mock.calls[0][0].error.requestId).toBe('trace-abc');
    expect(getHeader).toHaveBeenCalledWith('x-trace-id');
  });

  it('maps unmapped HTTP statuses to a stable errorCode instead of undefined', () => {
    process.env.NODE_ENV = 'production';
    const { host, json } = createHost();

    new GlobalExceptionFilter().catch(
      new HttpException('gateway timeout', HttpStatus.GATEWAY_TIMEOUT),
      host,
    );

    expect(json.mock.calls[0][0].error.errorCode).toBe('INTERNAL_ERROR');
    expect(json.mock.calls[0][0].error.retryable).toBe(true);
  });

  it('prefers the server-generated tracing id over client request headers', () => {
    process.env.NODE_ENV = 'production';
    const { host, json, getHeader, request } = createHost();
    getHeader.mockReturnValue('server-trace');
    request.headers = { 'x-request-id': 'client-req' };

    new GlobalExceptionFilter().catch(new Error('boom'), host);

    expect(json.mock.calls[0][0].error.requestId).toBe('server-trace');
  });

  it('does not serialize raw HttpException response objects into details', () => {
    process.env.NODE_ENV = 'production';
    const { host, json } = createHost();

    new GlobalExceptionFilter().catch(
      new BadRequestException({ message: 'bad payload', password: 'secret' }),
      host,
    );

    expect(json.mock.calls[0][0].error.details).toBeUndefined();
    expect(JSON.stringify(json.mock.calls[0][0])).not.toContain('secret');
  });
});
