/* Task 5 / P1：solverStatusChainVM 纯映射 + SolverStatusChain 渲染测试（每种状态）。 */
import { renderToString } from 'react-dom/server';
import { solverStatusChain, SOLVER_STATUS_LABELS } from './solverStatusChainVM';
import { SolverStatusChain } from '../panels/SolverStatusChain';
import type { SolverStatus } from '@shared/api.interface';

describe('solverStatusChainVM：状态 → 链（纯映射）', () => {
  it('缺失/未知状态 → null（不伪造链）', () => {
    expect(solverStatusChain(null)).toBeNull();
    expect(solverStatusChain(undefined)).toBeNull();
    expect(solverStatusChain('SOMETHING' as SolverStatus)).toBeNull();
  });

  it('OPTIMAL → CP-SAT 求解器 → 最优解', () => {
    const chain = solverStatusChain('OPTIMAL')!;
    expect(chain.map((s) => s.label)).toEqual(['CP-SAT 求解器', '最优解 OPTIMAL']);
    expect(chain.map((s) => s.kind)).toEqual(['primary', 'result']);
  });

  it('FEASIBLE → CP-SAT 求解器 → 可行解', () => {
    const chain = solverStatusChain('FEASIBLE')!;
    expect(chain.map((s) => s.label)).toEqual(['CP-SAT 求解器', '可行解 FEASIBLE']);
  });

  it('HEURISTIC → 启发式求解器（生产规范）单节点', () => {
    const chain = solverStatusChain('HEURISTIC')!;
    expect(chain.map((s) => s.label)).toEqual(['启发式求解器（生产规范）']);
  });

  it('FALLBACK → CP-SAT 请求 → 回退 → 启发式兜底（三态链）', () => {
    const chain = solverStatusChain('FALLBACK')!;
    expect(chain.map((s) => s.label)).toEqual(['CP-SAT 请求', '回退 FALLBACK', '启发式兜底']);
    expect(chain.map((s) => s.kind)).toEqual(['primary', 'failed', 'fallback']);
  });

  it('TIMEOUT → CP-SAT 请求 → 超时 → 启发式兜底', () => {
    const chain = solverStatusChain('TIMEOUT')!;
    expect(chain.map((s) => s.label)).toEqual(['CP-SAT 请求', '超时 TIMEOUT', '启发式兜底']);
  });

  it('UNAVAILABLE → CP-SAT 请求 → 不可用 → 启发式兜底', () => {
    const chain = solverStatusChain('UNAVAILABLE')!;
    expect(chain.map((s) => s.label)).toEqual(['CP-SAT 请求', '不可用 UNAVAILABLE', '启发式兜底']);
  });

  it('INFEASIBLE → CP-SAT 求解器 → 无可行解', () => {
    const chain = solverStatusChain('INFEASIBLE')!;
    expect(chain.map((s) => s.label)).toEqual(['CP-SAT 求解器', '无可行解 INFEASIBLE']);
  });

  it('SOLVER_STATUS_LABELS 覆盖全部枚举', () => {
    for (const s of ['OPTIMAL', 'FEASIBLE', 'HEURISTIC', 'FALLBACK', 'TIMEOUT', 'UNAVAILABLE', 'INFEASIBLE']) {
      expect(SOLVER_STATUS_LABELS[s]).toBeTruthy();
    }
  });
});

const ALL_STATUSES: SolverStatus[] = ['OPTIMAL', 'FEASIBLE', 'HEURISTIC', 'FALLBACK', 'TIMEOUT', 'UNAVAILABLE', 'INFEASIBLE'];

describe('SolverStatusChain 渲染（node renderToString）', () => {
  it('每个状态都渲染对应链文本', () => {
    for (const status of ALL_STATUSES) {
      const html = renderToString(
        <SolverStatusChain status={status} solverVersion="cp-sat-v3" solveDurationMs={1200} />,
      );
      for (const step of solverStatusChain(status)!) {
        expect(html).toContain(step.label);
      }
      expect(html).toContain('cp-sat-v3'); // 版本进 tooltip
      expect(html).toContain('1200ms');
    }
  });

  it('无状态但有版本 → 只显示版本，不显示伪链', () => {
    const html = renderToString(<SolverStatusChain status={null} solverVersion="heuristic-v2" />);
    expect(html).toContain('heuristic-v2');
    expect(html).not.toContain('CP-SAT');
    expect(html).not.toContain('→');
  });

  it('无状态无版本 → 渲染空（null）', () => {
    expect(renderToString(<SolverStatusChain status={null} solverVersion={null} />)).toBe('');
  });

  it('FALLBACK 链包含「回退 FALLBACK」与「启发式兜底」', () => {
    const html = renderToString(
      <SolverStatusChain status="FALLBACK" solverVersion="cp-sat-v3" fallbackReason="worker_unreachable" />,
    );
    expect(html).toContain('回退 FALLBACK');
    expect(html).toContain('启发式兜底');
    expect(html).toContain('CP-SAT 请求');
    expect(html).toContain('worker_unreachable');
  });
});
