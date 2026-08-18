import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { ewohEvent, ewohNotification } from '@server/database/schema';
import { AuditService } from '../shared/audit.service';
import { parseDateInput } from '../shared/parse-date-input';
import type { OrgContext } from '../shared/org-context.interceptor';
import { insertAndonNotifications } from '../notification/andon-notifications';
import { alertActionToState, alertStateTransitionAllowed } from '@shared/alert-state-machine';
import { buildEventEnvelope, envelopeForEvidence } from '@shared/event-envelope';
import { normalizeEventSeverity } from '@shared/risk';

export type DeviceStatus =
  | 'running'
  | 'idle'
  | 'fault'
  | 'changeover'
  | 'material_missing'
  | 'unmanned';

const DEVICE_STATUS_VALUES: DeviceStatus[] = [
  'running',
  'idle',
  'fault',
  'changeover',
  'material_missing',
  'unmanned',
];

const SEVERITY_BY_STATUS: Record<DeviceStatus, string> = {
  running: 'L1',
  idle: 'L1',
  fault: 'L3',
  changeover: 'L2',
  material_missing: 'L2',
  unmanned: 'L1',
};

/**
 * ADR-031：andon 处置复用 shared/alert-state-machine（alert.yaml 单一
 * 事实源）；保留函数名兼容既有调用方。reopen 角色条件（safety_admin）
 * 机器强制。
 */
export function nextAndonStatus(
  current: string,
  action: string,
  actorRole?: string,
): string | null {
  const target = alertActionToState(action);
  if (!target) return null;
  return alertStateTransitionAllowed(current, target.to, actorRole)
    ? target.to
    : null;
}

export interface OeeMetrics {
  availability: number;
  /** NEST-634：缺 outputQty / idealRatePerSec 输入时显式 null（不再默认 1 掩盖缺口）。 */
  performance: number | null;
  quality: number;
  /** performance 证据缺失时 OEE 同为 null（缺一项即不可信，绝不伪造）。 */
  oee: number | null;
  statusDurations: Record<string, number>;
  downtimeBreakdown: Array<{ reason: string; seconds: number }>;
}

export function computeOee(
  statusEvents: Array<{ evidenceJson?: unknown }>,
  plannedTimeSec: number,
): OeeMetrics {
  const durations: Record<string, number> = {};
  let runningSec = 0;
  let totalOutput = 0;
  let idealCapacity = 0;
  let hasOutputQty = false;
  let hasIdealRate = false;
  for (const event of statusEvents) {
    const evidence = (event.evidenceJson as Record<string, unknown> | null) ?? {};
    const status = String(evidence.status ?? 'idle');
    const duration = Math.max(0, Number(evidence.durationSec ?? 0));
    durations[status] = (durations[status] ?? 0) + duration;
    if (status !== 'running') continue;
    runningSec += duration;
    const outputQty = Number(evidence.outputQty ?? Number.NaN);
    const idealRatePerSec = Number(evidence.idealRatePerSec ?? Number.NaN);
    if (Number.isFinite(outputQty)) {
      totalOutput += outputQty;
      hasOutputQty = true;
    }
    if (Number.isFinite(idealRatePerSec)) {
      idealCapacity += idealRatePerSec * duration;
      hasIdealRate = true;
    }
  }
  const availableSec =
    plannedTimeSec > 0
      ? plannedTimeSec
      : Object.values(durations).reduce((sum, value) => sum + value, 0);
  const availability = availableSec > 0 ? Math.min(1, runningSec / availableSec) : 0;
  // NEST-634：性能指标仅在产出与理想速率证据齐备时计算；缺失 → null。
  const performance =
    hasOutputQty && hasIdealRate && idealCapacity > 0
      ? Math.min(1, Math.max(0, totalOutput / idealCapacity))
      : null;
  const quality = 1;
  const downtimeBreakdown = Object.entries(durations)
    .filter(([status]) => status !== 'running')
    .map(([status, seconds]) => ({ reason: status, seconds }))
    .sort((left, right) => right.seconds - left.seconds);
  return {
    availability,
    performance,
    quality,
    oee: performance == null ? null : availability * performance * quality,
    statusDurations: durations,
    downtimeBreakdown,
  };
}

@Injectable()
export class OeeService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly auditService: AuditService,
  ) {}

  /**
   * NEST-601~604（2026-08-17 审计整改）：oee 读写全部带 org 谓词；
   * 事件写入显式 orgId（缺租户上下文 fail-closed）。
   */
  private requireOrgId(actor?: OrgContext): string {
    const orgId = actor?.primaryOrgId?.trim();
    if (!orgId) {
      throw new BadRequestException(
        'org context missing: oee operations require tenant context',
      );
    }
    return orgId;
  }

  private orgCondition(actor?: OrgContext) {
    if (actor?.isGlobalAdmin) {
      return undefined;
    }
    return eq(ewohEvent.orgId, this.requireOrgId(actor));
  }

  async recordDeviceStatus(
    body: {
      deviceId: string;
      status: DeviceStatus;
      reason?: string;
      startedAt?: string;
      endedAt?: string;
      sourceType?: string;
      outputQty?: number;
      idealRatePerSec?: number;
    },
    actor?: OrgContext,
  ) {
    if (!body.deviceId?.trim() || !DEVICE_STATUS_VALUES.includes(body.status)) {
      throw new BadRequestException(
        `deviceId and one of ${DEVICE_STATUS_VALUES.join(', ')} are required`,
      );
    }
    // NEST-602：事件行显式 orgId（NULL 行=全租户可见，禁止）。
    const orgId = this.requireOrgId(actor);
    // P1（2026-08-19 审计）：日期入参显式校验（原 Invalid Date → 稳定 500）。
    const startedAt = parseDateInput(body.startedAt, 'startedAt') ?? new Date();
    const endedAt = parseDateInput(body.endedAt, 'endedAt');
    const durationSec =
      endedAt && startedAt.getTime() <= endedAt.getTime()
        ? Math.round((endedAt.getTime() - startedAt.getTime()) / 1000)
        : 0;
    const eventId = `ST-${randomUUID().slice(0, 8)}`;
    const evidenceJson = {
      deviceId: body.deviceId,
      status: body.status,
      reason: body.reason ?? null,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt?.toISOString() ?? null,
      durationSec,
      outputQty: body.outputQty ?? null,
      idealRatePerSec: body.idealRatePerSec ?? null,
      sourceType: body.sourceType ?? 'simulated',
    };
    const [row] = await this.db
      .insert(ewohEvent)
      .values({
        eventId,
        deviceId: body.deviceId,
        eventCode: 'DEVICE_STATUS',
        eventType: 'device_status',
        severity: SEVERITY_BY_STATUS[body.status],
        title: `设备状态-${body.status}`,
        status: 'closed',
        createdAt: startedAt,
        sourceType: body.sourceType ?? 'simulated',
        orgId,
        evidenceJson,
      })
      .returning();
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId,
      action: 'oee.device_status.record',
      entityType: 'event',
      entityId: eventId,
      before: null,
      after: { deviceId: body.deviceId, status: body.status, durationSec },
    });
    return row;
  }

  async listDeviceStatus(
    deviceId?: string,
    start?: string,
    end?: string,
    actor?: OrgContext,
    limit = 200,
  ) {
    // NEST-604：org 过滤 + LIMIT（原先无界全表）。
    const conditions = [eq(ewohEvent.eventType, 'device_status')];
    const orgCond = this.orgCondition(actor);
    if (orgCond) conditions.push(orgCond);
    if (deviceId) conditions.push(eq(ewohEvent.deviceId, deviceId));
    if (start) conditions.push(gte(ewohEvent.createdAt, new Date(start)));
    if (end) conditions.push(lte(ewohEvent.createdAt, new Date(end)));
    const safeLimit = Math.min(Math.max(1, Math.trunc(limit)), 500);
    return this.db
      .select()
      .from(ewohEvent)
      .where(and(...conditions))
      .orderBy(desc(ewohEvent.createdAt))
      .limit(safeLimit);
  }

  async calculateOee(
    deviceId: string,
    start: string,
    end: string,
    plannedTimeSec: number,
    actor?: OrgContext,
  ) {
    const statusEvents = await this.listDeviceStatus(deviceId, start, end, actor);
    const metrics = computeOee(statusEvents, plannedTimeSec);
    // NEST-601：质量事件按 deviceId + orgId 过滤（原先全设备全租户）。
    const qualityConditions = [
      eq(ewohEvent.eventType, 'quality'),
      eq(ewohEvent.deviceId, deviceId),
      gte(ewohEvent.createdAt, new Date(start)),
      lte(ewohEvent.createdAt, new Date(end)),
    ];
    const qualityOrgCond = this.orgCondition(actor);
    if (qualityOrgCond) qualityConditions.push(qualityOrgCond);
    const qualityRows = await this.db
      .select()
      .from(ewohEvent)
      .where(and(...qualityConditions));
    let quality = 1;
    if (qualityRows.length > 0) {
      const passed = qualityRows.filter(
        (row) =>
          (row.evidenceJson as Record<string, unknown> | null)?.result === 'pass',
      ).length;
      quality = passed / qualityRows.length;
    }
    metrics.quality = Number(quality.toFixed(4));
    metrics.oee =
      metrics.performance == null
        ? null
        : Number(
            (
              metrics.availability *
              metrics.performance *
              metrics.quality
            ).toFixed(4),
          );
    return {
      deviceId,
      start,
      end,
      plannedTimeSec,
      ...metrics,
    };
  }

  async openAndon(
    body: {
      deviceId: string;
      title: string;
      reason?: string;
      severity?: string;
      slaSeconds?: number;
      assignee?: string;
    },
    actor?: OrgContext,
  ) {
    if (!body.deviceId?.trim() || !body.title?.trim()) {
      throw new BadRequestException('deviceId and title are required');
    }
    // NEST-603：安灯事件行显式 orgId。
    const orgId = this.requireOrgId(actor);
    const eventId = `ANDON-${randomUUID().slice(0, 8)}`;
    const now = new Date();
    const nowIso = now.toISOString();
    // ADR-031 决策 2：Andon 开灯产出 AndonRaised 目录事件（envelope 嵌入
    // evidenceJson；level = canonical severity 词表 ADR-027；slaMinutes 派生）。
    const severity = normalizeEventSeverity(body.severity ?? 'high');
    const slaSeconds = body.slaSeconds ?? 900;
    const envelope = buildEventEnvelope({
      eventId: `EVT-${Math.floor(Date.now() / 1000)}-${randomUUID().slice(0, 8)}`,
      eventType: 'AndonRaised',
      occurredAt: nowIso,
      observedAt: nowIso,
      receivedAt: nowIso,
      source: 'cloud:oee',
      subject: eventId,
    });
    const envelopeRecord = envelopeForEvidence(envelope);
    const [row] = await this.db
      .insert(ewohEvent)
      .values({
        eventId,
        deviceId: body.deviceId,
        eventCode: 'ANDON',
        eventType: 'AndonRaised',
        severity,
        title: body.title.trim(),
        status: 'open',
        createdAt: now,
        sourceType: 'real',
        orgId,
        evidenceJson: {
          andonId: eventId,
          deviceId: body.deviceId,
          reason: body.reason ?? null,
          slaSeconds,
          slaMinutes: Math.ceil(slaSeconds / 60),
          level: severity,
          assignee: body.assignee ?? null,
          openedAt: nowIso,
          escalationLevel: 0,
          timeline: [{ at: nowIso, type: 'open', actor: actor?.userId ?? null }],
          envelope: envelopeRecord.envelope,
          envelopeSemantics: envelopeRecord.envelopeSemantics,
        },
      })
      .returning();
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId,
      action: 'oee.andon.open',
      entityType: 'event',
      entityId: eventId,
      before: null,
      after: { deviceId: body.deviceId, title: body.title },
    });
    // R-58 / ADR-037：安灯开灯 → 通知（app 恒建；lark 仅在 webhook 配置时建——
    // 未配置 = 渠道显式禁用，绝不建 doomed 行）。
    await this.createAndonNotifications(
      orgId,
      {
        recipientId: String(body.assignee ?? 'dispatcher'),
        externalRef: eventId,
        title: `安灯 ${body.title.trim()}`,
        body: `设备 ${body.deviceId} 安灯已开（${severity}）`,
        severity,
      },
    );
    return row;
  }

  async listAndons(actor?: OrgContext) {
    // ADR-031：canonical eventType=AndonRaised；历史行 'andon' 过渡兼容。
    // NEST-604：org 过滤 + LIMIT（原先无界全表）。
    const conditions = [inArray(ewohEvent.eventType, ['AndonRaised', 'andon'])];
    const orgCond = this.orgCondition(actor);
    if (orgCond) conditions.push(orgCond);
    return this.db
      .select()
      .from(ewohEvent)
      .where(and(...conditions))
      .orderBy(desc(ewohEvent.createdAt))
      .limit(500);
  }

  async transitionAndon(
    eventId: string,
    action: string,
    _body: Record<string, unknown> | undefined,
    actor?: OrgContext,
  ) {
    const orgCond = this.orgCondition(actor);
    const [row] = await this.db
      .select()
      .from(ewohEvent)
      .where(and(
        eq(ewohEvent.eventId, eventId),
        inArray(ewohEvent.eventType, ['AndonRaised', 'andon']),
        ...(orgCond ? [orgCond] : []),
      ));
    if (!row) {
      throw new NotFoundException(`Andon ${eventId} not found`);
    }
    const currentStatus = row.status ?? 'open';
    // SH-004 联动（W6 终态）：AccessTokenGuard 只挂 roles 数组（无单值
    // role），与 alert.service 的 nextAlertStatusForActor 同款遍历语义；
    // roleSatisfies 已 fail-closed，roles 为空（无角色信息）一律拒绝。
    let status: string | null = null;
    for (const role of actor?.roles ?? []) {
      status = nextAndonStatus(currentStatus, action, role);
      if (status) break;
    }
    if (!status) {
      throw new BadRequestException(
        `Transition ${action} not allowed from ${currentStatus}`,
      );
    }
    const now = new Date();
    const evidence = {
      ...((row.evidenceJson as Record<string, unknown> | null) ?? {}),
    };
    const timeline = Array.isArray(evidence.timeline)
      ? (evidence.timeline as Array<Record<string, unknown>>)
      : [];
    timeline.push({ at: now.toISOString(), type: action, actor: actor?.userId ?? null });
    evidence.timeline = timeline;
    let escalated = false;
    if (action === 'acknowledge' || action === 'process' || action === 'close') {
      const openedAt = new Date(String(evidence.openedAt ?? row.createdAt ?? now));
      const responseSec = Math.max(0, Math.round((now.getTime() - openedAt.getTime()) / 1000));
      if (!evidence.acknowledgedAt) {
        evidence.acknowledgedAt = now.toISOString();
        evidence.responseSec = responseSec;
      }
      if (action === 'close') {
        evidence.resolvedAt = now.toISOString();
        evidence.resolutionSec = responseSec;
      }
      const slaSeconds = Number(evidence.slaSeconds ?? 900);
      if (
        action === 'acknowledge' &&
        responseSec > slaSeconds &&
        Number(evidence.escalationLevel ?? 0) === 0
      ) {
        evidence.escalationLevel = 1;
        evidence.escalatedAt = now.toISOString();
        escalated = true;
      }
    }
    const [updated] = await this.db
      .update(ewohEvent)
      .set({
        status,
        evidenceJson: evidence,
        handlerAction: action,
      })
      .where(
        and(
          eq(ewohEvent.eventId, eventId),
          eq(ewohEvent.status, currentStatus),
          ...(orgCond ? [orgCond] : []),
        ),
      )
      .returning();
    if (!updated) {
      throw new ConflictException('STATE_CONFLICT');
    }
    if (escalated) {
      // R-58 / ADR-037：SLA 升级通知（app 恒建 + lark 配置时建；orgId 修复——
      // 此前缺 orgId 导致租户作用域查询不可见，§15）。
      await this.createAndonNotifications(this.requireOrgId(actor), {
        recipientId: String(evidence.assignee ?? 'dispatcher'),
        externalRef: eventId,
        title: `安灯SLA升级 ${row.title}`,
        body: `设备 ${row.deviceId} 安灯响应超过 SLA，请立即处理`,
        severity: row.severity ?? 'high',
      });
    }
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: this.requireOrgId(actor),
      action: `oee.andon.${action}`,
      entityType: 'event',
      entityId: eventId,
      before: { status: currentStatus },
      after: { status: updated.status, escalated },
    });
    return updated;
  }

  /**
   * R-58 / ADR-037 + ADR-040：安灯通知创建（共享助手 insertAndonNotifications：
   * app 恒建 + lark 配置时建；orgId 租户作用域 §15；externalRef 指向
   * Andon 事件主事实）。oee 与 ingest 边缘投影共用同一语义（§31）。
   */
  private async createAndonNotifications(
    orgId: string | null,
    input: {
      recipientId: string;
      externalRef: string;
      title: string;
      body: string;
      severity: string;
    },
  ): Promise<void> {
    await insertAndonNotifications(this.db, orgId, input);
  }

  async getSummary(deviceId: string, start: string, end: string, actor?: OrgContext) {
    const oee = await this.calculateOee(deviceId, start, end, 0, actor);
    const andons = await this.listAndons(actor);
    const openAndons = andons.filter((event) =>
      ['open', 'acknowledged', 'processing', 'reopened'].includes(
        event.status ?? 'open',
      ),
    );
    return {
      deviceId,
      start,
      end,
      oee,
      andon: {
        total: andons.length,
        open: openAndons.length,
      },
    };
  }
}
