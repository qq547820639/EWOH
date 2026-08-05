import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import ErrorState from './ErrorState';

jest.mock('sonner', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

function render(error: unknown, onRetry?: () => void): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <ErrorState error={error} onRetry={onRetry} />
    </MemoryRouter>,
  );
}

const retryableError = {
  response: {
    status: 503,
    data: {
      error: {
        errorCode: 'SERVER_ERROR',
        message: '服务器暂时不可用',
        requestId: 'req-abc-123',
        retryable: true,
        recommendedAction: '请稍后重试',
      },
    },
  },
};

const nonRetryableError = {
  response: {
    status: 403,
    data: {
      error: {
        errorCode: 'PERMISSION_DENIED',
        message: '无权限访问该资源',
        requestId: 'req-forbid-9',
        retryable: false,
        recommendedAction: '请联系管理员开通权限',
      },
    },
  },
};

describe('ErrorState (unified actionable error UI)', () => {
  it('renders requestId, copy affordance, retryable badge, and recommendedAction', () => {
    const markup = render(retryableError, jest.fn());
    expect(markup).toContain('req-abc-123');
    expect(markup).toContain('复制诊断信息');
    expect(markup).toContain('可安全重试');
    expect(markup).toContain('请稍后重试');
    // 可重试错误展示「重试」按钮
    expect(markup).toContain('重试');
  });

  it('does NOT show a retry button for a non-retryable error', () => {
    const markup = render(nonRetryableError, jest.fn());
    expect(markup).toContain('req-forbid-9');
    expect(markup).toContain('不可重试');
    expect(markup).toContain('请联系管理员开通权限');
    // 即使传入 onRetry，非可重试也不渲染「重试」按钮
    expect(markup).not.toContain('>重试</button>');
    // 复制诊断信息始终可用
    expect(markup).toContain('复制诊断信息');
  });
});