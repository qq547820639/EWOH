import { AgentService } from '../../../server/modules/agent/agent.service';
import {
  ewohAgentApproval,
  ewohAgentManifest,
  ewohEvent,
} from '@server/database/schema';

/**
 * Agent Policy TCK（ADR-016 / NO-06c）：决策表固化 Agent 政策不变量——
 * Autonomous Level × 审批门控 × 预算/回退 × Safety 边界的运行时执行面
 * （契约层机器规则由 audit-domain-contracts agent 域仲裁；本 TCK 守护
 * 运行时执行器与契约语义逐项一致）。
 */

const AGENT_ID = 'agent:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11';

function makeManifest(overrides: Record<string, unknown> = {}) {
  return {
    agentId: AGENT_ID,
    name: 'TCK Agent',
    version: 1,
    role: 'FactorySupervisor',
    purpose: 'tck',
    allowedTools: ['tool:world-snapshot', 'tool:record-evidence'],
    readScope: ['worldSnapshot'],
    writeScope: { tokens: [], commands: ['record_evidence', 'propose_plan', 'dispatch_task', 'reserve_resource'] },
    approvalRequirement: { autonomousLevel: 'L1', approvalRequiredFor: ['propose_plan'] },
    riskLevel: 'medium',
    inputContract: { schemaRef: 'catalog://x' },
    outputContract: { schemaRef: 'catalog://y' },
    auditTrail: true,
    budget: { maxSteps: 5, maxTokens: 1000, maxDurationSec: 60 },
    timeoutSec: 10,
    fallback: { onFailure: 'delegateHuman' },
    ...overrides,
  };
}

function build(manifest: Record<string, unknown>) {
  const rows: Array<Record<string, unknown>> = [
    {
      orgId: 'ORG-TCK', agentId: manifest.agentId, name: manifest.name, version: manifest.version,
      role: manifest.role, purpose: manifest.purpose, allowedTools: manifest.allowedTools,
      readScope: manifest.readScope, writeScope: manifest.writeScope,
      autonomousLevel: (manifest.approvalRequirement as Record<string, unknown>).autonomousLevel,
      riskLevel: manifest.riskLevel, status: 'registered', manifestJson: manifest,
    },
  ];
  const events: Array<Record<string, unknown>> = [];
  const approvals: Array<Record<string, unknown>> = [];
  function thenable(data: unknown[]): unknown {
    return {
      then: (resolve: (v: unknown[]) => void) => resolve(data),
      orderBy: jest.fn(() => thenable(data)),
      limit: jest.fn(() => thenable(data.slice(0, 100))),
    };
  }
  function collectStrings(node: unknown, out: Set<string>, seen: WeakSet<object>): void {
    if (node == null || typeof node !== 'object') return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    for (const value of Object.values(node as Record<string, unknown>)) {
      if (typeof value === 'string') out.add(value);
      else collectStrings(value, out, seen);
    }
  }
  function matchesApproval(cond: unknown, row: Record<string, unknown>): boolean {
    const values = new Set<string>();
    collectStrings(cond, values, new WeakSet());
    const statuses = [...values].filter((v) => ['pending', 'approved', 'rejected', 'expired'].includes(v));
    const ids = [...values].filter((v) => v.startsWith('appr-'));
    if (statuses.length > 0 && !statuses.includes(String(row.status))) return false;
    if (ids.length > 0 && !ids.includes(String(row.approvalId))) return false;
    return true;
  }
  const db = {
    select: jest.fn(() => ({
      from: jest.fn((table: unknown) => ({
        where: jest.fn((cond: unknown) => {
          if (table === ewohAgentApproval) {
            return thenable(approvals.filter((r) => matchesApproval(cond, r)));
          }
          return thenable(rows);
        }),
      })),
    })),
    insert: jest.fn((table: unknown) => ({
      values: jest.fn((row: Record<string, unknown>) => {
        if (table === ewohEvent) events.push(row);
        if (table === ewohAgentApproval) approvals.push({ createdAt: new Date(), ...row });
        return { onConflictDoNothing: jest.fn(), returning: jest.fn(async () => [row]) };
      }),
    })),
    update: jest.fn((table: unknown) => ({
      set: jest.fn((patch: Record<string, unknown>) => ({
        where: jest.fn((cond: unknown) => {
          if (table === ewohAgentApproval) {
            const hit = approvals.filter((r) => matchesApproval(cond, r));
            for (const r of hit) Object.assign(r, patch);
            return { returning: jest.fn(async () => hit) };
          }
          return { returning: jest.fn(async () => []) };
        }),
      })),
    })),
    // NO-47a：台账 CAS 与"待审批提醒终态"同事务 → 假 db 提供事务句柄
    // （本 spec 不构造通知行：提醒侧行为由 agent.service.spec.ts 覆盖）。
    transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  };
  const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
  const worldState = { getCurrentWorldState: jest.fn().mockResolvedValue({ events: [], stations: [], devices: [], persons: [] }) };
  const workOrder = {
    createWorkOrder: jest.fn().mockResolvedValue({ workOrderId: 'wo:test', status: 'created' }),
  };
  const knowledge = {
    registerEntry: jest.fn().mockResolvedValue({ created: true }),
    retrieveEntries: jest.fn().mockResolvedValue([]),
  };
  const service = new AgentService(
    db as never,
    audit as never,
    worldState as never,
    workOrder as never,
    knowledge as never,
  );
  return { service, events, approvals, rows };
}

type Expected =
  | { kind: 'needsApproval' }
  | { kind: 'executed' }
  | { kind: 'throw'; match: RegExp }
  | { kind: 'delegated' };

const TABLE: Array<{
  name: string;
  manifest: Record<string, unknown>;
  command: string;
  expect: Expected;
  /** NEST-329：budget 检查改为服务端累计计数——先执行 N 次耗尽预算再断言。 */
  primeExecutions?: number;
}> = [
  {
    name: 'L1 建议型：propose_plan 一律人审',
    manifest: makeManifest(),
    command: 'propose_plan',
    expect: { kind: 'needsApproval' },
  },
  {
    name: 'L1 建议型：任何写命令（record_evidence）一律人审',
    manifest: makeManifest(),
    command: 'record_evidence',
    expect: { kind: 'needsApproval' },
  },
  {
    name: 'L2 受控型：白名单命令（record_evidence）不经审批执行',
    manifest: makeManifest({
      role: 'Logistics',
      riskLevel: 'high',
      approvalRequirement: { autonomousLevel: 'L2', approvalRequiredFor: ['dispatch_task'] },
    }),
    command: 'record_evidence',
    expect: { kind: 'executed' },
  },
  {
    name: 'L2 受控型：approvalRequiredFor 命令（dispatch_task）人审',
    manifest: makeManifest({
      role: 'Logistics',
      riskLevel: 'high',
      approvalRequirement: { autonomousLevel: 'L2', approvalRequiredFor: ['dispatch_task'] },
    }),
    command: 'dispatch_task',
    expect: { kind: 'needsApproval' },
  },
  {
    name: 'L3 受限自治：白名单命令执行',
    manifest: makeManifest({
      role: 'Logistics',
      riskLevel: 'low',
      approvalRequirement: { autonomousLevel: 'L3', approvalRequiredFor: ['request_approval'] },
    }),
    command: 'record_evidence',
    expect: { kind: 'executed' },
  },
  {
    name: 'L0 咨询型：任何写命令 advisory_only 拒绝',
    manifest: makeManifest({
      role: 'Quality',
      riskLevel: 'low',
      approvalRequirement: { autonomousLevel: 'L0', approvalRequiredFor: [] },
    }),
    command: 'record_evidence',
    expect: { kind: 'throw', match: /advisory_only/ },
  },
  {
    name: '写范围外命令 fail-closed 拒绝',
    manifest: makeManifest({
      role: 'Logistics',
      writeScope: { tokens: [], commands: ['record_evidence'] },
      approvalRequirement: { autonomousLevel: 'L3', approvalRequiredFor: ['request_approval'] },
    }),
    command: 'dispatch_task',
    expect: { kind: 'throw', match: /command_not_allowed:dispatch_task/ },
  },
  {
    name: 'budget 超步数 fail-closed 拒绝（NEST-329 服务端累计计数）',
    manifest: makeManifest({
      role: 'Logistics',
      riskLevel: 'low',
      approvalRequirement: { autonomousLevel: 'L3', approvalRequiredFor: ['request_approval'] },
      budget: { maxSteps: 1, maxTokens: 1000, maxDurationSec: 60 },
    }),
    command: 'record_evidence',
    expect: { kind: 'throw', match: /budget_exceeded/ },
    // maxSteps=1：先成功执行 1 次耗尽预算，下一次拒绝。
    primeExecutions: 1,
  },
  {
    name: 'fallback=delegateHuman：命令执行失败 → delegated（不静默）',
    manifest: makeManifest({
      role: 'Logistics',
      riskLevel: 'low',
      writeScope: { tokens: [], commands: ['record_evidence', 'run_simulation'] },
      approvalRequirement: { autonomousLevel: 'L3', approvalRequiredFor: ['request_approval'] },
    }),
    command: 'run_simulation',
    expect: { kind: 'delegated' },
  },
];

describe('Agent Policy TCK（NO-06c 决策表）', () => {
  for (const row of TABLE) {
    it(row.name, async () => {
      const { service } = build(row.manifest);
      // NEST-329：预算按服务端累计计数——payload.stepsUsed 不再可信，
      // 需先真实执行 primeExecutions 次耗尽预算。
      for (let i = 0; i < (row.primeExecutions ?? 0); i += 1) {
        await service.executeCommand('ORG-TCK', AGENT_ID, {
          command: row.command,
          payload: {},
        });
      }
      if (row.expect.kind === 'throw') {
        await expect(
          service.executeCommand('ORG-TCK', AGENT_ID, {
            command: row.command,
            payload: {},
          }),
        ).rejects.toThrow(row.expect.match);
        return;
      }
      const result = await service.executeCommand('ORG-TCK', AGENT_ID, {
        command: row.command,
        payload: {},
      });
      if (row.expect.kind === 'needsApproval') {
        expect(result.needsApproval).toBe(true);
        expect(result.approvalId).toBeTruthy();
        expect(result.executed).toBe(false);
      } else if (row.expect.kind === 'executed') {
        expect(result.executed).toBe(true);
        expect(result.outcome).toBe('executed');
      } else {
        expect(result.delegated).toBe(true);
        expect(result.outcome).toBe('delegated');
      }
    });
  }

  it('批准 → 执行；驳回 → 拒绝（闭环两分支）', async () => {
    const { service } = build(makeManifest());
    const proposed = await service.executeCommand('ORG-TCK', AGENT_ID, {
      command: 'propose_plan',
      payload: {},
    });
    const approved = await service.resolveApproval('ORG-TCK', proposed.approvalId!, true, { userId: 'lead.chen', roles: ['workshop_lead'] });
    expect(approved.executed).toBe(true);

    const proposed2 = await service.executeCommand('ORG-TCK', AGENT_ID, {
      command: 'propose_plan',
      payload: {},
    });
    const rejected = await service.resolveApproval('ORG-TCK', proposed2.approvalId!, false, { userId: 'lead.chen', roles: ['workshop_lead'] }, '现场条件不满足');
    expect(rejected.outcome).toBe('rejected');
  });
});
