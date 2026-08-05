import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import QueryState from './QueryState';

jest.mock('sonner', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

function renderWithRouter(node: React.ReactNode): string {
  return renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
}

const children = <div>content</div>;

describe('QueryState', () => {
  it('renders an error state (not empty) when the query errors', () => {
    const markup = renderWithRouter(
      <QueryState isLoading={false} isError isEmpty onRefresh={() => {}}>
        {children}
      </QueryState>,
    );
    // 错误优先于空态：绝不渲染「暂无数据」
    expect(markup).not.toContain('暂无数据');
    // 解析出的错误终端（copy 按钮）应出现
    expect(markup).toContain('复制诊断信息');
  });

  it('renders empty state only when there is no error', () => {
    const markup = renderWithRouter(
      <QueryState isLoading={false} isError={false} isEmpty>
        {children}
      </QueryState>,
    );
    expect(markup).toContain('暂无数据');
    expect(markup).not.toContain('复制诊断信息');
  });

  it('shows stale data with a stale badge and update timestamp', () => {
    const updatedAt = new Date('2026-08-05T08:00:00Z').getTime();
    const markup = renderWithRouter(
      <QueryState isLoading={false} isError={false} isStale updatedAt={updatedAt}>
        {children}
      </QueryState>,
    );
    expect(markup).toContain('数据已过期');
    expect(markup).toContain('更新于');
    // Stale 时仍渲染上次成功的数据内容
    expect(markup).toContain('>content<');
  });

  it('still renders children when data is fresh and non-empty', () => {
    const markup = renderWithRouter(
      <QueryState isLoading={false} isError={false} isStale={false}>
        {children}
      </QueryState>,
    );
    expect(markup).toContain('>content<');
    expect(markup).not.toContain('暂无数据');
  });
});