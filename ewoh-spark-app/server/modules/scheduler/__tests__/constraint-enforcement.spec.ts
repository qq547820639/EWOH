/* CSTR-01（V357）：硬约束"声明面 ↔ 执行面"的分档，与决策追踪收窄。
 *
 * 钉住的事实：`SUPPORTED_HARD_CONSTRAINTS` 自称"求解器真实执行"，但 19 类里只有 9 类读约束实例
 * 自带的参数（`heuristic-scheduling-solver.ts` 的 switch case），另 10 类的维度由快照数据侧或
 * 求解器构造保证、实例参数无人读（`constraint-loader.service.ts` 只取 personId/deviceId/stationId/
 * zoneId/startMs/endMs 那几个键）。本轮只改"报什么"（追踪不再恒报注册表全量），不改"怎么解"。
 *
 * 为什么维度类不记成 violation：`solver.service.ts` 的 feasible = 派工数量达标 ∧ violations 为空，
 * 记违规会让本来可行的方案凭空不可行（那是行为变更，不是报告修正）。
 */
/// <reference types="jest" />
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  DIMENSION_ONLY_HARD_CONSTRAINTS,
  HARD_CONSTRAINT_ENFORCEMENT,
  SOLVER_CONSUMED_HARD_CONSTRAINTS,
  SUPPORTED_HARD_CONSTRAINTS,
  classifyHardConstraints,
} from '../constraints';
import {
  baseSolveOpts,
  buildSnapshot,
  defaultPolicy,
  device,
  makeSolver,
  person,
  task,
} from './scheduler-test-helpers';
import type { SchedulingConstraint } from '@shared/api.interface';

describe('CSTR-01 硬约束执行分档', () => {
  it('CSTR-01 分档表穷尽：键集＝注册表、两档相加＝分母、两档不相交', () => {
    expect(Object.keys(HARD_CONSTRAINT_ENFORCEMENT).sort()).toEqual(
      [...SUPPORTED_HARD_CONSTRAINTS].sort(),
    );
    expect(SOLVER_CONSUMED_HARD_CONSTRAINTS.length).toBe(9);
    expect(DIMENSION_ONLY_HARD_CONSTRAINTS.length).toBe(10);
    // Σ档位 == 分母（硬断言，防止新增类型只进一档或被漏掉）
    expect(
      SOLVER_CONSUMED_HARD_CONSTRAINTS.length + DIMENSION_ONLY_HARD_CONSTRAINTS.length,
    ).toBe(SUPPORTED_HARD_CONSTRAINTS.length);
    expect(
      SOLVER_CONSUMED_HARD_CONSTRAINTS.filter((t) => DIMENSION_ONLY_HARD_CONSTRAINTS.includes(t)),
    ).toEqual([]);
  });

  it('CSTR-01 classifyHardConstraints：软约束不进两档、重复类型去重、结果按名字定序', () => {
    const { consumed, dimensionOnly } = classifyHardConstraints([
      { type: 'LOCKED_DEVICE', taskId: 't1', deviceId: 'd1' },
      { type: 'LOCKED_DEVICE', taskId: 't2', deviceId: 'd2' },
      { type: 'STATION_CAPACITY', taskId: 't1' },
      { type: 'RESOURCE_TIME_WINDOW', taskId: 't1', startMs: 0, endMs: 1 },
      { type: 'PREFERRED_RESOURCE', taskId: 't1', deviceId: 'd1' },
    ] as SchedulingConstraint[]);
    expect(consumed).toEqual(['LOCKED_DEVICE']);
    expect(dimensionOnly).toEqual(['RESOURCE_TIME_WINDOW', 'STATION_CAPACITY']);
  });

  it('CSTR-01 生产路径：追踪只报按实例参数执行的类型，维度类落到 hardConstraintsIgnored', async () => {
    const { solver } = makeSolver();
    const plan = await solver.solve(
      buildSnapshot({
        persons: [person({ id: 'p1' })],
        tasks: [task({ id: 't1' })],
        devices: [device({ id: 'd1' })],
      }),
      [
        { type: 'LOCKED_DEVICE', taskId: 't1', deviceId: 'd1' },
        { type: 'RESOURCE_TIME_WINDOW', taskId: 't1', startMs: 0, endMs: Number.MAX_SAFE_INTEGER },
      ] as SchedulingConstraint[],
      { ...baseSolveOpts, policy: defaultPolicy() },
    );
    const trace = plan.assignments.find((a) => a.taskId === 't1')?.decisionTrace as
      | { hardConstraints?: string[]; hardConstraintsIgnored?: string[] }
      | undefined;
    expect(trace).toBeDefined();
    expect(trace!.hardConstraints).toEqual(['LOCKED_DEVICE']);
    expect(trace!.hardConstraintsIgnored).toEqual(['RESOURCE_TIME_WINDOW']);
    // 牙齿：改前这里恒等于注册表全量，同一句判据在旧行为下必翻红。
    expect(trace!.hardConstraints!.length).toBeLessThan(SUPPORTED_HARD_CONSTRAINTS.length);
    expect(trace!.hardConstraints).not.toContain('STATION_CAPACITY');
  });

  it('CSTR-01 接线：追踪由分档函数填充，求解器源码不再引用注册表全量', () => {
    const src = readFileSync(
      resolve(__dirname, '..', 'heuristic-scheduling-solver.ts'),
      'utf8',
    );
    expect(src).toContain('traceExt.hardConstraints = hardEnforcement.consumed;');
    expect(src).toContain('traceExt.hardConstraintsIgnored = hardEnforcement.dimensionOnly;');
    expect(src).not.toContain('SUPPORTED_HARD_CONSTRAINTS');
  });
});
