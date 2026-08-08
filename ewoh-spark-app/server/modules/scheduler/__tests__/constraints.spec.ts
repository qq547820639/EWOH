import {
  checkConstraintSupported,
  detectDependencyCycle,
  determineUnsupported,
  SUPPORTED_HARD_CONSTRAINTS,
  SUPPORTED_SOFT_CONSTRAINTS,
} from '../constraints';
import type { SchedulingConstraint } from '@shared/api.interface';

describe('constraints.ts', () => {
  describe('支持性检查', () => {
    it('全部 16 个硬约束均被判定为 supported', () => {
      expect(SUPPORTED_HARD_CONSTRAINTS).toHaveLength(16);
      for (const type of SUPPORTED_HARD_CONSTRAINTS) {
        const result = checkConstraintSupported({ type, taskId: 't1' });
        expect(result.supported).toBe(true);
        expect(result.reason).toBe('OK');
      }
    });

    it('全部 9 个软约束均被判定为 supported', () => {
      expect(SUPPORTED_SOFT_CONSTRAINTS).toHaveLength(9);
      for (const type of SUPPORTED_SOFT_CONSTRAINTS) {
        const result = checkConstraintSupported({ type, taskId: 't1' });
        expect(result.supported).toBe(true);
        expect(result.reason).toBe('OK');
      }
    });

    it('未知约束类型被显式判定为 UNSUPPORTED_CONSTRAINT', () => {
      const result = checkConstraintSupported({
        type: 'NOT_A_REAL_CONSTRAINT' as SchedulingConstraint['type'],
        taskId: 't1',
      });
      expect(result.supported).toBe(false);
      expect(result.reason).toBe('UNSUPPORTED_CONSTRAINT');
    });

    it('determineUnsupported 只返回不支持的约束', () => {
      const unsupported = determineUnsupported([
        { type: 'REQUIRED_SKILL', taskId: 't1' },
        { type: 'LOCKED_PERSON', taskId: 't1', personId: 'p1' },
        { type: 'GARBAGE' as SchedulingConstraint['type'], taskId: 't2' },
      ]);
      expect(unsupported).toHaveLength(1);
      expect(unsupported[0].constraint.type).toBe('GARBAGE');
      expect(unsupported[0].reason).toBe('UNSUPPORTED_CONSTRAINT');
    });
  });

  describe('detectDependencyCycle（前置依赖环检测）', () => {
    it('无环的线性依赖返回 null', () => {
      const predecessorOf = (id: string): string[] => {
        switch (id) {
          case 'a':
            return [];
          case 'b':
            return ['a'];
          case 'c':
            return ['b'];
          default:
            return [];
        }
      };
      expect(detectDependencyCycle(['a', 'b', 'c'], predecessorOf)).toBeNull();
    });

    it('a→b→a 的环被检测出，返回环路径', () => {
      const predecessorOf = (id: string): string[] => {
        switch (id) {
          case 'a':
            return ['b'];
          case 'b':
            return ['a'];
          default:
            return [];
        }
      };
      const cycle = detectDependencyCycle(['a', 'b'], predecessorOf);
      expect(cycle).not.toBeNull();
      // 环路径首尾相同。
      expect(cycle![0]).toBe(cycle![cycle!.length - 1]);
      expect(cycle!.length).toBeGreaterThan(1);
    });

    it('三任务自环 a→b→c→a 被检测出', () => {
      const map: Record<string, string[]> = {
        a: ['c'],
        b: ['a'],
        c: ['b'],
      };
      const cycle = detectDependencyCycle(['a', 'b', 'c'], (id) => map[id] ?? []);
      expect(cycle).not.toBeNull();
      expect(cycle![0]).toBe(cycle![cycle!.length - 1]);
    });

    it('集合外的前置任务被忽略，不误报环', () => {
      const predecessorOf = (id: string): string[] => {
        if (id === 'a') return ['external'] as string[];
        if (id === 'b') return ['a'];
        return [];
      };
      // external 不在给定任务集合内 → 不应形成环。
      expect(detectDependencyCycle(['a', 'b'], predecessorOf)).toBeNull();
    });
  });
});