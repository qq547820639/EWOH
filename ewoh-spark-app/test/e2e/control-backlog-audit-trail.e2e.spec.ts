/**
 * F-16 常驻回归：后台（无请求事务）留痕到底有没有落进审计链（真实 Nest + 真实 PostgreSQL）。
 *
 * 起因（V92 实测，§5.3ao）：`control-delivery-backlog.worker.ts` 的"巡检失败"审计写在
 * ALS 之外、`orgId: ''`，而 `ewoh_append_audit_log` 对 org_id 为 NULL 的行要求
 * `app.is_global_admin='true'`，否则抛 42501；外层 `.catch(() => undefined)` 又把它吞掉。
 * ⇒ 修复前这条留痕**一条都没落过库**，运维只剩进程日志可看。
 *
 * 本文件只钉两条（都可翻）：
 *  BA-01 机制前提：不带上下文直接追加 ⇒ 抛 42501 且库里 0 行。
 *      （这条是"为什么必须自建上下文"的依据；若哪天函数放宽了，本条会红，结论要重写。）
 *  BA-02 修复面：同一调用经 `systemGlobalAdminTransaction` ⇒ 恰好 1 行，
 *      字段与 worker 所用形状一致（action/actor/entity 三元组照抄生产调用点）。
 * 没有 BA-01，BA-02 的"1 行"可能只是探针自己写得进去；两条互为对照。
 */
import { randomUUID } from 'node:crypto';
import { resolveE2EConfig } from '../helpers/e2e-config';
import {
  cleanupE2EFixture,
  connectOwner,
  createE2EFixture,
  type E2EFixture,
  type OwnerSql,
} from '../helpers/e2e-db';
import { startE2EApp, type E2EAppHandle } from '../helpers/e2e-app';
import { AuditService } from '../../server/modules/shared/audit.service';
import { RequestDatabaseContext } from '../../server/database/request-database-context';

const config = resolveE2EConfig();
const WORKER_ACTION = 'control.delivery_backlog_sweep_failed';

(config ? describe : describe.skip)('后台审计留痕 E2E（F-16，真实 PostgreSQL）', () => {
  let owner: OwnerSql;
  let fixture: E2EFixture;
  let handle: E2EAppHandle;
  const runId = randomUUID().slice(0, 8);

  beforeAll(async () => {
    owner = await connectOwner(config!.ownerDatabaseUrl);
  });

  afterEach(async () => {
    try {
      await handle?.close();
    } finally {
      handle = undefined as unknown as E2EAppHandle;
      if (fixture) await cleanupE2EFixture(owner, fixture);
      fixture = undefined as unknown as E2EFixture;
    }
  });

  afterAll(async () => {
    await owner?.end();
  });

  async function boot(): Promise<void> {
    fixture = await createE2EFixture(owner);
    handle = await startE2EApp(config!, fixture.orgA.id);
  }

  /** 与生产调用点逐字段同形的入参（只有 reason 带本轮标记，便于精确数行）。 */
  const workerEntry = (marker: string) => ({
    actorId: 'system:control-backlog',
    orgId: '',
    action: WORKER_ACTION,
    entityType: 'control_command',
    entityId: 'worker',
    reason: marker,
  });

  const rowsOf = async (marker: string) => {
    const res = await owner`select count(*)::int as n from public.ewoh_audit_log where reason = ${marker}`;
    return Number(res[0]?.n ?? -1);
  };

  it('BA-01 无上下文的后台留痕：抛 42501 且库里 0 行（这就是 F-16 的成因）', async () => {
    await boot();
    const audit = handle.app.get(AuditService);
    const marker = `F16-BA01-${runId}`;
    let code = '';
    let message = '';
    await audit.appendAuditLog(workerEntry(marker)).catch((error: unknown) => {
      // drizzle 把驱动异常包成 "Failed query:"，SQLSTATE 在 cause 上；
      // 只读顶层 .code 会恒为 undefined（V92 探针第一版就踩了这个）。
      const e = error as { code?: string; cause?: { code?: string; message?: string } };
      code = e.code ?? e.cause?.code ?? '';
      message = String(e.cause?.message ?? error);
    });
    expect(code).toBe('42501');
    expect(message).toContain('global audit records require global administrator context');
    expect(await rowsOf(marker)).toBe(0);
  }, 120_000);

  it('BA-02 经 systemGlobalAdminTransaction 的同一调用：恰好落 1 行', async () => {
    await boot();
    const audit = handle.app.get(AuditService);
    const rdc = handle.app.get(RequestDatabaseContext);
    const marker = `F16-BA02-${runId}`;
    await rdc.systemGlobalAdminTransaction(() => audit.appendAuditLog(workerEntry(marker)));
    expect(await rowsOf(marker)).toBe(1);
    const row = await owner`select actor_id as "actorId", action, entity_type as "entityType",
      entity_id as "entityId", risk_level as "riskLevel"
      from public.ewoh_audit_log where reason = ${marker}`;
    expect(row[0]).toMatchObject({
      actorId: 'system:control-backlog',
      action: WORKER_ACTION,
      entityType: 'control_command',
      entityId: 'worker',
    });
  }, 120_000);
});
