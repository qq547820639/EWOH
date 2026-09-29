/**
 * 试点链行为基线：进程内 E2E 应用的**资源生命周期**（真实 Nest + 真实 PostgreSQL）。
 *
 * TEST-01 登记时写的是"装配类测试的进程级注册不可重置，会改变其后路由用例行为"，
 * 但一直没落到**可观测**上。这条把它钉成一个可数的信号：
 * `startE2EApp()` 会为"这一个应用"安装进程级 PgFaultGuard（`process.on('uncaughtException'
 * /'unhandledRejection')`），而 jest 的 `--runInBand` 只按文件隔离**模块注册表**、
 * 不隔离 `process` ⇒ 一旦 disposer 被丢弃，应用早就关了，本 worker 后续所有文件的
 * 进程级异常语义却仍由那个已关闭的应用接管（连接类故障被记成"已恢复"而不是浮出为失败）。
 *
 * L-01 判据刻意用守卫自己的计数器 `pgProcessFaultSnapshot().count`，不用 listenerCount：
 * jest 自己也注册 `unhandledRejection` 监听器，用监听数会把它算进来而变成双因判据。
 * 前提断言（探针可发性）：注入的伪故障必须真被分类器判成"连接类可恢复"——
 * 否则计数永远不动，这条用例就会假绿。
 */
import { resolveE2EConfig } from '../helpers/e2e-config';
import {
  cleanupE2EFixture,
  connectOwner,
  createE2EFixture,
  type E2EFixture,
  type OwnerSql,
} from '../helpers/e2e-db';
import { startE2EApp, type E2EAppHandle } from '../helpers/e2e-app';
import {
  classifyProcessFault,
  pgProcessFaultSnapshot,
} from '../../server/database/standalone.provider';

const config = resolveE2EConfig();

/** postgres 驱动自有的连接级错误码（分类器刻意只收驱动码，不收 ECONNRESET 之类通用 socket 码）。 */
const pgConnectionFault = (): Error & { code: string } =>
  Object.assign(new Error('Connection closed, maybe because the connected socket was closed'), {
    code: 'CONNECTION_CLOSED',
  });

(config ? describe : describe.skip)(
  '进程内 E2E 应用生命周期 E2E（真实 PostgreSQL）',
  () => {
    let owner: OwnerSql;
    let fixture: E2EFixture;
    let handle: E2EAppHandle | undefined;

    beforeAll(async () => {
      owner = await connectOwner(config!.ownerDatabaseUrl);
    });

    afterEach(async () => {
      try {
        await handle?.close();
      } finally {
        handle = undefined;
        if (fixture) await cleanupE2EFixture(owner, fixture);
        fixture = undefined as unknown as E2EFixture;
      }
    });

    afterAll(async () => {
      await owner?.end();
    });

    it('L-01 应用关闭后，属于它进程级故障守卫也必须退出（TEST-01）', async () => {
      fixture = await createE2EFixture(owner);
      handle = await startE2EApp(config!, fixture.orgA.id);
      await handle.close();
      // close() 之后 handle 已收尾；这里再显式置空，避免 afterEach 重复关闭。
      handle = undefined;

      const fault = pgConnectionFault();
      const classification = classifyProcessFault(fault);
      // 前提断言：分类器必须把这条判成"连接类可恢复"，否则本用例探针根本不会触发。
      expect(classification.recoverable).toBe(true);
      expect(classification.kind).toBe('pg-connection');

      const before = pgProcessFaultSnapshot().count;
      process.emit('unhandledRejection', fault, undefined as unknown as Promise<unknown>);
      const after = pgProcessFaultSnapshot().count;
      console.log(
        `[L-01] 关闭后 emit 连接类故障 → 计数 ${before}→${after} `
          + `kind=${classification.kind} 监听数 uncaughtException=${process.listenerCount('uncaughtException')} `
          + `unhandledRejection=${process.listenerCount('unhandledRejection')}`,
      );
      // 守卫若活过了应用，这条故障会被它记成"已恢复"（计数 +1）——
      // 也就是一个已经关掉的进程内应用，仍在替本 worker 后面的所有文件决定
      // "这个异常要不要吞"。修复后计数必须不动，回到 Node 默认语义。
      expect(after).toBe(before);
    });
  },
);
