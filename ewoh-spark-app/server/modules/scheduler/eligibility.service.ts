import { Injectable, Logger } from '@nestjs/common';
import { normalizeBatteryPct } from '@shared/scheduler';
import { normalizePersonRef } from '@shared/identity';
import type { CandidateRejectReason } from '@shared/reject-reason';
import type { EligibilityResult } from '@shared/api.interface';
import type { MaintenanceConditionProjection } from '@shared/maintenance';
import {
  qualityFindingsBlockDispatch,
  type QualityFindingProjection,
} from '@shared/quality';
import type { CapabilityRecord } from '@shared/capability';
import {
  deviceCapabilityNames,
  personCertificationExpiryMap,
  personSkillNames,
  stationCapabilityNames,
} from './capability-projection';

/** 参与资格判定的人员描述。 */
export interface EligiblePerson {
  id: string;
  status: string;
  skills: string[];
  certifications: string[];
  stationId: string | null;
  loadLevel: number;
  fatigueLevel: number;
  healthStatus: string | null;
  /** T03 / P1-2：证书到期信息（[{ name, expiresAtMs }]；expiresAtMs<now 视为过期）。 */
  certificationExpiry?: Array<{ name: string; expiresAtMs: number | null }> | null;
  // --- Command Map 增量（Phase 1 / P1-A + P1-B） ---
  /** 可用时间窗（正空间；缺数据不限制，不伪造）。 */
  availableWindows?: Array<{ startMs: number; endMs: number }> | null;
  /** 数据质量（P1-B fail-close；STALE/UNKNOWN + safety-critical → stale_data）。 */
  dataQuality?: 'FRESH' | 'STALE' | 'UNKNOWN';
  /** 字段来源维度（P1-B fail-close；DERIVED + safety-critical → derived_data_fail_closed）。 */
  source?: 'AUTHORITATIVE' | 'DERIVED';
  /**
   * NO-05c：活跃维护状态事实（ADR-010）。存在即拒绝派工
   * （person_maintenance_blocked，fail-closed，人审解除）。
   */
  maintenance?: MaintenanceConditionProjection[] | null;
  /**
   * NO-05d：活跃质量发现事实（ADR-011）。critical/high → 拒绝派工
   * （person_quality_blocked，fail-closed，人审经 dispositioned/closed 解除）；
   * medium/low 仅事实可见、不封锁。
   */
  qualityFindings?: QualityFindingProjection[] | null;
  /** NO-12v / ADR-045：能力契约记录（快照投影）；匹配优先契约形态。 */
  capabilityRecords?: CapabilityRecord[];
}

/** 参与资格判定的设备描述。 */
export interface EligibleDevice {
  id: string;
  batteryPct: number | null;
  online: boolean;
  status: string | null;
  /** 设备能力（如 'exo-lift' / 'vacuum'），用于 requiredDeviceCapabilities 匹配。 */
  capabilities: string[];
  /**
   * NO-15b：**被人为停用**的能力名（不参与匹配，但用于解释）。
   * 缺失 ≠ 停用：前者要换设备/加装，后者要复核停用决定或恢复。
   */
  disabledCapabilities?: string[];
  // --- Command Map 增量（Phase 1 / P1-A + P1-B） ---
  /** 可用时间窗（正空间；缺数据不限制，不伪造）。 */
  availableWindows?: Array<{ startMs: number; endMs: number }> | null;
  /** 维护时间窗（负空间；与候选区间重叠 → 设备不可用）。 */
  maintenanceWindows?: Array<{ startMs: number; endMs: number }> | null;
  /** 数据质量（P1-B fail-close；STALE/UNKNOWN + safety-critical → stale_data）。 */
  dataQuality?: 'FRESH' | 'STALE' | 'UNKNOWN';
  /** 字段来源维度（P1-B fail-close；DERIVED + safety-critical → derived_data_fail_closed）。 */
  source?: 'AUTHORITATIVE' | 'DERIVED';
  /**
   * NO-05c：活跃维护状态事实（ADR-010）。存在即拒绝派工
   * （device_maintenance_blocked，fail-closed，人审解除）。
   */
  maintenance?: MaintenanceConditionProjection[] | null;
  /**
   * NO-05d：活跃质量发现事实（ADR-011）。critical/high → 拒绝派工
   * （device_quality_blocked，fail-closed，人审经 dispositioned/closed 解除）；
   * medium/low 仅事实可见、不封锁。
   */
  qualityFindings?: QualityFindingProjection[] | null;
  /** NO-12v / ADR-045：能力契约记录（快照投影）；匹配优先契约形态。 */
  capabilityRecords?: CapabilityRecord[];
  /**
   * NO-34a：活跃外骨骼会话（佩戴中的设备）——存在即拒绝普通派工。
   * 无会话 → null/undefined（不伪造"没人用"）。
   */
  activeExoSession?: { sessionId: string; personId: string; startedAt: string } | null;
}

/** 参与资格判定的任务描述。 */
export interface EligibleTask {
  id: string;
  taskType: string;
  requiredSkills: string[];
  /** 技能匹配语义：ALL=全部必需，ANY=任一即可。缺省 ALL。 */
  skillMatchMode?: 'ALL' | 'ANY';
  requiredCertifications: string[];
  stationId: string | null;
  zoneId: string | null;
  predIds: string[];
  /** 设备能力需求（如 'exo-lift' / 'vacuum'），缺失任一能力则设备不可用。 */
  requiredDeviceCapabilities?: string[];
  /** T03 / P1-2：工位能力需求（task.requiredStationCapabilities ⊆ station.capabilities）。 */
  requiredStationCapabilities?: string[];
  /** T03 / P1-3：候选工位集合（station 决策变量；不在集合内的工位不可选）。 */
  candidateStations?: string[];
  // --- Command Map 增量（Phase 1 / P1-A + P1-B） ---
  /** 最早开始时间（epoch ms；候选区间与其无重叠 → 时间窗交集为空）。 */
  earliestStartMs?: number | null;
  /** 截止时间（epoch ms；候选区间与其无重叠 → 时间窗交集为空）。 */
  dueAtMs?: number | null;
  /** 安全关键任务（P1-B fail-close：STALE/UNKNOWN/关键 DERIVED 资源不可派）。 */
  safetyCritical?: boolean;
  /**
   * NO-35a：任务**已锁定的人员**（`task.assigneeId` 或方案级锁定；uuid 或规范身份）。
   *
   * 用途：佩戴中的外骨骼只对"锁定给该佩戴者"的任务可用——一把外骨骼不可能同时
   * 被两个人穿，但"张伟戴着它干张伟的任务"是合法的。没有锁定时一律拒绝（不猜配对）。
   */
  lockedAssigneeId?: string | null;
}

/** 资格判定上下文（软/硬约束参数）。 */
export interface EligibilityContext {
  now: number;
  /** 本次窗口内已占用的人员时间段（personId → 区间），用于防止双重预订。 */
  bookedTimeSlots: Array<{ personId: string; start: number; end: number }>;
  /** 本次窗口内已占用的设备时间段（deviceId → 区间），用于设备 reservation 冲突。 */
  bookedDeviceSlots?: Array<{ deviceId: string; start: number; end: number }>;
  /** 本次窗口内已占用的工位时间段（stationId → 区间），用于工位 reservation 冲突。 */
  bookedStationSlots?: Array<{ stationId: string; start: number; end: number }>;
  /** 当前候选任务的时间区间（用于 reservation 冲突判定）。 */
  candidateStartMs: number;
  candidateEndMs: number;
  /** 已锁定/正在执行任务的人员，不可再分配。 */
  lockedPersonIds: string[];
  /** 禁入区域列表。 */
  forbiddenZones: string[];
  /** 设备最低电量阈值。 */
  minBatteryPct: number;
  /** 最大连续负荷（0-1）。 */
  maxContinuousLoad: number;
  /** 因安全事件被禁止作业的人员。 */
  safetyBlockedPersonIds: string[];
  /** 因安全事件被禁止作业的设备；缺省空集仅为存量调用方兼容。 */
  safetyBlockedDeviceIds?: string[];
  /** 前置任务是否已完成。 */
  predecessorDone: (taskId: string) => boolean;
  /** T03 / P1-4：当前评估的候选工位（station 决策变量；缺省回退 task.stationId）。 */
  candidateStationId?: string | null;
  /** T03 / P1-3：候选工位容量（stationId → capacity）；null 表示无容量信息。 */
  stationCapacityById?: Map<string, number | null>;
  /** T03 / P1-3：候选工位能力（stationId → capabilities[]）。 */
  stationCapabilitiesById?: Map<string, string[]>;
  /** NO-12v / ADR-045：候选工位能力契约记录（匹配优先契约形态）。 */
  stationCapabilityRecordsById?: Map<string, CapabilityRecord[]>;
  /** T03 / P1-3：候选工位已占用（stationId → 时间区间），用于容量计数。 */
  bookedStationCounts?: Map<string, number>;
  /** P1-A：候选工位可用窗口（stationId → 窗口列表）；无数据不限制（缺数据不伪造）。 */
  stationAvailableWindowsById?: Map<string, Array<{ startMs: number; endMs: number }>>;
  /**
   * NO-05c：候选工位维护封锁（stationId → true 表示存在活跃维护状态事实）。
   * 命中即拒绝派工（station_maintenance_blocked，fail-closed，人审解除）。
   */
  stationMaintenanceBlockedById?: Map<string, boolean>;
  /**
   * NO-05d：候选工位质量封锁（stationId → true 表示存在 critical/high 活跃
   * 质量发现）。命中即拒绝派工（station_quality_blocked，fail-closed，
   * 人审经 dispositioned/closed 解除）。
   */
  stationQualityBlockedById?: Map<string, boolean>;
}

/**
 * 资格服务：对【人员 × 任务 × 设备】执行硬约束校验，
 * 每个未通过项返回一个原因 key（如 missing_skill / battery_low）。
 */
/**
 * NO-35a：人员引用归一（会话里是规范身份 `person:<id>`，任务锁定里通常是裸 uuid）。
 *
 * NO-36a 起实现移到 `@shared/identity.normalizePersonRef`（提交时刻的外骨骼会话
 * 守卫也要用同一口径），此处保留同名再导出，避免既有调用点与测试大范围改动。
 */
export { normalizePersonRef };

@Injectable()
export class EligibilityService {
  private readonly logger = new Logger(EligibilityService.name);

  /**
   * NEST-136（2026-08-17）：已占用时段的倒排索引缓存——同一 EligibilityContext
   * 对象在候选池构建期间被逐候选复用（buildCandidatePool 构建一次 ctx、
   * check 调用 N×M 次），此前每次 check 线性扫描全部 slots（大规模任务
   * O(candidates × slots) ≈ O(n²)）。WeakMap 按 ctx 构建一次
   * person/device/station → 区间列表索引，查询降为 O(该资源的区间数)。
   * 约束：ctx 的 slots 数组在 check 之间不可变（调用方每次池构建新建 ctx，
   * 满足该前提；rule-based 求解器每任务迭代新建池即新建 ctx）。
   */
  private readonly slotIndexCache = new WeakMap<
    EligibilityContext,
    {
      byPerson: Map<string, Array<{ start: number; end: number }>>;
      byDevice: Map<string, Array<{ start: number; end: number }>>;
      byStation: Map<string, Array<{ start: number; end: number }>>;
    }
  >();

  private slotIndexFor(ctx: EligibilityContext) {
    let idx = this.slotIndexCache.get(ctx);
    if (!idx) {
      const byPerson = new Map<string, Array<{ start: number; end: number }>>();
      for (const s of ctx.bookedTimeSlots) {
        const list = byPerson.get(s.personId);
        if (list) list.push({ start: s.start, end: s.end });
        else byPerson.set(s.personId, [{ start: s.start, end: s.end }]);
      }
      const byDevice = new Map<string, Array<{ start: number; end: number }>>();
      for (const s of ctx.bookedDeviceSlots ?? []) {
        const list = byDevice.get(s.deviceId);
        if (list) list.push({ start: s.start, end: s.end });
        else byDevice.set(s.deviceId, [{ start: s.start, end: s.end }]);
      }
      const byStation = new Map<string, Array<{ start: number; end: number }>>();
      for (const s of ctx.bookedStationSlots ?? []) {
        const list = byStation.get(s.stationId);
        if (list) list.push({ start: s.start, end: s.end });
        else byStation.set(s.stationId, [{ start: s.start, end: s.end }]);
      }
      idx = { byPerson, byDevice, byStation };
      this.slotIndexCache.set(ctx, idx);
    }
    return idx;
  }

  /**
   * NO-05d（ADR-011）：qualityFindings 中 critical/high 触发硬封锁；
   * medium/low 不封锁（仅事实可见）。未知严重度按封锁处理并留痕
   * （fail-closed，不把未知当作安全）。
   */
  private qualityBlocks(
    findings: QualityFindingProjection[] | null | undefined,
  ): boolean {
    return qualityFindingsBlockDispatch(findings, (findingId, severity) => {
      this.logger.warn(
        `质量发现严重度非契约值，按封锁处理（fail-closed）: ${findingId} ${severity}`,
      );
    });
  }

  /**
   * 硬约束检查。返回 eligible=false 并附带全部未通过原因。
   */
  check(
    person: EligiblePerson,
    task: EligibleTask,
    device: EligibleDevice | null,
    ctx: EligibilityContext,
  ): EligibilityResult {
    // 词表类型（不是 string[]）：任何未登记进 `CANDIDATE_REJECT_REASONS` 的键
    // 都在编译期失败，而不是靠调用方 `as` 断言蒙混（2026-09-11 审计：曾有 8 个键
    // 在类型之外，前端无法穷尽文案 → 现场看到英文键）。
    const reasons: CandidateRejectReason[] = [];

    // 1) 技能匹配（NO-12v / ADR-045：契约形态优先，无记录就地同源投影——语义不变）
    if (task.requiredSkills.length > 0) {
      const matchMode = task.skillMatchMode ?? 'ALL';
      const skillNames = personSkillNames(person);
      const hasSkill =
        matchMode === 'ALL'
          ? task.requiredSkills.every((s) => skillNames.includes(s))
          : task.requiredSkills.some((s) => skillNames.includes(s));
      if (!hasSkill) reasons.push('missing_skill');
    }

    // 1b) 证书到期（T03 / P1-2）：requiredCertifications 命中已过期证书 → cert_expired。
    // NO-12v / ADR-045：到期事实优先契约记录（certification expiresAt），
    // 无记录回退 raw certificationExpiry——存在性仍以 person.certifications 为准
    // （certification 记录因缺 issuer/expiry 被契约缺口丢弃，若改按记录存在性
    // 会改变既有语义，§30 语义不变）。
    if (task.requiredCertifications.length > 0) {
      const certOk = task.requiredCertifications.every((c) =>
        person.certifications.includes(c),
      );
      if (!certOk) reasons.push('missing_certification');
      else {
        const expiryByName = personCertificationExpiryMap(person);
        const expired = task.requiredCertifications.some((name) => {
          const expiresAtMs = expiryByName.get(name);
          return expiresAtMs != null && expiresAtMs < ctx.now;
        });
        if (expired) reasons.push('cert_expired');
      }
    }

    // 1c) 健康检查（T03 / P1-2）：healthStatus blocked 类状态 → health_blocked。
    if (
      person.healthStatus === 'blocked' ||
      person.healthStatus === 'injured' ||
      person.healthStatus === 'unavailable'
    ) {
      reasons.push('health_blocked');
    }

    // 1d) NO-05c（ADR-010）：活跃维护状态事实 → 拒绝派工（fail-closed，人审解除）。
    if (person.maintenance != null && person.maintenance.length > 0) {
      reasons.push('person_maintenance_blocked');
    }

    // 1e) NO-05d（ADR-011）：critical/high 活跃质量发现 → 拒绝派工
    // （fail-closed，人审经 dispositioned/closed 解除）；medium/low 不封锁。
    if (this.qualityBlocks(person.qualityFindings)) {
      reasons.push('person_quality_blocked');
    }

    // 2) 资质认证（证书存在性；1b 已处理过期）
    if (task.requiredCertifications.length > 0 && !reasons.includes('cert_expired')) {
      const certOk = task.requiredCertifications.every((c) =>
        person.certifications.includes(c),
      );
      if (!certOk) reasons.push('missing_certification');
    }

    // 3) 在岗状态（人员可用）
    // 2026-08-21 修复：状态大小写不敏感 + 兼容 active——数据侧 spatial person
    // status 为小写 available/active（seed 事实源），原硬编码 'AVAILABLE' 大写
    // 导致全员 person_unavailable → 候选空 → 方案 metrics 全 0。
    // 仅 offline/absent 等明确不可用状态排除；active（在岗执行中）由时间冲突
    // /锁定槽位判定拦截，不在此处误伤。
    const personStatus = (person.status ?? '').trim().toUpperCase();
    if (personStatus !== 'AVAILABLE' && personStatus !== 'ACTIVE') {
      reasons.push('person_unavailable');
    }

    // 4) 时间冲突（人员不被双重预订，用候选时间区间判定）
    //    NEST-136：倒排索引查询（同一 ctx 只构建一次索引，见 slotIndexFor）。
    const candidateStart = ctx.candidateStartMs;
    const candidateEnd = ctx.candidateEndMs;
    const slotIdx = this.slotIndexFor(ctx);
    const personConflicts = slotIdx.byPerson.get(person.id) ?? [];
    if (
      personConflicts.some((b) =>
        this.intervalsOverlap(b.start, b.end, candidateStart, candidateEnd),
      )
    ) {
      reasons.push('time_conflict');
    }

    // 4b) 设备 reservation 冲突
    if (device) {
      const deviceConflict = (slotIdx.byDevice.get(device.id) ?? []).some(
        (s) => this.intervalsOverlap(s.start, s.end, candidateStart, candidateEnd),
      );
      if (deviceConflict) reasons.push('device_reserved');
    }

    // 4c) 工位 reservation 冲突（针对候选工位，station 决策变量场景）
    const stationId = ctx.candidateStationId ?? task.stationId ?? null;
    if (stationId) {
      const stationConflict = (slotIdx.byStation.get(stationId) ?? []).some(
        (s) => this.intervalsOverlap(s.start, s.end, candidateStart, candidateEnd),
      );
      if (stationConflict) reasons.push('station_reserved');
    }

    // 4c2) NO-05c（ADR-010）：候选工位维护封锁 → 拒绝派工（fail-closed，人审解除）。
    if (stationId && ctx.stationMaintenanceBlockedById?.get(stationId)) {
      reasons.push('station_maintenance_blocked');
    }

    // 4c3) NO-05d（ADR-011）：候选工位质量封锁（critical/high）→ 拒绝派工
    // （fail-closed，人审经 dispositioned/closed 解除）。
    if (stationId && ctx.stationQualityBlockedById?.get(stationId)) {
      reasons.push('station_quality_blocked');
    }

    // 4d) T03 / P1-3：候选工位范围（candidateStations 非空且候选工位不在其中 → 拒绝）。
    if (
      stationId &&
      Array.isArray(task.candidateStations) &&
      task.candidateStations.length > 0 &&
      !task.candidateStations.includes(stationId)
    ) {
      reasons.push('not_in_candidate_stations');
    }

    // 4e) T03 / P1-3：station capability（requiredStationCapabilities ⊆ station.capabilities）。
    if (
      stationId &&
      Array.isArray(task.requiredStationCapabilities) &&
      task.requiredStationCapabilities.length > 0
    ) {
      const caps = stationCapabilityNames(
        ctx.stationCapabilityRecordsById?.get(stationId),
        ctx.stationCapabilitiesById?.get(stationId),
      );
      const missing = task.requiredStationCapabilities.filter((c) => !caps.includes(c));
      if (missing.length > 0) reasons.push('station_capability_mismatch');
    }

    // 4f) T03 / P1-3：station 容量硬校验（同一时间窗内重叠任务数 ≥ capacity →
    // station_capacity_exceeded）。与 eligibility bookedStationSlots 语义一致（同时段任务数）。
    if (stationId && ctx.stationCapacityById?.has(stationId)) {
      const capacity = ctx.stationCapacityById.get(stationId) ?? null;
      if (capacity != null && capacity >= 0) {
        const overlapCount = (ctx.bookedStationSlots ?? []).filter(
          (s) =>
            s.stationId === stationId &&
            this.intervalsOverlap(s.start, s.end, candidateStart, candidateEnd),
        ).length;
        if (overlapCount >= capacity) reasons.push('station_capacity_exceeded');
      }
    }

    // 4g) P1-A：Task Window ∩ Horizon（正空间）——候选区间与任务最早/截止边界无重叠
    // → 时间窗交集为空（候选不可派）。候选区间由 buildCandidatePool 按 travel+now 构造。
    if (task.earliestStartMs != null && candidateEnd <= task.earliestStartMs) {
      reasons.push('time_conflict');
    }
    if (task.dueAtMs != null && candidateStart >= task.dueAtMs) {
      reasons.push('time_conflict');
    }

    // 4h) P1-A：资源可用窗口正空间判定——候选区间必须与各资源至少一个可用窗口重叠。
    // 缺数据（空数组/undefined）→ 不限制（缺数据不伪造窗口，避免误伤存量无窗口数据的资源）。
    const personAvail = person.availableWindows ?? [];
    if (
      personAvail.length > 0 &&
      !personAvail.some((w) =>
        w.startMs <= candidateStart && candidateEnd <= w.endMs,
      )
    ) {
      reasons.push('time_conflict');
    }
    if (device) {
      // 4h1) 设备维护时间窗（负空间）：候选区间与任一维护窗口重叠 → 设备不可派。
      const mw = device.maintenanceWindows ?? [];
      if (
        mw.some((w) =>
          this.intervalsOverlap(w.startMs, w.endMs, candidateStart, candidateEnd),
        )
      ) {
        reasons.push('time_conflict');
      }
      // 4h2) 设备可用窗口（正空间）：候选区间必须落在至少一个窗口内（无数据不限制）。
      const devAvail = device.availableWindows ?? [];
      if (
        devAvail.length > 0 &&
        !devAvail.some((w) =>
          w.startMs <= candidateStart && candidateEnd <= w.endMs,
        )
      ) {
        reasons.push('time_conflict');
      }
    }
    // 4h3) 工位可用窗口（正空间；无数据不限制）。
    if (stationId) {
      const stationAvail = ctx.stationAvailableWindowsById?.get(stationId) ?? [];
      if (
        stationAvail.length > 0 &&
        !stationAvail.some((w) =>
          w.startMs <= candidateStart && candidateEnd <= w.endMs,
        )
      ) {
        reasons.push('time_conflict');
      }
    }
    // shift 契约（P1-A）：ewoh_personnel.shift 仅为 nullable 字符串（schema 无时间窗数据），
    // 不具备 start/end 时间语义，因此 shift 不参与硬交集——禁止用字符串猜测班次时间。

    // 5) 风险状态 / 已锁定人员
    if (ctx.lockedPersonIds.includes(person.id)) reasons.push('person_unavailable');

    // 6) 设备可用性 / 离线
    if (device) {
      if (!device.online) reasons.push('device_offline');
      const batteryPct = normalizeBatteryPct(device.batteryPct);
      if (batteryPct == null) reasons.push('battery_unknown');
      else if (batteryPct < ctx.minBatteryPct) reasons.push('battery_low');
      if (device.status === 'fault' || device.status === 'maintenance')
        reasons.push('device_unavailable');
      // 6a) NO-05c（ADR-010）：活跃维护状态事实 → 拒绝派工（fail-closed，人审解除）。
      if (device.maintenance != null && device.maintenance.length > 0) {
        reasons.push('device_maintenance_blocked');
      }
      // 6b) NO-05d（ADR-011）：critical/high 活跃质量发现 → 拒绝派工
      // （fail-closed，人审经 dispositioned/closed 解除）；medium/low 不封锁。
      if (this.qualityBlocks(device.qualityFindings)) {
        reasons.push('device_quality_blocked');
      }
      // 6c) NO-34a：设备正在外骨骼会话中（已绑定佩戴人员）→ 拒绝派工。
      // 这不是"提示"而是**硬约束**：一台外骨骼物理上不可能同时被两个人穿戴，
      // 会话是显式、可审计的绑定事实（ADR-032）。要解除要么结束会话，要么把任务
      // 交给正在佩戴的人（当前候选模型不支持"指定佩戴者"配对，因此一律拒绝并说明）。
      if (device.activeExoSession) {
        // 佩戴中的设备只对**正在佩戴它的那个人**可用（NO-35a）：
        //   · 候选人员就是佩戴者 → 合法（人机同体，物理上可行）；
        //   · 其它人员 → 拒绝（一台外骨骼不可能同时被两个人穿戴）；
        //   · 额外守卫：任务若锁定给别人，即使评估到佩戴者也不能用（锁定语义优先）。
        const wearer = normalizePersonRef(device.activeExoSession.personId);
        const candidatePerson = normalizePersonRef(person.id);
        const lockedTo = normalizePersonRef(task.lockedAssigneeId ?? null);
        if (candidatePerson !== wearer || (lockedTo !== null && lockedTo !== wearer)) {
          reasons.push('device_in_active_session');
        }
      }
      // 6b) 设备能力匹配：任务要求的任一能力缺失 → 设备不可用（即使在线且电量充足）。
      const requiredCaps = task.requiredDeviceCapabilities ?? [];
      if (requiredCaps.length > 0) {
        const capabilityNames = deviceCapabilityNames(device);
        const missing = requiredCaps.filter(
          (cap) => !capabilityNames.includes(cap),
        );
        if (missing.length > 0) {
          // 缺失 ≠ 停用（NO-15b）：如果缺的能力恰好**被人为停用**，原因要如实说
          // 是"被停用"（现场该去复核停用决定/恢复），而不是让现场以为是设备缺陷。
          const disabled = new Set(device.disabledCapabilities ?? []);
          const disabledMissing = missing.filter((cap) => disabled.has(cap));
          // 分开写（而不是三元表达式里的字符串）：词表漂移守卫靠扫描
          // `reasons.push('key')` 统计真实产出，写在表达式里会漏检。
          if (disabledMissing.length === missing.length && disabledMissing.length > 0) {
            reasons.push('capability_disabled');
          } else {
            reasons.push('missing_device_capability');
          }
        }
      }
    }

    // 7) 区域访问（禁入区域）
    if (task.zoneId && ctx.forbiddenZones.includes(task.zoneId))
      reasons.push('zone_forbidden');

    // 8) 前置任务完成
    for (const predId of task.predIds) {
      if (!ctx.predecessorDone(predId)) {
        reasons.push('predecessor_pending');
        break;
      }
    }

    // 9) 最大连续负荷
    if (person.loadLevel > ctx.maxContinuousLoad)
      reasons.push('continuous_work_exceeded');

    // 10) 安全
    if (ctx.safetyBlockedPersonIds.includes(person.id))
      reasons.push('safety_blocked');
    if (device && (ctx.safetyBlockedDeviceIds ?? []).includes(device.id))
      reasons.push('safety_blocked');

    // 11) P1-B：safety-critical fail-close——STALE/UNKNOWN 或关键 DERIVED 事实的候选不可派。
    // 与 dataQuality（新鲜度）正交；仅 safetyCritical=true 任务触发，非安全任务同状态不受影响。
    if (task.safetyCritical === true) {
      const personStale =
        person.dataQuality === 'STALE' || person.dataQuality === 'UNKNOWN';
      const deviceStale =
        device != null &&
        (device.dataQuality === 'STALE' || device.dataQuality === 'UNKNOWN');
      if (personStale || deviceStale) reasons.push('stale_data');
      if (person.source === 'DERIVED' || device?.source === 'DERIVED') {
        reasons.push('derived_data_fail_closed');
      }
    }

    return {
      personId: person.id,
      eligible: reasons.length === 0,
      reasons,
    };
  }

  private intervalsOverlap(
    startA: number,
    endA: number,
    startB: number,
    endB: number,
  ): boolean {
    return startA < endB && startB < endA;
  }
}
