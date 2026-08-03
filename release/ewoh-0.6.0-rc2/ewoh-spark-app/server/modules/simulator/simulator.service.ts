import {
  Injectable,
  Inject,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import {
  ewohDevice,
  ewohTelemetry,
  ewohEvent,
  ewohEventChain,
  ewohSpatialEntity,
  ewohWorldState,
  ewohEnvironment,
} from '@server/database/schema';
import { eq, gte, sql } from 'drizzle-orm';
import type { SimulatorStatus } from '@shared/api.interface';
import { RuleEngineService } from '../rule-engine/rule-engine.service';
import { RequestDatabaseContext } from '../../database/request-database-context';

/** 设备运行态 */
interface DeviceRuntime {
  entityId: string; // EXO-001
  deviceId: string; // EXO-001
  workerId: string; // W-001 (从 extra.worker_id 取)
  battery: number; // 0-100
  online: boolean;
  pitchDeg: number; // 姿态角
  loadScore: number; // 0-1
  fatigueTrend: number; // 0-1
  qualityStatus: string; // 'ok' | 'warn' | 'error'
}

/** 人员运行态 */
interface PersonRuntime {
  entityId: string; // W-001
  deviceId: string; // EXO-001 (从 extra.device_id 取)
  task: string; // 从 extra.task 取
  x: number; // 当前位置
  y: number;
  targetX: number; // 移动目标
  targetY: number;
  loadScore: number;
  status: string; // 'active' | 'idle' | 'moving'
}

/** 矩形边界（用于人员移动范围） */
interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

const MAIN_TICK_MS = 4000;
const ENV_TICK_MS = 10000;
const EVENT_DEDUP_MS = 30_000;
const OFFLINE_PROB = 0.02;
const RESTRICTED_PROB = 0.005;
const MOVE_STEP = 25;

@Injectable()
export class SimulatorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SimulatorService.name);

  private running = false;
  private startedAt: Date | null = null;
  private tickCount = 0;
  private lastTickAt: Date | null = null;
  private simulationErrorCount = 0;

  private devices: DeviceRuntime[] = [];
  private persons: PersonRuntime[] = [];
  private zoneIds: string[] = [];

  /** workerId -> 人员名称 */
  private workerNameMap = new Map<string, string>();
  /** deviceId -> 设备型号 */
  private deviceModelMap = new Map<string, string>();
  /** workstation entityId -> 边界 */
  private workstationBounds = new Map<string, Bounds>();
  /** person entityId -> 移动边界（取自父工位 bbox） */
  private personBounds = new Map<string, Bounds>();

  /** 本 tick 临时失联的设备（下一 tick 自动恢复） */
  private tempOfflineDevices = new Set<string>();
  /** 事件去重：dedupKey -> 上次触发时间戳(ms) */
  private lastEventTriggered = new Map<string, number>();

  private mainInterval: NodeJS.Timeout | null = null;
  private envInterval: NodeJS.Timeout | null = null;
  private mainTicking = false;
  private envTicking = false;

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly ruleEngine: RuleEngineService,
    private readonly requestDatabaseContext: RequestDatabaseContext,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.start();
    } catch (error) {
      this.logger.error('Simulator 自动启动失败', error);
    }
  }

  onModuleDestroy(): void {
    this.clearIntervals();
  }

  async start(): Promise<SimulatorStatus> {
    if (this.running) {
      return this.getStatus();
    }
    try {
      await this.loadInitialState();
      this.running = true;
      this.startedAt = new Date();
      this.tickCount = 0;
      this.lastTickAt = null;
      this.tempOfflineDevices.clear();
      this.lastEventTriggered.clear();
      this.mainInterval = setInterval(() => {
        this.mainTick().catch((e) => this.logger.error('mainTick 异常', e));
      }, MAIN_TICK_MS);
      this.envInterval = setInterval(() => {
        this.envTick().catch((e) => this.logger.error('envTick 异常', e));
      }, ENV_TICK_MS);
      this.logger.log('Simulator 已启动');
      return this.getStatus();
    } catch (error) {
      this.simulationErrorCount += 1;
      this.logger.error('start 失败', error);
      throw error;
    }
  }

  async stop(): Promise<SimulatorStatus> {
    this.clearIntervals();
    this.running = false;
    this.logger.log('Simulator 已停止');
    return this.getStatus();
  }

  async getStatus(): Promise<SimulatorStatus> {
    let eventCount = 0;
    if (this.startedAt) {
      try {
        await this.withSimulatorOrgContext(async () => {
          const [row] = await this.db
            .select({ count: sql<number>`count(*)::int` })
            .from(ewohEvent)
            .where(gte(ewohEvent.createdAt, this.startedAt!));
          eventCount = row?.count ?? 0;
        });
      } catch (error) {
        this.logger.error('getStatus 统计事件失败', error);
      }
    }
    return {
      running: this.running,
      startedAt: this.startedAt ? this.startedAt.toISOString() : null,
      tickCount: this.tickCount,
      lastTickAt: this.lastTickAt ? this.lastTickAt.toISOString() : null,
      deviceCount: this.devices.length,
      personCount: this.persons.length,
      eventCount,
      simulationErrorCount: this.simulationErrorCount,
    };
  }

  // ===== 初始化 =====

  private simulatorOrgId(): string | null {
    const orgId = process.env.EWOH_SIMULATOR_ORG_ID?.trim();
    return orgId || null;
  }

  private async withSimulatorOrgContext<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const orgId = this.simulatorOrgId();
    if (!orgId) {
      throw new Error(
        'EWOH_SIMULATOR_ORG_ID is not configured; simulator DB round skipped',
      );
    }
    return this.requestDatabaseContext.runInTransaction(
      [
        { name: 'app.user_id', value: 'simulator' },
        { name: 'app.current_org_id', value: orgId },
        { name: 'app.current_org_ids', value: orgId },
        { name: 'app.is_global_admin', value: 'false' },
      ],
      operation,
    );
  }

  private async loadInitialState(): Promise<void> {
    await this.withSimulatorOrgContext(async () => {
      const [
        deviceEntities,
        personEntities,
        workstationEntities,
        zoneEntities,
        deviceRows,
      ] = await Promise.all([
        this.db
          .select()
          .from(ewohSpatialEntity)
          .where(eq(ewohSpatialEntity.entityType, 'device')),
        this.db
          .select()
          .from(ewohSpatialEntity)
          .where(eq(ewohSpatialEntity.entityType, 'person')),
        this.db
          .select()
          .from(ewohSpatialEntity)
          .where(eq(ewohSpatialEntity.entityType, 'workstation')),
        this.db
          .select()
          .from(ewohSpatialEntity)
          .where(eq(ewohSpatialEntity.entityType, 'zone')),
        this.db.select().from(ewohDevice),
      ]);

      // ewoh_device 当前电量/在线状态
      const deviceBatteryMap = new Map<string, number>();
      for (const d of deviceRows) {
        deviceBatteryMap.set(d.deviceId, d.batteryPct ?? 100);
      }

      // 人员名称映射 + 设备初始负荷映射
      this.workerNameMap = new Map();
      const deviceLoadMap = new Map<string, number>();
      for (const p of personEntities) {
        this.workerNameMap.set(p.entityId, p.name);
        const extra = (p.extra ?? {}) as Record<string, unknown>;
        const deviceId = extra.device_id != null ? String(extra.device_id) : '';
        const loadScore =
          extra.load_score != null ? Number(extra.load_score) : 0.3;
        if (deviceId) deviceLoadMap.set(deviceId, loadScore);
      }

      // 工位边界
      this.workstationBounds = new Map();
      for (const w of workstationEntities) {
        const cx = w.x ?? 0;
        const cy = w.y ?? 0;
        const bw = w.bboxW ?? 0;
        const bh = w.bboxH ?? 0;
        this.workstationBounds.set(w.entityId, {
          minX: cx - bw / 2,
          maxX: cx + bw / 2,
          minY: cy - bh / 2,
          maxY: cy + bh / 2,
        });
      }

      // 设备运行态
      this.deviceModelMap = new Map();
      this.devices = [];
      for (const e of deviceEntities) {
        const extra = (e.extra ?? {}) as Record<string, unknown>;
        const workerId = extra.worker_id != null ? String(extra.worker_id) : '';
        const deviceModel =
          extra.device_model != null ? String(extra.device_model) : '';
        this.deviceModelMap.set(e.entityId, deviceModel);
        this.devices.push({
          entityId: e.entityId,
          deviceId: e.entityId,
          workerId,
          battery: deviceBatteryMap.get(e.entityId) ?? 100,
          online: true,
          pitchDeg: 0,
          loadScore: deviceLoadMap.get(e.entityId) ?? 0.3,
          fatigueTrend: 0,
          qualityStatus: 'ok',
        });
      }

      // 人员运行态 + 移动边界
      this.persons = [];
      this.personBounds = new Map();
      for (const p of personEntities) {
        const extra = (p.extra ?? {}) as Record<string, unknown>;
        const deviceId = extra.device_id != null ? String(extra.device_id) : '';
        const task = extra.task != null ? String(extra.task) : '';
        const loadScore =
          extra.load_score != null ? Number(extra.load_score) : 0.3;
        const x = p.x ?? 0;
        const y = p.y ?? 0;
        this.persons.push({
          entityId: p.entityId,
          deviceId,
          task,
          x,
          y,
          targetX: x,
          targetY: y,
          loadScore,
          status: 'active',
        });
        const bounds = p.parentId
          ? this.workstationBounds.get(p.parentId)
          : null;
        if (bounds) {
          this.personBounds.set(p.entityId, bounds);
        }
      }

      this.zoneIds = zoneEntities.map((z) => z.entityId);

      this.logger.log(
        `初始化完成：${this.devices.length} 台设备，${this.persons.length} 名人员，${this.zoneIds.length} 个区域`,
      );
    });
  }

  private clearIntervals(): void {
    if (this.mainInterval) {
      clearInterval(this.mainInterval);
      this.mainInterval = null;
    }
    if (this.envInterval) {
      clearInterval(this.envInterval);
      this.envInterval = null;
    }
  }

  // ===== 主 tick =====

  private async mainTick(): Promise<void> {
    if (!this.running || this.mainTicking) return;
    this.mainTicking = true;
    try {
      const now = new Date();
      this.tickCount++;
      this.lastTickAt = now;
      await this.withSimulatorOrgContext(() => this.performMainTick(now));
    } catch (error) {
      this.simulationErrorCount += 1;
      this.logger.error('mainTick 失败', error);
    } finally {
      this.mainTicking = false;
    }
  }

  private async performMainTick(now: Date): Promise<void> {
    const telemetryRows: Array<{
      deviceId: string;
      ts: Date;
      pitchDeg: number;
      loadScore: number;
      fatigueTrend: number;
      batteryPct: number;
      qualityStatus: string;
      sourceType: string;
      recordId: string;
      ingestedAt: Date;
      dataQuality: string;
    }> = [];
    const worldStateRows: Array<{
      entityId: string;
      stateJson: Record<string, unknown>;
      ts: Date;
    }> = [];

    // --- 设备处理 ---
    for (const device of this.devices) {
      // 临时失联恢复
      if (this.tempOfflineDevices.has(device.deviceId)) {
        this.tempOfflineDevices.delete(device.deviceId);
        device.online = true;
      } else if (device.online && Math.random() < OFFLINE_PROB) {
        // 本 tick 失联
        device.online = false;
        this.tempOfflineDevices.add(device.deviceId);
        await this.handleDeviceOffline(device);
        continue;
      }

      if (!device.online) continue;

      // 负荷随机游走
      device.loadScore = this.clamp(
        device.loadScore + this.rand(-0.15, 0.15),
        0.1,
        0.9,
      );
      // 姿态角：偶发尖峰
      device.pitchDeg =
        Math.random() < 0.1 ? this.rand(25, 50) : this.rand(1, 12);
      // 疲劳趋势缓慢上升
      device.fatigueTrend = this.clamp(
        device.fatigueTrend + this.rand(-0.01, 0.03),
        0,
        1,
      );
      // 电量消耗
      device.battery = device.battery - this.rand(0.3, 0.8);
      if (device.battery < 0) device.battery = 100; // 电量耗尽自动换电
      if (device.battery > 100) device.battery = 100;
      // 质量状态
      if (device.loadScore > 0.85 || device.pitchDeg > 40) {
        device.qualityStatus = 'error';
      } else if (device.loadScore > 0.7 || device.pitchDeg > 25) {
        device.qualityStatus = 'warn';
      } else {
        device.qualityStatus = 'ok';
      }

      telemetryRows.push({
        deviceId: device.deviceId,
        ts: now,
        pitchDeg: Number(device.pitchDeg.toFixed(2)),
        loadScore: Number(device.loadScore.toFixed(3)),
        fatigueTrend: Number(device.fatigueTrend.toFixed(3)),
        batteryPct: Math.round(device.battery),
        qualityStatus: device.qualityStatus,
        sourceType: 'simulated',
        recordId: randomUUID(),
        ingestedAt: now,
        dataQuality: 'good',
      });

      // 更新 ewoh_device（upsert）
      await this.upsertDevice(device, now);
    }

    // 批量写入遥测
    if (telemetryRows.length > 0) {
      await this.db.insert(ewohTelemetry).values(telemetryRows);
      // 规则引擎评估（大脑-感知层）
      for (const row of telemetryRows) {
        await this.ruleEngine.evaluate({
          deviceId: row.deviceId,
          pitchDeg: row.pitchDeg,
          loadScore: row.loadScore,
          batteryPct: row.batteryPct,
          sourceType: row.sourceType,
          recordId: row.recordId,
          dataQuality: row.dataQuality,
        });
      }
    }

    // --- 人员处理 ---
    for (const person of this.persons) {
      const dx = person.targetX - person.x;
      const dy = person.targetY - person.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= MOVE_STEP || dist === 0) {
        // 到达目标，选取新目标
        const bounds = this.personBounds.get(person.entityId);
        if (bounds) {
          person.targetX = this.rand(bounds.minX, bounds.maxX);
          person.targetY = this.rand(bounds.minY, bounds.maxY);
        }
        person.status = person.loadScore <= 0.2 ? 'idle' : 'active';
      } else {
        person.x += (dx / dist) * MOVE_STEP;
        person.y += (dy / dist) * MOVE_STEP;
        person.status = 'moving';
      }

      // 同步关联设备负荷
      const linkedDevice = this.devices.find(
        (d) => d.deviceId === person.deviceId,
      );
      if (linkedDevice) {
        person.loadScore = linkedDevice.loadScore;
      }

      // 更新空间实体 x/y（不改 sourceType）
      await this.db
        .update(ewohSpatialEntity)
        .set({ x: Math.round(person.x), y: Math.round(person.y) })
        .where(eq(ewohSpatialEntity.entityId, person.entityId));

      worldStateRows.push({
        entityId: person.entityId,
        stateJson: {
          x: Math.round(person.x),
          y: Math.round(person.y),
          status: person.status,
          task: person.task,
          loadScore: Number(person.loadScore.toFixed(3)),
          deviceId: person.deviceId,
          source_type: 'simulated',
        },
        ts: now,
      });

      // 禁区进入事件
      if (Math.random() < RESTRICTED_PROB) {
        await this.tryTriggerEvent({
          dedupKey: `RESTRICTED_ZONE:${person.entityId}`,
          deviceId: person.deviceId,
          eventCode: 'RESTRICTED_ZONE',
          eventType: 'safety',
          severity: 'L3',
          title: `人员 ${person.entityId} 进入禁区`,
        });
      }
    }

    // 批量写入世界状态
    if (worldStateRows.length > 0) {
      await this.db.insert(ewohWorldState).values(worldStateRows);
    }
  }

  private async handleDeviceOffline(device: DeviceRuntime): Promise<void> {
    await this.db
      .update(ewohDevice)
      .set({ online: false })
      .where(eq(ewohDevice.deviceId, device.deviceId));
    await this.ruleEngine.fireDeviceOffline(device.deviceId, 'simulated');
  }

  private async upsertDevice(device: DeviceRuntime, now: Date): Promise<void> {
    const workerName = this.workerNameMap.get(device.workerId) ?? '';
    const deviceModel = this.deviceModelMap.get(device.deviceId) ?? '';
    const batteryPct = Math.round(device.battery);
    await this.db
      .insert(ewohDevice)
      .values({
        deviceId: device.deviceId,
        workerName,
        deviceModel,
        batteryPct,
        online: true,
        lastTelemetryAt: now,
      })
      .onConflictDoUpdate({
        target: ewohDevice.deviceId,
        set: {
          batteryPct,
          online: true,
          lastTelemetryAt: now,
        },
      });
  }

  // ===== 环境 tick =====

  private async envTick(): Promise<void> {
    if (!this.running || this.envTicking) return;
    this.envTicking = true;
    try {
      const now = new Date();
      await this.withSimulatorOrgContext(async () => {
        const rows = this.zoneIds.map((zoneId) => ({
          sensorId: `sim-${zoneId}`,
          entityId: zoneId,
          temperature: Number(this.rand(22, 28).toFixed(1)),
          vibration: Number(this.rand(0.1, 0.6).toFixed(2)),
          noise: Number(this.rand(45, 75).toFixed(1)),
          airQuality: Number(this.rand(40, 95).toFixed(1)),
          ts: now,
          sourceType: 'simulated',
          recordId: randomUUID(),
          dataConfidence: 1.0,
        }));
        if (rows.length > 0) {
          await this.db.insert(ewohEnvironment).values(rows);
        }
      });
    } catch (error) {
      this.simulationErrorCount += 1;
      this.logger.error('envTick 失败', error);
    } finally {
      this.envTicking = false;
    }
  }

  // ===== 事件触发 =====

  private async tryTriggerEvent(params: {
    dedupKey: string;
    deviceId: string;
    eventCode: string;
    eventType: string;
    severity: string;
    title: string;
  }): Promise<void> {
    if (!this.canTrigger(params.dedupKey)) return;
    const eventId = this.genEventId();
    const now = new Date();
    await this.db.insert(ewohEvent).values({
      eventId,
      deviceId: params.deviceId,
      eventCode: params.eventCode,
      eventType: params.eventType,
      severity: params.severity,
      title: params.title,
      status: 'open',
      createdAt: now,
      sourceType: 'simulated',
      evidenceJson: { simulator_event: true, device_id: params.deviceId },
    });
    await this.db.insert(ewohEventChain).values({
      eventId,
      parentEventId: null,
      causalType: 'triggered',
      description: params.title,
      createdAt: now,
    });
    this.markTriggered(params.dedupKey);
  }

  private canTrigger(dedupKey: string): boolean {
    const last = this.lastEventTriggered.get(dedupKey);
    return !last || Date.now() - last >= EVENT_DEDUP_MS;
  }

  private markTriggered(dedupKey: string): void {
    this.lastEventTriggered.set(dedupKey, Date.now());
  }

  // ===== 工具方法 =====

  private genEventId(): string {
    return `EVT-${Math.floor(Date.now() / 1000)}-${this.randomSuffix(4)}`;
  }

  private randomSuffix(len: number): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    for (let i = 0; i < len; i++) {
      s += chars[Math.floor(Math.random() * chars.length)];
    }
    return s;
  }

  private rand(min: number, max: number): number {
    return min + Math.random() * (max - min);
  }

  private clamp(v: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, v));
  }
}
