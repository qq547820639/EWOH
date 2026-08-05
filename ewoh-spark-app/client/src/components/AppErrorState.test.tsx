import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import AppErrorState, { sanitizeUserText } from './AppErrorState';

jest.mock('sonner', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

function render(element: React.ReactElement): string {
  return renderToStaticMarkup(<MemoryRouter>{element}</MemoryRouter>);
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

describe('AppErrorState (friendly, safe, actionable error view)', () => {
  it('renders phenomenon / impact / saved / next-step / trace fields', () => {
    const markup = render(
      <AppErrorState
        error={retryableError}
        impact="设备列表将无法展示。"
        saved={false}
      />,
    );
    // 现象、可能影响、数据是否已保存、后续操作、请求ID 五要素齐全
    expect(markup).toContain('现象');
    expect(markup).toContain('服务器暂时不可用');
    expect(markup).toContain('可能影响');
    expect(markup).toContain('设备列表将无法展示。');
    expect(markup).toContain('数据是否已保存');
    expect(markup).toContain('未保存');
    expect(markup).toContain('后续操作');
    expect(markup).toContain('请稍后重试');
    expect(markup).toContain('请求ID');
    expect(markup).toContain('req-abc-123');
    // 可重试错误展示「重试」按钮与复制按钮
    expect(markup).toContain('重试');
    expect(markup).toContain('复制诊断信息');
  });

  it('renders IPv6-free trace from headers when present', () => {
    const headerError = {
      response: {
        status: 500,
        headers: { 'x-trace-id': 'trace-xyz-9' },
        data: { error: { message: '内部错误' } },
      },
    };
    const markup = render(<AppErrorState error={headerError} />);
    expect(markup).toContain('trace-xyz-9');
  });

  it('distinguishes 401/403/409 with actionable guidance', () => {
    const unauthorized = render(
      <AppErrorState error={{ response: { status: 401, data: { error: { message: 'x' } } } }} />,
    );
    expect(unauthorized).toContain('重新登录后重试');

    const forbidden = render(
      <AppErrorState error={{ response: { status: 403, data: { error: { message: 'x' } } } }} />,
    );
    expect(forbidden).toContain('请联系管理员申请相应权限');

    const conflict = render(
      <AppErrorState error={{ response: { status: 409, data: { error: { message: 'x' } } } }} />,
    );
    expect(conflict).toContain('刷新加载最新数据');
  });

  it('SANITIZES raw stack / JSON / developer text so they never reach the DOM', () => {
    const stackError = new Error(
      'TypeError: Cannot read properties of undefined (reading "x")\n' +
        '    at render (C:/app/App.tsx:12:3)\n' +
        '    at ReactCompleteWork (react-dom.development.js:12345:7)\n' +
        '    at commitRoot (react-dom.development.js:9999:1) {"secretKey":"secret-value"}',
    );
    const markup = render(
      <AppErrorState
        error={stackError}
        impact={'堆栈泄漏:\n    at BadImpact (C:/secret.ts:1:1) {"inner":"blob"} '}
      />,
    );

    // 原始堆栈 / 文件路径 / JSON / 开发者内部符号 均不得出现
    expect(markup).not.toContain('TypeError');
    expect(markup).not.toContain('App.tsx');
    expect(markup).not.toContain('react-dom');
    expect(markup).not.toContain('secret-value');
    expect(markup).not.toContain('secretKey');
    expect(markup).not.toContain('BadImpact');
    expect(markup).not.toContain('secret.ts');
    expect(markup).not.toContain('{"');
    // 清洗后仍有一个用户可读的兜底现象
    expect(markup).toContain('操作失败');
  });
});

describe('sanitizeUserText', () => {
  it('strips stack frames, JSON and error type prefixes', () => {
    const out = sanitizeUserText(
      'TypeError: boom\n at fn (C:/a.ts:1:1)\n at g (C:/b.js:2:2) {"k":"v"}',
    );
    expect(out).not.toContain('TypeError');
    expect(out).not.toContain('a.ts');
    expect(out).not.toContain('b.js');
    expect(out).not.toContain('{"');
    expect(out).toContain('boom');
  });

  it('caps very long text and collapses whitespace', () => {
    const out = sanitizeUserText('  a'.repeat(300));
    expect(out.length).toBeLessThanOrEqual(161);
    expect(out).toContain('…');
  });

  it('returns empty string for non-string input', () => {
    expect(sanitizeUserText(undefined)).toBe('');
    expect(sanitizeUserText(null)).toBe('');
    expect(sanitizeUserText(42)).toBe('');
  });
});