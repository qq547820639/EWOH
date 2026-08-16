/* Agent Manifest 契约行为测试（ADR-016 / NO-06，Phase 9 立项）。
 *
 * 覆盖：15 类角色注册表、Autonomous Level 阶梯（L2/L3 必须显式审批、
 * critical 仅 L0/L1、Safety 仅 L0/L1 且写范围为空）、auditTrail 强制、
 * budget/timeout 下界、fallback 封闭策略、规范身份（agentId/tools/
 * fallbackAgentId）。共享向量由 scripts/audit-domain-contracts.js agent 域
 * 独立仲裁（329/329）。
 */
/// <reference types="jest" />
import {
  validateAgentManifest,
  AGENT_ROLES,
  AUTONOMOUS_LEVELS,
} from './agent-manifest';

const AGENT_ID = 'agent:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11';

const BASE: Record<string, unknown> = {
  agentId: AGENT_ID,
  name: '测试 Agent',
  version: 1,
  role: 'FactorySupervisor',
  purpose: '测试用途',
  allowedTools: ['tool:world-snapshot'],
  readScope: ['worldSnapshot'],
  writeScope: { tokens: [], commands: [] },
  approvalRequirement: { autonomousLevel: 'L1', approvalRequiredFor: ['propose_plan'] },
  riskLevel: 'medium',
  inputContract: { schemaRef: 'catalog://x' },
  outputContract: { schemaRef: 'catalog://y' },
  auditTrail: true,
  budget: { maxSteps: 8, maxTokens: 20000, maxDurationSec: 300 },
  timeoutSec: 60,
  fallback: { onFailure: 'delegateHuman' },
};

describe('agent-manifest contract', () => {
  it('合法 L1 建议型与 L2 受控型清单通过', () => {
    expect(validateAgentManifest(BASE)).toEqual([]);
    expect(
      validateAgentManifest({
        ...BASE,
        role: 'Logistics',
        writeScope: { tokens: ['schedulingData'], commands: ['reserve_resource'] },
        approvalRequirement: { autonomousLevel: 'L2', approvalRequiredFor: ['dispatch_task'] },
        riskLevel: 'high',
      }),
    ).toEqual([]);
  });

  it('注册表：15 角色 + L0..L3 阶梯（L4 不在注册表）', () => {
    expect(AGENT_ROLES).toHaveLength(15);
    expect(AUTONOMOUS_LEVELS).toEqual(['L0', 'L1', 'L2', 'L3']);
    expect(validateAgentManifest({ ...BASE, role: 'Wizard' })).toEqual(['unknown_role']);
  });

  it('L2/L3 必须显式非空 approvalRequiredFor', () => {
    expect(
      validateAgentManifest({
        ...BASE,
        approvalRequirement: { autonomousLevel: 'L2', approvalRequiredFor: [] },
      }),
    ).toEqual(['approval_required']);
    expect(
      validateAgentManifest({
        ...BASE,
        approvalRequirement: { autonomousLevel: 'L3', approvalRequiredFor: [] },
      }),
    ).toEqual(['approval_required']);
  });

  it('critical 仅 L0/L1；Safety 仅 L0/L1 且写范围为空', () => {
    expect(
      validateAgentManifest({
        ...BASE,
        riskLevel: 'critical',
        approvalRequirement: { autonomousLevel: 'L2', approvalRequiredFor: ['dispatch_task'] },
      }),
    ).toEqual(['level_risk_conflict']);
    expect(
      validateAgentManifest({
        ...BASE,
        role: 'Safety',
        riskLevel: 'critical',
        approvalRequirement: { autonomousLevel: 'L1', approvalRequiredFor: [] },
        writeScope: { tokens: ['incidentData'], commands: [] },
      }),
    ).toEqual(['safety_role_write_forbidden']);
  });

  it('auditTrail 强制 true；budget/timeout 下界；fallback 封闭', () => {
    expect(validateAgentManifest({ ...BASE, auditTrail: false })).toEqual(['audit_required']);
    expect(
      validateAgentManifest({ ...BASE, budget: { maxSteps: 0, maxTokens: 1, maxDurationSec: 1 } }),
    ).toEqual(['bad_budget']);
    expect(validateAgentManifest({ ...BASE, timeoutSec: 0 })).toEqual(['bad_timeout']);
    expect(validateAgentManifest({ ...BASE, fallback: { onFailure: 'panic' } })).toEqual([
      'unknown_fallback',
    ]);
  });

  it('规范身份：agentId / tools / fallbackAgentId', () => {
    expect(validateAgentManifest({ ...BASE, agentId: 'not-canonical' })).toEqual([
      'bad_agent_id',
    ]);
    expect(validateAgentManifest({ ...BASE, allowedTools: ['not-canonical'] })).toEqual([
      'bad_tool',
    ]);
    expect(
      validateAgentManifest({ ...BASE, fallback: { onFailure: 'retry', fallbackAgentId: 'x' } }),
    ).toEqual(['bad_fallback_agent']);
  });
});
