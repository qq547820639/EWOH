/* R-4 边界回归（2026-09-13 自查）：启动期失败必须退出，不得被连接故障兜底变成僵尸。
 *
 * 现场（实测复现）：main.ts 原来是裸 `bootstrap()`——启动期任何以
 * unhandledRejection 形态到达顶层的失败，只要带着连接错误码
 * （CONNECTION_CLOSED 等，postgres 驱动的 init 查询失败正是这种形态），
 * 就会被 installPgConnectionFaultGuard 接管成"进程继续运行"。此时端口尚未监听：
 * 进程活着但不服务也不退出——健康检查起不来、编排层等不到退出码、
 * 重启循环被吞（僵尸进程）。
 *
 * 本测试锁定 exitOnBootstrapFailure 的两条不变量：
 *   ① bootstrap 拒绝（无论是否连接类错误码）→ 必须以退出码 1 终止并留痕；
 *   ② bootstrap 正常完成 → 绝不触发退出（服务期兜底语义不受影响）。
 */
/// <reference types="jest" />

jest.mock('@nestjs/core', () => ({ NestFactory: {} }));
jest.mock('@lark-apaas/fullstack-nestjs-core', () => ({
  configureApp: jest.fn(),
}));
jest.mock('hbs', () => ({ __express: jest.fn() }));
jest.mock('path', () => ({
  ...jest.requireActual('path'),
  join: jest.fn(() => 'dist/client'),
}));
jest.mock('./app.module', () => ({ AppModule: class AppModule {} }));
jest.mock('./standalone-main', () => ({
  bootstrapStandalone: jest.fn(),
}));

const exitSpy = jest
  .spyOn(process, 'exit')
  // process.exit 的签名返回 never；测试里用可复位的替身（不需要真实终止）。
  .mockImplementation((() => undefined) as never);
const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

import { exitOnBootstrapFailure } from './main';

/** catch 回调在 microtask 里执行：让一拍再断言（同步断言会假阴性）。 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('R-4 边界：bootstrap 失败必须退出（不留僵尸进程）', () => {
  afterEach(() => {
    exitSpy.mockClear();
    errorSpy.mockClear();
  });

  afterAll(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('连接类错误码拒绝 → exit 1（修复前：守卫接管成"进程继续运行"= 僵尸）', async () => {
    const bootError = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
      code: 'CONNECTION_CLOSED',
    });
    exitOnBootstrapFailure(Promise.reject(bootError));
    await flush();
    expect(exitSpy).toHaveBeenCalledWith(1);
    // 必须留痕：僵尸进程最难排查的点就是"没有任何输出"。
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('启动失败'),
      expect.stringContaining('ECONNREFUSED'),
    );
  });

  it('非连接类启动失败（配置错误/端口占用）→ 同样 exit 1（语义不分类，启动失败只有退出一条路）', async () => {
    exitOnBootstrapFailure(Promise.reject(new Error('EADDRINUSE: port 3000 in use')));
    await flush();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('启动失败'),
      expect.stringContaining('EADDRINUSE'),
    );
  });

  it('bootstrap 正常完成 → 不退出（服务期兜底语义不受影响）', async () => {
    exitOnBootstrapFailure(Promise.resolve());
    await flush();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
