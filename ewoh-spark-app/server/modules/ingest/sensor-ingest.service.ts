import { Injectable, Inject, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, eq } from 'drizzle-orm';
import { isValidSpatialKind } from '@shared/location';
import {
  ENVELOPE_CLOCK_DRIFT_TOLERANCE_MS,
  ENVELOPE_LATE_THRESHOLD_MS,
} from '@shared/event-envelope';
import { sql } from 'drizzle-orm';
import {
  ewohEnvironment,
  ewohWorldState,
  ewohSpatialEntity,
  ewohIdempotencyKeys,
  ewohDevice,
  ewohDeviceCapability,
} from '@server/database/schema';
import { INGEST_CATEGORY_BY_KIND, normalizeDeviceCategory } from '@shared/device-category';
import {
  DEVICE_CAPABILITY_SPECS,
  capabilitiesForCategory,
  toCapabilityRecord,
} from '@shared/device-capability';
import { validateCapability } from '@shared/capability';
import { isActuatorState } from '@shared/actuator';
import {
  evaluateSocPlausibility,
  resolveSocPlausibilityConfig,
  SocReanchorTracker,
  socRejectionMessage,
  type SocPlausibilityConfig,
} from '@shared/soc-plausibility';
import type {
  ActuatorFrameDto,
  EnvironmentFrameDto,
  CameraFrameDto,
  SpatialScanDto,
  LocationFrameDto,
  IngestResponse,
  DataSourceType,
} from '@shared/api.interface';

/**
 * SensorIngestService（P1-Ingest decomposition）
 *
 * 承担非外骨骼传感器类 ingest：environment / camera / spatial scan / location。
 * 与外骨骼核心链（IngestService.processOneFrame 私有链）完全解耦，
 * 仅依赖 DB 写入，无跨方法状态。IngestService 委托到本服务。
 *
 * 传输级幂等（2026-09-10 边缘韧性收口）：外骨骼路径用 ewoh_telemetry.raw_ref
 * 去重，而 environment / camera / location 三条路径此前**无去重**——边缘上行是
 * at-least-once（断网缓冲补传、失败重试），重放会把同一次观测写成两行，
 * 直接污染环境读数与人员定位。现三条路径统一按 (org_id, scope, record_id)
 * 认领（复用 ewoh_idempotency_keys 的唯一索引，跨实例原子），重放返回
 * `skipped: true` 且不再写库；写入失败则释放认领，避免瞬时错误把记录永久判为已处理。
 */
@Injectable()
export class SensorIngestService {
  private readonly logger = new Logger(SensorIngestService.name);

  /** 传输级幂等 scope（按接入路径区分键空间，避免不同路径的 record_id 相互抑制）。 */
  private static readonly SCOPE_ENVIRONMENT = 'ingest:environment';
  private static readonly SCOPE_CAMERA = 'ingest:camera';
  private static readonly SCOPE_LOCATION = 'ingest:location';
  private static readonly SCOPE_ACTUATOR = 'ingest:actuator';

  /** NO-92a：SOC 合理性闸门——配置自环境解析（非法回退默认），连击追踪进程内有界。 */
  private readonly socConfig: SocPlausibilityConfig = resolveSocPlausibilityConfig().cfg;
  private readonly socTracker = new SocReanchorTracker();
  /** 被拒 record_id 集（重放不虚增再锚定连击）；有界，超容淘汰最老。 */
  private readonly socRejectedRecords = new Map<string, number>();
  private static readonly SOC_REJECTED_RECORDS_CAP = 5_000;

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
  ) {}

  /**
   * 设备台账登记（2026-09-10 感知层入台账，幂等）。
   *
   * 为什么必须做：`ewoh_device` 是平台唯一的设备台账（设备页/在线率/新鲜度都读它），
   * 而环境/摄像头/定位三条摄入路径此前**只写业务表、不登记设备**——实测平台
   * `ewoh_device` 中这类设备为 0 行，感知层在 UI 上完全不存在。
   *
   * 语义：
   * - 首次出现即登记，类别由摄入 kind 唯一映射（`INGEST_CATEGORY_BY_KIND`）；
   * - 重复出现只更新"在线/最近遥测时间/来源"，
   *   **绝不覆盖**已登记的类别与型号（人工登记是权威，自动路径不得改写）；
   * - 电量不写（传感器无电池 → 保持 NULL，前端显示"—"而不是伪装成 0% 低电量）；
   * - 租户归属显式传 orgId（缺失时调用方已 fail-closed 拒绝，不会走到这里）。
   */
  async registerSensorDevice(params: {
    orgId: string;
    deviceId: string;
    kind: string;
    sourceType: DataSourceType;
    at: Date;
  }): Promise<void> {
    const { orgId, deviceId, kind, sourceType, at } = params;
    const category = INGEST_CATEGORY_BY_KIND[kind] ?? normalizeDeviceCategory(kind);
    try {
      await this.db
        .insert(ewohDevice)
        .values({
          orgId,
          deviceId,
          deviceCategory: category,
          // 显式写 NULL：列默认是 100，不显式置空会被数据库默认值填成"满电"
          // （实测：传感器设备被写成 100%，把"没有电池"伪装成"电量充足"）。
          // 传感器/摄像头/定位标签没有电池概念，NULL 才是真值，前端显示"—/不适用"。
          batteryPct: null,
          online: true,
          lastTelemetryAt: at,
          telemetryUpdatedAt: at,
          sourceType,
        })
        .onConflictDoUpdate({
          target: [ewohDevice.orgId, ewohDevice.deviceId],
          set: {
            online: true,
            lastTelemetryAt: at,
            telemetryUpdatedAt: at,
            sourceType,
            // 已有类别/型号不被自动路径覆盖（COALESCE 保留旧值；空则采用本次值）
            deviceCategory: sql`COALESCE(${ewohDevice.deviceCategory}, ${category})`,
          },
        });
    } catch (error) {
      // 登记失败不阻断数据落库（数据优先），但必须留痕——否则台账缺口无人知晓。
      this.logger.error(
        `传感器设备登记失败 device=${deviceId} kind=${kind} org=${orgId}（数据已入库，台账可能缺行）`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * NO-61a：执行机构状态 → 设备台账（位置/电量/故障/在线）。
   *
   * 合并语义（fail-closed，不擦除已知事实）：
   * - 电量/位置：帧里没有就用 `COALESCE(excluded, 现值)` **保留上一次已知值**
   *   （一帧缺电量不等于"电量未知"覆盖掉刚测到的 88%）；
   * - 故障码：帧是设备**当前**故障状态 → `fault` 写码、否则清空（故障解除是事实）；
   * - 类别：`COALESCE(现值, 'agv')`——人工登记的类别不被自动路径改写；
   * - 在线/最近遥测时间：如实刷新。
   */
  async projectActuatorDeviceState(params: {
    orgId: string;
    deviceId: string;
    at: Date;
    sourceType: DataSourceType;
    state: string;
    x: number | null;
    y: number | null;
    batteryPct: number | null;
    faultCode: string | null;
  }): Promise<void> {
    const { orgId, deviceId, at, sourceType, state, x, y, batteryPct, faultCode } = params;
    const isFault = state === 'fault';
    try {
      await this.db
        .insert(ewohDevice)
        .values({
          orgId,
          deviceId,
          deviceCategory: 'agv',
          batteryPct: batteryPct === null ? null : Math.round(batteryPct),
          locationLat: x,
          locationLng: y,
          locationCoordinateType: 'FACTORY_CARTESIAN',
          faultCode: isFault ? faultCode : null,
          online: state !== 'offline',
          lastTelemetryAt: at,
          telemetryUpdatedAt: at,
          sourceType,
        })
        .onConflictDoUpdate({
          target: [ewohDevice.orgId, ewohDevice.deviceId],
          set: {
            batteryPct: sql`COALESCE(${batteryPct === null ? null : Math.round(batteryPct)}, ${ewohDevice.batteryPct})`,
            locationLat: sql`COALESCE(${x}, ${ewohDevice.locationLat})`,
            locationLng: sql`COALESCE(${y}, ${ewohDevice.locationLng})`,
            locationCoordinateType: 'FACTORY_CARTESIAN',
            faultCode: isFault ? (faultCode ?? 'UNKNOWN_FAULT') : null,
            online: state !== 'offline',
            lastTelemetryAt: at,
            telemetryUpdatedAt: at,
            sourceType,
            deviceCategory: sql`COALESCE(${ewohDevice.deviceCategory}, 'agv')`,
          },
        });
    } catch (error) {
      // 台账投影失败不阻断状态上行（数据优先），但必须留痕——否则"调度看不到执行机构"
      // 这类缺口在日志里无迹可查。
      this.logger.error(
        `执行机构台账投影失败 device=${deviceId} org=${orgId}（状态已入 world_state，台账可能滞后）`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * 声明设备能力（幂等，2026-09-10 能力模型落地）。
   *
   * 为什么：DDL 早有 `ewoh_device_capability`（带 `(org_id, device_id,
   * capability_key)` 唯一键），但从来没有写入方（实测 0 行）——世界模型只知道
   * "有这台设备"，不知道"它能观测什么"，调度/约束校验/AI 解释都缺这层事实。
   *
   * 语义：
   * - 能力键由类别经 `capabilitiesForCategory` 唯一决定（未登记类别 → 不声明，
   *   宁可能力为空也不猜）；
   * - 幂等：`ON CONFLICT (org_id, device_id, capability_key)` 只刷新 `_updated_at`
   *   与 `status`（被人工停用的能力保持停用，自动路径不得悄悄复活）；
   * - 只声明不删除：能力下线走 `status`，保留历史（审计）。
   */
  async declareDeviceCapabilities(params: {
    orgId: string;
    deviceId: string;
    category: string | null | undefined;
    at: Date;
  }): Promise<number> {
    const { orgId, deviceId, category, at } = params;
    const keys = capabilitiesForCategory(category);
    if (keys.length === 0) return 0;
    let declared = 0;
    for (const key of keys) {
      const spec = DEVICE_CAPABILITY_SPECS[key];
      if (!spec) continue;
      // 权威契约记录（ADR-043 Canonical Capability Model）：设备能力台账不是
      // "另一套能力表"——kind/providerType/subject/capabilityId 必须逐字段合规。
      const record = toCapabilityRecord({
        deviceId,
        category,
        name: key,
        mode: spec.mode,
        label: spec.label,
        fields: spec.fields,
        grantedAt: at.toISOString(),
      });
      // fail-closed：契约不合法就**不写**（宁可能力缺失并告警，也不写脏记录）
      const errors = validateCapability(record);
      if (errors.length > 0) {
        this.logger.error(
          `设备能力记录违反 Canonical Capability Model（已跳过写入） device=${deviceId} name=${key}: ${errors.join(', ')}`,
        );
        continue;
      }
      try {
        await this.db
          .insert(ewohDeviceCapability)
          .values({
            orgId,
            capabilityId: record.capabilityId,
            deviceId,
            // capability_type = 权威 kind（device_capability / exo_capability）
            capabilityType: record.kind,
            // capability_key = 权威 name（开放词表，已登记在 knownValues）
            capabilityKey: record.name,
            capabilityValue: {
              mode: spec.mode,
              label: spec.label,
              fields: [...spec.fields],
              subject: record.subject,
              providerType: record.providerType,
              evidence: record.evidence,
            },
            compatible: true,
            version: 1,
            status: 'active',
            effectiveFrom: at,
          })
          .onConflictDoUpdate({
            target: [
              ewohDeviceCapability.orgId,
              ewohDeviceCapability.deviceId,
              ewohDeviceCapability.capabilityKey,
            ],
            set: {
              // 只刷新"见过"的时间与描述；status 保持原值（人工停用不被自动路径复活）。
              // NO-14f：同时纠正 kind 与 capabilityId——历史行曾用自造 kind
              // （observation/interaction），重新声明即自愈为权威 kind；
              // 这两列都由类别推导，不是人工输入，覆盖安全。
              capabilityType: record.kind,
              capabilityId: record.capabilityId,
              updatedAt: new Date(),
              // 权威字段刷新，但**不擦除人工留痕**：`capability_value` 里还存着
              // `lifecycle`（谁在什么时候因为什么停用了它）。整对象覆盖会让停用理由
              // 在下一帧到达时凭空消失（能力仍是停用状态，现场却看不到原因）。
              // 因此用 jsonb `||` 合并：右侧（本次声明的权威字段）覆盖同名键，
              // 其它既有键（lifecycle 等人工信息）原样保留。
              capabilityValue: sql`${ewohDeviceCapability.capabilityValue} || ${JSON.stringify({
                mode: spec.mode,
                label: spec.label,
                fields: [...spec.fields],
                subject: record.subject,
                providerType: record.providerType,
                evidence: record.evidence,
              })}::jsonb`,
            },
          });
        declared += 1;
      } catch (error) {
        // 声明失败不阻断数据落库，但必须留痕（能力缺口可被运维发现）
        this.logger.error(
          `设备能力声明失败 device=${deviceId} key=${key}（数据已入库，能力台账可能缺行）`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
    return declared;
  }

  /**
   * 认领 record_id（原子、跨实例安全）。
   *
   * `INSERT ... ON CONFLICT DO NOTHING RETURNING`：返回行 = 首次投递（可写），
   * 无返回行 = 重复投递（跳过）。绝不用「先查后写」——并发重放下会双写。
   */
  private async claimRecord(orgId: string, scope: string, recordId: string): Promise<boolean> {
    const rows = await this.db
      .insert(ewohIdempotencyKeys)
      .values({ orgId, scope, idempotencyKey: recordId })
      .onConflictDoNothing({
        target: [
          ewohIdempotencyKeys.orgId,
          ewohIdempotencyKeys.scope,
          ewohIdempotencyKeys.idempotencyKey,
        ],
      })
      .returning({ id: ewohIdempotencyKeys.id });
    return rows.length > 0;
  }

  /**
   * 释放认领（写入失败时调用）。
   *
   * 若写入失败却保留认领，边缘侧重试同一 record_id 会被永久判为"已处理"——
   * 数据静默丢失，且比重复更糟。释放失败只记录（不覆盖原始错误）。
   */
  private async releaseClaim(orgId: string, scope: string, recordId: string): Promise<void> {
    try {
      await this.db
        .delete(ewohIdempotencyKeys)
        .where(and(
          eq(ewohIdempotencyKeys.orgId, orgId),
          eq(ewohIdempotencyKeys.scope, scope),
          eq(ewohIdempotencyKeys.idempotencyKey, recordId),
        ));
    } catch (error) {
      this.logger.error(
        `释放幂等认领失败（该 record_id 可能被永久判为已处理）：scope=${scope} record=${recordId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * 观测时间语义（与外骨骼路径/信封契约同一判定口径）：
   * - `clockDrift`：事件时间超前接收时刻超过 5min 容差 → 传感器时钟不可信；
   * - `isLate`     ：事件时间落后接收时刻超过 10min → 迟到（**标记不丢弃**）。
   *
   * 阈值复用 `@shared/event-envelope` 常量：不得在本服务另写一套数字，
   * 否则"边缘标记迟到、平台按另一套口径判正常"。
   */
  private frameSemantics(eventTime: string): { clockDrift: boolean; isLate: boolean } {
    const ts = new Date(eventTime).getTime();
    if (!Number.isFinite(ts)) return { clockDrift: false, isLate: false };
    const now = Date.now();
    return {
      clockDrift: ts - now > ENVELOPE_CLOCK_DRIFT_TOLERANCE_MS,
      isLate: now - ts > ENVELOPE_LATE_THRESHOLD_MS,
    };
  }

  /**
   * 重复投递的统一响应（语义与外骨骼路径 skipped 一致：未落库、非错误）。
   * 时间标记随帧回传：一条"迟到的重复帧"仍需如实报告 is_late，
   * 否则运维会以为重放的是及时数据。
   */
  private duplicateResponse(
    recordId: string,
    semantics?: { clockDrift: boolean; isLate: boolean },
  ): IngestResponse {
    return {
      accepted: false,
      skipped: true,
      record_id: recordId,
      // 迟到帧在首次投递时即降级为 degraded，重放保持同一口径
      data_quality: semantics?.isLate ? 'degraded' : 'good',
      events_triggered: 0,
      is_late: semantics?.isLate ?? false,
      clock_drift: semantics?.clockDrift ?? false,
    };
  }

  // ===== 执行机构（AGV/PLC）接入（NO-59b）=====

  /**
   * NO-92a：执行机构电量合理性闸门（SOC plausibility gate）。
   *
   * 判据与领域口径的唯一事实源是 `@shared/soc-plausibility`（含为何不用现成库、
   * 为何守在平台侧而非边缘侧的设计取舍）。
   *
   * 行为契约：
   * - battery_pct 缺帧 → 闸门不参与（只有带电量的帧才可判）；
   * - 锚点（台账现值 + 最近遥测时刻）读取失败 → fail-open 放行（数据优先，
   *   与"台账投影失败不阻断状态上行"同一纪律），但留 warn 痕迹；
   * - 越界/非物理跳变 → 显式拒绝（不写世界状态与台账）；调用方释放幂等认领，
   *   同帧重放再次得到显式拒绝——拒绝是可重复观察的事实，不是一次性错误；
   *   且**同 record_id 重放不虚增再锚定连击**（拒绝集去重）：at-least-once 重投
   *   的是同一次观测，不是设备的新话——1 帧毛刺重放 3 次不得误判为"持续新水平"；
   * - 连续 `reanchorStreak` 帧（不同 record_id）同一新水平 → 再锚定接受（真实
   *   充电/换电是持续过程，毛刺只有一帧），调用方在成功响应上标记
   *   `soc_reanchored: true`。
   */
  private async gateActuatorSoc(
    orgId: string,
    deviceId: string,
    batteryPct: number | null | undefined,
    candidateAt: Date,
    recordId: string,
  ): Promise<{ outcome: 'allow'; reanchored: boolean } | { outcome: 'reject'; response: IngestResponse }> {
    if (batteryPct === null || batteryPct === undefined) {
      return { outcome: 'allow', reanchored: false };
    }
    const candidate = Number(batteryPct);
    const trackerKey = `${orgId}:${deviceId}`;
    let prevPct: number | null = null;
    let prevAt: Date | null = null;
    try {
      const [deviceRow] = await this.db
        .select({ batteryPct: ewohDevice.batteryPct, lastTelemetryAt: ewohDevice.lastTelemetryAt })
        .from(ewohDevice)
        .where(and(eq(ewohDevice.orgId, orgId), eq(ewohDevice.deviceId, deviceId)));
      prevPct = deviceRow?.batteryPct ?? null;
      prevAt = deviceRow?.lastTelemetryAt ?? null;
    } catch (error) {
      this.logger.warn(
        `SOC 闸门锚点读取失败 device=${deviceId}（fail-open 放行本帧，不阻断状态上行）`,
        error instanceof Error ? error.stack : String(error),
      );
      return { outcome: 'allow', reanchored: false };
    }
    const verdict = evaluateSocPlausibility({ prevPct, prevAt, candidate, candidateAt, cfg: this.socConfig });
    if (verdict.verdict === 'plausible' || verdict.verdict === 'unjudgeable') {
      this.socTracker.clear(trackerKey);
      this.socRejectedRecords.delete(recordId);
      return { outcome: 'allow', reanchored: false };
    }
    if (verdict.verdict === 'out_of_range') {
      return {
        outcome: 'reject',
        response: {
          accepted: false,
          skipped: false,
          record_id: recordId,
          data_quality: 'invalid',
          events_triggered: 0,
          error: socRejectionMessage(verdict, candidate, prevPct),
        },
      };
    }
    // 同 record_id 重放：连击不虚增（同一观测只记一次），但拒绝语义原样重现。
    const isReplay = this.socRejectedRecords.has(recordId);
    const streak = isReplay
      ? this.socTracker.currentStreak(trackerKey)
      : this.socTracker.record(trackerKey, Math.round(candidate));
    if (!isReplay) {
      this.socRejectedRecords.set(recordId, Date.now());
      if (this.socRejectedRecords.size > SensorIngestService.SOC_REJECTED_RECORDS_CAP) {
        const oldest = this.socRejectedRecords.keys().next().value;
        if (oldest !== undefined) this.socRejectedRecords.delete(oldest);
      }
    }
    if (streak >= this.socConfig.reanchorStreak) {
      this.socTracker.clear(trackerKey);
      this.socRejectedRecords.delete(recordId);
      return { outcome: 'allow', reanchored: true };
    }
    return {
      outcome: 'reject',
      response: {
        accepted: false,
        skipped: false,
        record_id: recordId,
        data_quality: 'invalid',
        events_triggered: 0,
        error: `${socRejectionMessage(verdict, candidate, prevPct)}（连击 ${streak}/${this.socConfig.reanchorStreak}${isReplay ? '，重放不连击' : ''}）`,
      },
    };
  }

  /**
   * 执行机构状态帧上行：写世界状态实体行（`state_json.actuator`）+ 登记设备与能力。
   *
   * 为什么落 `ewoh_world_state` 而不是遥测表：执行机构的位置/状态是**世界状态的实体事实**
   * （和定位/相机检测同一类），世界模型与指挥地图按实体读它；遥测表是设备级时序量，
   * 两者语义不同（这行不参与"人/资产定位"融合：融合只认 `state_json ? 'locator'`）。
   *
   * fail-closed：
   *   · 缺 device_id / event_time → 拒绝（不写半条事实）；
   *   · `state` 必须在**封闭词表**内（未知状态拒绝并回显，不默认 idle——那是伪造在线）；
   *   · 缺租户上下文 → 拒绝（不静默写全局可见行）；
   *   · 未来时间戳（时钟漂移）→ 拒绝（污染新鲜度）；
   *   · 同 record_id 重放 → 幂等跳过（边缘 at-least-once）。
   */
  async ingestActuator(frame: ActuatorFrameDto, orgId?: string | null): Promise<IngestResponse> {
    const sourceType: DataSourceType = frame.source_type ?? 'real';
    const recordId = frame.record_id ?? randomUUID();
    const deviceId = String(frame.device_id ?? '').trim();
    if (deviceId === '' || !frame.event_time) {
      return {
        accepted: false,
        skipped: false,
        record_id: recordId,
        data_quality: 'invalid',
        events_triggered: 0,
        error: 'device_id 和 event_time 必填',
      };
    }
    // 坏时钟 fail-closed：event_time 必须可解析为时间。不可解析的时间戳若放行，
    // 后续 `new Date(frame.event_time)` 得到 Invalid Date，驱动层拒绝后被兜底
    // catch 归类为「写入失败 retryable:true」——边缘会对一条**永远无效**的帧
    // 无限重试（每次还空转幂等认领/释放）。environment/camera/location 三路径
    // 在控制器有 assertParsableTime 把关，actuator 控制器只查"存在"，可解析性
    // 只能由本服务把关。永久非法显式拒绝且不可重试（缺省 retryable = 保守不重试）。
    if (!Number.isFinite(new Date(frame.event_time).getTime())) {
      return {
        accepted: false,
        skipped: false,
        record_id: recordId,
        data_quality: 'invalid',
        events_triggered: 0,
        error: `BAD_EVENT_TIME：event_time 不可解析为时间（收到：${String(frame.event_time)}）`,
      };
    }
    if (!isActuatorState(frame.state)) {
      return {
        accepted: false,
        skipped: false,
        record_id: recordId,
        data_quality: 'invalid',
        events_triggered: 0,
        error: `UNKNOWN_ACTUATOR_STATE：state=${String(frame.state ?? '')}（词表：idle/moving/arrived/paused/fault/offline）`,
      };
    }
    if (!orgId?.trim()) {
      return {
        accepted: false,
        skipped: false,
        record_id: recordId,
        data_quality: 'invalid',
        events_triggered: 0,
        error: '租户上下文缺失，拒绝写入（不静默写全局）',
      };
    }
    const semantics = this.frameSemantics(frame.event_time);
    if (semantics.clockDrift) {
      return {
        accepted: false,
        skipped: false,
        record_id: recordId,
        data_quality: 'invalid',
        events_triggered: 0,
        error: `CLOCK_DRIFT_FUTURE_TS：event_time 超前接收时刻超过 ${ENVELOPE_CLOCK_DRIFT_TOLERANCE_MS / 60000} 分钟，拒绝写入`,
        clock_drift: true,
        is_late: false,
      };
    }
    if (!(await this.claimRecord(orgId, SensorIngestService.SCOPE_ACTUATOR, recordId))) {
      return this.duplicateResponse(recordId, semantics);
    }
    try {
      // NO-92a：电量合理性闸门（在幂等认领之后、任何写入之前；拒绝路径释放认领，
      // 同帧重放会再次得到显式拒绝而不是 duplicate 静默）。
      const socGate = await this.gateActuatorSoc(orgId, deviceId, frame.battery_pct, new Date(frame.event_time), recordId);
      if (socGate.outcome === 'reject') {
        await this.releaseClaim(orgId, SensorIngestService.SCOPE_ACTUATOR, recordId);
        return socGate.response;
      }
      await this.db.insert(ewohWorldState).values({
        entityId: deviceId,
        ts: new Date(frame.event_time),
        stateJson: {
          actuator: true,
          state: frame.state,
          x: frame.x ?? null,
          y: frame.y ?? null,
          battery_pct: frame.battery_pct ?? null,
          fault_code: frame.fault_code ?? null,
          current_task_id: frame.current_task_id ?? null,
          target_station_id: frame.target_station_id ?? null,
          last_authorization_ref: frame.last_authorization_ref ?? null,
          station_id: frame.station_id ?? null,
          source_type: sourceType,
          record_id: recordId,
        } as Record<string, unknown>,
        orgId,
      });
      await this.registerSensorDevice({
        orgId, deviceId, kind: 'actuator', sourceType, at: new Date(frame.event_time),
      });
      // NO-61a：把执行机构状态投影到**设备台账**（位置/电量/故障）。
      // 为什么必须做：调度只看设备行（`ewoh_device.location_lat/lng` + `battery_pct`），
      // 而此前执行机构的位置/电量只落在 world_state 的 state_json 里 → 候选里出现
      // `battery_unknown`，设备位置对路由/世界模型不可见（本轮实测：AGV 在候选里被
      // "电量未知"挡在 eligible 之外）。传感器没有电池（NULL 才是真值）；执行机构**有**，
      // 而且它的位置就是执行层事实。
      await this.projectActuatorDeviceState({
        orgId,
        deviceId,
        at: new Date(frame.event_time),
        sourceType,
        state: frame.state,
        x: frame.x ?? null,
        y: frame.y ?? null,
        batteryPct: frame.battery_pct ?? null,
        faultCode: frame.fault_code ?? null,
      });
      await this.declareDeviceCapabilities({
        orgId, deviceId, category: 'agv', at: new Date(frame.event_time),
      });
      return {
        accepted: true,
        skipped: false,
        record_id: recordId,
        data_quality: semantics.isLate ? 'degraded' : 'good',
        events_triggered: 0,
        is_late: semantics.isLate,
        clock_drift: false,
        ...(socGate.reanchored ? { soc_reanchored: true } : {}),
      };
    } catch (error) {
      await this.releaseClaim(orgId, SensorIngestService.SCOPE_ACTUATOR, recordId);
      this.logger.error(`写入执行机构状态失败 device=${deviceId}`, error);
      return {
        accepted: false,
        skipped: false,
        record_id: recordId,
        data_quality: 'invalid',
        events_triggered: 0,
        error: '写入失败',
        retryable: true,
      };
    }
  }

  // ===== 环境传感器接入 =====

  async ingestEnvironment(
    frame: EnvironmentFrameDto,
    orgId?: string | null,
  ): Promise<IngestResponse> {
    const sourceType: DataSourceType = frame.source_type ?? 'real';
    const recordId = frame.record_id ?? randomUUID();
    const now = new Date();
    // R2-SOP-022：org 缺失显式拒绝——对齐 camera/spatial/location 三路径的
    // fail-closed 语义（不再静默写 NULL=legacy 全租户可见行）。
    if (!orgId?.trim()) {
      return {
        accepted: false,
        skipped: false,
        record_id: recordId,
        data_quality: 'invalid',
        events_triggered: 0,
        error: '租户上下文缺失，拒绝写入（不静默写全局）',
      };
    }
    // 时间语义：未来时间戳（时钟漂移超容差）是坏时钟而非"晚到的数据"——
    // 写进去会污染新鲜度与排序（世界状态"最新一条"）。显式拒绝，边缘转死信留痕。
    const semantics = this.frameSemantics(frame.event_time);
    if (semantics.clockDrift) {
      return {
        accepted: false,
        skipped: false,
        record_id: recordId,
        data_quality: 'invalid',
        events_triggered: 0,
        error: `CLOCK_DRIFT_FUTURE_TS：event_time 超前接收时刻超过 ${ENVELOPE_CLOCK_DRIFT_TOLERANCE_MS / 60000} 分钟，拒绝写入`,
        clock_drift: true,
        is_late: false,
      };
    }
    // 传输级幂等：重放同一 record_id 不再写第二行（边缘上行 at-least-once）。
    if (!(await this.claimRecord(orgId, SensorIngestService.SCOPE_ENVIRONMENT, recordId))) {
      return this.duplicateResponse(recordId, semantics);
    }
    try {
      await this.db.insert(ewohEnvironment).values({
        sensorId: frame.sensor_id,
        entityId: frame.entity_id ?? null,
        temperature: frame.temperature ?? null,
        vibration: frame.vibration ?? null,
        noise: frame.noise ?? null,
        airQuality: frame.air_quality ?? null,
        ts: new Date(frame.event_time),
        sourceType,
        recordId,
        // ADR-075 续（NO-13aa）：环境传感器行归属注入（001 ewoh_org_visible RLS 对齐）。
        orgId: orgId ?? null,
        dataConfidence: frame.data_confidence ?? 1.0,
      });
      await this.registerSensorDevice({
        orgId, deviceId: frame.sensor_id, kind: 'environment', sourceType,
        at: new Date(frame.event_time),
      });
      await this.declareDeviceCapabilities({
        orgId, deviceId: frame.sensor_id, category: 'environment_sensor',
        at: new Date(frame.event_time),
      });
      return {
        accepted: true,
        skipped: false,
        record_id: recordId,
        // 迟到不降级（ADR-009：标记不丢弃），但必须如实回传标记
        data_quality: semantics.isLate ? 'degraded' : 'good',
        events_triggered: 0,
        is_late: semantics.isLate,
        clock_drift: false,
      };
    } catch (error) {
      await this.releaseClaim(orgId, SensorIngestService.SCOPE_ENVIRONMENT, recordId);
      this.logger.error(`写入环境数据失败 sensor=${frame.sensor_id}`, error);
      return {
        accepted: false,
        skipped: false,
        record_id: recordId,
        data_quality: 'invalid',
        events_triggered: 0,
        error: '写入失败',
        // 写入失败是瞬时故障（DB/连接）：边缘可安全重试（record_id 已释放认领，
        // 重试不会重复落账）。与"永远不该写入"的拒绝显式区分。
        retryable: true,
      };
    }
  }

  // ===== 摄像头结构化检测接入 =====

  /**
   * NEST-204：写入显式携带 orgId（org 缺失 → 显式失败，不静默写
   * NULL=legacy 全可见行）。
   */
  async ingestCamera(frame: CameraFrameDto, orgId?: string | null): Promise<IngestResponse> {
    const sourceType: DataSourceType = frame.source_type ?? 'real';
    const recordId = frame.record_id ?? randomUUID();
    const now = new Date();
    if (!orgId?.trim()) {
      return {
        accepted: false,
        skipped: false,
        record_id: recordId,
        data_quality: 'invalid',
        events_triggered: 0,
        error: '租户上下文缺失，拒绝写入（不静默写全局）',
      };
    }
    const semantics = this.frameSemantics(frame.event_time);
    if (semantics.clockDrift) {
      return {
        accepted: false,
        skipped: false,
        record_id: recordId,
        data_quality: 'invalid',
        events_triggered: 0,
        error: `CLOCK_DRIFT_FUTURE_TS：event_time 超前接收时刻超过 ${ENVELOPE_CLOCK_DRIFT_TOLERANCE_MS / 60000} 分钟，拒绝写入`,
        clock_drift: true,
        is_late: false,
      };
    }
    // 传输级幂等：重放同一 record_id 不再写第二组世界状态行。
    if (!(await this.claimRecord(orgId, SensorIngestService.SCOPE_CAMERA, recordId))) {
      return this.duplicateResponse(recordId, semantics);
    }
    try {
      // 写入 ewoh_world_state（每个检测目标一条状态快照）
      const rows = frame.detections.map((det) => ({
        entityId: det.track_id
          ? `${frame.camera_id}:${det.track_id}`
          : `${frame.camera_id}:${det.class_name}`,
        stateJson: {
          camera_id: frame.camera_id,
          class_name: det.class_name,
          confidence: det.confidence,
          bbox: det.bbox ?? null,
          skeleton: det.skeleton ?? null,
          action: det.action ?? null,
          source_type: sourceType,
          // 幂等认领用的 record_id 必须落行：否则"这一行来自哪条上行记录"无法追溯，
          // 也无法在事后核对"重放没有双写"（2026-09-10 边缘韧性收口）。
          record_id: recordId,
        } as Record<string, unknown>,
        ts: new Date(frame.event_time),
        // NEST-204：行归属注入。
        orgId,
      }));
      if (rows.length > 0) {
        await this.db.insert(ewohWorldState).values(rows);
      }
      await this.registerSensorDevice({
        orgId, deviceId: frame.camera_id, kind: 'camera', sourceType,
        at: new Date(frame.event_time),
      });
      await this.declareDeviceCapabilities({
        orgId, deviceId: frame.camera_id, category: 'camera', at: new Date(frame.event_time),
      });
      return {
        accepted: true,
        skipped: false,
        record_id: recordId,
        data_quality: semantics.isLate ? 'degraded' : 'good',
        events_triggered: 0,
        is_late: semantics.isLate,
        clock_drift: false,
      };
    } catch (error) {
      await this.releaseClaim(orgId, SensorIngestService.SCOPE_CAMERA, recordId);
      this.logger.error(`写入摄像头数据失败 camera=${frame.camera_id}`, error);
      return {
        accepted: false,
        skipped: false,
        record_id: recordId,
        data_quality: 'invalid',
        events_triggered: 0,
        error: '写入失败',
        // 写入失败是瞬时故障（DB/连接）：边缘可安全重试（record_id 已释放认领，
        // 重试不会重复落账）。与"永远不该写入"的拒绝显式区分。
        retryable: true,
      };
    }
  }

  // ===== 场景直接建模接入（多源融合） =====

  /** 空间扫描产物接入（3DGS/LiDAR/视觉SLAM）→ upsert ewoh_spatial_entity
   *（NEST-204：写入显式携带 orgId，org 缺失显式失败）。 */
  async ingestSpatialScan(
    scan: SpatialScanDto,
    orgId?: string | null,
  ): Promise<IngestResponse> {
    const recordId = randomUUID();
    const now = new Date();
    if (!orgId?.trim()) {
      return {
        accepted: false,
        skipped: false,
        record_id: recordId,
        data_quality: 'invalid',
        events_triggered: 0,
        error: '租户上下文缺失，拒绝写入（不静默写全局）',
      };
    }
    // ADR-007：空间类型必须在 Canonical Location 契约注册表内；未知类型拒绝
    // （fail-closed，不把脏类型写进 ewoh_spatial_entity）。
    const entityType = scan.entity_type ?? 'workstation';
    if (!isValidSpatialKind(entityType)) {
      return {
        accepted: false,
        skipped: false,
        record_id: recordId,
        data_quality: 'invalid',
        events_triggered: 0,
        error: `entity_type ${entityType} 不在空间类型注册表（ADR-007）`,
      };
    }
    try {
      // DATA-FLOW-B1（2026-08-18）：坐标显式提供但非法（NaN/Infinity）→ fail-closed 拒绝；
      // 缺省写 NULL（诚实表达"位置未知"，不再写 0 假坐标——ADR-007 UNKNOWN 语义，
      // 消费方 x ?? 0 已兜底）。
      for (const [label, value] of [
        ['x', scan.x],
        ['y', scan.y],
        ['yaw', scan.yaw],
        ['bbox_w', scan.bbox_w],
        ['bbox_h', scan.bbox_h],
      ] as const) {
        if (value !== undefined && value !== null && !Number.isFinite(value)) {
          return {
            accepted: false,
            skipped: false,
            record_id: recordId,
            data_quality: 'invalid',
            events_triggered: 0,
            error: `${label} 坐标非法（非有限数）`,
          };
        }
      }
      const extra = {
        splat_url: scan.splat_url ?? null,
        pointcloud_url: scan.pointcloud_url ?? null,
        capture_at: scan.capture_at ?? null,
        scan_device: scan.scan_device ?? null,
        alignment_error_mm: scan.alignment_error_mm ?? null,
      };
      await this.db
        .insert(ewohSpatialEntity)
        .values({
          entityId: scan.entity_id,
          entityType,
          parentId: scan.parent_id ?? null,
          name: scan.name ?? scan.entity_id,
          x: scan.x ?? null,
          y: scan.y ?? null,
          yaw: scan.yaw ?? null,
          bboxW: scan.bbox_w ?? null,
          bboxH: scan.bbox_h ?? null,
          status: 'active',
          sourceType: scan.source_type,
          confidence: scan.confidence ?? 1.0,
          version: 1,
          extra,
          // NEST-204：行归属注入。
          orgId,
        })
        .onConflictDoUpdate({
          // R2-SOP-003/R2-SAM-003（standalone_059）：冲突目标改租户复合键
          // (org_id, entity_id)——跨租户同 entity_id 不再互相覆盖元数据，
          // 冲突更新只会命中本 org 自己的行。
          target: [ewohSpatialEntity.orgId, ewohSpatialEntity.entityId],
          set: {
            sourceType: scan.source_type,
            confidence: scan.confidence ?? 1.0,
            extra,
            updatedAt: now,
          },
        });
      return {
        accepted: true,
        skipped: false,
        record_id: recordId,
        data_quality: 'good',
        events_triggered: 0,
      };
    } catch (error) {
      this.logger.error(`写入空间扫描失败 entity=${scan.entity_id}`, error);
      return {
        accepted: false,
        skipped: false,
        record_id: recordId,
        data_quality: 'invalid',
        events_triggered: 0,
        error: '写入失败',
        // 写入失败是瞬时故障（DB/连接）：边缘可安全重试（record_id 已释放认领，
        // 重试不会重复落账）。与"永远不该写入"的拒绝显式区分。
        retryable: true,
      };
    }
  }

  /** 定位坐标流接入（UWB/Wi-Fi/视觉融合）→ ewoh_world_state
   *（NEST-204：写入显式携带 orgId，org 缺失显式失败）。 */
  async ingestLocation(loc: LocationFrameDto, orgId?: string | null): Promise<IngestResponse> {
    const sourceType: DataSourceType = loc.source_type ?? 'real';
    const recordId = loc.record_id ?? randomUUID();
    if (!orgId?.trim()) {
      return {
        accepted: false,
        skipped: false,
        record_id: recordId,
        data_quality: 'invalid',
        events_triggered: 0,
        error: '租户上下文缺失，拒绝写入（不静默写全局）',
      };
    }
    try {
      // DATA-FLOW-B1（2026-08-18）：定位坐标 x/y 必须为有限数（DTO 声明必填，
      // 运行时防 NaN/Infinity 污染 world_state 位置）。
      if (!Number.isFinite(loc.x) || !Number.isFinite(loc.y)) {
        return {
          accepted: false,
          skipped: false,
          record_id: recordId,
          data_quality: 'invalid',
          events_triggered: 0,
          error: 'x/y 坐标缺失或非法（非有限数）',
        };
      }
      const semantics = this.frameSemantics(loc.ts);
      if (semantics.clockDrift) {
        // 定位对未来时间戳最敏感：世界状态按 ts 取"最新位置"，未来时间戳会让
        // 陈旧位置长期占位。显式拒绝（边缘转死信人工复核）。
        return {
          accepted: false,
          skipped: false,
          record_id: recordId,
          data_quality: 'invalid',
          events_triggered: 0,
          error: `CLOCK_DRIFT_FUTURE_TS：ts 超前接收时刻超过 ${ENVELOPE_CLOCK_DRIFT_TOLERANCE_MS / 60000} 分钟，拒绝写入`,
          clock_drift: true,
          is_late: false,
        };
      }
      // 传输级幂等：先做（无 DB 的）取值校验，再认领——非法帧不该占用 record_id。
      if (!(await this.claimRecord(orgId, SensorIngestService.SCOPE_LOCATION, recordId))) {
        return this.duplicateResponse(recordId, semantics);
      }
      await this.db.insert(ewohWorldState).values({
        entityId: loc.entity_id,
        stateJson: {
          locator: loc.locator,
          confidence: loc.confidence,
          x: loc.x,
          y: loc.y,
          z: loc.z ?? 0,
          source_type: sourceType,
          // 同上：定位行的来源记录可追溯（重放不双写的事后核对依据）。
          record_id: recordId,
        } as Record<string, unknown>,
        ts: new Date(loc.ts),
        // NEST-204：行归属注入。
        orgId,
      });
      await this.registerSensorDevice({
        orgId,
        // 物理设备优先（tag_id）；老客户端不带时以 entity_id 兜底登记，
        // 保证"有人被定位但设备台账为空"这种自相矛盾的状态不会出现。
        deviceId: loc.tag_id?.trim() || loc.entity_id,
        kind: 'location',
        sourceType,
        at: new Date(loc.ts),
      });
      await this.declareDeviceCapabilities({
        orgId,
        deviceId: loc.tag_id?.trim() || loc.entity_id,
        category: 'location_tag',
        at: new Date(loc.ts),
      });
      return {
        accepted: true,
        skipped: false,
        record_id: recordId,
        data_quality: semantics.isLate ? 'degraded' : 'good',
        events_triggered: 0,
        is_late: semantics.isLate,
        clock_drift: false,
      };
    } catch (error) {
      await this.releaseClaim(orgId, SensorIngestService.SCOPE_LOCATION, recordId);
      this.logger.error(`写入定位数据失败 entity=${loc.entity_id}`, error);
      return {
        accepted: false,
        skipped: false,
        record_id: recordId,
        data_quality: 'invalid',
        events_triggered: 0,
        error: '写入失败',
        // 写入失败是瞬时故障（DB/连接）：边缘可安全重试（record_id 已释放认领，
        // 重试不会重复落账）。与"永远不该写入"的拒绝显式区分。
        retryable: true,
      };
    }
  }
}
