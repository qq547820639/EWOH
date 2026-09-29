/**
 * 试点链行为基线：审批实例的**唯一性**与"一次业务授权能被消耗几次"（真实 Nest + 真实 PostgreSQL）。
 *
 * F-01 登记时说 `createApproval` 用 randomUUID、无幂等键、(entityType,entityId) 无唯一约束，
 * 一直停在「走读定位」。本文件把它推到实测，并且刻意只回答可判定的问题（V70 三条 AI-*，V71 三条 CP-*）：
 *  AI-01 同一业务对象能否并存两份**都已通过**的审批实例？（F-04 的前提）
 *  AI-02 若能，一次"放宽高风险能力"的业务意图是否能被**两份实例各授权一次**？（这才是危害，不是"字段少写"）
 *  AI-03 同一份实例重复消耗是否被挡？（挡得住 ⇒ 缺口精确落在"实例数无界"，而不是"消耗无闸门"）
 * 各条独立可翻：任何一条与预期不符都据实改结论，不许把推断写成已证实。
 *
 * 高风险能力取契约里 `capabilityRisk=high` 的 `crane`（与 `capability-disabled-plan-explain.mjs` 同一口径）；
 * 放宽=从任务要求里撤销原来的高风险要求，收紧=加回去（按 NO-20a 只有放宽要审批）。
 *
 * V71 在同一文件补上**控制面**那一半（F-04b，§5.3w 的"未测"项）：
 *  CP-01 高危控制请求（`clear_fault`）建单即自带一份审批实例——这是平台自己的代码（`control.service.ts:473`）；
 *  CP-02 同一请求名下再补交一份，只批**旧那份** ⇒ 下发命令会不会被"看不见的最新那份"挡掉；
 *  CP-03 判别对照：只批**最新那份** ⇒ 同一身份、同一角色、同一指纹路径必须能下发放行。
 * 有 CP-03 这条对照，CP-02 的结果才不能归因于权限/令牌/设备未注册。控制面选 `clear_fault` 而非
 * `dispatch_task`：两者同为高危（`shared/actuator.ts` 的 `ACTUATOR_HIGH_RISK_COMMANDS`），但
 * `dispatch_task` 属运动类、受 NO-74c 更严的运动配额影响，会把两臂的结论搅浑。
 */
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
const HIGH_RISK = 'crane';
const ENTITY_TYPE = 'task_capability_change';
/** V71/F-04b：控制面审批实例的 entityType（与 `control.service.ts:475` 自动建单同源）。 */
const CONTROL_ENTITY_TYPE = 'control_request';
/** 高危（`ACTUATOR_HIGH_RISK_COMMANDS`）但不属运动配额（`MOTION_COMMAND_KEYS`）——避免 NO-74c 搅浑两臂结论。 */
const HIGH_RISK_CONTROL_KEY = 'clear_fault';

const sorted = (list: readonly string[]) => [...list].sort().join(',');

(config ? describe : describe.skip)(
  '审批实例唯一性与授权消耗 E2E（真实 PostgreSQL）',
  () => {
    let owner: OwnerSql;
    let fixture: E2EFixture;
    let resources: SchedulerFixture;
    let handle: E2EAppHandle;
    let adminToken: string;
    let creatorToken: string;
    /** V71 控制面：发起人兼下发人（dispatcherA），与安全审批人（adminToken）分开以回避自批。 */
    let operatorToken: string;
    let deviceId: string;
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

    async function boot(): Promise<string> {
      fixture = await createE2EFixture(owner);
      resources = await seedSchedulerFixture(owner, fixture.orgA.id);
      handle = await startE2EApp(config!, fixture.orgA.id);
      const baseUrl = handle.baseUrl;
      // 发起人与审批人必须是两个身份（回避自批，NO-20a）。
      const admin = await login(baseUrl, fixture.globalAdminA.username, fixture.globalAdminA.password);
      expect(admin.status).toBe(201);
      adminToken = admin.body.accessToken;
      const approver = await login(baseUrl, fixture.approverA.username, fixture.approverA.password);
      expect(approver.status).toBe(201);
      creatorToken = approver.body.accessToken;
      return baseUrl;
    }

    async function readTask(): Promise<{ capabilities: string[]; version: number }> {
      const res = await apiRequest<Record<string, unknown>>(
        baseUrl(),
        `/api/tasks/${resources.taskId}`,
        { headers: jsonHeaders(adminToken) },
      );
      expect(res.status).toBe(200);
      const raw = (res.body as { requiredDeviceCapabilities?: unknown }).requiredDeviceCapabilities;
      return {
        capabilities: Array.isArray(raw) ? (raw as string[]) : [],
        version: Number((res.body as { version?: number }).version ?? 0),
      };
    }

    function baseUrl(): string {
      return handle.baseUrl;
    }

    async function patchRequirements(body: Record<string, unknown>, token: string) {
      return apiRequest<Record<string, unknown>>(
        baseUrl(),
        `/api/tasks/${resources.taskId}/requirements`,
        { method: 'PATCH', headers: jsonHeaders(token), body: JSON.stringify(body) },
      );
    }

    /** 建一份"放宽 crane"的审批实例并由另一身份通过（返回实例号与建单响应）。 */
    async function approvedRelaxationInstance(resulting: string[], label: string) {
      const created = await apiRequest<{ id?: string; steps?: { id: string }[] }>(
        baseUrl(),
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
              title: label,
              summary: `e2e（run=${runId}）：${label}`,
              metrics: {
                relaxedHighRiskCapabilities: HIGH_RISK,
                resultingDeviceCapabilities: sorted(resulting),
                resultingStationCapabilities: '',
              },
            },
          }),
        },
      );
      expect(created.status).toBe(201);
      const approvalId = created.body.id as string;
      const stepId = created.body.steps?.[0]?.id as string;
      // 发起人自批必须 403（独立审批闸门）；真正的批准来自另一身份。
      const self = await apiRequest(
        baseUrl(),
        `/api/approvals/${approvalId}/steps/${stepId}/state?action=approve`,
        { method: 'POST', headers: jsonHeaders(creatorToken), body: JSON.stringify({ reason: 'self' }) },
      );
      expect(self.status).toBe(403);
      const approved = await apiRequest(
        baseUrl(),
        `/api/approvals/${approvalId}/steps/${stepId}/state?action=approve`,
        { method: 'POST', headers: jsonHeaders(adminToken), body: JSON.stringify({ reason: 'e2e 安全复核通过' }) },
      );
      expect([200, 201]).toContain(approved.status);
      return approvalId;
    }

    async function liveInstances(): Promise<Array<{ eventId: string; status: string }>> {
      return owner`SELECT event_id AS "eventId", status FROM ewoh_event
        WHERE event_type = ${ENTITY_TYPE}
           OR (event_type = 'approval_instance'
               AND evidence_json->>'entityType' = ${ENTITY_TYPE}
               AND evidence_json->>'entityId' = ${resources.taskId})`
        .then((rows) => rows.map((r) => ({ eventId: String(r.eventId), status: String(r.status) })));
    }

    async function usageRows(approvalIds: string[]): Promise<number> {
      const [rows] = await owner`SELECT count(*)::int AS n FROM ewoh_event
        WHERE event_type = 'approval_usage' AND causation_id = ANY(${approvalIds}::text[])`.values();
      return Number(rows[0]);
    }

    it('AI-01 同一业务对象可并存两份都已通过的审批实例（F-04 前提的实测）', async () => {
      const baseUrlValue = await boot();
      const base = await readTask();
      // 先把高风险要求加回去（收紧不需要审批），后面「放宽」才有实际内容可撤销。
      const tightened = [...new Set([...base.capabilities, HIGH_RISK])];
      const tighten = await patchRequirements({ requiredDeviceCapabilities: tightened }, adminToken);
      expect(tighten.status).toBe(200);
      const resulting = tightened.filter((c) => c !== HIGH_RISK);

      const a = await approvedRelaxationInstance(resulting, `放宽 ${HIGH_RISK}（实例 A）`);
      const b = await approvedRelaxationInstance(resulting, `放宽 ${HIGH_RISK}（实例 B，指纹与 A 相同）`);
      const instances = await liveInstances();
      const approvedOnTask = instances.filter((r) => r.status === 'approved');
      console.log(
        `[AI-01] baseUrl=${baseUrlValue.startsWith('http') ? 'ok' : '?'} 实例 A=${a} B=${b} `
          + `该任务的 approved 实例数=${approvedOnTask.length} 全部实例状态=${instances.map((r) => r.status).join('/')}`,
      );
      // F-04：没有任何唯一约束或幂等键把"同一对象的第二份待批实例"挡住。
      expect(approvedOnTask.length).toBeGreaterThanOrEqual(2);
    });

    it('AI-02 一次业务意图可被两份实例各授权一次；AI-03 同一实例重复消耗被挡', async () => {
      const baseUrlValue = await boot();
      const base = await readTask();
      const tightened = [...new Set([...base.capabilities, HIGH_RISK])];
      expect((await patchRequirements({ requiredDeviceCapabilities: tightened }, adminToken)).status).toBe(200);
      const resulting = tightened.filter((c) => c !== HIGH_RISK);

      // 前置：不带审批的放宽必须被 409 拒绝（否则 AI-02 的"能过"就没有对照意义）。
      const blocked = await patchRequirements({ requiredDeviceCapabilities: resulting }, adminToken);
      expect([403, 409]).toContain(blocked.status);

      const a = await approvedRelaxationInstance(resulting, `放宽 ${HIGH_RISK}（实例 A）`);
      const b = await approvedRelaxationInstance(resulting, `放宽 ${HIGH_RISK}（实例 B）`);

      // 第一次放宽用 A 授权。
      const first = await patchRequirements({ requiredDeviceCapabilities: resulting, approvalId: a }, adminToken);
      const firstBody = JSON.stringify(first.body ?? {}).slice(0, 160);
      expect(first.status).toBe(200);

      // 收紧回去（不需要审批）——现场真实动作：安全边界被重新加严，随后又想放宽。
      const retreat = await patchRequirements({ requiredDeviceCapabilities: tightened }, adminToken);
      expect(retreat.status).toBe(200);

      // 第二次放宽用 B 授权：同样的业务意图、同样的指纹，但换了"另一份审批"。
      const second = await patchRequirements({ requiredDeviceCapabilities: resulting, approvalId: b }, adminToken);
      const usages = await usageRows([a, b]);
      console.log(
        `[AI-02] 第一次放宽(A)=${first.status} 收紧退回=${retreat.status} 第二次放宽(B)=${second.status} `
          + `approval_usage 行数=${usages}（A=${a} B=${b}） 第一次响应体=${firstBody}`,
      );
      // 实测结论候选：200 ⇒ 一次业务授权被消耗两次（实例数无界的危害成立）；
      // 409 ⇒ 平台另有绑定（如要求"最新实例"），则 F-04 的这条危害被证伪。
      expect(second.status).toBe(200);
      expect(usages).toBe(2);

      // AI-03：同一份实例（B 已消耗）再来一次，必须被消耗闸门挡住。
      const againTighten = await patchRequirements({ requiredDeviceCapabilities: tightened }, adminToken);
      expect(againTighten.status).toBe(200);
      const reuse = await patchRequirements({ requiredDeviceCapabilities: resulting, approvalId: b }, adminToken);
      const reuseBody = JSON.stringify(reuse.body ?? {}).slice(0, 200);
      console.log(`[AI-03] 重复使用同一实例 B → HTTP ${reuse.status} ${reuseBody}`);
      expect([403, 409]).toContain(reuse.status);
      expect(String(reuseBody)).toContain('APPROVAL_ALREADY_CONSUMED');
      expect(await usageRows([a, b])).toBe(2);
      void baseUrlValue;
    });

    // ── V71 / F-04b：控制面「同一请求两份审批实例，闸门看的是哪一份」────────────────
    // 判据见文件头 CP-01/02/03。`findLatestForEntity`（approval-persistence.service.ts:464-489）
    // 按 `created_at DESC limit 1` 取一条，所以"最新"必须有定义：两条实例的 created_at
    // 必须严格不同，否则本用例的前提不成立（照 D-01 的前提断言做法，直接失败而不是放过）。

    /** 该控制请求名下的全部审批实例，按 created_at 升序（A=最早=平台建单时自动带的那份）。 */
    async function controlInstances(requestId: string) {
      // 微秒口径：`created_at` 是 timestamptz(6)，而 JS `Date` 与 HTTP DTO 都只到**毫秒**——
      // 实测两份实例可以落在同一毫秒内（第一次跑就是被这个截断误判成"时间相等"）。
      // 闸门的 `ORDER BY created_at DESC` 在库里按微秒比较，所以判据必须同口径取微秒。
      const rows = await owner`SELECT event_id AS "eventId", status,
          to_char(created_at, 'YYYY-MM-DD "T" HH24:MI:SS.US') AS "createdAt",
          (floor(extract(epoch FROM date_trunc('second', created_at)))::bigint * 1000000
            + extract(microseconds FROM created_at)::bigint)::text AS "us"
        FROM ewoh_event
        WHERE event_type = 'approval_instance'
          AND evidence_json->>'entityType' = ${CONTROL_ENTITY_TYPE}
          AND evidence_json->>'entityId' = ${requestId}
        ORDER BY created_at ASC, event_id ASC`;
      return rows.map((r) => ({
        eventId: String(r.eventId),
        status: String(r.status),
        createdAt: String(r.createdAt),
        at: Number(r.us),
      }));
    }

    async function approveInstance(approvalId: string, token: string) {
      const detail = await apiRequest<{ steps?: { id: string }[] }>(
        handle.baseUrl,
        `/api/approvals/${approvalId}`,
        { headers: jsonHeaders(token) },
      );
      expect(detail.status).toBe(200);
      const stepId = String(detail.body?.steps?.[0]?.id ?? '');
      expect(stepId.length).toBeGreaterThan(0);
      return apiRequest(
        handle.baseUrl,
        `/api/approvals/${approvalId}/steps/${stepId}/state?action=approve`,
        { method: 'POST', headers: jsonHeaders(token), body: JSON.stringify({ reason: 'e2e F-04b 安全复核' }) },
      );
    }

    /**
     * CP-01：建一张高危控制请求——按 `control.service.ts:456,473` 它必须落 `pending_approval`
     * 并**自带一份**审批实例；随后手工再补交一份（F-04 的控制面同现：无唯一约束挡第二份）。
     */
    async function twoInstanceRequest(tag: string) {
      const created = await apiRequest<{ id?: string; status?: string; riskLevel?: string }>(
        handle.baseUrl,
        '/api/control/requests',
        {
          method: 'POST',
          headers: jsonHeaders(operatorToken),
          body: JSON.stringify({
            deviceId,
            commandKeys: [HIGH_RISK_CONTROL_KEY],
            idempotencyKey: `f04b-${tag}-${runId}`,
          }),
        },
      );
      expect(created.status).toBe(201);
      expect(String(created.body?.status)).toBe('pending_approval'); // CP-01
      const requestId = String(created.body.id);
      // CP-01 的定级事实在**库里**：建单把请求判成 high 才会既落 pending_approval 又自动建审批实例。
      expect((await requestRow(requestId)).riskLevel).toBe('high');
      // 现状钉住（F-15，不掩盖）：同一次建单的 HTTP 响应把 riskLevel 报成 null——
      // `rowFromSelect`（control.service.ts:3008-3022）手工拷列时漏了 risk_level，
      // 于是"平台按高危把这单送进了审批链"这件事在创建响应上是看不见的（读面口径分裂）。
      expect(String(created.body?.riskLevel)).toBe('null');
      const auto = await controlInstances(requestId);
      expect(auto.length).toBe(1); // CP-01：高危建单自动带一张审批实例
      const extra = await apiRequest<{ id?: string }>(
        handle.baseUrl,
        '/api/approvals',
        {
          method: 'POST',
          headers: jsonHeaders(creatorToken),
          body: JSON.stringify({
            entityType: CONTROL_ENTITY_TYPE,
            entityId: requestId,
            roles: ['safety_admin'],
            subject: {
              objectType: CONTROL_ENTITY_TYPE,
              objectId: requestId,
              title: `F-04b 重开审批（${tag}）`,
              summary: `e2e（run=${runId}）：同一控制请求的第二份待批实例`,
              metrics: { commandKeys: HIGH_RISK_CONTROL_KEY, deviceId },
            },
          }),
        },
      );
      return { requestId, created, extra, all: await controlInstances(requestId) };
    }

    function sendCommand(requestId: string, token: string) {
      return apiRequest<{ attempts?: { attemptId: string; commandKey: string }[] }>(
        handle.baseUrl,
        `/api/control/requests/${requestId}/commands`,
        {
          method: 'POST',
          headers: jsonHeaders(token),
          body: JSON.stringify({ commandKey: HIGH_RISK_CONTROL_KEY, payload: {} }),
        },
      );
    }

    async function requestRow(requestId: string) {
      const rows = await owner`SELECT status, risk_level AS "riskLevel", approved_at AS "approvedAt"
        FROM ewoh_control_request WHERE request_id = ${requestId}`;
      return {
        status: String(rows[0]?.status ?? ''),
        riskLevel: String(rows[0]?.riskLevel ?? ''),
        approvedAt: rows[0]?.approvedAt ?? null,
      };
    }

    async function controlCommandCount(requestId: string): Promise<number> {
      const rows = await owner`SELECT count(*)::int AS n FROM ewoh_control_command
        WHERE request_id = ${requestId}`;
      return Number(rows[0]?.n ?? -1);
    }

    /** 控制面各臂独立起环境：新租户 + 新设备 id，避免与 AI-* 臂相互污染。 */
    async function bootControl(deviceTag: string): Promise<string> {
      fixture = await createE2EFixture(owner);
      handle = await startE2EApp(config!, fixture.orgA.id);
      deviceId = `AGV-F04B-${deviceTag}-${runId}`;
      const operator = await login(
        handle.baseUrl,
        fixture.dispatcherA.username,
        fixture.dispatcherA.password,
      );
      expect(operator.status).toBe(201);
      operatorToken = operator.body.accessToken;
      const admin = await login(
        handle.baseUrl,
        fixture.globalAdminA.username,
        fixture.globalAdminA.password,
      );
      expect(admin.status).toBe(201);
      adminToken = admin.body.accessToken;
      // 补交审批单用的是 workshop_lead：`dispatcher` 在 POST /api/approvals 上被角色闸拦下
      // （实测 403 "Forbidden resource"=RolesGuard，而非业务规则）——所以"谁能开单"这一条
      // 控制面与任务面同形，本用例沿用 AI-* 臂已验证可开单的身份。
      const approver = await login(
        handle.baseUrl,
        fixture.approverA.username,
        fixture.approverA.password,
      );
      expect(approver.status).toBe(201);
      creatorToken = approver.body.accessToken;
      return handle.baseUrl;
    }

    it('CP-02 只批旧那份审批 ⇒ 高危命令被"看不见的最新那份"挡成 403（F-04b）', async () => {
      await bootControl('cp02');
      const { requestId, created, extra, all } = await twoInstanceRequest('cp02');
      const a = all[0]!;
      const b = all[1]!;
      // 前提断言：A 严格早于 B，否则"最新一份"无定义，本用例结论不成立。
      expect(a.at).toBeLessThan(b.at);
      const approved = await approveInstance(a.eventId, adminToken);
      expect([200, 201]).toContain(approved.status);
      const afterApprove = await controlInstances(requestId);
      const send = await sendCommand(requestId, operatorToken);
      const body = JSON.stringify(send.body ?? {}).slice(0, 240);
      const row = await requestRow(requestId);
      const commands = await controlCommandCount(requestId);
      console.log(
        `[CP-02] 建单=${created.status} 实例数=${all.length} 补交第二份=${extra.status} `
          + `批旧(A)=${approved.status} 实例状态=${afterApprove.map((r) => `${r.eventId.slice(0, 8)}:${r.status}`).join(',')} `
          + `A.created=${a.createdAt} B.created=${b.createdAt} `
          + `下发=${send.status} ${body} 请求行=${row.status} approved_at=${row.approvedAt ?? 'NULL'} `
          + `命令行数=${commands}`,
      );
      // F-04 的控制面同现：第二份实例照样建得出来。
      expect(extra.status).toBe(201);
      // 核心判据：一张**已通过**的审批凭证存在于该请求名下，却不进闸门的视野，
      // 且 403 文案只说"审批还没过"，不告诉操作者"你有两份、我看的是最新那份"。
      expect(afterApprove.filter((r) => r.status === 'approved').length).toBe(1);
      expect(send.status).toBe(403);
      expect(body).toContain('awaits approval');
      expect(body).toContain('pending');
      // 403 不留半写状态：请求行仍是 pending_approval，一条命令都不该落库。
      expect(row.status).toBe('pending_approval');
      expect(row.approvedAt).toBeNull();
      expect(commands).toBe(0);
    });

    it('CP-03 判别对照：只批最新那份 ⇒ 同一身份/角色/指纹路径放行 201（F-04b 归因）', async () => {
      await bootControl('cp03');
      const { requestId, extra, all } = await twoInstanceRequest('cp03');
      const a = all[0]!;
      const b = all[1]!;
      expect(extra.status).toBe(201);
      expect(a.at).toBeLessThan(b.at);
      const approved = await approveInstance(b.eventId, adminToken);
      expect([200, 201]).toContain(approved.status);
      const send = await sendCommand(requestId, operatorToken);
      const row = await requestRow(requestId);
      const commands = await controlCommandCount(requestId);
      const attemptId = send.body?.attempts?.[0]?.attemptId ?? null;
      console.log(
        `[CP-03] 批新(B)=${approved.status} 下发=${send.status} attempt=${attemptId} `
          + `请求行=${row.status} approved_at=${row.approvedAt ? '已写' : 'NULL'} `
          + `命令行数=${commands} 旧份 A=${a.eventId.slice(0, 8)} 状态=`
          + `${(await controlInstances(requestId)).find((r) => r.eventId === a.eventId)?.status}`,
      );
      // CP-02 的对照臂：身份、角色、设备、命令键、指纹路径全同，唯一差别是批的是最新那份。
      expect(send.status).toBe(201);
      expect(typeof attemptId).toBe('string');
      // 闸门 CAS `pending_approval → approved` 后，下发流程立刻把请求推进到等网关回执的
      // 状态（实测 `pending_gateway`）——这里钉"离开了待审批态且写了 approved_at"，
      // 而不是钉某个中间态：中间态属于下发流程，与 F-04b 的判据无关。
      expect(['approved', 'pending_gateway']).toContain(row.status);
      expect(row.status).not.toBe('pending_approval');
      expect(row.approvedAt).not.toBeNull();
      expect(commands).toBe(1);
      // 副作用（F-04 在控制面同形）：批了新份并不会让旧那份失效——实测 A 永久停在 pending，
      // 于是该请求名下长期挂着一张"永远不会再被查阅"的待批审批单。
      const tail = await controlInstances(requestId);
      expect(tail.find((r) => r.eventId === a.eventId)?.status).toBe('pending');
    });
  },
);
