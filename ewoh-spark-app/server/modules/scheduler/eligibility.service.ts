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
}

/** 参与资格判定的设备描述。 */
export interface EligibleDevice {
  id: string;
  batteryPct: number;
  online: boolean;
  status: string | null;
}

/** 参与资格判定的任务描述。 */
export interface EligibleTask {
  id: string;
  taskType: string;
  requiredSkills: string[];
  requiredCertifications: string[];
  stationId: string | null;
  zoneId: string | null;
  predIds: string[];
}

/** 资格判定上下文（软/硬约束参数）。 */
export interface EligibilityContext {
  now: number;
  /** 本次窗口内已占用的人员时间段（personId → 区间），用于防止双重预订。 */
  bookedTimeSlots: Array<{ personId: string; start: number; end: number }>;
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
      const hasSkill = task.requiredSkills.some((s) =>
        person.skills.includes(s),
      );
      if (!hasSkill) reasons.push('missing_skill');
    }

    // 2) 资质认证
    if (task.requiredCertifications.length > 0) {
      const certOk = task.requiredCertifications.every((c) =>
        person.certifications.includes(c),
      );
      if (!certOk) reasons.push('missing_certification');
    }

    // 3) 在岗状态（人员可用）
    if (person.status !== 'available') reasons.push('person_unavailable');

    // 4) 时间冲突（人员不被双重预订）
    const conflicts = ctx.bookedTimeSlots.filter(
      (b) => this.intervalsOverlap(b.start, b.end, ctx.now, ctx.now),
    );
    if (conflicts.some((b) => b.personId === person.id))
      reasons.push('time_conflict');

    // 5) 风险状态 / 已锁定人员
    if (ctx.lockedPersonIds.includes(person.id)) reasons.push('person_unavailable');

    // 6) 设备可用性 / 离线
    if (device) {
      if (!device.online) reasons.push('device_offline');
      if (device.batteryPct < ctx.minBatteryPct) reasons.push('battery_low');
      if (device.status === 'fault' || device.status === 'maintenance')
        reasons.push('device_unavailable');
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