import { parseError, authzGuidance } from './errorContract';

describe('parseError', () => {
  it('解析权限不足错误（403/PERMISSION_DENIED）', () => {
    const err = {
      response: {
        status: 403,
        data: {
          error: {
            errorCode: 'PERMISSION_DENIED',
            code: 'PERMISSION_DENIED',
            message: '无权限访问该资源',
            requestId: 'req-123',
            recommendedAction: '请联系管理员开通权限',
          },
        },
      },
    };
    const parsed = parseError(err);
    expect(parsed.kind).toBe('permission');
    expect(parsed.code).toBe('PERMISSION_DENIED');
    expect(parsed.requestId).toBe('req-123');
    expect(parsed.recommendedAction).toBe('请联系管理员开通权限');
    expect(parsed.message).toBe('无权限访问该资源');
  });

  it('解析业务校验失败（422/BUSINESS_VALIDATION）', () => {
    const err = {
      response: {
        status: 422,
        data: {
          error: {
            errorCode: 'BUSINESS_VALIDATION',
            message: '工单号不能为空',
            requestId: 'req-456',
            recommendedAction: '请补充工单号',
          },
        },
      },
    };
    const parsed = parseError(err);
    expect(parsed.kind).toBe('validation');
    expect(parsed.code).toBe('BUSINESS_VALIDATION');
    expect(parsed.recommendedAction).toBe('请补充工单号');
    expect(parsed.requestId).toBe('req-456');
  });

  it('解析连接失败（网络错误，无 response）', () => {
    const err = { code: 'ERR_NETWORK', message: 'Network Error' };
    const parsed = parseError(err);
    expect(parsed.kind).toBe('connection');
    expect(parsed.code).toBe('CONNECTION_ERROR');
  });

  it('解析服务器故障（500，无 error 字段时按状态推断）', () => {
    const err = { response: { status: 500, data: { error: { message: '服务器内部错误' } } } };
    const parsed = parseError(err);
    expect(parsed.kind).toBe('server');
    expect(parsed.code).toBe('SERVER_ERROR');
    expect(parsed.recommendedAction).toBe('请稍后重试；如持续失败请联系管理员');
    expect(parsed.message).toBe('服务器内部错误');
  });

  it('无字段回退：普通 Error 推断为 unknown', () => {
    const parsed = parseError(new Error('未知错误'));
    expect(parsed.kind).toBe('unknown');
    expect(parsed.code).toBe('UNKNOWN_ERROR');
    expect(parsed.requestId).toBe('');
    expect(parsed.message).toBe('未知错误');
  });

  it('retryable: 后端显式声明优先，覆盖类别推断', () => {
    const err = {
      response: {
        status: 503,
        data: {
          error: {
            errorCode: 'SERVER_ERROR',
            message: '稍后可重试',
            retryable: true,
          },
        },
      },
    };
    const parsed = parseError(err);
    expect(parsed.kind).toBe('server');
    expect(parsed.retryable).toBe(true);
  });

  it('retryable: 权限/校验类默认不可重试', () => {
    expect(parseError({ response: { status: 403, data: { error: { message: 'x' } } } }).retryable).toBe(false);
    expect(parseError({ response: { status: 422, data: { error: { message: 'x' } } } }).retryable).toBe(false);
  });

  it('retryable: 连接/服务器/未知类默认可重试', () => {
    expect(parseError({ code: 'ERR_NETWORK', message: 'Network Error' }).retryable).toBe(true);
    expect(parseError({ response: { status: 500, data: { error: { message: 'x' } } } }).retryable).toBe(true);
    expect(parseError(new Error('未知')).retryable).toBe(true);
  });

  it('携带 HTTP 状态码到 status 字段，供 401/403/409 细分', () => {
    expect(parseError({ response: { status: 401, data: { error: { message: 'x' } } } }).status).toBe(401);
    expect(parseError({ response: { status: 403, data: { error: { message: 'x' } } } }).status).toBe(403);
    expect(parseError({ response: { status: 409, data: { error: { message: 'x' } } } }).status).toBe(409);
    expect(parseError({ code: 'ERR_NETWORK', message: 'Network Error' }).status).toBeUndefined();
  });

  it('authzGuidance 区分 401/403/409 并给出可操作指导', () => {
    expect(authzGuidance(401)?.nextStep).toContain('重新登录');
    expect(authzGuidance(403)?.nextStep).toContain('申请相应权限');
    expect(authzGuidance(409)?.nextStep).toContain('刷新加载最新数据');
    expect(authzGuidance(500)).toBeNull();
    expect(authzGuidance(undefined)).toBeNull();
  });
});