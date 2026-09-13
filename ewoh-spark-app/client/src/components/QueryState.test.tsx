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
    // 文案优化（2026-08-19）：stale 态文案由“数据已过期”改为中性的“数据待更新”
    // （实为 react-query 缓存新鲜度，非业务同步状态），断言同步。
    expect(markup).toContain('数据待更新');
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

  it('R2-CC2-002: loading/empty 表面使用语义令牌（无字面 bg-white，dark 主题可读）', () => {
    const loading = renderWithRouter(
      <QueryState isLoading isError={false}>
        {children}
      </QueryState>,
    );
    expect(loading).toContain('bg-card');
    // 语义令牌 bg-card 存在、字面浅色 bg-white 不存在（2026-08-18 深色适配
    // 提交曾把本行误改为 not.toContain('bg-card')，与上一行自相矛盾）。
    expect(loading).not.toContain('bg-white');
    const empty = renderWithRouter(
      <QueryState isLoading={false} isError={false} isEmpty>
        {children}
      </QueryState>,
    );
    expect(empty).toContain('bg-card');
    expect(empty).not.toContain('bg-white');
  });

  // ── query 直传（2026-09-13 审计：页面漏传 isError 把"读不到"渲染成"不存在"）──

  describe('query 直传派生状态', () => {
    it('403 失败 + 空数据时渲染权限态，绝不渲染「暂无数据」', () => {
      const markup = renderWithRouter(
        <QueryState
          query={{
            isLoading: false,
            isError: true,
            error: { response: { status: 403, data: { error: { message: 'Forbidden' } } } },
          }}
          isEmpty
        >
          {children}
        </QueryState>,
      );
      // 这是本组件的核心不变量：读失败 ≠ 没有数据。
      expect(markup).not.toContain('暂无数据');
      expect(markup).toContain('权限不足');
    });

    it('isLoading 由 query 派生', () => {
      const markup = renderWithRouter(
        <QueryState query={{ isLoading: true }}>{children}</QueryState>,
      );
      expect(markup).toContain('正在加载数据');
      expect(markup).not.toContain('暂无数据');
    });

    it('isStale / dataUpdatedAt 由 query 派生（陈旧数据仍渲染上次内容）', () => {
      const updatedAt = new Date('2026-08-05T08:00:00Z').getTime();
      const markup = renderWithRouter(
        <QueryState query={{ isLoading: false, isError: false, isStale: true, dataUpdatedAt: updatedAt }}>
          {children}
        </QueryState>,
      );
      expect(markup).toContain('数据待更新');
      expect(markup).toContain('更新于');
      expect(markup).toContain('>content<');
    });

    it('显式 props 逐字段优先于 query（页面可覆盖特例）', () => {
      // query 说"加载中"，但页面显式声明 isLoading={false} → 按显式值渲染内容。
      const markup = renderWithRouter(
        <QueryState query={{ isLoading: true }} isLoading={false}>
          {children}
        </QueryState>,
      );
      expect(markup).not.toContain('正在加载数据');
      expect(markup).toContain('>content<');
    });

    it('显式 isError 与 query 的错误各自独立生效（错误优先于空态）', () => {
      const markup = renderWithRouter(
        <QueryState query={{ isLoading: false, isError: false }} isError error={{ status: 500 }} isEmpty>
          {children}
        </QueryState>,
      );
      expect(markup).not.toContain('暂无数据');
      expect(markup).toContain('复制诊断信息');
    });

    it('query 正常且非空时透传 children（不误判）', () => {
      const markup = renderWithRouter(
        <QueryState query={{ isLoading: false, isError: false }}>{children}</QueryState>,
      );
      expect(markup).toContain('>content<');
      expect(markup).not.toContain('暂无数据');
    });
  });
});