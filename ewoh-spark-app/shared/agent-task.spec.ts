/* Agent Task 契约行为测试（ADR-017 / NO-06e，intelligence-l5-agentic 立项）。
 *
 * 覆盖：3 kind / 4 priority / 6 status 封闭注册表、taskId 规范身份、
 * assignedRole 与 agent-manifest 同源、dependencies 规范身份 + 自引用拒绝、
 * dueTime 不得早于 createdAt、budget 下界、auditTrail 强制、状态机转移。
 * 共享向量由 scripts/audit-domain-contracts.js agent_task 域独立仲裁（351/351）。
 */
/// <reference types="jest" />
import {
  validateAgentTask,
  agentTaskTransitionAllowed,
  TASK_KINDS,
  TASK_STATUSES,
} from './agent-task';

const TASK_ID = 'task:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11';

const BASE: Record<string, unknown> = {
  taskId: TASK_ID,
  name: '测试任务',
  version: 1,
  kind: 'analysis',
  assignedRole: 'FactorySupervisor',
  dependencies: [],
  inputContract: { schemaRef: 'catalog://x' },
  outputContract: { schemaRef: 'catalog://y' },
  priority: 'medium',
  createdAt: '2026-08-16T08:00:00Z',
  budget: { maxSteps: 5, maxTokens: 10000, maxDurationSec: 300 },
  status: 'created',
  auditTrail: true,
};

describe('agent-task contract', () => {
  it('合法分析任务与依赖执行任务通过', () => {
    expect(validateAgentTask(BASE)).toEqual([]);
    expect(
      validateAgentTask({
        ...BASE,
        taskId: 'task:5c1b2a3d-1111-4222-8333-9a8b7c6d5e4f',
        kind: 'execution',
        assignedRole: 'Logistics',
        dependencies: [TASK_ID],
        priority: 'high',
        dueTime: '2026-08-16T18:00:00Z',
      }),
    ).toEqual([]);
  });

  it('注册表：kind/priority/status 封闭；assignedRole 同源', () => {
    expect(TASK_KINDS).toEqual(['analysis', 'suggestion', 'execution']);
    expect(TASK_STATUSES).toHaveLength(6);
    expect(validateAgentTask({ ...BASE, kind: 'gizmo' })).toEqual(['unknown_kind']);
    expect(validateAgentTask({ ...BASE, assignedRole: 'Wizard' })).toEqual(['unknown_role']);
    expect(validateAgentTask({ ...BASE, priority: 'urgent-now' })).toEqual(['bad_priority']);
    expect(validateAgentTask({ ...BASE, status: 'teleported' })).toEqual(['bad_status']);
  });

  it('dependencies 规范身份 + 自引用拒绝（DAG 机器规则）', () => {
    expect(validateAgentTask({ ...BASE, dependencies: ['not-canonical'] })).toEqual([
      'bad_dependency',
    ]);
    expect(validateAgentTask({ ...BASE, dependencies: [TASK_ID] })).toEqual([
      'self_dependency',
    ]);
  });

  it('dueTime 不得早于 createdAt（时间语义与 ADR-009 同源）', () => {
    expect(
      validateAgentTask({ ...BASE, dueTime: '2026-08-16T07:00:00Z' }),
    ).toEqual(['bad_time']);
  });

  it('auditTrail 强制 true；budget 下界', () => {
    expect(validateAgentTask({ ...BASE, auditTrail: false })).toEqual(['audit_required']);
    expect(
      validateAgentTask({ ...BASE, budget: { maxSteps: 0, maxTokens: 1, maxDurationSec: 1 } }),
    ).toEqual(['bad_budget']);
  });

  it('状态机转移（contracts/state-machines/agent-task.yaml）', () => {
    expect(agentTaskTransitionAllowed('created', 'dispatched')).toBe(true);
    expect(agentTaskTransitionAllowed('created', 'cancelled')).toBe(true);
    expect(agentTaskTransitionAllowed('in_progress', 'completed')).toBe(true);
    expect(agentTaskTransitionAllowed('in_progress', 'failed')).toBe(true);
    // SH-018：yaml/实现均支持 in_progress→cancelled，补齐覆盖。
    expect(agentTaskTransitionAllowed('in_progress', 'cancelled')).toBe(true);
    expect(agentTaskTransitionAllowed('dispatched', 'cancelled')).toBe(true);
    expect(agentTaskTransitionAllowed('created', 'completed')).toBe(false);
    expect(agentTaskTransitionAllowed('completed', 'dispatched')).toBe(false);
  });

  it('SH-005：actorRole 强制 yaml 声明的 role 约束（缺省不校验保持向后兼容）', () => {
    expect(agentTaskTransitionAllowed('created', 'dispatched', 'orchestrator')).toBe(true);
    expect(agentTaskTransitionAllowed('created', 'dispatched', 'agent')).toBe(false);
    expect(agentTaskTransitionAllowed('dispatched', 'in_progress', 'agent')).toBe(true);
    expect(agentTaskTransitionAllowed('in_progress', 'completed', 'agent')).toBe(true);
    expect(agentTaskTransitionAllowed('in_progress', 'cancelled', 'orchestrator')).toBe(true);
    expect(agentTaskTransitionAllowed('in_progress', 'cancelled', 'agent')).toBe(false);
  });
});
