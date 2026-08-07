import { EligibilityService, type EligiblePerson, type EligibleTask } from '../eligibility.service';
import { makeEligibilityCtx } from './scheduler-test-helpers';

describe('EligibilityService reservation 冲突（Task 0.2）', () => {
  const svc = new EligibilityService();

  const person: EligiblePerson = {
    id: 'p1',
    status: 'available',
    skills: ['work'],
    certifications: [],
    stationId: null,
    loadLevel: 0,
    fatigueLevel: 0,
    healthStatus: 'normal',
  };

  const baseTask: EligibleTask = {
    id: 't1',
    taskType: 'work',
    requiredSkills: ['work'],
    requiredCertifications: [],
    stationId: null,
    zoneId: null,
    predIds: [],
  };

  it('人员已有 09:00-10:00 预订，新任务候选 09:30-10:30 → time_conflict', () => {
    const res = svc.check(
      person,
      baseTask,
      null,
      makeEligibilityCtx({
        bookedTimeSlots: [{ personId: 'p1', start: 9 * 3600_000, end: 10 * 3600_000 }],
        candidateStartMs: 9.5 * 3600_000,
        candidateEndMs: 10.5 * 3600_000,
      }),
    );
    expect(res.eligible).toBe(false);
    expect(res.reasons).toContain('time_conflict');
  });

  it('非重叠区间不冲突 → 不记 time_conflict', () => {
    const res = svc.check(
      person,
      baseTask,
      null,
      makeEligibilityCtx({
        bookedTimeSlots: [{ personId: 'p1', start: 8 * 3600_000, end: 9 * 3600_000 }],
        candidateStartMs: 9.5 * 3600_000,
        candidateEndMs: 10.5 * 3600_000,
      }),
    );
    expect(res.eligible).toBe(true);
    expect(res.reasons).not.toContain('time_conflict');
  });

  it('设备 reservation 冲突 → device_reserved', () => {
    const res = svc.check(
      person,
      baseTask,
      { id: 'd1', batteryPct: 100, online: true, status: 'online', capabilities: [] },
      makeEligibilityCtx({
        bookedDeviceSlots: [{ deviceId: 'd1', start: 9 * 3600_000, end: 10 * 3600_000 }],
        candidateStartMs: 9.5 * 3600_000,
        candidateEndMs: 10.5 * 3600_000,
      }),
    );
    expect(res.reasons).toContain('device_reserved');
  });

  it('工位 reservation 冲突 → station_reserved', () => {
    const res = svc.check(
      person,
      { ...baseTask, stationId: 'st1' },
      null,
      makeEligibilityCtx({
        bookedStationSlots: [{ stationId: 'st1', start: 9 * 3600_000, end: 10 * 3600_000 }],
        candidateStartMs: 9.5 * 3600_000,
        candidateEndMs: 10.5 * 3600_000,
      }),
    );
    expect(res.reasons).toContain('station_reserved');
  });

  it('无设备/无工位时不产生设备/工位冲突原因', () => {
    const res = svc.check(
      person,
      baseTask,
      null,
      makeEligibilityCtx({
        bookedDeviceSlots: [{ deviceId: 'd1', start: 0, end: 100 }],
        bookedStationSlots: [{ stationId: 'st1', start: 0, end: 100 }],
        candidateStartMs: 9.5 * 3600_000,
        candidateEndMs: 10.5 * 3600_000,
      }),
    );
    expect(res.reasons).not.toContain('device_reserved');
    expect(res.reasons).not.toContain('station_reserved');
  });

  describe('技能匹配语义 skillMatchMode（ALL / ANY）', () => {
    const multiSkillTask: EligibleTask = {
      id: 't-skill',
      taskType: 'work',
      requiredSkills: ['laser', 'cnc'],
      requiredCertifications: [],
      stationId: null,
      zoneId: null,
      predIds: [],
    };
    const partialPerson: EligiblePerson = {
      ...person,
      skills: ['laser'], // 只具备其中一个技能
    };

    it('缺省/ALL：人员缺少任一必需技能 → missing_skill', () => {
      const res = svc.check(
        partialPerson,
        multiSkillTask,
        null,
        makeEligibilityCtx({ candidateStartMs: 9 * 3600_000, candidateEndMs: 10 * 3600_000 }),
      );
      expect(res.eligible).toBe(false);
      expect(res.reasons).toContain('missing_skill');
    });

    it('ANY：人员具备任一必需技能 → 通过', () => {
      const res = svc.check(
        partialPerson,
        { ...multiSkillTask, skillMatchMode: 'ANY' },
        null,
        makeEligibilityCtx({ candidateStartMs: 9 * 3600_000, candidateEndMs: 10 * 3600_000 }),
      );
      expect(res.eligible).toBe(true);
      expect(res.reasons).not.toContain('missing_skill');
    });

    it('ALL：人员具备全部必需技能 → 通过', () => {
      const res = svc.check(
        { ...person, skills: ['laser', 'cnc'] },
        { ...multiSkillTask, skillMatchMode: 'ALL' },
        null,
        makeEligibilityCtx({ candidateStartMs: 9 * 3600_000, candidateEndMs: 10 * 3600_000 }),
      );
      expect(res.eligible).toBe(true);
      expect(res.reasons).not.toContain('missing_skill');
    });
  });
});