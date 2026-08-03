import { randomUUID } from 'node:crypto';
import { resolveE2EConfig } from '../helpers/e2e-config';
import {
  cleanupE2EFixture,
  connectOwner,
  createE2EFixture,
  findControlRequest,
  type E2EFixture,
  type OwnerSql,
} from '../helpers/e2e-db';
import {
  startE2EApp,
  type E2EAppHandle,
} from '../helpers/e2e-app';
import {
  apiRequest,
  jsonHeaders,
  login,
  logout,
  refresh,
} from '../helpers/e2e-http';

const e2eConfig = resolveE2EConfig();

if (!e2eConfig) {
  describe.skip('EWOH HTTP + PostgreSQL E2E (skipped)', () => {
    it('requires a runtime DATABASE_URL', () => {
      expect(e2eConfig).not.toBeNull();
    });
  });
} else {
  describe('EWOH HTTP + PostgreSQL E2E (SP-01..SP-08)', () => {
    const runId = randomUUID().slice(0, 12);
    let owner: OwnerSql | undefined;
    let fixture: E2EFixture | undefined;
    let handle: E2EAppHandle | undefined;
    let baseUrl = '';

    beforeAll(async () => {
      owner = await connectOwner(e2eConfig.ownerDatabaseUrl);
      fixture = await createE2EFixture(owner);
      handle = await startE2EApp(e2eConfig, fixture.orgA.id);
      baseUrl = handle.baseUrl;
    }, 60000);

    afterAll(async () => {
      if (handle) {
        await handle.close();
      }
      if (owner) {
        if (fixture) {
          await cleanupE2EFixture(owner, fixture);
        }
        await owner.end();
      }
    });

    it('serves /health/live and /health/ready with 200', async () => {
      const live = await apiRequest<{ status: string }>(baseUrl, '/health/live');
      expect(live.status).toBe(200);
      expect(live.body.status).toBe('ok');

      const ready = await apiRequest<{
        status: string;
        checks: { database: string };
      }>(baseUrl, '/health/ready');
      expect(ready.status).toBe(200);
      expect(ready.body.checks?.database).toBe('ok');
    });

    it('exposes Prometheus metrics with factory resource attributes', async () => {
      process.env.EWOH_FACTORY_ID = `factory-${runId}`;
      process.env.EWOH_FACTORY_NAME = 'E2E Factory';
      process.env.EWOH_FACTORY_UPGRADE_RING = 'shadow';
      process.env.EWOH_RELEASE_VERSION = '0.6.0-rc2';
      process.env.EWOH_REGION = 'cn-north-1';

      const metrics = await apiRequest<string>(baseUrl, '/metrics');
      expect(metrics.status).toBe(200);
      expect(metrics.body).toContain(
        `ewoh_resource_info{factory_id="factory-${runId}",factory_name="E2E Factory",upgrade_ring="shadow",release_version="0.6.0-rc2",region="cn-north-1"} 1`,
      );
      expect(metrics.body).toContain('ewoh_process_uptime_seconds');
    });

    it('rejects unauthenticated business API calls with 401', async () => {
      for (const path of ['/api/me', '/api/system/config', '/api/audit']) {
        const response = await apiRequest(baseUrl, path);
        expect(response.status).toBe(401);
      }
    });

    it('blocks viewer access to admin config, audit, and control writes', async () => {
      const auth = await login(
        baseUrl,
        fixture!.viewerA.username,
        fixture!.viewerA.password,
      );
      expect(auth.status).toBe(201);
      expect(auth.body.user.roles).toContain('viewer');
      expect(auth.body.user.orgId).toBe(fixture!.orgA.id);
      expect(auth.body.accessToken).toBeTruthy();

      const viewerToken = auth.body.accessToken;
      for (const path of ['/api/system/config', '/api/audit']) {
        const response = await apiRequest(baseUrl, path, {
          headers: jsonHeaders(viewerToken),
        });
        expect(response.status).toBe(403);
      }

      const write = await apiRequest(baseUrl, '/api/control/requests', {
        method: 'POST',
        headers: jsonHeaders(viewerToken),
        body: JSON.stringify({
          deviceId: 'EXO-E2E-VIEWER',
          commandKeys: ['start'],
          idempotencyKey: `viewer-${runId}`,
        }),
      });
      expect(write.status).toBe(403);
    });

    it('enforces device contract route roles', async () => {
      const viewer = await login(
        baseUrl,
        fixture!.viewerA.username,
        fixture!.viewerA.password,
      );
      expect(viewer.status).toBe(201);
      const denied = await apiRequest(baseUrl, '/api/devices', {
        headers: jsonHeaders(viewer.body.accessToken),
      });
      expect(denied.status).toBe(403);

      const dispatcher = await login(
        baseUrl,
        fixture!.dispatcherA.username,
        fixture!.dispatcherA.password,
      );
      expect(dispatcher.status).toBe(201);
      const allowed = await apiRequest(baseUrl, '/api/devices', {
        headers: jsonHeaders(dispatcher.body.accessToken),
      });
      expect(allowed.status).toBe(200);
    });

    it('serves the AsyncAPI/CloudEvents event catalog to authenticated users', async () => {
      const auth = await login(
        baseUrl,
        fixture!.dispatcherA.username,
        fixture!.dispatcherA.password,
      );
      expect(auth.status).toBe(201);

      const catalog = await apiRequest<{
        info: { title: string; version: string };
        channels: Record<string, unknown>;
      }>(baseUrl, '/api/events/catalog', {
        headers: jsonHeaders(auth.body.accessToken),
      });
      expect(catalog.status).toBe(200);
      expect(catalog.body.info.title).toBe('EWOH Event Catalog');
      expect(Object.keys(catalog.body.channels).length).toBeGreaterThanOrEqual(
        13,
      );

      const eventType = await apiRequest<{
        eventType: string;
        channel: string;
      }>(baseUrl, '/api/events/catalog/TelemetryObserved', {
        headers: jsonHeaders(auth.body.accessToken),
      });
      expect(eventType.status).toBe(200);
      expect(eventType.body.eventType).toBe('TelemetryObserved');
      expect(eventType.body.channel).toBe('telemetry.observed');
    });

    it('evaluates policies and serves the canonical operator-safety example', async () => {
      const auth = await login(
        baseUrl,
        fixture!.dispatcherA.username,
        fixture!.dispatcherA.password,
      );
      expect(auth.status).toBe(201);
      const token = auth.body.accessToken;

      const example = await apiRequest<{
        policyId: string;
        version: string;
        effect: string;
        rules: Array<{ field: string; operator: string; value: unknown }>;
      }>(baseUrl, '/api/policies/examples', {
        headers: jsonHeaders(token),
      });
      expect(example.status).toBe(200);
      expect(example.body.policyId).toBe('deny-dispatch-high-risk');
      expect(example.body.effect).toBe('deny');

      const risky = await apiRequest<{
        decision: string;
        matched: boolean;
      }>(baseUrl, '/api/policies/evaluate', {
        method: 'POST',
        headers: jsonHeaders(token),
        body: JSON.stringify({
          policy: example.body,
          context: { plan: { riskLevel: 'critical', requiresApproval: true } },
        }),
      });
      expect(risky.status).toBe(201);
      expect(risky.body.decision).toBe('deny');
      expect(risky.body.matched).toBe(true);

      const safe = await apiRequest<{
        decision: string;
        matched: boolean;
      }>(baseUrl, '/api/policies/evaluate', {
        method: 'POST',
        headers: jsonHeaders(token),
        body: JSON.stringify({
          policy: example.body,
          context: { plan: { riskLevel: 'low', requiresApproval: true } },
        }),
      });
      expect(safe.status).toBe(201);
      expect(safe.body.decision).toBe('allow');
      expect(safe.body.matched).toBe(false);
    });

    it('serves workflow examples and computes role-aware next steps', async () => {
      const auth = await login(
        baseUrl,
        fixture!.dispatcherA.username,
        fixture!.dispatcherA.password,
      );
      expect(auth.status).toBe(201);
      const token = auth.body.accessToken;

      const example = await apiRequest<{
        workflowId: string;
        version: string;
        steps: Array<{ name: string; action: string }>;
      }>(baseUrl, '/api/workflows/examples', {
        headers: jsonHeaders(token),
      });
      expect(example.status).toBe(200);
      expect(example.body.workflowId).toBe('mes-execution');
      expect(example.body.steps).toHaveLength(8);

      const workerAdvance = await apiRequest<{
        currentActionAllowed: boolean;
        allowedNextSteps: Array<{ name: string; action: string }>;
      }>(baseUrl, '/api/workflows/advance', {
        method: 'POST',
        headers: jsonHeaders(token),
        body: JSON.stringify({
          workflow: example.body,
          currentStep: 'report',
          roles: ['worker'],
        }),
      });
      expect(workerAdvance.status).toBe(201);
      expect(workerAdvance.body.currentActionAllowed).toBe(true);
      expect(workerAdvance.body.allowedNextSteps).toEqual([]);

      const qualityAdvance = await apiRequest<{
        allowedNextSteps: Array<{ name: string; action: string }>;
      }>(baseUrl, '/api/workflows/advance', {
        method: 'POST',
        headers: jsonHeaders(token),
        body: JSON.stringify({
          workflow: example.body,
          currentStep: 'report',
          roles: ['quality'],
        }),
      });
      expect(qualityAdvance.status).toBe(201);
      expect(qualityAdvance.body.allowedNextSteps).toEqual([
        { name: 'inspect', action: 'inspect' },
      ]);
    });

    it('lets global_admin read/write system config, read audit, and create control requests', async () => {
      const auth = await login(
        baseUrl,
        fixture!.globalAdminA.username,
        fixture!.globalAdminA.password,
      );
      expect(auth.status).toBe(201);
      expect(auth.body.user.roles).toContain('global_admin');
      const adminToken = auth.body.accessToken;

      const configList = await apiRequest<unknown[]>(
        baseUrl,
        '/api/system/config',
        { headers: jsonHeaders(adminToken) },
      );
      expect(configList.status).toBe(200);
      expect(Array.isArray(configList.body)).toBe(true);

      const configKey = `e2e.admin.${runId}`;
      const configSet = await apiRequest<{
        configKey: string;
        configValue: unknown;
      }>(baseUrl, `/api/system/config/${configKey}`, {
        method: 'PUT',
        headers: jsonHeaders(adminToken),
        body: JSON.stringify({
          configValue: { enabled: true, actor: 'global-admin' },
        }),
      });
      expect(configSet.status).toBe(200);
      expect(configSet.body.configKey).toBe(configKey);

      const audit = await apiRequest<{
        items: unknown[];
        total: number;
      }>(baseUrl, '/api/audit', { headers: jsonHeaders(adminToken) });
      expect(audit.status).toBe(200);
      expect(Array.isArray(audit.body.items)).toBe(true);

      const control = await apiRequest<{ id: string }>(
        baseUrl,
        '/api/control/requests',
        {
          method: 'POST',
          headers: jsonHeaders(adminToken),
          body: JSON.stringify({
            deviceId: 'EXO-E2E-ADMIN',
            commandKeys: ['start'],
            idempotencyKey: `admin-${runId}`,
          }),
        },
      );
      expect(control.status).toBe(201);
      expect(control.body.id).toBeTruthy();
    });

    it('persists org feature flags and enforces write roles', async () => {
      const adminA = await login(
        baseUrl,
        fixture!.globalAdminA.username,
        fixture!.globalAdminA.password,
      );
      expect(adminA.status).toBe(201);
      const adminToken = adminA.body.accessToken;
      const flagKey = `feature.e2e.${runId}`;

      const setFlag = await apiRequest<{
        key: string;
        enabled: boolean;
        metadata: Record<string, unknown>;
      }>(baseUrl, `/api/system/feature-flags/${flagKey}`, {
        method: 'PUT',
        headers: jsonHeaders(adminToken),
        body: JSON.stringify({ enabled: true, metadata: { owner: 'e2e' } }),
      });
      expect(setFlag.status).toBe(200);
      expect(setFlag.body.key).toBe(flagKey);
      expect(setFlag.body.enabled).toBe(true);
      expect(setFlag.body.metadata).toEqual({ owner: 'e2e' });

      const listFlags = await apiRequest<
        Array<{ key: string; enabled: boolean }>
      >(baseUrl, '/api/system/feature-flags', {
        headers: jsonHeaders(adminToken),
      });
      expect(listFlags.status).toBe(200);
      expect(
        listFlags.body.find((flag) => flag.key === flagKey)?.enabled,
      ).toBe(true);

      const viewerB = await login(
        baseUrl,
        fixture!.viewerB.username,
        fixture!.viewerB.password,
      );
      expect(viewerB.status).toBe(201);
      const viewerBToken = viewerB.body.accessToken;
      const viewerBFlags = await apiRequest<Array<{ key: string }>>(
        baseUrl,
        '/api/system/feature-flags',
        { headers: jsonHeaders(viewerBToken) },
      );
      expect(viewerBFlags.status).toBe(200);
      expect(
        viewerBFlags.body.some((flag) => flag.key === flagKey),
      ).toBe(false);

      const deniedWrite = await apiRequest(
        baseUrl,
        `/api/system/feature-flags/${flagKey}`,
        {
          method: 'PUT',
          headers: jsonHeaders(viewerBToken),
          body: JSON.stringify({ enabled: false }),
        },
      );
      expect(deniedWrite.status).toBe(403);
    });

    it('rotates refresh tokens and revokes them after reuse/logout', async () => {
      const first = await login(
        baseUrl,
        fixture!.viewerB.username,
        fixture!.viewerB.password,
      );
      expect(first.status).toBe(201);
      const firstRefresh = first.body.refreshToken;

      const rotated = await refresh(baseUrl, firstRefresh);
      expect(rotated.status).toBe(201);
      expect(rotated.body.refreshToken).not.toBe(firstRefresh);

      const reused = await refresh(baseUrl, firstRefresh);
      expect(reused.status).toBe(401);

      const signedOut = await logout(baseUrl, rotated.body.refreshToken);
      expect(signedOut.status).toBe(201);

      const afterLogout = await refresh(baseUrl, rotated.body.refreshToken);
      expect(afterLogout.status).toBe(401);
    });

    it('isolates org A control data from org B over HTTP', async () => {
      const dispatcherA = await login(
        baseUrl,
        fixture!.dispatcherA.username,
        fixture!.dispatcherA.password,
      );
      expect(dispatcherA.status).toBe(201);

      const created = await apiRequest<{ id: string }>(
        baseUrl,
        '/api/control/requests',
        {
          method: 'POST',
          headers: jsonHeaders(dispatcherA.body.accessToken),
          body: JSON.stringify({
            deviceId: 'EXO-E2E-ORG-A',
            commandKeys: ['start'],
            idempotencyKey: `isolation-a-${runId}`,
          }),
        },
      );
      expect(created.status).toBe(201);
      const requestId = created.body.id;

      const dispatcherB = await login(
        baseUrl,
        fixture!.dispatcherB.username,
        fixture!.dispatcherB.password,
      );
      expect(dispatcherB.status).toBe(201);
      const hidden = await apiRequest(baseUrl, `/api/control/requests/${requestId}`, {
        headers: jsonHeaders(dispatcherB.body.accessToken),
      });
      expect(hidden.status).toBe(404);

      const hiddenWrite = await apiRequest(
        baseUrl,
        `/api/control/requests/${requestId}/commands`,
        {
          method: 'POST',
          headers: jsonHeaders(dispatcherB.body.accessToken),
          body: JSON.stringify({ commandKey: 'start' }),
        },
      );
      expect(hiddenWrite.status).toBe(404);

      const own = await apiRequest(baseUrl, `/api/control/requests/${requestId}`, {
        headers: jsonHeaders(dispatcherA.body.accessToken),
      });
      expect(own.status).toBe(200);
      expect((own.body as { request: { id: string } }).request.id).toBe(requestId);
    });

    it('persists world snapshots/deltas and expires old cursors', async () => {
      const dispatcherA = await login(
        baseUrl,
        fixture!.dispatcherA.username,
        fixture!.dispatcherA.password,
      );
      expect(dispatcherA.status).toBe(201);
      const token = dispatcherA.body.accessToken;

      const firstSnapshot = await apiRequest<{
        snapshotVersion: number;
        cursor: string;
        entities: unknown[];
      }>(baseUrl, '/api/world/snapshot', { headers: jsonHeaders(token) });
      expect(firstSnapshot.status).toBe(200);
      expect(firstSnapshot.body.snapshotVersion).toBeGreaterThanOrEqual(1);
      expect(firstSnapshot.body.cursor).toBeTruthy();

      const delta = await apiRequest<{
        nextCursor: string;
        upserts: unknown[];
        removals: string[];
      }>(
        baseUrl,
        `/api/world/delta?cursor=${encodeURIComponent(firstSnapshot.body.cursor)}`,
        { headers: jsonHeaders(token) },
      );
      expect(delta.status).toBe(200);
      expect(Array.isArray(delta.body.upserts)).toBe(true);
      expect(delta.body.nextCursor).toBeTruthy();

      const secondSnapshot = await apiRequest<{
        snapshotVersion: number;
        cursor: string;
      }>(baseUrl, '/api/world/snapshot', { headers: jsonHeaders(token) });
      expect(secondSnapshot.status).toBe(200);
      expect(secondSnapshot.body.snapshotVersion).toBeGreaterThan(
        firstSnapshot.body.snapshotVersion,
      );

      const expired = await apiRequest(
        baseUrl,
        `/api/world/delta?cursor=${encodeURIComponent(firstSnapshot.body.cursor)}`,
        { headers: jsonHeaders(token) },
      );
      expect(expired.status).toBe(410);
    });

    it('persists control requests to PostgreSQL for the creating org', async () => {
      const dispatcherA = await login(
        baseUrl,
        fixture!.dispatcherA.username,
        fixture!.dispatcherA.password,
      );
      expect(dispatcherA.status).toBe(201);

      const created = await apiRequest<{ id: string }>(
        baseUrl,
        '/api/control/requests',
        {
          method: 'POST',
          headers: jsonHeaders(dispatcherA.body.accessToken),
          body: JSON.stringify({
            deviceId: 'EXO-E2E-DB',
            commandKeys: ['start'],
            idempotencyKey: `db-check-${runId}`,
          }),
        },
      );
      expect(created.status).toBe(201);

      const row = await findControlRequest(
        owner!,
        created.body.id,
        fixture!.orgA.id,
      );
      expect(row).not.toBeNull();
      expect(row?.device_id).toBe('EXO-E2E-DB');
      expect(row?.status).toBe('created');
      expect(row?.org_id).toBe(fixture!.orgA.id);
    });

    it('ingests canonical UnifiedExoFrame with source_type and org isolation', async () => {
      const entityId = `EXO-INGEST-${runId}`;
      const recordId = `REC-INGEST-${runId}`;
      const rawRef = `RAW-INGEST-${runId}`;
      await owner!.unsafe(
        `insert into public.ewoh_spatial_entity
           (org_id, entity_id, entity_type, name, source_type)
         values ($1::uuid, $2, 'device', $2, 'seed')`,
        [fixture!.orgA.id, entityId],
      );

      const frame = {
        entity_id: entityId,
        event_time: new Date().toISOString(),
        source_type: 'real',
        pose: {
          trunk_pitch_deg: 50,
          angular_velocity_dps: 12.3,
          joint_angles_deg: { left_knee: 45 },
        },
        load: {
          assist_level: 0.6,
          torque_nm: 18.5,
          cumulative_load_score: 0.85,
        },
        device: {
          battery_pct: 88,
          temperature_c: 36.5,
          fault_code: null,
        },
        quality: {
          packet_loss_pct: 1.2,
          confidence: 0.95,
          status: 'good',
        },
        record_id: recordId,
        raw_ref: rawRef,
      };

      const ingested = await apiRequest<{
        accepted: boolean;
        skipped: boolean;
        data_quality: string;
      }>(baseUrl, '/api/ingest/exoskeleton', {
        method: 'POST',
        headers: {
          ...jsonHeaders(),
          'x-org-id': fixture!.orgA.id,
        },
        body: JSON.stringify(frame),
      });
      expect(ingested.status).toBe(201);
      expect(ingested.body).toMatchObject({
        accepted: true,
        data_quality: 'good',
      });

      const rows = await owner!.unsafe<
        Array<{
          device_id: string;
          pitch_deg: number;
          load_score: number;
          battery_pct: number;
          assist_level: number;
          source_type: string;
          org_id: string;
        }>
      >(
        `select device_id, pitch_deg, load_score, battery_pct, assist_level,
                source_type, org_id::text
         from public.ewoh_telemetry
         where record_id = $1`,
        [recordId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].device_id).toBe(entityId);
      expect(rows[0].pitch_deg).toBe(50);
      expect(rows[0].load_score).toBeCloseTo(0.85, 3);
      expect(rows[0].battery_pct).toBe(88);
      expect(rows[0].assist_level).toBeCloseTo(0.6, 3);
      expect(rows[0].source_type).toBe('real');
      expect(rows[0].org_id).toBe(fixture!.orgA.id);

      const duplicate = await apiRequest<{
        accepted: boolean;
        skipped: boolean;
      }>(baseUrl, '/api/ingest/exoskeleton', {
        method: 'POST',
        headers: {
          ...jsonHeaders(),
          'x-org-id': fixture!.orgA.id,
        },
        body: JSON.stringify({ ...frame, record_id: `${recordId}-dup` }),
      });
      expect(duplicate.status).toBe(201);
      expect(duplicate.body.accepted).toBe(false);
      expect(duplicate.body.skipped).toBe(true);
    });

    it('persists gamification resource allocation and audit in PostgreSQL', async () => {
      const admin = await login(
        baseUrl,
        fixture!.globalAdminA.username,
        fixture!.globalAdminA.password,
      );
      expect(admin.status).toBe(201);
      const token = admin.body.accessToken;
      const personId = `P-GAME-${runId}`;
      const stationId = `WS-GAME-${runId}`;

      await owner!.begin(async (tx) => {
        await tx.unsafe(
          `insert into public.ewoh_spatial_entity
             (org_id, entity_id, entity_type, name, source_type)
           values ($1::uuid, $2, 'person', $2, 'seed')`,
          [fixture!.orgA.id, personId],
        );
        await tx.unsafe(
          `insert into public.ewoh_spatial_entity
             (org_id, entity_id, entity_type, name, source_type)
           values ($1::uuid, $2, 'workstation', $2, 'seed')`,
          [fixture!.orgA.id, stationId],
        );
        await tx.unsafe(
          `insert into public.ewoh_device
             (org_id, device_id, online, source_type)
           values ($1::uuid, $2, true, 'simulated')`,
          [fixture!.orgA.id, personId],
        );
      });

      const allocation = await apiRequest<{
        planId: string;
        evaluation: { overall: string; conflicts: string[] };
        allocations: Array<{ success: boolean }>;
      }>(baseUrl, '/api/gamification/resources/allocate', {
        method: 'POST',
        headers: jsonHeaders(token),
        body: JSON.stringify({
          allocations: [
            {
              entityId: personId,
              targetType: 'workstation',
              targetId: stationId,
            },
          ],
          reason: 'e2e gamification allocation',
        }),
      });
      expect(allocation.status).toBe(201);
      expect(allocation.body.planId).toBeTruthy();
      expect(allocation.body.allocations[0].success).toBe(true);
      expect(allocation.body.evaluation.conflicts).toEqual([]);

      const planRows = await owner!.unsafe<
        Array<{
          plan_id: string;
          strategy: string;
          status: string;
          org_id: string;
        }>
      >(
        `select plan_id, strategy, status, org_id::text
         from public.ewoh_schedule_plan
         where plan_id = $1`,
        [allocation.body.planId],
      );
      expect(planRows).toHaveLength(1);
      expect(planRows[0].strategy).toBe('resource_alloc');
      expect(planRows[0].status).toBe('proposed');
      expect(planRows[0].org_id).toBe(fixture!.orgA.id);

      const auditRows = await owner!.unsafe<
        Array<{ plan_id: string; action: string; org_id: string }>
      >(
        `select plan_id, action, org_id::text
         from public.ewoh_schedule_audit
         where plan_id = $1 and action = 'allocate'`,
        [allocation.body.planId],
      );
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0].org_id).toBe(fixture!.orgA.id);
    });

    it('executes a complete MES production work order with material and quality trace', async () => {
      const dispatcher = await login(
        baseUrl,
        fixture!.dispatcherA.username,
        fixture!.dispatcherA.password,
      );
      expect(dispatcher.status).toBe(201);
      const token = dispatcher.body.accessToken;
      const orderId = `WO-E2E-${runId}`;

      const created = await apiRequest<{
        workOrder: { scheduleTaskId: string; status: string; source: string };
        steps: Array<{ stepId: string; status: string }>;
      }>(baseUrl, '/api/mes/work-orders', {
        method: 'POST',
        headers: jsonHeaders(token),
        body: JSON.stringify({
          orderId,
          title: `E2E 装配工单 ${runId}`,
          productCode: 'PROD-E2E',
          orderQty: 10,
          batchNo: `BATCH-${runId}`,
          steps: [
            {
              name: '上料',
              assignedDeviceId: 'EXO-001',
              assignedPersonId: `P-E2E-${runId}`,
            },
            { name: '装配', assignedDeviceId: 'EXO-001' },
          ],
        }),
      });
      expect(created.status).toBe(201);
      expect(created.body.workOrder.scheduleTaskId).toBe(orderId);
      expect(created.body.workOrder.status).toBe('draft');
      expect(created.body.steps).toHaveLength(2);

      for (const action of ['release', 'start']) {
        const state = await apiRequest(
          baseUrl,
          `/api/mes/work-orders/${orderId}/state?action=${action}`,
          {
            method: 'POST',
            headers: jsonHeaders(token),
            body: '{}',
          },
        );
        expect(state.status).toBe(201);
      }

      const firstStep = created.body.steps[0];
      const secondStep = created.body.steps[1];
      for (const action of ['start']) {
        const stepState = await apiRequest(
          baseUrl,
          `/api/mes/work-orders/${orderId}/steps/${firstStep.stepId}/state?action=${action}`,
          {
            method: 'POST',
            headers: jsonHeaders(token),
            body: JSON.stringify({ quantity: 5 }),
          },
        );
        expect(stepState.status).toBe(201);
      }

      const workbench = await apiRequest<
        Array<{ stepId: string; status: string }>
      >(
        baseUrl,
        `/api/mobile/workbench?personId=${encodeURIComponent(`P-E2E-${runId}`)}`,
        { headers: jsonHeaders(token) },
      );
      expect(workbench.status).toBe(200);
      expect(
        workbench.body.some((step) => step.stepId === firstStep.stepId),
      ).toBe(true);

      const scanned = await apiRequest<{
        workOrder: { scheduleTaskId: string };
      }>(baseUrl, '/api/mobile/workbench/scan', {
        method: 'POST',
        headers: jsonHeaders(token),
        body: JSON.stringify({ orderId }),
      });
      expect(scanned.status).toBe(201);
      expect(scanned.body.workOrder.scheduleTaskId).toBe(orderId);

      for (const action of ['report']) {
        const stepState = await apiRequest(
          baseUrl,
          `/api/mes/work-orders/${orderId}/steps/${firstStep.stepId}/state?action=${action}`,
          {
            method: 'POST',
            headers: jsonHeaders(token),
            body: JSON.stringify({ quantity: 5 }),
          },
        );
        expect(stepState.status).toBe(201);
      }

      const material = await apiRequest<{ bindingId: string }>(
        baseUrl,
        `/api/mes/work-orders/${orderId}/materials`,
        {
          method: 'POST',
          headers: jsonHeaders(token),
          body: JSON.stringify({
            materialId: 'MAT-E2E',
            quantity: 2,
            reason: 'E2E 投料',
          }),
        },
      );
      expect(material.status).toBe(201);
      expect(material.body.bindingId).toBeTruthy();

      const inspection = await apiRequest<{ eventId: string; result: string }>(
        baseUrl,
        `/api/mes/work-orders/${orderId}/inspections`,
        {
          method: 'POST',
          headers: jsonHeaders(token),
          body: JSON.stringify({
            stepId: firstStep.stepId,
            result: 'pass',
            quantity: 5,
          }),
        },
      );
      expect(inspection.status).toBe(201);
      expect(inspection.body.result).toBe('pass');
      expect(inspection.body.eventId).toBeTruthy();

      for (const action of ['review', 'handover']) {
        const stepState = await apiRequest(
          baseUrl,
          `/api/mes/work-orders/${orderId}/steps/${firstStep.stepId}/state?action=${action}`,
          {
            method: 'POST',
            headers: jsonHeaders(token),
            body: JSON.stringify({ decision: 'approved', receiver: 'next-station' }),
          },
        );
        expect(stepState.status).toBe(201);
      }
      for (const action of ['start', 'report', 'review', 'handover']) {
        const isMobileStart = action === 'start';
        const endpoint = isMobileStart
          ? `/api/mobile/workbench/orders/${orderId}/steps/${secondStep.stepId}/state?action=${action}`
          : `/api/mes/work-orders/${orderId}/steps/${secondStep.stepId}/state?action=${action}`;
        const stepState = await apiRequest(
          baseUrl,
          endpoint,
          {
            method: 'POST',
            headers: jsonHeaders(token),
            body: JSON.stringify({ quantity: 5 }),
          },
        );
        expect(stepState.status).toBe(201);
      }

      const completed = await apiRequest(
        baseUrl,
        `/api/mes/work-orders/${orderId}/state?action=complete`,
        {
          method: 'POST',
          headers: jsonHeaders(token),
          body: '{}',
        },
      );
      expect(completed.status).toBe(201);
      expect((completed.body as { status: string }).status).toBe('completed');

      const trace = await apiRequest<{
        nodes: Array<{ type: string }>;
        links: Array<{ type: string }>;
      }>(baseUrl, `/api/mes/work-orders/${orderId}/trace`, {
        headers: jsonHeaders(token),
      });
      expect(trace.status).toBe(200);
      expect(trace.body.nodes.some((node) => node.type === 'work_order')).toBe(true);
      expect(trace.body.nodes.some((node) => node.type === 'inspection')).toBe(true);
      expect(trace.body.nodes.some((node) => node.type === 'material')).toBe(true);
      expect(trace.body.links.some((link) => link.type === 'inspected')).toBe(true);

      const orderRows = await owner!.unsafe<
        Array<{ schedule_task_id: string; status: string; source: string; org_id: string }>
      >(
        `select schedule_task_id, status, source, org_id::text
         from public.ewoh_schedule_task
         where schedule_task_id = $1`,
        [orderId],
      );
      expect(orderRows).toHaveLength(1);
      expect(orderRows[0].status).toBe('completed');
      expect(orderRows[0].source).toBe('mes');
      expect(orderRows[0].org_id).toBe(fixture!.orgA.id);

      const stepRows = await owner!.unsafe<
        Array<{ status: string; org_id: string }>
      >(
        `select status, org_id::text
         from public.ewoh_schedule_task_step
         where schedule_task_id = $1`,
        [orderId],
      );
      expect(stepRows).toHaveLength(2);
      expect(stepRows.every((row) => row.status === 'handed_over')).toBe(true);
      expect(stepRows.every((row) => row.org_id === fixture!.orgA.id)).toBe(true);

      const materialRows = await owner!.unsafe<
        Array<{ binding_type: string; quantity: string; org_id: string }>
      >(
        `select binding_type, quantity::text, org_id::text
         from public.ewoh_resource_binding
         where target_id = $1 and binding_type = 'material_consumption'`,
        [orderId],
      );
      expect(materialRows).toHaveLength(1);
      expect(Number(materialRows[0].quantity)).toBe(2);
      expect(materialRows[0].org_id).toBe(fixture!.orgA.id);

      const eventRows = await owner!.unsafe<
        Array<{ event_code: string; org_id: string }>
      >(
        `select event_code, org_id::text
         from public.ewoh_event
         where event_id = $1`,
        [inspection.body.eventId],
      );
      expect(eventRows).toHaveLength(1);
      expect(eventRows[0].event_code).toBe('QUALITY_INSPECTION');
      expect(eventRows[0].org_id).toBe(fixture!.orgA.id);
    });

    it('records device status, calculates OEE, and escalates andon SLA', async () => {
      const dispatcher = await login(
        baseUrl,
        fixture!.dispatcherA.username,
        fixture!.dispatcherA.password,
      );
      expect(dispatcher.status).toBe(201);
      const token = dispatcher.body.accessToken;
      const deviceId = `EXO-OEE-${runId}`;
      const start = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const end = new Date(Date.now() + 60 * 60 * 1000).toISOString();

      const statuses = [
        { status: 'running', startedAt: new Date(Date.now() - 200_000).toISOString(), endedAt: new Date(Date.now() - 140_000).toISOString() },
        { status: 'fault', startedAt: new Date(Date.now() - 140_000).toISOString(), endedAt: new Date(Date.now() - 110_000).toISOString() },
        { status: 'idle', startedAt: new Date(Date.now() - 110_000).toISOString(), endedAt: new Date(Date.now() - 100_000).toISOString() },
      ];
      for (const status of statuses) {
        const recorded = await apiRequest(
          baseUrl,
          '/api/oee/device-status',
          {
            method: 'POST',
            headers: jsonHeaders(token),
            body: JSON.stringify({ deviceId, ...status }),
          },
        );
        expect(recorded.status).toBe(201);
      }

      const oee = await apiRequest<{
        availability: number;
        oee: number;
        downtimeBreakdown: Array<{ reason: string; seconds: number }>;
      }>(
        baseUrl,
        `/api/oee/calculate?deviceId=${deviceId}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&plannedTimeSec=100`,
        {
          method: 'POST',
          headers: jsonHeaders(token),
        },
      );
      expect(oee.status).toBe(201);
      expect(oee.body.availability).toBeCloseTo(0.6, 3);
      expect(oee.body.oee).toBeCloseTo(0.6, 3);
      expect(oee.body.downtimeBreakdown[0].reason).toBe('fault');

      const andon = await apiRequest<{ eventId: string; status: string }>(
        baseUrl,
        '/api/oee/andons',
        {
          method: 'POST',
          headers: jsonHeaders(token),
          body: JSON.stringify({
            deviceId,
            title: `安灯测试 ${runId}`,
            reason: '缺料',
            slaSeconds: -1,
            assignee: 'dispatcher',
          }),
        },
      );
      expect(andon.status).toBe(201);
      expect(andon.body.status).toBe('open');
      const andonId = andon.body.eventId;

      const acknowledged = await apiRequest<{ status: string }>(
        baseUrl,
        `/api/oee/andons/${andonId}/state?action=acknowledge`,
        {
          method: 'POST',
          headers: jsonHeaders(token),
          body: '{}',
        },
      );
      expect(acknowledged.status).toBe(201);
      expect(acknowledged.body.status).toBe('acknowledged');

      const notificationRows = await owner!.unsafe<
        Array<{ notification_id: string; org_id: string; external_ref: string }>
      >(
        `select notification_id, org_id::text, external_ref
         from public.ewoh_notification
         where external_ref = $1`,
        [andonId],
      );
      expect(notificationRows).toHaveLength(1);
      expect(notificationRows[0].org_id).toBe(fixture!.orgA.id);

      for (const action of ['process', 'close']) {
        const transition = await apiRequest(
          baseUrl,
          `/api/oee/andons/${andonId}/state?action=${action}`,
          {
            method: 'POST',
            headers: jsonHeaders(token),
            body: '{}',
          },
        );
        expect(transition.status).toBe(201);
      }

      const andonRows = await owner!.unsafe<
        Array<{ event_id: string; status: string; org_id: string }>
      >(
        `select event_id, status, org_id::text
         from public.ewoh_event
         where event_id = $1`,
        [andonId],
      );
      expect(andonRows).toHaveLength(1);
      expect(andonRows[0].status).toBe('closed');
      expect(andonRows[0].org_id).toBe(fixture!.orgA.id);
    });

    it('receives ERP orders idempotently and tracks outbound acknowledgments', async () => {
      const dispatcher = await login(
        baseUrl,
        fixture!.dispatcherA.username,
        fixture!.dispatcherA.password,
      );
      expect(dispatcher.status).toBe(201);
      const token = dispatcher.body.accessToken;
      const externalOrderId = `SO-E2E-${runId}`;
      const outboundId = `OB-E2E-${runId}`;

      const first = await apiRequest<{
        duplicate: boolean;
        order: { eventId: string };
        workOrderId: string;
      }>(baseUrl, '/api/erp/orders', {
        method: 'POST',
        headers: jsonHeaders(token),
        body: JSON.stringify({
          externalOrderId,
          productCode: 'ERP-PROD',
          quantity: 10,
          bom: [{ materialId: 'MAT-ERP', quantity: 2 }],
        }),
      });
      expect(first.status).toBe(201);
      expect(first.body.duplicate).toBe(false);
      expect(first.body.workOrderId).toBeTruthy();

      const second = await apiRequest<{
        duplicate: boolean;
        order: { eventId: string };
      }>(baseUrl, '/api/erp/orders', {
        method: 'POST',
        headers: jsonHeaders(token),
        body: JSON.stringify({
          externalOrderId,
          productCode: 'ERP-PROD',
          quantity: 10,
        }),
      });
      expect(second.status).toBe(201);
      expect(second.body.duplicate).toBe(true);
      expect(second.body.order.eventId).toBe(first.body.order.eventId);

      const queued = await apiRequest<{
        duplicate: boolean;
        outbound: { eventId: string; status: string };
      }>(baseUrl, '/api/erp/outbound', {
        method: 'POST',
        headers: jsonHeaders(token),
        body: JSON.stringify({
          outboundId,
          type: 'production_report',
          externalOrderId,
          payload: { quantity: 10 },
        }),
      });
      expect(queued.status).toBe(201);
      expect(queued.body.duplicate).toBe(false);
      expect(queued.body.outbound.status).toBe('pending');

      const acked = await apiRequest<{ status: string }>(
        baseUrl,
        `/api/erp/outbound/${queued.body.outbound.eventId}/ack`,
        {
          method: 'POST',
          headers: jsonHeaders(token),
          body: JSON.stringify({ success: true }),
        },
      );
      expect(acked.status).toBe(201);
      expect(acked.body.status).toBe('sent');

      const reconcile = await apiRequest<{
        orders: { total: number; byStatus: Record<string, number> };
        outbound: { total: number; byStatus: Record<string, number> };
        completedErpWorkOrders: number;
      }>(baseUrl, '/api/erp/reconcile', {
        method: 'POST',
        headers: jsonHeaders(token),
      });
      expect(reconcile.status).toBe(201);
      expect(reconcile.body.orders.total).toBeGreaterThanOrEqual(1);
      expect(reconcile.body.outbound.total).toBeGreaterThanOrEqual(1);
      expect(reconcile.body.outbound.byStatus.sent).toBeGreaterThanOrEqual(1);
      expect(reconcile.body.completedErpWorkOrders).toBe(0);

      const orderRows = await owner!.unsafe<
        Array<{ event_id: string; org_id: string }>
      >(
        `select event_id, org_id::text
         from public.ewoh_event
         where event_id = $1`,
        [first.body.order.eventId],
      );
      expect(orderRows).toHaveLength(1);
      expect(orderRows[0].org_id).toBe(fixture!.orgA.id);

      const workOrderRows = await owner!.unsafe<
        Array<{ schedule_task_id: string; source: string; org_id: string }>
      >(
        `select schedule_task_id, source, org_id::text
         from public.ewoh_schedule_task
         where schedule_task_id = $1`,
        [first.body.workOrderId],
      );
      expect(workOrderRows).toHaveLength(1);
      expect(workOrderRows[0].source).toBe('erp');
      expect(workOrderRows[0].org_id).toBe(fixture!.orgA.id);
    });

    it('registers and publishes a factory template, then installs a profile and asset package', async () => {
      const dispatcher = await login(
        baseUrl,
        fixture!.dispatcherA.username,
        fixture!.dispatcherA.password,
      );
      expect(dispatcher.status).toBe(201);
      const token = dispatcher.body.accessToken;
      const templateId = `TPL-E2E-${runId}`;

      const registered = await apiRequest<{
        templateId: string;
        lifecycleStatus: string;
      }>(baseUrl, '/api/scale/templates', {
        method: 'POST',
        headers: jsonHeaders(token),
        body: JSON.stringify({
          templateId,
          name: 'E2E 离散机加工模板',
          industry: 'discrete_machining',
          version: '1.0.0',
          compatibleCore: '>=0.6.0 <1.0.0',
          manifest: {
            modules: ['mes-p0', 'oee', 'andon'],
            scenarioPacks: ['mes-execution@1.x'],
          },
        }),
      });
      expect(registered.status).toBe(201);
      expect(registered.body.lifecycleStatus).toBe('draft');

      for (const action of ['review', 'certify', 'publish']) {
        const transition = await apiRequest<{ lifecycleStatus: string }>(
          baseUrl,
          `/api/scale/templates/${templateId}/state?action=${action}`,
          {
            method: 'POST',
            headers: jsonHeaders(token),
          },
        );
        expect(transition.status).toBe(201);
        expect(transition.body.lifecycleStatus).not.toBe('draft');
      }

      const installed = await apiRequest<{
        profileId: string;
        factoryName: string;
        status: string;
      }>(baseUrl, `/api/scale/templates/${templateId}/install`, {
        method: 'POST',
        headers: jsonHeaders(token),
        body: JSON.stringify({
          factoryName: 'E2E 工厂B',
          config: { shift: { count: 2 } },
        }),
      });
      expect(installed.status).toBe(201);
      expect(installed.body.status).toBe('installed');

      const diffPreview = await apiRequest<{
        templateId: string;
        mergedConfig: Record<string, unknown>;
        diff: { changed: string[]; added: string[] };
      }>(baseUrl, `/api/scale/templates/${templateId}/diff-preview`, {
        method: 'POST',
        headers: jsonHeaders(token),
        body: JSON.stringify({
          config: { shift: { count: 3 }, newFlag: true },
        }),
      });
      expect(diffPreview.status).toBe(201);
      expect(diffPreview.body.templateId).toBe(templateId);
      expect(
        (diffPreview.body.mergedConfig.shift as { count: number }).count,
      ).toBe(3);
      expect(diffPreview.body.mergedConfig.newFlag).toBe(true);
      expect(diffPreview.body.diff.added).toContain('shift');
      expect(diffPreview.body.diff.added).toContain('newFlag');
      expect(diffPreview.body.diff.changed).toEqual([]);

      const secondInstall = await apiRequest<{
        profileId: string;
        factoryName: string;
        status: string;
      }>(baseUrl, `/api/scale/templates/${templateId}/install`, {
        method: 'POST',
        headers: jsonHeaders(token),
        body: JSON.stringify({
          factoryName: 'E2E 工厂C',
          config: { shift: { count: 3 } },
        }),
      });
      expect(secondInstall.status).toBe(201);
      expect(secondInstall.body.profileId).not.toBe(installed.body.profileId);
      expect(secondInstall.body.status).toBe('installed');

      const thirdInstall = await apiRequest<{
        profileId: string;
        factoryName: string;
        status: string;
      }>(baseUrl, `/api/scale/templates/${templateId}/install`, {
        method: 'POST',
        headers: jsonHeaders(token),
        body: JSON.stringify({
          factoryName: 'E2E 配置工厂D',
          config: { shift: { count: 4 }, upgradeRing: 'small' },
        }),
      });
      expect(thirdInstall.status).toBe(201);
      expect(thirdInstall.body.profileId).not.toBe(installed.body.profileId);
      expect(thirdInstall.body.profileId).not.toBe(secondInstall.body.profileId);
      expect(thirdInstall.body.status).toBe('installed');

      const thirdRows = await owner!.unsafe<
        Array<{
          status: string;
          config_json: { shift?: { count?: number }; upgradeRing?: string };
          org_id: string;
        }>
      >(
        `select status, config_json, org_id::text
         from public.ewoh_factory_profile
         where profile_id = $1`,
        [thirdInstall.body.profileId],
      );
      expect(thirdRows).toHaveLength(1);
      expect(thirdRows[0].status).toBe('installed');
      expect(thirdRows[0].config_json.shift?.count).toBe(4);
      expect(thirdRows[0].config_json.upgradeRing).toBe('small');
      expect(thirdRows[0].org_id).toBe(fixture!.orgA.id);

      const asset = await apiRequest<{ packageId: string; status: string }>(
        baseUrl,
        '/api/scale/assets',
        {
          method: 'POST',
          headers: jsonHeaders(token),
          body: JSON.stringify({
            packageId: `PKG-E2E-${runId}`,
            packageType: 'scenario',
            name: 'heavy-lifting-safety',
            version: '1.0.0',
            manifest: { requires: { connectors: ['exoskeleton-frame@1.x'] } },
          }),
        },
      );
      expect(asset.status).toBe(201);
      expect(asset.body.status).toBe('draft');

      const profiles = await apiRequest<Array<{ profileId: string }>>(
        baseUrl,
        '/api/scale/profiles',
        { headers: jsonHeaders(token) },
      );
      expect(profiles.status).toBe(200);
      expect(
        profiles.body.some((row) => row.profileId === installed.body.profileId),
      ).toBe(true);

      const assets = await apiRequest<Array<{ packageId: string }>>(
        baseUrl,
        '/api/scale/assets',
        { headers: jsonHeaders(token) },
      );
      expect(assets.status).toBe(200);
      expect(assets.body.some((row) => row.packageId === asset.body.packageId)).toBe(
        true,
      );

      const connector = await apiRequest<{
        packageId: string;
        packageType: string;
      }>(baseUrl, '/api/scale/connectors', {
        method: 'POST',
        headers: jsonHeaders(token),
        body: JSON.stringify({
          name: 'opcua-generic-machinery',
          version: '1.2.0',
          runtime: 'edge-python',
          protocol: 'opcua',
          outputEvents: ['DeviceStateChanged'],
        }),
      });
      expect(connector.status).toBe(201);
      expect(connector.body.packageType).toBe('connector');

      const scenarioPack = await apiRequest<{
        packageId: string;
        packageType: string;
      }>(baseUrl, '/api/scale/scenario-packs', {
        method: 'POST',
        headers: jsonHeaders(token),
        body: JSON.stringify({
          name: 'heavy-lifting-safety',
          version: '1.0.0',
          requires: { connectors: ['exoskeleton-frame@1.x'] },
          workflows: ['mes-execution', 'safety-monitoring'],
          policies: ['operator-safety'],
          acceptance: 'smoke',
        }),
      });
      expect(scenarioPack.status).toBe(201);
      expect(scenarioPack.body.packageType).toBe('scenario');

      const installedScenario = await apiRequest<{ status: string }>(
        baseUrl,
        `/api/scale/scenario-packs/${scenarioPack.body.packageId}/install`,
        {
          method: 'POST',
          headers: jsonHeaders(token),
        },
      );
      expect(installedScenario.status).toBe(201);
      expect(installedScenario.body.status).toBe('installed');

      const connectors = await apiRequest<Array<{ packageId: string }>>(
        baseUrl,
        '/api/scale/connectors',
        { headers: jsonHeaders(token) },
      );
      expect(connectors.status).toBe(200);
      expect(
        connectors.body.some((row) => row.packageId === connector.body.packageId),
      ).toBe(true);

      const scenarioPacks = await apiRequest<Array<{ packageId: string }>>(
        baseUrl,
        '/api/scale/scenario-packs',
        { headers: jsonHeaders(token) },
      );
      expect(scenarioPacks.status).toBe(200);
      expect(
        scenarioPacks.body.some(
          (row) => row.packageId === scenarioPack.body.packageId,
        ),
      ).toBe(true);

      const conformance = await apiRequest<{
        passed: boolean;
        checks: Array<{ check: string; passed: boolean }>;
      }>(baseUrl, `/api/scale/assets/${connector.body.packageId}/conformance`, {
        method: 'POST',
        headers: jsonHeaders(token),
      });
      expect(conformance.status).toBe(201);
      expect(conformance.body.passed).toBe(true);
      expect(
        conformance.body.checks.some(
          (check) => check.check === 'runtime' && check.passed,
        ),
      ).toBe(true);

      const replayed = await apiRequest<{
        profileId: string;
        status: string;
        configJson: Record<string, unknown>;
      }>(baseUrl, `/api/scale/profiles/${installed.body.profileId}/replay`, {
        method: 'POST',
        headers: jsonHeaders(token),
      });
      expect(replayed.status).toBe(201);
      expect(replayed.body.status).toBe('replayed');
      expect(replayed.body.configJson).toEqual({
        shift: { count: 2 },
      });

      const fleetUpgrade = await apiRequest<{
        packageId: string;
        updatedProfiles: number;
      }>(baseUrl, '/api/scale/fleet/upgrade', {
        method: 'POST',
        headers: jsonHeaders(token),
        body: JSON.stringify({ packageId: connector.body.packageId }),
      });
      expect(fleetUpgrade.status).toBe(201);
      expect(fleetUpgrade.body.updatedProfiles).toBeGreaterThanOrEqual(2);

      const fleetRollback = await apiRequest<{ rolledBackProfiles: number }>(
        baseUrl,
        '/api/scale/fleet/rollback',
        {
          method: 'POST',
          headers: jsonHeaders(token),
        },
      );
      expect(fleetRollback.status).toBe(201);
      expect(fleetRollback.body.rolledBackProfiles).toBeGreaterThanOrEqual(2);

      const templateRows = await owner!.unsafe<
        Array<{ template_id: string; lifecycle_status: string; org_id: string }>
      >(
        `select template_id, lifecycle_status, org_id::text
         from public.ewoh_factory_template
         where template_id = $1`,
        [templateId],
      );
      expect(templateRows).toHaveLength(1);
      expect(templateRows[0].lifecycle_status).toBe('published');
      expect(templateRows[0].org_id).toBe(fixture!.orgA.id);

      const profileRows = await owner!.unsafe<
        Array<{ profile_id: string; status: string; org_id: string }>
      >(
        `select profile_id, status, org_id::text
         from public.ewoh_factory_profile
         where profile_id = $1`,
        [installed.body.profileId],
      );
      expect(profileRows).toHaveLength(1);
      expect(profileRows[0].status).toBe('rolled_back');
      expect(profileRows[0].org_id).toBe(fixture!.orgA.id);

      const replayedRows = await owner!.unsafe<
        Array<{ status: string; org_id: string }>
      >(
        `select status, org_id::text
         from public.ewoh_factory_profile
         where profile_id = $1`,
        [installed.body.profileId],
      );
      expect(replayedRows).toHaveLength(1);
      expect(replayedRows[0].status).toBe('rolled_back');
      expect(replayedRows[0].org_id).toBe(fixture!.orgA.id);

      const fleetRows = await owner!.unsafe<
        Array<{ status: string; org_id: string }>
      >(
        `select status, org_id::text
         from public.ewoh_factory_profile
         where org_id = $1::uuid
         order by profile_id`,
        [fixture!.orgA.id],
      );
      expect(fleetRows.length).toBeGreaterThanOrEqual(2);
      expect(fleetRows.every((row) => row.status === 'rolled_back')).toBe(true);

      const shadowInstall = await apiRequest<{
        profileId: string;
        status: string;
      }>(baseUrl, `/api/scale/templates/${templateId}/install`, {
        method: 'POST',
        headers: jsonHeaders(token),
        body: JSON.stringify({
          factoryName: `Shadow Factory ${runId}`,
          config: { upgradeRing: 'shadow' },
        }),
      });
      expect(shadowInstall.status).toBe(201);
      expect(shadowInstall.body.status).toBe('installed');

      const ringUpgrade = await apiRequest<{
        targetRing: string;
        updatedProfiles: number;
        skippedProfiles: number;
      }>(baseUrl, '/api/scale/fleet/upgrade', {
        method: 'POST',
        headers: jsonHeaders(token),
        body: JSON.stringify({
          packageId: connector.body.packageId,
          ring: 'shadow',
        }),
      });
      expect(ringUpgrade.status).toBe(201);
      expect(ringUpgrade.body.targetRing).toBe('shadow');
      expect(ringUpgrade.body.updatedProfiles).toBeGreaterThanOrEqual(1);

      const shadowUpgradedRows = await owner!.unsafe<
        Array<{ status: string; org_id: string }>
      >(
        `select status, org_id::text
         from public.ewoh_factory_profile
         where profile_id = $1`,
        [shadowInstall.body.profileId],
      );
      expect(shadowUpgradedRows).toHaveLength(1);
      expect(shadowUpgradedRows[0].status).toBe('upgraded');
      expect(shadowUpgradedRows[0].org_id).toBe(fixture!.orgA.id);

      const ringRollback = await apiRequest<{
        targetRing: string;
        rolledBackProfiles: number;
      }>(baseUrl, '/api/scale/fleet/rollback', {
        method: 'POST',
        headers: jsonHeaders(token),
        body: JSON.stringify({ ring: 'shadow' }),
      });
      expect(ringRollback.status).toBe(201);
      expect(ringRollback.body.targetRing).toBe('shadow');
      expect(ringRollback.body.rolledBackProfiles).toBeGreaterThanOrEqual(1);

      const shadowRolledBackRows = await owner!.unsafe<
        Array<{ status: string }>
      >(
        `select status
         from public.ewoh_factory_profile
         where profile_id = $1`,
        [shadowInstall.body.profileId],
      );
      expect(shadowRolledBackRows).toHaveLength(1);
      expect(shadowRolledBackRows[0].status).toBe('rolled_back');

      const fleetStatus = await apiRequest<{
        factoryCount: number;
        statusCounts: Record<string, number>;
        profiles: Array<{ profileId: string; upgradeRing: string }>;
      }>(baseUrl, '/api/scale/fleet/status', {
        headers: jsonHeaders(token),
      });
      expect(fleetStatus.status).toBe(200);
      expect(fleetStatus.body.factoryCount).toBeGreaterThanOrEqual(2);
      expect(
        fleetStatus.body.profiles.some(
          (profile) => profile.profileId === shadowInstall.body.profileId,
        ),
      ).toBe(true);
      expect(
        fleetStatus.body.profiles.find(
          (profile) => profile.profileId === shadowInstall.body.profileId,
        )?.upgradeRing,
      ).toBe('shadow');
      expect(fleetStatus.body.statusCounts.rolled_back).toBeGreaterThanOrEqual(
        1,
      );

      const supportBundle = await apiRequest<{
        bundleId: string;
        includesSecrets: boolean;
        factoryCount: number;
        orgId: string | null;
      }>(baseUrl, '/api/scale/fleet/support-bundle', {
        method: 'POST',
        headers: jsonHeaders(token),
      });
      expect(supportBundle.status).toBe(201);
      expect(supportBundle.body.bundleId).toMatch(/^SB-/);
      expect(supportBundle.body.includesSecrets).toBe(false);
      expect(supportBundle.body.factoryCount).toBeGreaterThanOrEqual(2);
      expect(supportBundle.body.orgId).toBe(fixture!.orgA.id);

      const secondProfileRows = await owner!.unsafe<
        Array<{ profile_id: string; org_id: string }>
      >(
        `select profile_id, org_id::text
         from public.ewoh_factory_profile
         where profile_id = $1`,
        [secondInstall.body.profileId],
      );
      expect(secondProfileRows).toHaveLength(1);
      expect(secondProfileRows[0].org_id).toBe(fixture!.orgA.id);

      const assetRows = await owner!.unsafe<
        Array<{ package_id: string; org_id: string }>
      >(
        `select package_id, org_id::text
         from public.ewoh_asset_package
         where package_id = $1`,
        [asset.body.packageId],
      );
      expect(assetRows).toHaveLength(1);
      expect(assetRows[0].org_id).toBe(fixture!.orgA.id);

      const connectorRows = await owner!.unsafe<
        Array<{ package_id: string; org_id: string }>
      >(
        `select package_id, org_id::text
         from public.ewoh_asset_package
         where package_id = $1`,
        [connector.body.packageId],
      );
      expect(connectorRows).toHaveLength(1);
      expect(connectorRows[0].org_id).toBe(fixture!.orgA.id);

      const scenarioRows = await owner!.unsafe<
        Array<{ package_id: string; org_id: string }>
      >(
        `select package_id, org_id::text
         from public.ewoh_asset_package
         where package_id = $1`,
        [scenarioPack.body.packageId],
      );
      expect(scenarioRows).toHaveLength(1);
      expect(scenarioRows[0].org_id).toBe(fixture!.orgA.id);

      const uninstalled = await apiRequest<{ status: string }>(
        baseUrl,
        `/api/scale/scenario-packs/${scenarioPack.body.packageId}/uninstall`,
        {
          method: 'POST',
          headers: jsonHeaders(token),
        },
      );
      expect(uninstalled.status).toBe(201);
      expect(uninstalled.body.status).toBe('uninstalled');

      const uninstalledRows = await owner!.unsafe<
        Array<{ status: string; org_id: string }>
      >(
        `select status, org_id::text
         from public.ewoh_asset_package
         where package_id = $1`,
        [scenarioPack.body.packageId],
      );
      expect(uninstalledRows).toHaveLength(1);
      expect(uninstalledRows[0].status).toBe('uninstalled');
      expect(uninstalledRows[0].org_id).toBe(fixture!.orgA.id);

      const golden = await apiRequest<{
        specVersion: string;
        templateId: string;
        profileId: string;
        factoryName: string;
        connectors: string[];
        scenarioPacks: string[];
        reused: boolean;
      }>(baseUrl, '/api/scale/golden-factory/install', {
        method: 'POST',
        headers: jsonHeaders(token),
        body: JSON.stringify({
          factoryName: `Golden Factory ${runId}`,
        }),
      });
      expect(golden.status).toBe(201);
      expect(golden.body.specVersion).toBe('1.0.0');
      expect(golden.body.connectors).toHaveLength(3);
      expect(golden.body.scenarioPacks).toHaveLength(4);
      expect(golden.body.reused).toBe(false);

      const goldenAgain = await apiRequest<{
        profileId: string;
        reused: boolean;
      }>(baseUrl, '/api/scale/golden-factory/install', {
        method: 'POST',
        headers: jsonHeaders(token),
        body: JSON.stringify({
          factoryName: `Golden Factory ${runId}`,
        }),
      });
      expect(goldenAgain.status).toBe(201);
      expect(goldenAgain.body.reused).toBe(true);
      expect(goldenAgain.body.profileId).toBe(golden.body.profileId);

      const goldenTemplateRows = await owner!.unsafe<
        Array<{ lifecycle_status: string; org_id: string }>
      >(
        `select lifecycle_status, org_id::text
         from public.ewoh_factory_template
         where template_id = $1`,
        [golden.body.templateId],
      );
      expect(goldenTemplateRows).toHaveLength(1);
      expect(goldenTemplateRows[0].lifecycle_status).toBe('published');
      expect(goldenTemplateRows[0].org_id).toBe(fixture!.orgA.id);

      const goldenProfileRows = await owner!.unsafe<
        Array<{ status: string; org_id: string }>
      >(
        `select status, org_id::text
         from public.ewoh_factory_profile
         where profile_id = $1`,
        [golden.body.profileId],
      );
      expect(goldenProfileRows).toHaveLength(1);
      expect(goldenProfileRows[0].status).toBe('installed');
      expect(goldenProfileRows[0].org_id).toBe(fixture!.orgA.id);

      const goldenScenarioRows = await owner!.unsafe<
        Array<{ package_id: string; status: string }>
      >(
        `select package_id, status
         from public.ewoh_asset_package
         where package_id = any($1::text[])
         order by package_id`,
        [golden.body.scenarioPacks],
      );
      expect(goldenScenarioRows).toHaveLength(4);
      expect(
        goldenScenarioRows.every((row) => row.status === 'installed'),
      ).toBe(true);

      const mapping = await apiRequest<{
        packageId: string;
        packageType: string;
      }>(baseUrl, '/api/scale/mappings', {
        method: 'POST',
        headers: jsonHeaders(token),
        body: JSON.stringify({
          name: 'exoskeleton-telemetry-v1',
          version: '1.0.0',
          source: { system: 'exo-jsonl', schemaRef: 'ewoh:///schemas/exo-frame/v1' },
          target: { system: 'ewoh', schemaRef: 'ewoh:///schemas/telemetry/v1' },
          rules: [
            { from: 'entity_id', to: 'entityId', required: true },
            { from: 'load.total_kg', to: 'payload.load.totalKg' },
          ],
        }),
      });
      expect(mapping.status).toBe(201);
      expect(mapping.body.packageType).toBe('mapping');

      const mappingList = await apiRequest<Array<{ packageId: string }>>(
        baseUrl,
        '/api/scale/mappings',
        { headers: jsonHeaders(token) },
      );
      expect(mappingList.status).toBe(200);
      expect(
        mappingList.body.some((row) => row.packageId === mapping.body.packageId),
      ).toBe(true);

      const mappingDetail = await apiRequest<{ packageId: string }>(
        baseUrl,
        `/api/scale/mappings/${mapping.body.packageId}`,
        { headers: jsonHeaders(token) },
      );
      expect(mappingDetail.status).toBe(200);
      expect(mappingDetail.body.packageId).toBe(mapping.body.packageId);

      const mappingConformance = await apiRequest<{ passed: boolean }>(
        baseUrl,
        `/api/scale/assets/${mapping.body.packageId}/conformance`,
        {
          method: 'POST',
          headers: jsonHeaders(token),
        },
      );
      expect(mappingConformance.status).toBe(201);
      expect(mappingConformance.body.passed).toBe(true);

      const mappingRows = await owner!.unsafe<
        Array<{ package_id: string; org_id: string }>
      >(
        `select package_id, org_id::text
         from public.ewoh_asset_package
         where package_id = $1`,
        [mapping.body.packageId],
      );
      expect(mappingRows).toHaveLength(1);
      expect(mappingRows[0].org_id).toBe(fixture!.orgA.id);

      const legacyConnector = await apiRequest<{
        packageId: string;
        packageType: string;
      }>(baseUrl, '/api/scale/connectors', {
        method: 'POST',
        headers: jsonHeaders(token),
        body: JSON.stringify({
          name: 'legacy-connector',
          version: '0.5.0',
          runtime: 'edge-python',
          protocol: 'legacy',
          compatibility: { core: '>0.6.0' },
        }),
      });
      expect(legacyConnector.status).toBe(201);

      const compatibility = await apiRequest<{
        coreVersion: string;
        compatibleCount: number;
        incompatibleCount: number;
        assets: Array<{
          packageId: string;
          packageType: string;
          compatible: boolean;
          reason: string;
        }>;
      }>(baseUrl, '/api/scale/compatibility', {
        headers: jsonHeaders(token),
      });
      expect(compatibility.status).toBe(200);
      expect(compatibility.body.coreVersion).toBe('0.6.0-rc2');
      expect(
        compatibility.body.assets.find(
          (row) => row.packageId === legacyConnector.body.packageId,
        )?.compatible,
      ).toBe(false);
      expect(
        compatibility.body.assets.find(
          (row) => row.packageId === connector.body.packageId,
        )?.compatible,
      ).toBe(true);
      expect(compatibility.body.incompatibleCount).toBeGreaterThanOrEqual(1);

      const onboardingChecklist = await apiRequest<{
        version: string;
        steps: Array<{ code: string; name: string }>;
      }>(baseUrl, '/api/scale/onboarding/checklist', {
        headers: jsonHeaders(token),
      });
      expect(onboardingChecklist.status).toBe(200);
      expect(onboardingChecklist.body.steps).toHaveLength(7);
      expect(onboardingChecklist.body.steps[0].code).toBe('F0');

      const onboarding = await apiRequest<{
        runId: string;
        overall: string;
        profileId: string;
        supportBundleId: string;
        steps: Array<{ code: string; passed: boolean; detail?: string }>;
      }>(baseUrl, '/api/scale/onboarding/run', {
        method: 'POST',
        headers: jsonHeaders(token),
        body: JSON.stringify({
          factoryName: `Onboarding Factory ${runId}`,
        }),
      });
      expect(onboarding.status).toBe(201);
      expect(onboarding.body.overall).toBe('passed');
      expect(onboarding.body.steps).toHaveLength(7);
      expect(onboarding.body.steps.every((step) => step.passed)).toBe(true);
      expect(onboarding.body.supportBundleId).toMatch(/^SB-/);

      const onboardingProfileRows = await owner!.unsafe<
        Array<{ status: string; org_id: string }>
      >(
        `select status, org_id::text
         from public.ewoh_factory_profile
         where profile_id = $1`,
        [onboarding.body.profileId],
      );
      expect(onboardingProfileRows).toHaveLength(1);
      expect(onboardingProfileRows[0].status).toBe('installed');
      expect(onboardingProfileRows[0].org_id).toBe(fixture!.orgA.id);

      const partnerChecklist = await apiRequest<{
        partner: boolean;
        steps: Array<{ code: string }>;
      }>(baseUrl, '/api/scale/onboarding/partner/checklist', {
        headers: jsonHeaders(token),
      });
      expect(partnerChecklist.status).toBe(200);
      expect(partnerChecklist.body.partner).toBe(true);
      expect(partnerChecklist.body.steps).toHaveLength(7);

      const partnerRun = await apiRequest<{
        overall: string;
        partner: boolean;
        steps: Array<{ passed: boolean }>;
      }>(baseUrl, '/api/scale/onboarding/partner/shadow-run', {
        method: 'POST',
        headers: jsonHeaders(token),
        body: JSON.stringify({
          factoryName: `Partner Shadow ${runId}`,
        }),
      });
      expect(partnerRun.status).toBe(201);
      expect(partnerRun.body.overall).toBe('passed');
      expect(partnerRun.body.partner).toBe(true);
      expect(partnerRun.body.steps.every((step) => step.passed)).toBe(true);

      const scaleMetrics = await apiRequest<{
        templateCount: number;
        profileCount: number;
        assetPackageCount: number;
        publishedRate: number;
        ringCounts: Record<string, number>;
      }>(baseUrl, '/api/scale/metrics', {
        headers: jsonHeaders(token),
      });
      expect(scaleMetrics.status).toBe(200);
      expect(scaleMetrics.body.templateCount).toBeGreaterThanOrEqual(1);
      expect(scaleMetrics.body.profileCount).toBeGreaterThanOrEqual(2);
      expect(scaleMetrics.body.assetPackageCount).toBeGreaterThanOrEqual(3);
      expect(scaleMetrics.body.publishedRate).toBeGreaterThan(0);
      expect(scaleMetrics.body.ringCounts).toBeDefined();

      const difference = await apiRequest<{
        key: string;
        factoryName: string;
        status: string;
        updatedBy: string | null;
      }>(baseUrl, '/api/scale/differences', {
        method: 'POST',
        headers: jsonHeaders(token),
        body: JSON.stringify({
          factoryName: `Factory D ${runId}`,
          key: 'weighing',
          category: 'process',
          value: true,
        }),
      });
      expect(difference.status).toBe(201);
      expect(difference.body.status).toBe('open');
      expect(difference.body.factoryName).toBe(`Factory D ${runId}`);

      const differences = await apiRequest<
        Array<{ key: string; factoryName: string; status: string }>
      >(baseUrl, '/api/scale/differences', {
        headers: jsonHeaders(token),
      });
      expect(differences.status).toBe(200);
      expect(
        differences.body.some(
          (row) => row.key === difference.body.key && row.status === 'open',
        ),
      ).toBe(true);
    });

    it('persists approval instances, steps, and audit operations', async () => {
      const adminA = await login(
        baseUrl,
        fixture!.globalAdminA.username,
        fixture!.globalAdminA.password,
      );
      expect(adminA.status).toBe(201);
      const token = adminA.body.accessToken;
      const entityId = `T-${runId}`;

      const created = await apiRequest<{
        id: string;
        entityType: string;
        entityId: string;
        status: string;
        steps: Array<{ id: string; status: string }>;
        createdAt: string;
      }>(baseUrl, '/api/approvals', {
        method: 'POST',
        headers: jsonHeaders(token),
        body: JSON.stringify({
          entityType: 'production_task',
          entityId,
          roles: ['lead', 'safety'],
        }),
      });
      expect(created.status).toBe(201);
      expect(created.body.id).toBeTruthy();
      expect(created.body.entityType).toBe('production_task');
      expect(created.body.entityId).toBe(entityId);
      expect(created.body.steps).toHaveLength(2);

      const eventRows = await owner!.unsafe<
        Array<{
          event_id: string;
          event_type: string;
          title: string;
          status: string;
          org_id: string;
          evidence_json: {
            entityType: string;
            entityId: string;
            createdAt: string;
          };
        }>
      >(
        `select event_id, event_type, title, status, org_id::text, evidence_json
         from public.ewoh_event
         where event_id = $1 and event_type = 'approval_instance'`,
        [created.body.id],
      );
      expect(eventRows).toHaveLength(1);
      expect(eventRows[0].status).toBe('pending');
      expect(eventRows[0].org_id).toBe(fixture!.orgA.id);
      expect(eventRows[0].evidence_json).toEqual({
        entityType: 'production_task',
        entityId,
        createdAt: created.body.createdAt,
      });

      const chainRows = await owner!.unsafe<
        Array<{
          event_id: string;
          parent_event_id: string;
          causal_type: string;
          description: string;
          org_id: string;
        }>
      >(
        `select event_id, parent_event_id, causal_type, description, org_id::text
         from public.ewoh_event_chain
         where parent_event_id = $1 and causal_type = 'approval_step'
         order by created_at`,
        [created.body.id],
      );
      expect(chainRows).toHaveLength(2);
      expect(chainRows[0].parent_event_id).toBe(created.body.id);
      expect(chainRows[0].causal_type).toBe('approval_step');
      expect(chainRows[0].org_id).toBe(fixture!.orgA.id);
      for (const row of chainRows) {
        expect(JSON.parse(row.description)).toMatchObject({ status: 'pending' });
      }

      const fetched = await apiRequest<
        { id: string; status: string; steps: Array<{ status: string }> }
      >(baseUrl, `/api/approvals/${created.body.id}`, {
        headers: jsonHeaders(token),
      });
      expect(fetched.status).toBe(200);
      expect(fetched.body.id).toBe(created.body.id);
      expect(fetched.body.steps).toHaveLength(2);

      const stepId = created.body.steps[0].id;
      const approved = await apiRequest<{
        status: string;
        steps: Array<{ status: string }>;
      }>(
        baseUrl,
        `/api/approvals/${created.body.id}/steps/${stepId}/state?action=approve`,
        {
          method: 'POST',
          headers: jsonHeaders(token),
          body: JSON.stringify({ reason: 'e2e approve' }),
        },
      );
      expect(approved.status).toBe(200);
      expect(approved.body.status).toBe('pending');
      expect(approved.body.steps[0].status).toBe('approved');

      const auditRows = await owner!.unsafe<
        Array<{
          action: string;
          entity_type: string;
          entity_id: string;
          org_id: string;
          before_json: { stepStatus: string } | null;
          after_json: { stepStatus: string } | null;
        }>
      >(
        `select action, entity_type, entity_id, org_id::text, before_json, after_json
         from public.ewoh_audit_log
         where entity_type = 'approval' and entity_id = $1
         order by audit_seq`,
        [created.body.id],
      );
      expect(auditRows.length).toBeGreaterThanOrEqual(1);
      expect(auditRows.every((row) => row.org_id === fixture!.orgA.id)).toBe(true);
      const approveAudit = auditRows.find((row) => row.action === 'approval.approve');
      expect(approveAudit).toBeTruthy();
      expect(approveAudit?.before_json).toMatchObject({ stepStatus: 'pending' });
      expect(approveAudit?.after_json).toMatchObject({ stepStatus: 'approved' });
    });

    it('reuses scheduler plans for the same idempotency key', async () => {
      const dispatcher = await login(
        baseUrl,
        fixture!.dispatcherA.username,
        fixture!.dispatcherA.password,
      );
      expect(dispatcher.status).toBe(201);
      const token = dispatcher.body.accessToken;
      const idempotencyKey = `e2e-plan-${runId}`;
      const body = JSON.stringify({ idempotencyKey });

      const first = await apiRequest<Array<{ planId: string }>>(
        baseUrl,
        '/api/scheduler/plans',
        {
          method: 'POST',
          headers: jsonHeaders(token),
          body,
        },
      );
      expect(first.status).toBe(201);
      expect(Array.isArray(first.body)).toBe(true);
      expect(first.body.length).toBeGreaterThan(0);

      const second = await apiRequest<Array<{ planId: string }>>(
        baseUrl,
        '/api/scheduler/plans',
        {
          method: 'POST',
          headers: jsonHeaders(token),
          body,
        },
      );
      expect(second.status).toBe(201);
      expect(second.body.map((plan) => plan.planId).sort()).toEqual(
        first.body.map((plan) => plan.planId).sort(),
      );
    });

    it('keeps system config rows org-scoped and unreadable by org B users', async () => {
      const adminA = await login(
        baseUrl,
        fixture!.globalAdminA.username,
        fixture!.globalAdminA.password,
      );
      expect(adminA.status).toBe(201);

      const configKey = `e2e.org.${runId}`;
      const set = await apiRequest(baseUrl, `/api/system/config/${configKey}`, {
        method: 'PUT',
        headers: jsonHeaders(adminA.body.accessToken),
        body: JSON.stringify({
          configValue: { scope: 'org-a-only', ok: true },
        }),
      });
      expect(set.status).toBe(200);

      const viewerB = await login(
        baseUrl,
        fixture!.viewerB.username,
        fixture!.viewerB.password,
      );
      expect(viewerB.status).toBe(201);
      const hidden = await apiRequest(
        baseUrl,
        `/api/system/config/${configKey}`,
        { headers: jsonHeaders(viewerB.body.accessToken) },
      );
      expect(hidden.status).toBe(403);

      const own = await apiRequest<{ configKey: string; configValue: unknown }>(
        baseUrl,
        `/api/system/config/${configKey}`,
        { headers: jsonHeaders(adminA.body.accessToken) },
      );
      expect(own.status).toBe(200);
      expect(own.body.configKey).toBe(configKey);
      expect(own.body.configValue).toEqual({ scope: 'org-a-only', ok: true });

      const rows = await owner!.unsafe<Array<{ org_id: string }>>(
        `select org_id::text
         from public.ewoh_scheduler_config
         where config_key = $1`,
        [configKey],
      );
      expect(rows.map((row) => row.org_id)).toEqual([fixture!.orgA.id]);
    });
  });
}
