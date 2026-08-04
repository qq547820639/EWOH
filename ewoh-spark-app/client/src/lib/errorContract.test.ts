import { parseError } from './errorContract';

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
});