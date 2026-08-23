import { Injectable, Inject, Logger } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { ewohEvent, ewohEventChain, ewohTelemetry, ewohDevice } from '@server/database/schema';
import { eq, and, desc, gte, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { normalizeSeverity } from '@shared/risk';
import { buildEventEnvelope, envelopeForEvidence } from '@shared/event-envelope';

/**
 * 规则引擎服务（大脑-感知层）
 * 从 SimulatorService / IngestionService 收到遥测后评估 5 条规则：
 *   LOW_BATTERY / HIGH_LOAD / POSTURE_RISK / DEVICE_OFFLINE / DATA_DEGRADED
 * 事件去重：30s 窗口；以 ewoh_event(event_code, device_id, created_at) 的
 * 数据库查询为准，进程内 Map 仅作缓存，避免每个遥测都重复查库。
 * 证据链：写入 source_type / trigger_record_id / evidence_json
 */
/** ADR-009：规则事件码 → Canonical Event Catalog 类型（NO-04b）。 */
const RULE_EVENT_TYPE_MAP: Readonly<Record<string, string>> = {
  LOW_BATTERY: 'DeviceLowBattery',
  HIGH_LOAD: 'WorkerHighLoad',
  POSTURE_RISK: 'WorkerPostureRisk',
  DEVICE_OFFLINE: 'DeviceOffline',
  DATA_DEGRADED: 'DataDegraded',
};

@Injectable()
export class RuleEngineService {
  private readonly logger = new Logger(RuleEngineService.name);

  /** 事件去重窗口（ms） */
  private static readonly DEDUP_MS = 30_000;
  /** DATA_DEGRADED 连续 degraded 阈值 */
  private static readonly DEGRADED_CONSECUTIVE = 3;

  /** dedupKey -> 上次触发时间戳(ms) */
  private lastEventTriggered = new Map<string, number>();

  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  /**
   * 评估单条遥测，按需触发事件
   * @param row 已写入 ewoh_telemetry 的记录（含 id/deviceId/pitchDeg/loadScore/batteryPct/sourceType/recordId/dataQuality 等；
   * NEST-621：可选 orgId 随事件落库，缺省时依赖请求级 GUC 默认）
   * @returns 触发的事件数量
   */
  async evaluate(row: {
    id?: string;
    deviceId: string;
    pitchDeg?: number | null;
    loadScore?: number | null;
    batteryPct?: number | null;
    sourceType?: string | null;
    recordId?: string | null;
    dataQuality?: string | null;
    packetLossPct?: number | null;
    orgId?: string | null;
  }): Promise<number> {
    let triggered = 0;
    const sourceType = row.sourceType ?? 'simulated';

    try {
      // 规则 1: LOW_BATTERY（电量 < 20）
      if (row.batteryPct != null && row.batteryPct < 20) {
        if (await this.tryFire('LOW_BATTERY', row, sourceType, 'L2', 'device', `设备 ${row.deviceId} 电量低 (${row.batteryPct}%)`, {
          battery_pct: row.batteryPct,
        })) triggered++;
      }

      // 规则 2: HIGH_LOAD（负荷 > 0.8）
      if (row.loadScore != null && row.loadScore > 0.8) {
        if (await this.tryFire('HIGH_LOAD', row, sourceType, 'L2', 'load', `设备 ${row.deviceId} 负荷过高 (${Math.round((row.loadScore as number) * 100)}%)`, {
          load_score: row.loadScore,
        })) triggered++;
      }

      // 规则 3: POSTURE_RISK（俯仰角 > 45°）
      if (row.pitchDeg != null && row.pitchDeg > 45) {
        if (await this.tryFire('POSTURE_RISK', row, sourceType, 'L3', 'safety', `设备 ${row.deviceId} 姿态风险 (俯仰 ${row.pitchDeg}°)`, {
          pitch_deg: row.pitchDeg,
        })) triggered++;
      }

      // 规则 4: DEVICE_OFFLINE（数据质量为 invalid 视为离线）
      if (row.dataQuality === 'invalid') {
        if (await this.tryFire('DEVICE_OFFLINE', row, sourceType, 'L3', 'device', `设备 ${row.deviceId} 数据无效/疑似离线`, {
          data_quality: row.dataQuality,
          packet_loss_pct: row.packetLossPct ?? 0,
        })) triggered++;
      }

      // 规则 5: DATA_DEGRADED（连续 3 条 degraded）
      if (row.dataQuality === 'degraded') {
        const consecutive = await this.countRecentDegraded(row.deviceId);
        if (consecutive >= RuleEngineService.DEGRADED_CONSECUTIVE) {
          if (await this.tryFire('DATA_DEGRADED', row, sourceType, 'L2', 'data', `设备 ${row.deviceId} 数据连续降级 (${consecutive} 条)`, {
            consecutive_degraded: consecutive,
          })) triggered++;
        }
      }
    } catch (error) {
      this.logger.error(`规则评估异常 deviceId=${row.deviceId}`, error);
    }

    return triggered;
  }

  /**
   * 主动触发设备离线事件（供 SimulatorService / IngestionService 在判定离线时调用；
   * NEST-621：可选 orgId 随事件落库）。
   */
  async fireDeviceOffline(
    deviceId: string,
    sourceType = 'simulated',
    orgId?: string | null,
  ): Promise<void> {
    await this.tryFire(
      'DEVICE_OFFLINE',
      { deviceId, sourceType, orgId },
      sourceType,
      'L3',
      'device',
      `设备 ${deviceId} 失联`,
      { reason: 'offline_detected' },
    );
  }

  // ===== 内部 =====

  /** 查询最近 N 条遥测，统计末尾连续 degraded 数量 */
  private async countRecentDegraded(deviceId: string): Promise<number> {
    try {
      const recent = await this.db
        .select({ dataQuality: ewohTelemetry.dataQuality })
        .from(ewohTelemetry)
        .where(eq(ewohTelemetry.deviceId, deviceId))
        .orderBy(desc(ewohTelemetry.ts))
        .limit(RuleEngineService.DEGRADED_CONSECUTIVE);
      let count = 0;
      for (const r of recent) {
        if (r.dataQuality === 'degraded') count++;
        else break;
      }
      return count;
    } catch (error) {
      this.logger.error(`查询连续 degraded 失败 deviceId=${deviceId}`, error);
      return 0;
    }
  }

  /**
   * 触发事件（含去重 + 写入 ewoh_event + ewoh_event_chain）
   * @returns 是否实际触发（未去重）
   */
  private async tryFire(
    eventCode: string,
    row: { deviceId: string; sourceType?: string | null; recordId?: string | null; orgId?: string | null },
    sourceType: string,
    severity: string,
    eventType: string,
    title: string,
    evidence: Record<string, unknown>,
  ): Promise<boolean> {
    // ADR-007 接线：写入前归一化到规范严重度阶梯（L1→critical/L2→high/L3→medium；
    // 未知值 fail-closed 抛错 → 调用方 catch → 不落事件，绝不静默改写）。
    const canonicalSeverity = normalizeSeverity(severity);
    // ADR-009 / NO-04b：事件类型收敛到 Canonical Event Catalog + 信封嵌入
    // （occurred/observed/received 同刻 = 云侧本地生成；Late 语义由共享 helper 计算）。
    const catalogEventType = RULE_EVENT_TYPE_MAP[eventCode] ?? eventType;
    const dedupKey = `${eventCode}:${row.deviceId}`;
    if (!this.canTrigger(dedupKey)) return false;

    try {
      if (await this.hasRecentEvent(eventCode, row.deviceId)) {
        this.markTriggered(dedupKey);
        return false;
      }
    } catch (error) {
      this.logger.error(
        `事件去重查询失败 ${eventCode} deviceId=${row.deviceId}`,
        error,
      );
      return false;
    }

    this.markTriggered(dedupKey);

    try {
      const eventId = this.genEventId();
      const now = new Date();
      const nowIso = now.toISOString();
      const envelope = buildEventEnvelope({
        eventId,
        eventType: catalogEventType,
        occurredAt: nowIso,
        observedAt: nowIso,
        receivedAt: nowIso,
        source: 'cloud:rule-engine',
        subject: `device:${row.deviceId}`,
      });
      const envelopeRecord = envelopeForEvidence(envelope);
      await this.db.insert(ewohEvent).values({
        eventId,
        deviceId: row.deviceId,
        eventCode,
        eventType: catalogEventType,
        severity: canonicalSeverity,
        title,
        status: 'open',
        createdAt: now,
        // ADR-009 / standalone_066: Event Envelope fields.
        occurredAt: now,
        receivedAt: now,
        schemaVersion: '1.0.0',
        correlationId: null,
        causationId: null,
        confidence: null,
        sourceType,
        triggerRecordId: row.recordId ?? null,
        // NEST-621：事件显式 orgId（缺省依赖 GUC 默认，不再写 NULL 全局行）。
        ...(row.orgId ? { orgId: row.orgId } : {}),
        evidenceJson: {
          ...evidence,
          telemetry_id: row.recordId ?? null,
          device_id: row.deviceId,
          fired_at: nowIso,
          envelope: envelopeRecord.envelope,
          envelopeSemantics: envelopeRecord.envelopeSemantics,
        },
      });
      await this.db.insert(ewohEventChain).values({
        eventId,
        parentEventId: null,
        causalType: 'triggered',
        description: title,
        createdAt: now,
        ...(row.orgId ? { orgId: row.orgId } : {}),
      });
      return true;
    } catch (error) {
      this.logger.error(`写入事件失败 ${eventCode}`, error);
      return false;
    }
  }

  private async hasRecentEvent(
    eventCode: string,
    deviceId: string,
  ): Promise<boolean> {
    const [recent] = await this.db
      .select({ eventId: ewohEvent.eventId })
      .from(ewohEvent)
      .where(
        and(
          eq(ewohEvent.eventCode, eventCode),
          eq(ewohEvent.deviceId, deviceId),
          gte(
            ewohEvent.createdAt,
            new Date(Date.now() - RuleEngineService.DEDUP_MS),
          ),
        ),
      )
      .limit(1);
    return Boolean(recent);
  }

  private canTrigger(dedupKey: string): boolean {
    const last = this.lastEventTriggered.get(dedupKey);
    return !last || Date.now() - last >= RuleEngineService.DEDUP_MS;
  }

  private markTriggered(dedupKey: string): void {
    this.lastEventTriggered.set(dedupKey, Date.now());
  }

  private genEventId(): string {
    // NEST-644：ID 后缀密码学化（Math.random 非密码学安全，同秒碰撞可预测）。
    return `EVT-${Math.floor(Date.now() / 1000)}-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  }
}
