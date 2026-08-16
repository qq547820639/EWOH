/* 静态页面级渲染 smoke（NO-13f / ADR-055：工厂操作台页面渲染测试补强）。
 *
 * Forbidden（403 无权限）与 NotFound（404）——真实页面渲染 + 路由上下文
 * （MemoryRouter）+ auth 依赖 mock（renderToStaticMarkup 同栈）。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import Forbidden from './Forbidden/Forbidden';
import NotFound from './NotFound/NotFound';

jest.mock('../lib/auth', () => ({
  getAuthUser: () => ({ username: 'op-1' }),
  revokeSession: jest.fn(),
}));

describe('静态页面级渲染 smoke（NO-13f / ADR-055）', () => {
  it('Forbidden：403 标题 + 当前账号 + 返回/退出动作', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <Forbidden />
      </MemoryRouter>,
    );
    expect(markup).toContain('403 无权限');
    expect(markup).toContain('op-1');
    expect(markup).toContain('退出登录');
  });

  it('NotFound：404 + 返回指挥中心链接（href 指向 /command-center）', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <NotFound />
      </MemoryRouter>,
    );
    expect(markup).toContain('404');
    expect(markup).toContain('返回指挥中心');
    expect(markup).toContain('/command-center');
  });
});
