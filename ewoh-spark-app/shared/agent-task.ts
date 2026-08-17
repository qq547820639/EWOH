/* 前后端共享契约 - Canonical Agent Task（ADR-017 / NO-06e，intelligence-l5-agentic）。
 *
 * 权威契约：contracts/agent-task/agent-task.schema.json + test-vectors.json。
 * 语义与 src/edge_platform/contracts/agent_task.py 逐项一致（共享向量约束）。
 * agentRoleRegistry 与 shared/agent-manifest.ts 同源（门禁交叉核对）。
 */

import { isCanonicalIdentity } from './identity';
import { parseEnvelopeTs } from './event-envelope';
import { AGENT_ROLES } from './agent-manifest';

export const TASK_KINDS = ['analysis', 'suggestion', 'execution'] as const;
export const TASK_PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
export const TASK_STATUSES = [
  'created', 'dispatched', 'in_progress', 'completed', 'failed', 'cancelled',
] as const;

const KIND_SET: ReadonlySet<string> = new Set(TASK_KINDS);
const PRIORITY_SET: ReadonlySet<string> = new Set(TASK_PRIORITIES);
const STATUS_SET: ReadonlySet<string> = new Set(TASK_STATUSES);

const REQUIRED_FIELDS = [
  'taskId', 'name', 'version', 'kind', 'assignedRole', 'dependencies',
  'inputContract', 'outputContract', 'priority', 'createdAt', 'budget',
  'status', 'auditTrail',
] as const;

/** 校验 AgentTask；返回错误码列表（空 = 合法）。fail-closed。 */
export function validateAgentTask(record: unknown): string[] {
  if (record == null || typeof record !== 'object' || Array.isArray(record)) {
    return ['record_must_be_object'];
  }
  const r = record as Record<string, unknown>;
  for (const field of REQUIRED_FIELDS) {
    if (!(field in r)) return [`missing_field:${field}`];
  }
  if (typeof r.taskId !== 'string' || !isCanonicalIdentity(r.taskId)) {
    return ['bad_task_id'];
  }
  if (typeof r.name !== 'string' || r.name === '') return ['bad_name'];
  const version = r.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return ['bad_version'];
  }
  if (!KIND_SET.has(String(r.kind))) return ['unknown_kind'];
  if (!AGENT_ROLES.includes(String(r.assignedRole) as (typeof AGENT_ROLES)[number])) {
    return ['unknown_role'];
  }
  const assignee = r.assigneeAgentId;
  if (assignee != null && (typeof assignee !== 'string' || !isCanonicalIdentity(assignee))) {
    return ['bad_assignee'];
  }
  const dependencies = r.dependencies;
  if (!Array.isArray(dependencies) || dependencies.some((d) => typeof d !== 'string' || !isCanonicalIdentity(d))) {
    return ['bad_dependency'];
  }
  if (dependencies.includes(String(r.taskId))) return ['self_dependency'];
  for (const key of ['inputContract', 'outputContract']) {
    const contract = r[key];
    if (typeof contract !== 'object' || contract === null || Array.isArray(contract)) {
      return ['bad_contract'];
    }
    const ref = (contract as Record<string, unknown>).schemaRef;
    if (typeof ref !== 'string' || ref === '') return ['bad_contract'];
  }
  if (!PRIORITY_SET.has(String(r.priority))) return ['bad_priority'];
  const createdMs = parseEnvelopeTs(String(r.createdAt));
  if (createdMs == null) return ['bad_time'];
  const dueTime = r.dueTime;
  if (dueTime != null) {
    const dueMs = parseEnvelopeTs(String(dueTime));
    if (dueMs == null || dueMs < createdMs) return ['bad_time'];
  }
  const budget = r.budget;
  if (typeof budget !== 'object' || budget === null || Array.isArray(budget)) {
    return ['bad_budget'];
  }
  for (const key of ['maxSteps', 'maxTokens', 'maxDurationSec']) {
    const value = (budget as Record<string, unknown>)[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      return ['bad_budget'];
    }
  }
  if (!STATUS_SET.has(String(r.status))) return ['bad_status'];
  if (r.auditTrail !== true) return ['audit_required'];
  return [];
}

/** 状态转移表（与 contracts/state-machines/agent-task.yaml 逐条一致，含 role 约束）。
 *
 * SH-005 / R2-SHR-004：agent-task.yaml 每条 transition 声明 role
 * （orchestrator/agent），actorRole 缺省即拒绝（fail-closed，对齐
 * alert-state-machine SH-004 纪律）——权责边界不可缺省旁路。
 */
const AGENT_TASK_TRANSITIONS: ReadonlyArray<{ from: string; to: string; role: string }> = [
  { from: 'created', to: 'dispatched', role: 'orchestrator' },
  { from: 'dispatched', to: 'in_progress', role: 'agent' },
  { from: 'in_progress', to: 'completed', role: 'agent' },
  { from: 'in_progress', to: 'failed', role: 'agent' },
  { from: 'created', to: 'cancelled', role: 'orchestrator' },
  { from: 'dispatched', to: 'cancelled', role: 'orchestrator' },
  { from: 'in_progress', to: 'cancelled', role: 'orchestrator' },
];

export function agentTaskTransitionAllowed(current: string, target: string, actorRole?: string): boolean {
  const match = AGENT_TASK_TRANSITIONS.find((t) => t.from === current && t.to === target);
  if (!match) return false;
  // R2-SHR-004：actorRole 缺省即拒绝（fail-closed）——与 Python
  // agent_task_transition_allowed 的 actor_role 参数口径一致。
  return match.role === actorRole;
}
