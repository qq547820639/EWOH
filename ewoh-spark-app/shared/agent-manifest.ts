/* 前后端共享契约 - Canonical Agent Manifest（ADR-016 / NO-06，Phase 9 立项）。
 *
 * 权威契约：contracts/agent/agent-manifest.schema.json + test-vectors.json。
 * 语义与 src/edge_platform/contracts/agent.py 逐项一致（共享向量约束）。
 */

import { isCanonicalIdentity } from './identity';

export const AGENT_ROLES = [
  'FactorySupervisor', 'Logistics', 'Production', 'Maintenance', 'Quality',
  'Safety', 'Scheduling', 'Material', 'Energy', 'WorkerSupport',
  'Exoskeleton', 'Incident', 'Knowledge', 'Simulation', 'Operations',
] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export const SCOPE_TOKENS = [
  'worldSnapshot', 'worldReplay', 'personnelData', 'equipmentData',
  'materialData', 'schedulingData', 'maintenanceData', 'qualityData',
  'incidentData', 'energyData', 'simulationData', 'knowledgeData',
] as const;

export const AGENT_COMMANDS = [
  'propose_plan', 'reserve_resource', 'dispatch_task', 'create_work_order',
  'notify_personnel', 'request_approval', 'run_simulation', 'record_evidence',
  'register_knowledge',
] as const;

export const AGENT_RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
export const AUTONOMOUS_LEVELS = ['L0', 'L1', 'L2', 'L3'] as const;
export const FALLBACK_STRATEGIES = ['fail', 'retry', 'delegateHuman', 'safeIdle'] as const;

const ROLE_SET: ReadonlySet<string> = new Set(AGENT_ROLES);
const SCOPE_SET: ReadonlySet<string> = new Set(SCOPE_TOKENS);
const COMMAND_SET: ReadonlySet<string> = new Set(AGENT_COMMANDS);
const RISK_SET: ReadonlySet<string> = new Set(AGENT_RISK_LEVELS);
const LEVEL_SET: ReadonlySet<string> = new Set(AUTONOMOUS_LEVELS);
const FALLBACK_SET: ReadonlySet<string> = new Set(FALLBACK_STRATEGIES);

const REQUIRED_FIELDS = [
  'agentId', 'name', 'version', 'role', 'purpose', 'allowedTools', 'readScope',
  'writeScope', 'approvalRequirement', 'riskLevel', 'inputContract',
  'outputContract', 'auditTrail', 'budget', 'timeoutSec', 'fallback',
] as const;

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((x) => typeof x === 'string');
}

/** 校验 Agent Manifest；返回错误码列表（空 = 合法）。fail-closed。 */
export function validateAgentManifest(record: unknown): string[] {
  if (record == null || typeof record !== 'object' || Array.isArray(record)) {
    return ['record_must_be_object'];
  }
  const r = record as Record<string, unknown>;
  for (const field of REQUIRED_FIELDS) {
    if (!(field in r)) return [`missing_field:${field}`];
  }
  if (typeof r.agentId !== 'string' || !isCanonicalIdentity(r.agentId)) {
    return ['bad_agent_id'];
  }
  if (!ROLE_SET.has(String(r.role))) return ['unknown_role'];
  if (typeof r.name !== 'string' || r.name === '') return ['bad_name'];
  const version = r.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return ['bad_version'];
  }
  if (typeof r.purpose !== 'string' || r.purpose.trim() === '') return ['empty_purpose'];
  const tools = r.allowedTools;
  if (!isStringList(tools) || tools.some((t) => !isCanonicalIdentity(t))) return ['bad_tool'];
  const readScope = r.readScope;
  if (!isStringList(readScope)) return ['bad_scope'];
  for (const token of readScope) {
    if (!SCOPE_SET.has(token)) return ['unknown_scope_token'];
  }
  const writeScope = r.writeScope;
  if (typeof writeScope !== 'object' || writeScope === null || Array.isArray(writeScope)) {
    return ['bad_write_scope'];
  }
  const ws = writeScope as Record<string, unknown>;
  const writeTokens = ws.tokens ?? [];
  if (!isStringList(writeTokens)) return ['bad_scope'];
  for (const token of writeTokens) {
    if (!SCOPE_SET.has(token)) return ['unknown_scope_token'];
  }
  const writeCommands = ws.commands ?? [];
  if (!isStringList(writeCommands)) return ['bad_command'];
  for (const command of writeCommands) {
    if (!COMMAND_SET.has(command)) return ['unknown_command'];
  }
  const approval = r.approvalRequirement;
  if (typeof approval !== 'object' || approval === null || Array.isArray(approval)) {
    return ['bad_approval'];
  }
  const ap = approval as Record<string, unknown>;
  const level = ap.autonomousLevel;
  if (typeof level !== 'string' || !LEVEL_SET.has(level)) return ['unknown_autonomous_level'];
  const required = ap.approvalRequiredFor ?? [];
  if (!isStringList(required)) return ['bad_approval'];
  for (const command of required) {
    if (!COMMAND_SET.has(command)) return ['unknown_command'];
  }
  if ((level === 'L2' || level === 'L3') && required.length === 0) {
    return ['approval_required'];
  }
  if (!RISK_SET.has(String(r.riskLevel))) return ['unknown_risk_level'];
  if (r.riskLevel === 'critical' && (level === 'L2' || level === 'L3')) {
    return ['level_risk_conflict'];
  }
  if (r.role === 'Safety') {
    if (level === 'L2' || level === 'L3') return ['safety_autonomy_forbidden'];
    if (writeTokens.length > 0 || writeCommands.length > 0) {
      return ['safety_role_write_forbidden'];
    }
  }
  for (const key of ['inputContract', 'outputContract']) {
    const contract = r[key];
    if (typeof contract !== 'object' || contract === null || Array.isArray(contract)) {
      return ['bad_contract'];
    }
    const ref = (contract as Record<string, unknown>).schemaRef;
    if (typeof ref !== 'string' || ref === '') return ['bad_contract'];
  }
  if (r.auditTrail !== true) return ['audit_required'];
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
  const timeoutSec = r.timeoutSec;
  if (typeof timeoutSec !== 'number' || !Number.isInteger(timeoutSec) || timeoutSec < 1) {
    return ['bad_timeout'];
  }
  const fallback = r.fallback;
  if (typeof fallback !== 'object' || fallback === null || Array.isArray(fallback)) {
    return ['unknown_fallback'];
  }
  const fb = fallback as Record<string, unknown>;
  if (!FALLBACK_SET.has(String(fb.onFailure))) return ['unknown_fallback'];
  const fallbackAgent = fb.fallbackAgentId;
  if (fallbackAgent != null && (typeof fallbackAgent !== 'string' || !isCanonicalIdentity(fallbackAgent))) {
    return ['bad_fallback_agent'];
  }
  return [];
}
