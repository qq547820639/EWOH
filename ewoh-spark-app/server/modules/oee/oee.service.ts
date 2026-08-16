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
  performance: number;
  quality: number;
  oee: number;
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
  let performance = 1;
  if (hasOutputQty && hasIdealRate && idealCapacity > 0) {
    performance = Math.min(1, Math.max(0, totalOutput / idealCapacity));
  }
  const quality = 1;
  const downtimeBreakdown = Object.entries(durations)
    .filter(([status]) => status !== 'running')
    .map(([status, seconds]) => ({ reason: status, seconds }))
    .sort((left, right) => right.seconds - left.seconds);
  return {
    availability,
    performance,
    quality,
    oee: availability * performance * quality,
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
    const startedAt = body.startedAt ? new Date(body.startedAt) : new Date();
    const endedAt = body.endedAt ? new Date(body.endedAt) : null;
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
        evidenceJson,
      })
      .returning();
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: 'oee.device_status.record',
      entityType: 'event',
      entityId: eventId,
      before: null,
      after: { deviceId: body.deviceId, status: body.status, durationSec },
    });
    return row;
  }

  async listDeviceStatus(deviceId?: string, start?: string, end?: string) {
    const conditions = [eq(ewohEvent.eventType, 'device_status')];
    if (deviceId) conditions.push(eq(ewohEvent.deviceId, deviceId));
    if (start) conditions.push(gte(ewohEvent.createdAt, new Date(start)));
    if (end) conditions.push(lte(ewohEvent.createdAt, new Date(end)));
    return this.db
      .select()
      .from(ewohEvent)
      .where(and(...conditions))
      .orderBy(desc(ewohEvent.createdAt));
  }

  async calculateOee(
    deviceId: string,
    start: string,
    end: string,
    plannedTimeSec: number,
  ) {
    const statusEvents = await this.listDeviceStatus(deviceId, start, end);
    const metrics = computeOee(statusEvents, plannedTimeSec);
    const qualityRows = await this.db
      .select()
      .from(ewohEvent)
      .where(
        and(
          eq(ewohEvent.eventType, 'quality'),
          gte(ewohEvent.createdAt, new Date(start)),
          lte(ewohEvent.createdAt, new Date(end)),
        ),
      );
    let quality = 1;
    if (qualityRows.length > 0) {
      const passed = qualityRows.filter(
        (row) =>
          (row.evidenceJson as Record<string, unknown> | null)?.result === 'pass',
      ).length;
      quality = passed / qualityRows.length;
    }
    metrics.quality = Number(quality.toFixed(4));
    metrics.oee = Number(
      (metrics.availability * metrics.performance * metrics.quality).toFixed(4),
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
      orgId: actor?.primaryOrgId ?? '',
      action: 'oee.andon.open',
      entityType: 'event',
      entityId: eventId,
      before: null,
      after: { deviceId: body.deviceId, title: body.title },
    });
    // R-58 / ADR-037：安灯开灯 → 通知（app 恒建；lark 仅在 webhook 配置时建——
    // 未配置 = 渠道显式禁用，绝不建 doomed 行）。
    await this.createAndonNotifications(
      actor?.primaryOrgId ?? null,
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

  async listAndons() {
    // ADR-031：canonical eventType=AndonRaised；历史行 'andon' 过渡兼容。
    return this.db
      .select()
      .from(ewohEvent)
      .where(inArray(ewohEvent.eventType, ['AndonRaised', 'andon']))
      .orderBy(desc(ewohEvent.createdAt));
  }

  async transitionAndon(
    eventId: string,
    action: string,
    _body: Record<string, unknown> | undefined,
    actor?: OrgContext,
  ) {
    const [row] = await this.db
      .select()
      .from(ewohEvent)
      .where(and(
        eq(ewohEvent.eventId, eventId),
        inArray(ewohEvent.eventType, ['AndonRaised', 'andon']),
      ));
    if (!row) {
      throw new NotFoundException(`Andon ${eventId} not found`);
    }
    const currentStatus = row.status ?? 'open';
    const status = nextAndonStatus(currentStatus, action, actor?.role);
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
        ),
      )
      .returning();
    if (!updated) {
      throw new ConflictException('STATE_CONFLICT');
    }
    if (escalated) {
      // R-58 / ADR-037：SLA 升级通知（app 恒建 + lark 配置时建；orgId 修复——
      // 此前缺 orgId 导致租户作用域查询不可见，§15）。
      await this.createAndonNotifications(actor?.primaryOrgId ?? null, {
        recipientId: String(evidence.assignee ?? 'dispatcher'),
        externalRef: eventId,
        title: `安灯SLA升级 ${row.title}`,
        body: `设备 ${row.deviceId} 安灯响应超过 SLA，请立即处理`,
        severity: row.severity ?? 'high',
      });
    }
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
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

  async getSummary(deviceId: string, start: string, end: string) {
    const oee = await this.calculateOee(deviceId, start, end, 0);
    const andons = await this.listAndons();
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
