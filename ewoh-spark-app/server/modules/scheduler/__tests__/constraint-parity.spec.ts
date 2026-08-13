/* 统一约束 IR 编译器 parity 测试矩阵（Phase 1 / P1-1）。
 *
 * 以数据驱动方式逐条断言 8 条 parity 关键约束的编译结果，并把 IR 语义与
 * eligibility.service.ts 的 reason key、双求解器语义对齐（防止双求解器漂移）。
 */
/// <reference types="jest" />
import {
  classifyHardness,
  compileConstraints,
  type ConstraintCompileTask,
} from '../constraint-compiler';
import type { SchedulingConstraint, SchedulingConstraintIR } from '@shared/scheduler';

function makeTask(overrides: Partial<ConstraintCompileTask> = {}): ConstraintCompileTask {
  return {
    requiredSkills: ['assembly', 'weld'],
    skillMatchMode: 'ALL',
    requiredCertifications: ['c-weld-basic'],
    mustFinishByMs: null,
    dueMs: null,
    predIds: ['t0'],
    ...overrides,
  };
}

function makeCtx(
  tasks: Record<string, ConstraintCompileTask> = { t1: makeTask() },
  weights: { lateness?: number } = { lateness: 100 },
): { tasksById: Map<string, ConstraintCompileTask>; weights: { lateness?: number } } {
  return {
    tasksById: new Map<string, ConstraintCompileTask>(Object.entries(tasks)),
    weights,
  };
}

function constraint(
  overrides: Partial<SchedulingConstraint> = {},
): SchedulingConstraint {
  return {
    type: 'REQUIRED_SKILL',
    taskId: 't1',
    ...overrides,
  };
}

function byType(irs: SchedulingConstraintIR[], type: string): SchedulingConstraintIR {
  const ir = irs.find((x) => x.type === type);
  if (!ir) throw new Error(`missing IR entry for type=${type}`);
  return ir;
}

describe('constraint-compiler（统一约束 IR parity 矩阵）', () => {
  describe('classifyHardness（EXCLUDED_RESOURCE 双集合冲突时 HARD 优先）', () => {
    it('EXCLUDED_RESOURCE 重分类为 HARD（与 SUPPORTED_HARD_CONSTRAINTS 一致）', () => {
      expect(classifyHardness('EXCLUDED_RESOURCE')).toBe('HARD');
    });

    it('硬/软约束分类正确', () => {
      expect(classifyHardness('REQUIRED_SKILL')).toBe('HARD');
      expect(classifyHardness('STATION_CAPACITY')).toBe('HARD');
      expect(classifyHardness('MIN_TRAVEL_TIME')).toBe('SOFT');
      expect(classifyHardness('FATIGUE_BALANCE')).toBe('SOFT');
    });
  });

  describe('8 条 parity 关键约束', () => {
    it('REQUIRED_SKILL（ALL，缺省）→ params.skillMatchMode + params.requiredSkills', () => {
      const [ir] = compileConstraints([constraint()], makeCtx());
      expect(ir.hardness).toBe('HARD');
      expect(ir.scope).toBe('person');
      expect(ir.reasonCode).toBe('missing_skill');
      expect(ir.params).toMatchObject({
        skillMatchMode: 'ALL',
        requiredSkills: ['assembly', 'weld'],
      });
    });

    it('REQUIRED_SKILL（ANY）→ params.skillMatchMode=ANY', () => {
      const [ir] = compileConstraints(
        [constraint()],
        makeCtx({
          t1: makeTask({ skillMatchMode: 'ANY', requiredSkills: ['inspect'] }),
        }),
      );
      expect(ir.params).toMatchObject({
        skillMatchMode: 'ANY',
        requiredSkills: ['inspect'],
      });
    });

    it('REQUIRED_CERTIFICATION → params.requiredCertifications + missing_certification', () => {
      const [ir] = compileConstraints(
        [constraint({ type: 'REQUIRED_CERTIFICATION' })],
        makeCtx(),
      );
      expect(ir.hardness).toBe('HARD');
      expect(ir.scope).toBe('person');
      expect(ir.reasonCode).toBe('missing_certification');
      expect(ir.params).toMatchObject({
        requiredCertifications: ['c-weld-basic'],
      });
    });

    it('SAFETY_BLOCK → HARD + reasonCode=safety_blocked + scope=person', () => {
      const [ir] = compileConstraints(
        [constraint({ type: 'SAFETY_BLOCK', personId: 'p9' })],
        makeCtx(),
      );
      expect(ir.hardness).toBe('HARD');
      expect(ir.scope).toBe('person');
      expect(ir.reasonCode).toBe('safety_blocked');
    });

    it('PREDECESSOR → params.predIds + reasonCode=predecessor_pending', () => {
      const [ir] = compileConstraints(
        [constraint({ type: 'PREDECESSOR' })],
        makeCtx({ t1: makeTask({ predIds: ['t0', 't-1'] }) }),
      );
      expect(ir.hardness).toBe('HARD');
      expect(ir.scope).toBe('task');
      expect(ir.reasonCode).toBe('predecessor_pending');
      expect(ir.params).toMatchObject({ predIds: ['t0', 't-1'] });
    });

    it('STATION_CAPACITY → HARD + params.capacity + reasonCode=station_capacity_exceeded', () => {
      const [ir] = compileConstraints(
        [constraint({ type: 'STATION_CAPACITY', stationId: 'S-1', value: 3 })],
        makeCtx(),
      );
      expect(ir.hardness).toBe('HARD');
      expect(ir.scope).toBe('station');
      expect(ir.reasonCode).toBe('station_capacity_exceeded');
      expect(ir.params.capacity).toBe(3);
    });

    it('mustFinishByMs（任务派生）→ HARD + params.mustFinishByMs + must_finish_by_violation', () => {
      const irs = compileConstraints(
        [],
        makeCtx({ t1: makeTask({ mustFinishByMs: 1_700_001_600_000 }) }),
      );
      const ir = byType(irs, 'MUST_FINISH_BY');
      expect(ir.hardness).toBe('HARD');
      expect(ir.scope).toBe('task');
      expect(ir.source).toBe('derived');
      expect(ir.reasonCode).toBe('must_finish_by_violation');
      expect(ir.params.mustFinishByMs).toBe(1_700_001_600_000);
    });

    it('dueMs（任务派生）→ SOFT + params.dueMs + penalty（lateness 罚）', () => {
      const irs = compileConstraints(
        [],
        makeCtx({ t1: makeTask({ dueMs: 1_700_001_000_000 }) }),
      );
      const ir = byType(irs, 'DUE');
      expect(ir.hardness).toBe('SOFT');
      expect(ir.scope).toBe('task');
      expect(ir.source).toBe('derived');
      expect(ir.reasonCode).toBe('due');
      expect(ir.params.dueMs).toBe(1_700_001_000_000);
      expect(ir.penalty).toBe(100);
    });

    it('EXCLUDED_RESOURCE → HARD（重分类）', () => {
      const [ir] = compileConstraints(
        [constraint({ type: 'EXCLUDED_RESOURCE', deviceId: 'd9' })],
        makeCtx(),
      );
      expect(ir.hardness).toBe('HARD');
      expect(ir.scope).toBe('device');
      expect(ir.reasonCode).toBe('excluded_resource');
      expect(ir.params.deviceId).toBe('d9');
    });
  });

  describe('其余硬/软约束通用归一化', () => {
    it('其余硬约束映射到 eligibility reason key（PERSON_AVAILABLE / MIN_BATTERY）', () => {
      const irs = compileConstraints(
        [
          constraint({ type: 'PERSON_AVAILABLE', personId: 'p1' }),
          constraint({ type: 'MIN_BATTERY', value: 20 }),
        ],
        makeCtx(),
      );
      const person = byType(irs, 'PERSON_AVAILABLE');
      expect(person.hardness).toBe('HARD');
      expect(person.reasonCode).toBe('person_unavailable');
      const battery = byType(irs, 'MIN_BATTERY');
      expect(battery.hardness).toBe('HARD');
      expect(battery.reasonCode).toBe('battery_low');
    });

    it('软约束归一化为 SOFT + 类型名小写蛇形 reasonCode', () => {
      const irs = compileConstraints(
        [
          constraint({ type: 'MIN_TRAVEL_TIME' }),
          constraint({ type: 'FATIGUE_BALANCE' }),
        ],
        makeCtx(),
      );
      expect(byType(irs, 'MIN_TRAVEL_TIME')).toMatchObject({
        hardness: 'SOFT',
        reasonCode: 'min_travel_time',
      });
      expect(byType(irs, 'FATIGUE_BALANCE')).toMatchObject({
        hardness: 'SOFT',
        reasonCode: 'fatigue_balance',
      });
    });
  });

  describe('不支持约束（UNSUPPORTED）', () => {
    it('不支持的约束 → reasonCode=UNSUPPORTED_CONSTRAINT（绝不标为已执行）', () => {
      const irs = compileConstraints(
        [constraint({ type: 'NOT_A_REAL_CONSTRAINT' as SchedulingConstraint['type'] })],
        makeCtx(),
      );
      expect(irs).toHaveLength(1);
      expect(irs[0].reasonCode).toBe('UNSUPPORTED_CONSTRAINT');
      expect(irs[0].type).toBe('NOT_A_REAL_CONSTRAINT');
    });
  });
});
