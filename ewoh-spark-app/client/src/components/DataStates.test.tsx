import { renderToStaticMarkup } from 'react-dom/server';
import DataStates from './DataStates';

jest.mock('sonner', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

function render(element: React.ReactElement): string {
  return renderToStaticMarkup(element);
}

describe('DataStates (partial / stale / degraded / offline)', () => {
  it('renders each health with its label', () => {
    expect(render(<DataStates health="partial" />)).toContain('部分数据缺失');
    expect(render(<DataStates health="stale" />)).toContain('数据已过期');
    expect(render(<DataStates health="degraded" />)).toContain('服务降级');
    expect(render(<DataStates health="offline" />)).toContain('离线');
  });

  it('renders message, detail and retry button', () => {
    const markup = render(
      <DataStates health="stale" message="列表已过期" detail="更新于 12:00" onRetry={() => {}} />,
    );
    expect(markup).toContain('列表已过期');
    expect(markup).toContain('更新于 12:00');
    expect(markup).toContain('重试');
  });

  it('sanitizes raw stack / JSON from message and detail', () => {
    const markup = render(
      <DataStates
        health="degraded"
        message={'降级原因:\n    at C:/bad.ts:1:1 {"a":"b"} '}
        detail={'at D:/secret.ts:2:2 {"k":"v"}'}
      />,
    );
    expect(markup).not.toContain('bad.ts');
    expect(markup).not.toContain('secret.ts');
    expect(markup).not.toContain('{"');
  });

  it('offline renders with alert role for assistive tech', () => {
    const markup = render(<DataStates health="offline" />);
    expect(markup).toContain('role="alert"');
  });
});