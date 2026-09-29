/**
 * 执行边界授权的「有效期锚点」与前端重投影（V107，PROJ-01 末格）。
 *
 * 普查（V102）把这一格写成"前端直接读聚合列"。本轮先复核那句话：登记的两个位点读的都**不是**
 * 聚合列，而是"服务端已算好的字段 + 浏览器里再投影一次状态"——
 *   · `client/src/pages/ApprovalConsole/approvalConsoleLogic.ts` 的 `authorizationState()`：
 *     用 `status / expired / remainingMs` 重算 usable / expiring-soon / expired；
 *   · `client/src/pages/FieldOperations/fieldOperationsLogic.ts` 的 `OPEN_EXECUTION_STATUSES`：
 *     在前端硬编码一份"未终结"执行词表。
 * 复核之后真正值得测的有两件：**锚点**与**不变量**。
 *
 * 走读形状（已证实·读码）：`approval-persistence.service.ts:293-310` 把"通过时间"取成
 * `row.updatedAt`，有效期 = 通过时间 + 24h；而审批的批准动作只 `.set({ status })`
 * （`:589-591`，另有 `:695` bypass、`:756` cancel 同样只改 status），列定义没有 `$onUpdate`，
 * 迁移里也没有维护 `_updated_at` 的触发器 ⇒ `_updated_at` 事实上停在**建行时刻**。
 * 于是"自批准起 24h"这句话与实际算出的"自创建起 24h"不是一回事：pending 多久就烧掉多久。
 *
 * 本例四臂：AV-01 锚点取证（不造假，只用真实 create→approve 之间的时间差）；
 * AV-02 后果（把这条自己建的行时间前移 25h ⇒ 刚批完就"出生即过期"）；
 * AV-03 前端重投影所依赖的字段不变量（`expired ⇔ remainingMs` 的符号关系，一次同刻派生）；
 * AV-04 读侧词表对照（前端硬编码集合 vs 服务端封闭词表）。
 * 探针阶段：先把读数打全，断言只放已能自证的形状。
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolveE2EConfig } from '../helpers/e2e-config';
import {
  cleanupE2EFixture,
  connectOwner,
  createE2EFixture,
  seedSchedulerFixture,
  type E2EFixture,
  type OwnerSql,
  type SchedulerFixture,
} from '../helpers/e2e-db';
import { startE2EApp, type E2EAppHandle } from '../helpers/e2e-app';
import { apiRequest, jsonHeaders, login } from '../helpers/e2e-http';

const config = resolveE2EConfig();
const ENTITY_TYPE = 'task_capability_change';
const VALIDITY_MS = 24 * 60 * 60 * 1000;

interface AuthorizationItem {
  approvalId: string;
  status: string;
  createdAt: string | null;
  approvedAt: string | null;
  expiresAt: string | null;
  expired: boolean;
  remainingMs: number | null;
}

(config ? describe : describe.skip)(
  '执行边界授权有效期锚点 E2E（V107：通过时间到底锚在哪一刻）',
  () => {
    let owner: OwnerSql;
    let fixture: E2EFixture;
    let resources: SchedulerFixture;
    let handle: E2EAppHandle;
    let creatorToken = '';
    let adminToken = '';
    const runId = randomUUID().slice(0, 8);
    let approvalId = '';
    let approveCallMs = 0;
    let viewApprovedMsFromAv01 = 0;
    let createdMsFromAv01 = 0;

    beforeAll(async () => {
      owner = await connectOwner(config!.ownerDatabaseUrl);
      fixture = await createE2EFixture(owner);
      resources = await seedSchedulerFixture(owner, fixture.orgA.id);
      process.env.EWOH_SOLVER_ACTIVATION = 'OFF';
      handle = await startE2EApp(config!, fixture.orgA.id);
      const creator = await login(handle.baseUrl, fixture.approverA.username, fixture.approverA.password);
      expect(creator.status).toBe(201);
      creatorToken = creator.body.accessToken;
      const admin = await login(
        handle.baseUrl, process.env.EWOH_E2E_ADMIN_USER ?? 'admin', process.env.EWOH_E2E_ADMIN_PASS ?? '',
      );
      expect(admin.status).toBe(201);
      adminToken = admin.body.accessToken;
    }, 180_000);

    afterAll(async () => {
      try {
        await handle?.close();
      } finally {
        if (fixture && owner) await cleanupE2EFixture(owner, fixture);
      }
      await owner?.end();
    });

    async function authorizations(): Promise<AuthorizationItem[]> {
      const res = await apiRequest<AuthorizationItem[]>(handle.baseUrl, '/api/approvals/authorizations', {
        headers: jsonHeaders(creatorToken),
      });
      expect(res.status).toBe(200);
      return Array.isArray(res.body) ? res.body : [];
    }

    const mine = async (items: AuthorizationItem[]) =>
      items.find((i) => i.approvalId === approvalId);

    it('AV-01 锚点取证：通过时间=建行时刻，pending 的时长直接从 24h 里扣掉', async () => {
      const created = await apiRequest<{ id?: string; steps?: { id: string }[] }>(
        handle.baseUrl,
        '/api/approvals',
        {
          method: 'POST',
          headers: jsonHeaders(creatorToken),
          body: JSON.stringify({
            entityType: ENTITY_TYPE,
            entityId: resources.taskId,
            roles: ['safety_admin'],
            subject: {
              objectType: ENTITY_TYPE,
              objectId: resources.taskId,
              title: `e2e AV-01 ${runId}`,
              summary: `e2e（run=${runId}）有效期锚点取证`,
              metrics: { relaxedHighRiskCapabilities: ['lift'], resultingDeviceCapabilities: ['AGV-01'] },
            },
          }),
        },
      );
      console.log(`[AV-01] create http=${created.status} body=${JSON.stringify(created.body).slice(0, 200)}`);
      expect(created.status).toBe(201);
      approvalId = String(created.body.id);
      const stepId = String(created.body.steps?.[0]?.id);
      expect(stepId).not.toBe('undefined');

      // 真实等待：让"创建"与"批准"之间有可测的间隔（不造假数据，只是让时钟走）。
      await new Promise((r) => setTimeout(r, 1_600));
      const approved = await apiRequest(
        handle.baseUrl, `/api/approvals/${approvalId}/steps/${stepId}/state?action=approve`,
        { method: 'POST', headers: jsonHeaders(adminToken), body: JSON.stringify({ reason: 'e2e AV-01 复核通过' }) },
      );
      approveCallMs = Date.now();
      expect([200, 201]).toContain(approved.status);

      const item = await mine(await authorizations());
      expect(item).toBeDefined();
      const it = item as AuthorizationItem;
      console.log(
        `[AV-01] status=${it.status} createdAt=${String(it.createdAt)} approvedAt=${String(it.approvedAt)} `
        + `expiresAt=${String(it.expiresAt)} expired=${String(it.expired)} remainingMs=${String(it.remainingMs)}`,
      );
      const createdMs = it.createdAt ? Date.parse(it.createdAt) : 0;
      const approvedMs = it.approvedAt ? Date.parse(it.approvedAt) : 0;
      const expiresMs = it.expiresAt ? Date.parse(it.expiresAt) : 0;
      // 读数先落到共享变量，再进判据：V181 实测——旧写法把赋值放在断言之后，AV-01 一红，
      // AV-05 就拿 undefined 当"通过时间"（读出 1970-01-01），一次抖动变成两条红、且第二条看不出原告。
      viewApprovedMsFromAv01 = approvedMs;
      createdMsFromAv01 = createdMs;
      console.log(
        `[AV-01] 批准动作发生在 ${new Date(approveCallMs).toISOString()}；`
        + `台账给的"通过时间"比它早 ${(approveCallMs - approvedMs)}ms；`
        + `expiresAt-approvedAt=${expiresMs - approvedMs}ms、expiresAt-批准动作=${approveCallMs ? expiresMs - approveCallMs : 0}ms`,
      );
      // V181 改判据（不改判的语义，只去掉运气常数）：
      // 旧写法 ① |approvedMs-createdMs| ≤ 2ms。而同一棵树两次重放四遍实测到的刻差是
      // −1 / −3 / −2 / −2 ms（视图的 approvedAt 恒**早于** createdAt，"两列精度不同的 1ms 级舍入差"
      // 这个说法当场作废）⇒ 阈值落在自己的观测分布里，红不红取决于机器快慢，不取决于"锚在哪一刻"。
      // 现在用**用例自己造出来的分辨窗口**做尺度：锚在"建行"这一侧 ⇔ 距建行的刻差 ≪ 距批准动作的间隔
      // （两个假说相差 1.6s，判据不需要毫秒常数）。
      const span = approveCallMs - createdMs;
      expect(span).toBeGreaterThanOrEqual(1_500); // 前提：故意造的分辨窗口真在（没造出来就没在测这件事）
      console.log(
        `[AV-01] 视图内部刻差 approvedAt-createdAt=${approvedMs - createdMs}ms`
        + `｜分辨窗口 span(批准动作-建行)=${span}ms ⇒ 判据尺度 span/4=${Math.floor(span / 4)}ms`,
      );
      // ① "通过时间"取的是建行这一侧的时刻，而不是批准动作发生的时刻；
      expect(Math.abs(approvedMs - createdMs)).toBeLessThanOrEqual(Math.floor(span / 4));
      // ①' 同一条判据的反面：若哪天锚被改到批准动作那一刻，这条必红（①/①' 合起来才有分辨力）；
      expect(approveCallMs - approvedMs).toBeGreaterThanOrEqual(Math.floor((span * 3) / 4));
      // ③ 有效期整 24h 从那个锚点起算 ⇒ 留给使用者的不足 24h（pending 多久烧多久）。
      expect(expiresMs - approvedMs).toBe(VALIDITY_MS);
      expect(expiresMs - approveCallMs).toBeLessThan(VALIDITY_MS - 1_000);
    }, 240_000);

    /**
     * AV-02 后果取证：把**本例自己刚建的**那条实例行的时间戳前移 25h（一次性隔离集群内的
     * 前提操作，等价于"这份授权挂了 25h 才被批准"），再读授权视图。
     * 它测的不是"过期会不会发生"（那当然会），而是**过期判定的锚点在哪**：
     * 批准动作刚刚发生，视图却报"已过期、剩余 0"。
     */
    it('AV-02 后果：刚批准完的授权，视图可以是"出生即过期"', async () => {
      expect(approvalId).not.toBe('');
      await owner.unsafe(
        'update public.ewoh_event set _created_at = now() - interval \'25 hours\', '
        + '_updated_at = now() - interval \'25 hours\' where event_id = $1',
        [approvalId],
      );
      const item = await mine(await authorizations());
      const it = item as AuthorizationItem;
      console.log(
        `[AV-02] 时间前移 25h 后：status=${it.status} expired=${String(it.expired)} `
        + `remainingMs=${String(it.remainingMs)} approvedAt=${String(it.approvedAt)}`,
      );
      // 批准这个事实没变（仍是 approved），变的只是锚点与当下的差值。
      expect(it.status).toBe('approved');
      expect(it.expired).toBe(true);
      // 前端 `authorizationState` 的第一分支就是 `a.expired` ⇒ 这里会渲染成"已过期"。
      expect(it.remainingMs).toBe(0);
    }, 240_000);

    it('AV-03 不变量：expired 与 remainingMs 由同一次 nowMs 派生（前端重投影只依赖这一条）', async () => {
      const items = await authorizations();
      const boundary = items.filter((i) => i.status === 'approved');
      console.log(`[AV-03] 窗口内 approved 授权 ${boundary.length} 条`);
      expect(boundary.length).toBeGreaterThan(0);
      for (const i of boundary) {
        console.log(
          `[AV-03]   ${i.approvalId} expired=${String(i.expired)} remainingMs=${String(i.remainingMs)}`,
        );
        // ① 绝不为负（`:310` 的 Math.max(0, …)）——客户端把 remainingMs<=0 归到 expiring-soon，
        //    负值会让"已过期"被显示成"还剩 -X"。
        expect(Number(i.remainingMs ?? 0)).toBeGreaterThanOrEqual(0);
        // ② 判过期的与"剩余为 0"必须同时成立：两者取自同一 nowMs，若哪天拆成两次读/两个来源，
        //    就会出现"expired=false 但 remainingMs=0"或反向的错窗显示。
        if (i.expired) expect(i.remainingMs).toBe(0);
        if (!i.expired && i.remainingMs !== null) expect(i.remainingMs).toBeGreaterThan(0);
      }
    }, 240_000);

    /**
     * AV-05 决定性对照：先否证我自己的猜想（"批准时刻在步骤行里"），再指出它到底在哪。
     * 读数以事实为准：批准动作虽然写了步骤行，但那次 `.set()` 只带 `description`
     * （`approval-persistence.service.ts:575-585`），列定义没有 `$onUpdate`、迁移里也没有维护
     * `_updated_at` 的触发器 ⇒ **步骤行与实例行的 `_updated_at` 都停在创建时刻**；
     * 真正记录"批准于何时"的是**审计行**（`:622` 的 `approval.approve`，其 created_at 贴着动作）。
     * 所以这不是"数据不够"，也不是"库里没有时间"，而是：**有效期锚点取了行时间戳（可被任何后续写移动，
     * 见 AV-02），而不是审批这个事实自己的时间**。修法有现成权威源可用。
     */
    it('AV-05 决定性对照：批准时刻在库里另有其行，授权视图没用它', async () => {
      expect(approvalId).not.toBe('');
      // 前提：AV-01 的读数必须在场。V181 实测过一次级联——AV-01 先红 ⇒ 这里拿到 undefined ⇒
      // new Date(0)=1970-01-01，第二条红看不出原告是谁。前提不过就当前提不过，不许往下读成事实。
      expect(Number.isFinite(viewApprovedMsFromAv01)).toBe(true);
      expect(Number.isFinite(createdMsFromAv01)).toBe(true);
      const stepRows = await owner`
        select event_id as "eventId", _updated_at as "stepUpdatedAt", description as d
          from public.ewoh_event_chain
         where parent_event_id = ${approvalId}`;
      const step = (stepRows[0] ?? {}) as Record<string, unknown>;
      const raw = step.d;
      const desc = (typeof raw === 'string' ? JSON.parse(raw) : raw ?? {}) as Record<string, unknown>;
      const stepMs = step.stepUpdatedAt instanceof Date
        ? (step.stepUpdatedAt as Date).getTime() : Number.NaN;
      console.log(
        `[AV-05] 步骤行数=${stepRows.length} 步骤行 _updated_at=${String(step.stepUpdatedAt)} `
        + `（JSON 里的 decidedAt=${String(desc?.decidedAt)}）`,
      );
      console.log(
        `[AV-05] 批准动作=${new Date(approveCallMs).toISOString()} `
        + `｜AV-01 时视图给的"通过时间"=${new Date(viewApprovedMsFromAv01).toISOString()} `
        + `（比动作早 ${approveCallMs - viewApprovedMsFromAv01}ms，等于建行时刻 ${viewApprovedMsFromAv01 - createdMsFromAv01}ms 内）`,
      );
      const auditRows = await owner`
        select occurred_at as "auditAt", _created_at as "rowAt", action
          from public.ewoh_audit_log
         where entity_id = ${approvalId} and action = 'approval.approve'`;
      const auditMs = (auditRows[0] as Record<string, unknown>)?.auditAt instanceof Date
        ? ((auditRows[0] as Record<string, unknown>).auditAt as Date).getTime() : Number.NaN;
      console.log(
        `[AV-05] 审计 approval.approve 行数=${auditRows.length}，其 created_at=${String((auditRows[0] as Record<string, unknown>)?.auditAt)}`
        + `（与批准动作差 ${auditMs - approveCallMs}ms）`
        + `｜审计行 _created_at=${String((auditRows[0] as Record<string, unknown>)?.rowAt)}`,
      );
      expect(Number.isFinite(stepMs)).toBe(true);
      // ① 我原来的猜想被自己的读数否证：批准动作虽然写了步骤行，但 `.set({ description })` 不带时间戳，
      //    所以**步骤行的 `_updated_at` 也停在创建时刻**（与实例行同刻，差在毫秒级）。
      //    V181：同 AV-01，判据尺度改用例自己造的分辨窗口，不再写毫秒常数（实测两行刻差随负载走）。
      const span05 = approveCallMs - createdMsFromAv01;
      expect(span05).toBeGreaterThanOrEqual(1_500);
      expect(Math.abs(stepMs - viewApprovedMsFromAv01)).toBeLessThanOrEqual(Math.floor(span05 / 4));
      // ② 两行都不记录"批准于何时"，但库里**确实有**这个事实：审计行的 created_at 贴着动作发生。
      expect(auditRows.length).toBeGreaterThan(0);
      expect(Math.abs(auditMs - approveCallMs)).toBeLessThan(1_500);
      // ③ 于是准确结论是：授权视图与网关的有效期锚点用的是"行最后被写"的列，
      //    而"批准"这一事实的时间在审计面；两者相差正好是 pending 的时长。
      expect(auditMs - viewApprovedMsFromAv01).toBeGreaterThanOrEqual(1_000);
    }, 240_000);

    it('AV-04 读侧词表对照：前端硬编码的"未终结"集合必须落在服务端封闭词表内', async () => {
      const clientSrc = readFileSync(
        `${process.cwd()}/client/src/pages/FieldOperations/fieldOperationsLogic.ts`, 'utf8',
      );
      const serverSrc = readFileSync(
        `${process.cwd()}/server/modules/scheduler/execution-receipt-state.ts`, 'utf8',
      );
      const cm = clientSrc.match(/OPEN_EXECUTION_STATUSES\s*=\s*new Set\(\[([^\]]*)\]\)/);
      const tm = serverSrc.match(/const terminal = new Set\(\[([^\]]*)\]\)/);
      // 服务端词表取状态机的**键**（每行 `NAME: [...]`）——用跨度正则抓 token 会漏掉
      // 只出现在某个键位上的状态（第一版就漏了 PAUSED，把尺子的缺陷读成产品的缺陷）。
      const allowedBlock = serverSrc.match(/const allowed: Record<string, string\[\]> = \{([\s\S]*?)\n\};/);
      // 先剥掉每个键右侧的转移目标数组，再取键——一行里可能并排写了三个状态
      // （`COMPLETED: [...], FAILED: [...], CANCELLED: [...]`），按行首匹配会漏掉后两个。
      const keysOnly = (allowedBlock?.[1] ?? '').replace(/\[[^\]]*\]/g, '');
      const serverStates = Array.from(keysOnly.matchAll(/([A-Z_]+)\s*:/g)).map((m) => m[1]);
      const split = (txt?: string) => (txt ?? '').split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean);
      const clientSet = new Set(split(cm?.[1]));
      const serverSet = new Set(serverStates);
      const terminalSet = new Set(split(tm?.[1]));
      // 尺子自检：词表解析必须真吃到 7 个状态、3 个终态（少一个就是解析器漏了，不是产品漂移）。
      expect([...serverSet].sort().join(',')).toBe(
        'CANCELLED,COMPLETED,DISPATCHED,FAILED,PAUSED,PLANNED,STARTED',
      );
      expect([...terminalSet].sort().join(',')).toBe('CANCELLED,COMPLETED,FAILED');
      console.log(
        `[AV-04] 前端 OPEN=${JSON.stringify([...clientSet])}｜服务端词表=${JSON.stringify([...serverSet])}`,
      );
      expect(clientSet.size).toBeGreaterThan(0);
      expect(serverSet.size).toBeGreaterThan(0);
      // 前端不得出现服务端不认识的词（写了就恒 false ⇒ 静默漏提醒）；
      for (const s of clientSet) expect(serverSet.has(s)).toBe(true);
      // 服务端的全部终态都必须被前端排除在"未终结"之外（写了就恒真 ⇒ 永远提醒）。
      for (const t of terminalSet) expect(clientSet.has(t)).toBe(false);
      console.log(`[AV-04] 服务端终态=${JSON.stringify([...terminalSet])}`);
      console.log(`[AV-04] 词表漂移=${clientSet.size - [...clientSet].filter((s) => serverSet.has(s)).length}`);
    }, 120_000);
  },
);
