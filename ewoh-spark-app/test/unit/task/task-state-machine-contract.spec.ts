/* task-state-machine-contract.spec.ts — Canonical Execution Model TS↔契约锁步（ADR-049 / NO-12z，§9/§31）。
 *
 * 单一事实源 = contracts/state-machines/task.yaml。
 * 锁步对象：
 *   1. task.service.ts 的 TASK_ACTIONS / TASK_NON_TERMINAL / TASK_TERMINAL
 *      （nextTaskStatus 的运行时消费面）；
 *   2. scheduler/task-lifecycle.ts 的状态分类集合（历史别名显式声明）。
 * 漂移即测试失败（与 Python 侧 test_state_machine_contract.py 同纪律）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

import {
  TASK_ACTIONS,
  TASK_NON_TERMINAL,
  TASK_TERMINAL,
  nextTaskStatus,
  taskActionPath,
} from '../../../server/modules/task/task.service';
import { TaskLifecycle } from '../../../server/modules/scheduler/task-lifecycle';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const TASK_YAML = path.join(REPO_ROOT, 'contracts', 'state-machines', 'task.yaml');

interface TaskContract {
  version: string;
  states: string[];
  transitions: Array<{ from: string; to: string; role: unknown; condition: string }>;
  terminal: string[];
}

const contract = yaml.load(fs.readFileSync(TASK_YAML, 'utf-8')) as TaskContract;

/** 契约显式转换（any_non_terminal 除外）→ 锁定的 action 映射（ADR-049 审计结论）。 */
const EXPLICIT_ACTION_MAP: Record<string, string> = {
  'draft|pending_confirm': 'submit',
  'pending_confirm|pending_approval': 'request_approval',
  'pending_confirm|pending_dispatch': 'skip_approval',
  'pending_approval|pending_dispatch': 'approve',
  'pending_approval|draft': 'reject',
  'pending_dispatch|dispatched': 'dispatch',
  'dispatched|received': 'receive',
  'received|executing': 'start',
  'executing|paused': 'pause',
  'paused|executing': 'resume',
  'executing|exception': 'exception',
  'exception|executing': 'resolve',
  'executing|completed': 'complete',
};

function explicitTransitions(): Array<{ from: string; to: string }> {
  return contract.transitions.filter((t) => t.from !== 'any_non_terminal');
}

/** 从契约推导 11 状态 × 全动作 的期望 nextTaskStatus 表（穷举负例的期望源）。 */
function expectedNext(from: string, action: string): string | null {
  if (action === 'cancel') {
    if (contract.terminal.includes(from)) return null;
    if (contract.states.includes(from)) return 'cancelled';
    return null;
  }
  for (const t of explicitTransitions()) {
    if (t.from !== from) continue;
    const mapped = EXPLICIT_ACTION_MAP[`${t.from}|${t.to}`];
    if (mapped === action) return t.to;
  }
  return null;
}

/** 锁步检查器（可复用；负测试证明其可检出漂移）。 */
function diffActions(actions: Array<{ action: string; from: string; to: string }>): string[] {
  const errors: string[] = [];
  const byFrom = new Map<string, Set<string>>();
  for (const t of explicitTransitions()) {
    const mapped = EXPLICIT_ACTION_MAP[`${t.from}|${t.to}`];
    if (!mapped) {
      errors.push(`契约转换 ${t.from}->${t.to} 缺少 action 映射`);
      continue;
    }
    if (!actions.some((a) => a.action === mapped && a.from === t.from && a.to === t.to)) {
      errors.push(`契约转换 ${t.from}->${t.to}（action=${mapped}）在运行时表中缺失`);
    }
    if (!byFrom.has(t.from)) byFrom.set(t.from, new Set());
    byFrom.get(t.from)!.add(t.to);
  }
  for (const a of actions) {
    const allowed = byFrom.get(a.from);
    if (!allowed || !allowed.has(a.to)) {
      errors.push(`运行时表存在契约外转换 ${a.action}: ${a.from}->${a.to}`);
    }
  }
  return errors;
}

describe('Canonical Execution Model：TS 状态机 ↔ task.yaml 锁步（ADR-049）', () => {
  it('契约形状：11 状态 / 14 转换 / terminal=[completed, cancelled]', () => {
    expect(contract.states).toHaveLength(11);
    expect(contract.transitions).toHaveLength(14);
    expect(contract.terminal).toEqual(['completed', 'cancelled']);
  });

  it('TASK_ACTIONS 与契约逐条一致（无缺失、无契约外转换）', () => {
    expect(diffActions(TASK_ACTIONS)).toEqual([]);
  });

  it('穷举负例：11 状态 × 14 动作 与契约推导逐格一致（漂移即失败）', () => {
    const actions = [
      'submit', 'request_approval', 'skip_approval', 'approve', 'reject',
      'dispatch', 'receive', 'start', 'pause', 'resume', 'exception',
      'resolve', 'complete', 'cancel',
    ];
    for (const state of contract.states) {
      for (const action of actions) {
        expect(nextTaskStatus(state, action)).toBe(expectedNext(state, action));
      }
    }
    // 未知状态/未知动作 fail-closed（null，不猜）。
    expect(nextTaskStatus('mystery', 'start')).toBeNull();
    expect(nextTaskStatus('draft', 'mystery')).toBeNull();
  });

  it('cancel 语义：非终态可取消、终态不可取消（any_non_terminal → cancelled）', () => {
    for (const state of contract.states) {
      const expectCancel = !contract.terminal.includes(state) ? 'cancelled' : null;
      expect(nextTaskStatus(state, 'cancel')).toBe(expectCancel);
    }
  });

  it('TASK_NON_TERMINAL / TASK_TERMINAL 与契约集合一致', () => {
    expect([...TASK_NON_TERMINAL].sort()).toEqual(
      contract.states.filter((s) => !contract.terminal.includes(s)).sort(),
    );
    expect([...TASK_TERMINAL].sort()).toEqual([...contract.terminal].sort());
  });

  it('检查器负测试：人为缺失转换必须被检出（与 Python 负测试同纪律）', () => {
    const drifted = TASK_ACTIONS.filter(
      (a) => !(a.action === 'complete' && a.from === 'executing'),
    );
    const errors = diffActions(drifted);
    expect(errors.some((e) => e.includes('executing->completed'))).toBe(true);
  });

  it('taskActionPath（ADR-050）：契约图上最短合法动作链 / 不可达 / 空路径', () => {
    expect(taskActionPath('dispatched', 'executing')).toEqual(['receive', 'start']);
    expect(taskActionPath('received', 'executing')).toEqual(['start']);
    expect(taskActionPath('executing', 'completed')).toEqual(['complete']);
    expect(taskActionPath('received', 'completed')).toEqual(['start', 'complete']);
    expect(taskActionPath('paused', 'completed')).toEqual(['resume', 'complete']);
    expect(taskActionPath('executing', 'executing')).toEqual([]);
    expect(taskActionPath('completed', 'executing')).toBeNull();
    expect(taskActionPath('cancelled', 'draft')).toBeNull();
    // 链上每一步必须落在契约转换集中（与 nextTaskStatus 锁步自洽）。
    for (const [from, to] of [
      ['dispatched', 'executing'],
      ['received', 'completed'],
      ['paused', 'completed'],
    ] as const) {
      const path = taskActionPath(from, to)!;
      let cursor: string = from;
      for (const action of path) {
        const next = nextTaskStatus(cursor, action);
        expect(next).not.toBeNull();
        cursor = next!;
      }
      expect(cursor).toBe(to);
    }
  });

  it('task-lifecycle.ts 分类集合与契约状态集锁步（历史别名显式声明）', () => {
    // schedulable = draft/pending_confirm/pending_approval/pending_dispatch（+ 别名 pending/queued）
    const schedulableBase = ['draft', 'pending_confirm', 'pending_approval', 'pending_dispatch'];
    for (const s of schedulableBase) expect(TaskLifecycle.isSchedulable(s)).toBe(true);
    for (const s of ['dispatched', 'received', 'executing', 'paused', 'exception', 'completed', 'cancelled']) {
      expect(TaskLifecycle.isSchedulable(s)).toBe(false);
    }
    // locked = dispatched/received/executing/paused/exception
    const locked = ['dispatched', 'received', 'executing', 'paused', 'exception'];
    for (const s of locked) expect(TaskLifecycle.isLocked(s)).toBe(true);
    for (const s of ['draft', 'pending_confirm', 'pending_approval', 'pending_dispatch', 'completed', 'cancelled']) {
      expect(TaskLifecycle.isLocked(s)).toBe(false);
    }
    // dispatchable = pending_dispatch/dispatched/received/executing
    for (const s of ['pending_dispatch', 'dispatched', 'received', 'executing']) {
      expect(TaskLifecycle.isDispatchable(s)).toBe(true);
    }
    expect(TaskLifecycle.isDispatchable('pending_approval')).toBe(false);
    // executing 集合 = executing/received/paused
    for (const s of ['executing', 'received', 'paused']) {
      expect(TaskLifecycle.isExecuting(s)).toBe(true);
    }
    expect(TaskLifecycle.isExecuting('dispatched')).toBe(false);
    // terminal = completed/cancelled（+ 历史别名 done）
    for (const s of ['completed', 'cancelled']) {
      expect(TaskLifecycle.isTerminal(s)).toBe(true);
    }
    for (const s of ['executing', 'paused', 'draft']) {
      expect(TaskLifecycle.isTerminal(s)).toBe(false);
    }
  });
});
