import { renderToStaticMarkup } from 'react-dom/server';
import PageSkeleton from './PageSkeleton';

describe('PageSkeleton (route Suspense fallback)', () => {
  it('renders a skeleton page instead of a bare loading spinner', () => {
    const markup = renderToStaticMarkup(<PageSkeleton />);
    expect(markup).toContain('data-slot="skeleton"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-busy="true"');
    // 骨架屏不应退化为裸文本「加载中...」spinner
    expect(markup).not.toContain('加载中...');
  });

  it('reserves page content space with multiple skeleton blocks', () => {
    const markup = renderToStaticMarkup(<PageSkeleton />);
    const skeletonCount = markup.split('data-slot="skeleton"').length - 1;
    expect(skeletonCount).toBe(6);
  });
});