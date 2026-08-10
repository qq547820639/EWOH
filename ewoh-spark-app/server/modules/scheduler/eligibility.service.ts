import { Injectable } from '@nestjs/common';
import type { EligibilityResult } from '@shared/api.interface';

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
}

/** 参与资格判定的设备描述。 */
export interface EligibleDevice {
  id: string;
  batteryPct: number;
  online: boolean;
  status: string | null;
  /** 设备能力（如 'exo-lift' / 'vacuum'），用于 requiredDeviceCapabilities 匹配。 */
  capabilities: string[];
  // --- Command Map 增量（Phase 1 / P1-A + P1-B） ---
  /** 可用时间窗（正空间；缺数据不限制，不伪造）。 */
  availableWindows?: Array<{ startMs: number; endMs: number }> | null;
  /** 维护时间窗（负空间；与候选区间重叠 → 设备不可用）。 */
  maintenanceWindows?: Array<{ startMs: number; endMs: number }> | null;
  /** 数据质量（P1-B fail-close；STALE/UNKNOWN + safety-critical → stale_data）。 */
  dataQuality?: 'FRESH' | 'STALE' | 'UNKNOWN';
  /** 字段来源维度（P1-B fail-close；DERIVED + safety-critical → derived_data_fail_closed）。 */
  source?: 'AUTHORITATIVE' | 'DERIVED';
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
  /** 前置任务是否已完成。 */
  predecessorDone: (taskId: string) => boolean;
  /** T03 / P1-4：当前评估的候选工位（station 决策变量；缺省回退 task.stationId）。 */
  candidateStationId?: string | null;
  /** T03 / P1-3：候选工位容量（stationId → capacity）；null 表示无容量信息。 */
  stationCapacityById?: Map<string, number | null>;
  /** T03 / P1-3：候选工位能力（stationId → capabilities[]）。 */
  stationCapabilitiesById?: Map<string, string[]>;
  /** T03 / P1-3：候选工位已占用（stationId → 时间区间），用于容量计数。 */
  bookedStationCounts?: Map<string, number>;
  /** P1-A：候选工位可用窗口（stationId → 窗口列表）；无数据不限制（缺数据不伪造）。 */
  stationAvailableWindowsById?: Map<string, Array<{ startMs: number; endMs: number }>>;
}

/**
 * 资格服务：对【人员 × 任务 × 设备】执行硬约束校验，
 * 每个未通过项返回一个原因 key（如 missing_skill / battery_low）。
 */
@Injectable()
export class EligibilityService {
  /**
   * 硬约束检查。返回 eligible=false 并附带全部未通过原因。
   */
  check(
    person: EligiblePerson,
    task: EligibleTask,
    device: EligibleDevice | null,
    ctx: EligibilityContext,
  ): EligibilityResult {
    const reasons: string[] = [];

    // 1) 技能匹配
    if (task.requiredSkills.length > 0) {
      const matchMode = task.skillMatchMode ?? 'ALL';
      // ALL=全部必需（.every），ANY=任一即可（.some）
      const hasSkill =
        matchMode === 'ALL'
          ? task.requiredSkills.every((s) => person.skills.includes(s))
          : task.requiredSkills.some((s) => person.skills.includes(s));
      if (!hasSkill) reasons.push('missing_skill');
    }

    // 1b) 证书到期（T03 / P1-2）：requiredCertifications 命中已过期证书 → cert_expired。
    if (task.requiredCertifications.length > 0) {
      const certOk = task.requiredCertifications.every((c) =>
        person.certifications.includes(c),
      );
      if (!certOk) reasons.push('missing_certification');
      else {
        const expired = (person.certificationExpiry ?? []).some(
          (e) =>
            e.expiresAtMs != null &&
            e.expiresAtMs < ctx.now &&
            task.requiredCertifications.includes(e.name),
        );
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

    // 2) 资质认证（证书存在性；1b 已处理过期）
    if (task.requiredCertifications.length > 0 && !reasons.includes('cert_expired')) {
      const certOk = task.requiredCertifications.every((c) =>
        person.certifications.includes(c),
      );
      if (!certOk) reasons.push('missing_certification');
    }

    // 3) 在岗状态（人员可用）
    if (person.status !== 'available') reasons.push('person_unavailable');

    // 4) 时间冲突（人员不被双重预订，用候选时间区间判定）
    const candidateStart = ctx.candidateStartMs;
    const candidateEnd = ctx.candidateEndMs;
    const conflicts = ctx.bookedTimeSlots.filter((b) =>
      this.intervalsOverlap(b.start, b.end, candidateStart, candidateEnd),
    );
    if (conflicts.some((b) => b.personId === person.id))
      reasons.push('time_conflict');

    // 4b) 设备 reservation 冲突
    if (device) {
      const deviceConflict = (ctx.bookedDeviceSlots ?? []).some(
        (s) =>
          s.deviceId === device.id &&
          this.intervalsOverlap(s.start, s.end, candidateStart, candidateEnd),
      );
      if (deviceConflict) reasons.push('device_reserved');
    }

    // 4c) 工位 reservation 冲突（针对候选工位，station 决策变量场景）
    const stationId = ctx.candidateStationId ?? task.stationId ?? null;
    if (stationId) {
      const stationConflict = (ctx.bookedStationSlots ?? []).some(
        (s) =>
          s.stationId === stationId &&
          this.intervalsOverlap(s.start, s.end, candidateStart, candidateEnd),
      );
      if (stationConflict) reasons.push('station_reserved');
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
      const caps = ctx.stationCapabilitiesById?.get(stationId) ?? [];
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
        this.intervalsOverlap(w.startMs, w.endMs, candidateStart, candidateEnd),
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
          this.intervalsOverlap(w.startMs, w.endMs, candidateStart, candidateEnd),
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
          this.intervalsOverlap(w.startMs, w.endMs, candidateStart, candidateEnd),
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
      if (device.batteryPct < ctx.minBatteryPct) reasons.push('battery_low');
      if (device.status === 'fault' || device.status === 'maintenance')
        reasons.push('device_unavailable');
      // 6b) 设备能力匹配：任务要求的任一能力缺失 → 设备不可用（即使在线且电量充足）。
      const requiredCaps = task.requiredDeviceCapabilities ?? [];
      if (requiredCaps.length > 0) {
        const missing = requiredCaps.filter(
          (cap) => !device.capabilities.includes(cap),
        );
        if (missing.length > 0) reasons.push('missing_device_capability');
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