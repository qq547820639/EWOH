import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { AgentService } from '../../../server/modules/agent/agent.service';
import {
  ewohAgentApproval,
  ewohAgentManifest,
  ewohEvent,
  ewohNotification,
} from '@server/database/schema';
import { validateDecision } from '@shared/decision';

const AGENT_ID = 'agent:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11';

function makeManifest(overrides: Record<string, unknown> = {}) {
  return {
    agentId: AGENT_ID,
    name: '工厂主管 Agent',
    version: 1,
    role: 'FactorySupervisor',
    purpose: '汇总工厂态势并生成运营建议',
    allowedTools: ['tool:world-snapshot', 'tool:record-evidence'],
    readScope: ['worldSnapshot'],
    writeScope: { tokens: [], commands: ['record_evidence', 'propose_plan'] },
    approvalRequirement: { autonomousLevel: 'L2', approvalRequiredFor: ['propose_plan'] },
    riskLevel: 'medium',
    inputContract: { schemaRef: 'catalog://x' },
    outputContract: { schemaRef: 'catalog://y' },
    auditTrail: true,
    budget: { maxSteps: 8, maxTokens: 20000, maxDurationSec: 300 },
    timeoutSec: 60,
    fallback: { onFailure: 'delegateHuman' },
    ...overrides,
  };
}

function createAgentDb(
  presetRows: Array<Record<string, unknown>> = [],
  presetApprovals: Array<Record<string, unknown>> = [],
) {
  const rows = [...presetRows];
  const events: Array<Record<string, unknown>> = [];
  const notifications: Array<Record<string, unknown>> = [];
  const approvals: Array<Record<string, unknown>> = [...presetApprovals];
  function thenable(data: unknown[]): unknown {
    const obj = {
      then: (resolve: (v: unknown[]) => void) => resolve(data),
      orderBy: jest.fn(() => thenable(data)),
      limit: jest.fn(() => thenable(data.slice(0, 100))),
    };
    return obj;
  }
  // ewoh_agent_approval 条件匹配（eq/and 树递归收集值：org/status/approvalId 前缀）。
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
    const orgs = [...values].filter((v) => v.startsWith('ORG-'));
    const statuses = [...values].filter((v) => ['pending', 'approved', 'rejected', 'expired'].includes(v));
    const ids = [...values].filter((v) => v.startsWith('appr-'));
    if (orgs.length > 0 && !orgs.includes(String(row.orgId))) return false;
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
        if (table === ewohAgentManifest) rows.push(row);
        if (table === ewohEvent) events.push(row);
        if (table === ewohNotification) notifications.push(row);
        if (table === ewohAgentApproval) {
          approvals.push({ createdAt: new Date(), ...row });
        }
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
  };
  const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
  const worldState = {
    getCurrentWorldState: jest.fn().mockResolvedValue({
      worldVersion: 1,
      entityVersions: {},
      events: [],
      persons: [],
      devices: [],
      stations: [],
    }),
  };
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
  return { db, audit, worldState, workOrder, knowledge, rows, events, notifications, approvals, service };
}

describe('AgentService（NO-06b：注册 + 执行）', () => {
  it('注册：契约校验 + Tool 注册表 fail-closed 后落库（审计同源）', async () => {
    const { rows, audit, service } = createAgentDb();
    const result = await service.registerManifest(makeManifest(), 'ORG-1', { userId: 'u1' });
    expect(result).toEqual(makeManifest());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.agentId).toBe(AGENT_ID);
    expect(rows[0]?.autonomousLevel).toBe('L2');
    expect(audit.appendAuditLog).toHaveBeenCalled();
  });

  it('注册：契约非法（auditTrail=false）fail-closed 拒绝且不落库', async () => {
    const { rows, service } = createAgentDb();
    await expect(
      service.registerManifest(makeManifest({ auditTrail: false }), 'ORG-1'),
    ).rejects.toThrow(/agent_manifest_invalid:audit_required/);
    expect(rows).toHaveLength(0);
  });

  it('注册：未注册 Tool fail-closed 拒绝', async () => {
    const { rows, service } = createAgentDb();
    await expect(
      service.registerManifest(
        makeManifest({ allowedTools: ['tool:world-snapshot', 'tool:sudo-all'] }),
        'ORG-1',
      ),
    ).rejects.toThrow(/unregistered_tool:tool:sudo-all/);
    expect(rows).toHaveLength(0);
  });

  it('注册：同版本幂等重注册返回既有清单（不重复落库）', async () => {
    const manifest = makeManifest();
    const { rows, service } = createAgentDb([
      {
        orgId: 'ORG-1', agentId: AGENT_ID, name: manifest.name, version: 1,
        role: manifest.role, purpose: manifest.purpose, allowedTools: manifest.allowedTools,
        readScope: manifest.readScope, writeScope: manifest.writeScope,
        autonomousLevel: 'L2', riskLevel: 'medium', status: 'registered',
        manifestJson: manifest,
      },
    ]);
    const result = await service.registerManifest(manifest, 'ORG-1');
    expect(result).toEqual(manifest);
    expect(rows).toHaveLength(1);
  });

  it('执行：L2 白名单命令（record_evidence）执行并落 AgentDecisionRecorded 事件', async () => {
    const { rows, events, service } = createAgentDb([
      {
        orgId: 'ORG-1', agentId: AGENT_ID, name: 'a', version: 1, role: 'FactorySupervisor',
        purpose: 'p', allowedTools: [], readScope: [], writeScope: {},
        autonomousLevel: 'L2', riskLevel: 'medium', status: 'registered',
        manifestJson: makeManifest(),
      },
    ]);
    const result = await service.executeCommand('ORG-1', AGENT_ID, {
      command: 'record_evidence',
      payload: { note: 'ok' },
    });
    expect(result.executed).toBe(true);
    expect(result.outcome).toBe('executed');
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('AgentDecisionRecorded');
    expect(rows).toHaveLength(1);
  });

  it('执行：approvalRequiredFor 命令 → needsApproval（L2 人审门控）', async () => {
    const { events, service } = createAgentDb([
      {
        orgId: 'ORG-1', agentId: AGENT_ID, name: 'a', version: 1, role: 'FactorySupervisor',
        purpose: 'p', allowedTools: [], readScope: [], writeScope: {},
        autonomousLevel: 'L2', riskLevel: 'medium', status: 'registered',
        manifestJson: makeManifest(),
      },
    ]);
    const result = await service.executeCommand('ORG-1', AGENT_ID, {
      command: 'propose_plan',
      payload: {},
    });
    expect(result.executed).toBe(false);
    expect(result.needsApproval).toBe(true);
    expect(result.outcome).toBe('proposed');
    expect(events[0]?.eventType).toBe('AgentTaskProposed');
  });

  it('执行：写范围外命令 fail-closed 拒绝', async () => {
    const { service } = createAgentDb([
      {
        orgId: 'ORG-1', agentId: AGENT_ID, name: 'a', version: 1, role: 'FactorySupervisor',
        purpose: 'p', allowedTools: [], readScope: [], writeScope: {},
        autonomousLevel: 'L2', riskLevel: 'medium', status: 'registered',
        manifestJson: makeManifest(),
      },
    ]);
    await expect(
      service.executeCommand('ORG-1', AGENT_ID, { command: 'dispatch_task' }),
    ).rejects.toThrow(/command_not_allowed:dispatch_task/);
  });

  it('执行：budget 超步数 fail-closed 拒绝（NEST-329：服务端累计计数，payload 不可绕过）', async () => {
    const { service } = createAgentDb([
      {
        orgId: 'ORG-1', agentId: AGENT_ID, name: 'a', version: 1, role: 'FactorySupervisor',
        purpose: 'p', allowedTools: [], readScope: [], writeScope: {},
        autonomousLevel: 'L2', riskLevel: 'medium', status: 'registered',
        manifestJson: makeManifest(),
      },
    ]);
    // maxSteps=8：先耗尽 8 步（每次成功执行 +1），第 9 次拒绝。
    for (let i = 0; i < 8; i += 1) {
      const step = await service.executeCommand('ORG-1', AGENT_ID, {
        command: 'record_evidence',
        payload: { stepsUsed: 0 }, // NEST-329 后 payload.stepsUsed 不再被信任
      });
      expect(step.executed).toBe(true);
    }
    await expect(
      service.executeCommand('ORG-1', AGENT_ID, {
        command: 'record_evidence',
        payload: { stepsUsed: 0 },
      }),
    ).rejects.toThrow(/budget_exceeded:maxSteps=8/);
  });

  it('执行：L0 Agent 无写命令能力（advisory_only）', async () => {
    const { service } = createAgentDb([
      {
        orgId: 'ORG-1', agentId: AGENT_ID, name: 'a', version: 1, role: 'Safety',
        purpose: 'p', allowedTools: [], readScope: [], writeScope: {},
        autonomousLevel: 'L0', riskLevel: 'critical', status: 'registered',
        manifestJson: makeManifest({
          role: 'Safety',
          riskLevel: 'critical',
          writeScope: { tokens: [], commands: ['record_evidence'] },
          approvalRequirement: { autonomousLevel: 'L0', approvalRequiredFor: [] },
        }),
      },
    ]);
    await expect(
      service.executeCommand('ORG-1', AGENT_ID, { command: 'record_evidence' }),
    ).rejects.toThrow(/advisory_only/);
  });

  it('执行：fallback=delegateHuman 时失败委托（tool 未实现 → delegated）', async () => {
    const { events, service } = createAgentDb([
      {
        orgId: 'ORG-1', agentId: AGENT_ID, name: 'a', version: 1, role: 'Logistics',
        purpose: 'p', allowedTools: [], readScope: [], writeScope: {},
        autonomousLevel: 'L3', riskLevel: 'high', status: 'registered',
        manifestJson: makeManifest({
          role: 'Logistics',
          writeScope: { tokens: ['schedulingData'], commands: ['reserve_resource'] },
          approvalRequirement: { autonomousLevel: 'L3', approvalRequiredFor: [] },
          riskLevel: 'high',
          fallback: { onFailure: 'delegateHuman' },
        }),
      },
    ]);
    const result = await service.executeCommand('ORG-1', AGENT_ID, {
      command: 'reserve_resource',
    });
    expect(result.executed).toBe(false);
    expect(result.outcome).toBe('delegated');
    expect(result.delegated).toBe(true);
    expect(events.some((e) => e.eventType === 'AgentDecisionRecorded')).toBe(true);
  });
});

describe('AgentService（NO-06c：审批桥接 + 工厂主管 Agent）', () => {
  function registeredRow(manifest: Record<string, unknown>) {
    return {
      orgId: 'ORG-1', agentId: manifest.agentId, name: manifest.name, version: manifest.version,
      role: manifest.role, purpose: manifest.purpose, allowedTools: manifest.allowedTools,
      readScope: manifest.readScope, writeScope: manifest.writeScope,
      autonomousLevel: 'L1', riskLevel: manifest.riskLevel, status: 'registered',
      manifestJson: manifest,
    };
  }

  it('审批桥接：needsApproval 落 ewoh_agent_approval 台账（跨重启持久化，ADR-039）', async () => {
    const { approvals, service } = createAgentDb([
      registeredRow(makeManifest({
        approvalRequirement: { autonomousLevel: 'L1', approvalRequiredFor: ['propose_plan'] },
      })),
    ]);
    const result = await service.executeCommand('ORG-1', AGENT_ID, {
      command: 'propose_plan',
      payload: { kind: 'advisory' },
    });
    expect(result.needsApproval).toBe(true);
    expect(result.approvalId).toBeTruthy();
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      orgId: 'ORG-1',
      approvalId: result.approvalId,
      agentId: AGENT_ID,
      command: 'propose_plan',
      status: 'pending',
      payloadJson: { kind: 'advisory' },
      rolesJson: ['workshop_lead'],
    });
    expect(approvals[0]?.createdAt).toBeInstanceOf(Date);
  });

  it('审批批准 → 执行闭环（executed + 决策事件）', async () => {
    const { events, service } = createAgentDb([
      registeredRow(makeManifest({
        approvalRequirement: { autonomousLevel: 'L1', approvalRequiredFor: ['propose_plan'] },
      })),
    ]);
    const proposed = await service.executeCommand('ORG-1', AGENT_ID, {
      command: 'propose_plan',
      payload: { kind: 'advisory' },
    });
    const result = await service.resolveApproval('ORG-1', proposed.approvalId!, true);
    expect(result.executed).toBe(true);
    expect(result.outcome).toBe('executed');
    expect(events.some((e) => e.eventType === 'AgentDecisionRecorded')).toBe(true);
  });

  it('审批驳回 → 拒绝留痕（不执行）', async () => {
    const { events, service } = createAgentDb([
      registeredRow(makeManifest({
        approvalRequirement: { autonomousLevel: 'L1', approvalRequiredFor: ['propose_plan'] },
      })),
    ]);
    const proposed = await service.executeCommand('ORG-1', AGENT_ID, {
      command: 'propose_plan',
      payload: {},
    });
    const result = await service.resolveApproval('ORG-1', proposed.approvalId!, false);
    expect(result.executed).toBe(false);
    expect(result.outcome).toBe('rejected');
    const decisionEvents = events.filter((e) => e.eventType === 'AgentDecisionRecorded');
    expect(decisionEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('工厂主管 Agent 端到端：世界状态 → 建议 → propose_plan → 审批', async () => {
    const { worldState, approvals, service } = createAgentDb([]);
    worldState.getCurrentWorldState.mockResolvedValue({
      worldVersion: 3,
      entityVersions: {},
      events: [{ severity: 'critical' }, { severity: 'medium' }],
      persons: [{ entityId: 'person:p1' }],
      devices: [{ entityId: 'exo:e1' }],
      stations: [{ entityId: 'station:s1', queue: ['t1'] }],
    });
    // R2-SBZ-002：建议流必须携带租户上下文（OrgContext）读取世界状态。
    const { suggestion, result } = await service.runSupervisorSuggestion('ORG-1', {
      userId: 'u1',
      primaryOrgId: 'ORG-1',
    });
    expect(suggestion.facts).toEqual({
      highSeverityEvents: 1,
      backlogStations: 1,
      deviceCount: 1,
      personCount: 1,
    });
    expect(suggestion.recommendations).toHaveLength(2);
    expect(result.needsApproval).toBe(true);
    expect(result.approvalId).toBeTruthy();
    expect(approvals.some((a) => a.approvalId === result.approvalId && a.status === 'pending')).toBe(true);
  });
});

describe('AgentService（R2-SBZ-002：supervisor 建议流世界状态读取租户上下文）', () => {
  it('getCurrentWorldState 以调用方 OrgContext（primaryOrgId）调用——本租户谓词生效', async () => {
    const { worldState, service } = createAgentDb([]);
    worldState.getCurrentWorldState.mockResolvedValue({
      worldVersion: 1,
      entityVersions: {},
      events: [],
      persons: [],
      devices: [],
      stations: [],
    });
    const actor = { userId: 'u1', primaryOrgId: 'ORG-1' };
    await service.runSupervisorSuggestion('ORG-1', actor);
    // 世界状态服务按 ctx.primaryOrgId 加 org 谓词（NEST-101）——
    // 透传缺失即退化为全租户聚合（R2-SBZ-002 根因）。
    expect(worldState.getCurrentWorldState).toHaveBeenCalledWith(
      expect.objectContaining({ primaryOrgId: 'ORG-1' }),
    );
  });

  it('缺失 actor（无租户上下文）→ 401 fail-closed，绝不回退全局世界状态', async () => {
    const { worldState, service } = createAgentDb([]);
    // NEST-213 actorOf 同款语义：缺失即 401（UnauthorizedException）。
    await expect(service.runSupervisorSuggestion('ORG-1')).rejects.toThrow(
      UnauthorizedException,
    );
    expect(worldState.getCurrentWorldState).not.toHaveBeenCalled();
  });

  it('actor.primaryOrgId 与 orgId 不一致 → 401 fail-closed（调用链错位防御）', async () => {
    const { worldState, service } = createAgentDb([]);
    await expect(
      service.runSupervisorSuggestion('ORG-1', { userId: 'u1', primaryOrgId: 'ORG-OTHER' }),
    ).rejects.toThrow(/org 上下文缺失或不一致/);
    expect(worldState.getCurrentWorldState).not.toHaveBeenCalled();
  });
});

describe('AgentService（NO-06d：领域命令执行器 + 审批超时）', () => {
  function registeredRow(manifest: Record<string, unknown>) {
    return {
      orgId: 'ORG-1', agentId: manifest.agentId, name: manifest.name, version: manifest.version,
      role: manifest.role, purpose: manifest.purpose, allowedTools: manifest.allowedTools,
      readScope: manifest.readScope, writeScope: manifest.writeScope,
      autonomousLevel: 'L3', riskLevel: manifest.riskLevel, status: 'registered',
      manifestJson: manifest,
    };
  }

  it('create_work_order 接入真实 WorkOrderService（L3 白名单执行）', async () => {
    const { workOrder, service } = createAgentDb([
      registeredRow(makeManifest({
        role: 'Maintenance',
        writeScope: { tokens: ['maintenanceData'], commands: ['create_work_order'] },
        approvalRequirement: { autonomousLevel: 'L3', approvalRequiredFor: [] },
        riskLevel: 'high',
      })),
    ]);
    const result = await service.executeCommand('ORG-1', AGENT_ID, {
      command: 'create_work_order',
      payload: {
        workOrderType: 'maintenance',
        origin: { kind: 'maintenance_condition', id: 'mc:1' },
        subjectEntityId: 'machine:m1',
        severity: 'high',
      },
    });
    expect(result.executed).toBe(true);
    expect(workOrder.createWorkOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        workOrderType: 'maintenance',
        origin: { kind: 'maintenance_condition', id: 'mc:1' },
        subjectEntityId: 'machine:m1',
      }),
      'ORG-1',
    );
  });

  it('create_work_order 载荷缺 origin 字段 fail-closed 拒绝（fallback=delegateHuman → delegated 不假装执行）', async () => {
    const { workOrder, events, service } = createAgentDb([
      registeredRow(makeManifest({
        role: 'Maintenance',
        writeScope: { tokens: ['maintenanceData'], commands: ['create_work_order'] },
        approvalRequirement: { autonomousLevel: 'L3', approvalRequiredFor: [] },
        riskLevel: 'high',
      })),
    ]);
    const result = await service.executeCommand('ORG-1', AGENT_ID, {
      command: 'create_work_order',
      payload: { workOrderType: 'maintenance' },
    });
    expect(result.outcome).toBe('delegated');
    expect(result.delegated).toBe(true);
    expect(workOrder.createWorkOrder).not.toHaveBeenCalled();
    expect(events.some((e) => e.eventType === 'AgentDecisionRecorded')).toBe(true);
  });

  it('审批超时（>24h）解析为拒绝留痕', async () => {
    const { events, approvals, service } = createAgentDb([
      registeredRow(makeManifest({
        approvalRequirement: { autonomousLevel: 'L1', approvalRequiredFor: ['propose_plan'] },
      })),
    ]);
    const proposed = await service.executeCommand('ORG-1', AGENT_ID, {
      command: 'propose_plan',
      payload: {},
    });
    // 推进台账 created_at 模拟 25h 前创建（过期是台账事实，跨重启同样生效）
    const row = approvals.find((a) => a.approvalId === proposed.approvalId);
    (row as Record<string, unknown>).createdAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const result = await service.resolveApproval('ORG-1', proposed.approvalId!, true);
    expect(result.outcome).toBe('rejected');
    expect(result.detail).toContain('approval_expired');
    expect(row?.status).toBe('expired'); // 台账落 expired（§33 显式不静默）
    expect(events.some((e) => e.eventType === 'AgentDecisionRecorded')).toBe(true);
  });

  // ── NO-13j / ADR-059：agent_approval 决策留痕（Decision Catalog kind #3） ──

  it('NO-13j：批准解析 → decisionJson 落库（human 权威 + 判定事实完整，契约门内）', async () => {
    const { approvals, service } = createAgentDb([
      registeredRow(makeManifest({
        approvalRequirement: { autonomousLevel: 'L1', approvalRequiredFor: ['propose_plan'] },
      })),
    ]);
    const proposed = await service.executeCommand('ORG-1', AGENT_ID, {
      command: 'propose_plan',
      payload: {},
    });
    const result = await service.resolveApproval('ORG-1', proposed.approvalId!, true, { userId: 'u1' });
    expect(result.outcome).toBe('executed');
    const row = approvals.find((a) => a.approvalId === proposed.approvalId);
    const decision = (row as Record<string, unknown>).decisionJson as Record<string, unknown>;
    expect(decision).toBeDefined();
    expect(decision.decisionId).toBe(`decision:${proposed.approvalId}:agent-approval`);
    expect(decision.kind).toBe('agent_approval');
    expect(decision.status).toBe('approved');
    expect(decision.decisionAuthority).toBe('human');
    expect(decision.subject).toBe(`agent:${AGENT_ID}`);
    expect(decision.tenantId).toBe('ORG-1');
    expect(decision.riskLevel).toBe('medium'); // manifest.riskLevel=medium 真实映射
    expect(decision.requiresApproval).toBe(false);
    expect((decision.approver as Record<string, unknown>).actor).toBe('user:u1');
    expect(validateDecision(decision)).toEqual([]);
  });

  it('NO-13j：驳回解析 → rejected 决策留痕（decisionId 确定性幂等）', async () => {
    const { approvals, service } = createAgentDb([
      registeredRow(makeManifest({
        approvalRequirement: { autonomousLevel: 'L1', approvalRequiredFor: ['propose_plan'] },
      })),
    ]);
    const proposed = await service.executeCommand('ORG-1', AGENT_ID, {
      command: 'propose_plan',
      payload: {},
    });
    const result = await service.resolveApproval('ORG-1', proposed.approvalId!, false, { userId: 'u2' });
    expect(result.outcome).toBe('rejected');
    const row = approvals.find((a) => a.approvalId === proposed.approvalId);
    const decision = (row as Record<string, unknown>).decisionJson as Record<string, unknown>;
    expect(decision.status).toBe('rejected');
    expect(decision.decisionAuthority).toBe('human');
    expect((decision.selected as Record<string, unknown>).optionId).toBe('opt:reject');
    expect(validateDecision(decision)).toEqual([]);
    // 重复解析 CAS 未命中 → 不再追加第二条决策（确定性幂等）。
    await expect(service.resolveApproval('ORG-1', proposed.approvalId!, false, { userId: 'u2' }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('NO-13j：超时解析 → policy 权威决策留痕（approval_expired，无人工操作者）', async () => {
    const { approvals, service } = createAgentDb([
      registeredRow(makeManifest({
        riskLevel: 'critical',
        approvalRequirement: { autonomousLevel: 'L1', approvalRequiredFor: ['propose_plan'] },
      })),
    ]);
    const proposed = await service.executeCommand('ORG-1', AGENT_ID, {
      command: 'propose_plan',
      payload: {},
    });
    const row = approvals.find((a) => a.approvalId === proposed.approvalId);
    (row as Record<string, unknown>).createdAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const result = await service.resolveApproval('ORG-1', proposed.approvalId!, true);
    expect(result.outcome).toBe('rejected');
    const decision = (row as Record<string, unknown>).decisionJson as Record<string, unknown>;
    expect(decision.status).toBe('rejected');
    expect(decision.decisionAuthority).toBe('policy');
    expect(decision.riskLevel).toBe('high'); // critical 收敛 + evidence 留原始档
    expect(decision.evidence).toEqual(['manifest_risk:critical', 'command:propose_plan']);
    expect((decision.approver as Record<string, unknown>).actor).toBe('policy:agent-approval-ttl');
    expect((decision.selected as Record<string, unknown>).reason).toEqual(['approval_expired']);
    expect(validateDecision(decision)).toEqual([]);
  });

  // ── NO-07b：内置 Knowledge Agent（L1 建议型） ─────────────────────────────

  it('ensureBuiltinKnowledge 注册 Knowledge Agent Manifest（role=Knowledge，L1，register_knowledge）', async () => {
    const { rows, audit, service } = createAgentDb();
    const result = await service.ensureBuiltinKnowledge('ORG-1');
    expect((result as Record<string, unknown>).role).toBe('Knowledge');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.agentId).toBe('agent:ewoh-knowledge-agent');
    expect(rows[0]?.autonomousLevel).toBe('L1');
    expect(audit.appendAuditLog).toHaveBeenCalled();
  });

  it('register_knowledge：非 Knowledge Agent（命令白名单外）fail-closed 拒绝', async () => {
    const { knowledge, service } = createAgentDb([
      registeredRow(makeManifest({
        approvalRequirement: { autonomousLevel: 'L1', approvalRequiredFor: ['propose_plan'] },
      })),
    ]);
    await expect(
      service.executeCommand('ORG-1', AGENT_ID, {
        command: 'register_knowledge',
        payload: { kind: 'process_knowledge', scope: 'factory', title: 't', body: 'b' },
      }),
    ).rejects.toThrow('command_not_allowed:register_knowledge');
    expect(knowledge.registerEntry).not.toHaveBeenCalled();
  });

  it('register_knowledge：L1 一律人审（审批桥接 proposed → 批准后执行真实 Domain Service）', async () => {
    const { knowledge, approvals, events, service } = createAgentDb([
      registeredRow(makeManifest({
        role: 'Knowledge',
        agentId: 'agent:ewoh-knowledge-agent',
        writeScope: { tokens: [], commands: ['register_knowledge'] },
        approvalRequirement: { autonomousLevel: 'L1', approvalRequiredFor: ['register_knowledge'] },
      })),
    ]);
    const payload = {
      kind: 'process_knowledge',
      scope: 'factory',
      title: '缺料处置',
      body: '先冻结派工再补料',
      sourceEvidenceIds: ['event:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11'],
    };
    const proposed = await service.executeCommand('ORG-1', 'agent:ewoh-knowledge-agent', {
      command: 'register_knowledge',
      payload,
    });
    expect(proposed.needsApproval).toBe(true);
    expect(proposed.outcome).toBe('proposed');
    expect(knowledge.registerEntry).not.toHaveBeenCalled();
    expect(approvals.some((a) => a.approvalId === proposed.approvalId && a.status === 'pending')).toBe(true);
    const executed = await service.resolveApproval('ORG-1', proposed.approvalId!, true);
    expect(executed.outcome).toBe('executed');
    expect(knowledge.registerEntry).toHaveBeenCalledWith(payload, 'ORG-1');
    expect(approvals.some((a) => a.approvalId === proposed.approvalId && a.status === 'approved')).toBe(true);
    // 提议 + 批准执行两条 AgentDecisionRecorded（register_knowledge 非 propose_plan 流）
    expect(events.filter((e) => e.eventType === 'AgentDecisionRecorded')).toHaveLength(2);
  });

  it('register_knowledge 载荷缺 sourceEvidenceIds → delegateHuman（绝不假装执行成功）', async () => {
    const { knowledge, events, service } = createAgentDb([
      registeredRow(makeManifest({
        role: 'Knowledge',
        agentId: 'agent:ewoh-knowledge-agent',
        writeScope: { tokens: [], commands: ['register_knowledge'] },
        approvalRequirement: { autonomousLevel: 'L3', approvalRequiredFor: [] },
      })),
    ]);
    const result = await service.executeCommand('ORG-1', 'agent:ewoh-knowledge-agent', {
      command: 'register_knowledge',
      payload: { kind: 'process_knowledge', scope: 'factory', title: 't', body: 'b' },
    });
    expect(result.outcome).toBe('delegated');
    expect(knowledge.registerEntry).not.toHaveBeenCalled();
    expect(events.some((e) => e.eventType === 'AgentDecisionRecorded')).toBe(true);
  });
});

describe('AgentService（NO-12f/ADR-030：待批清单 + 通知闭环）', () => {
  function registeredRow(manifest: Record<string, unknown>) {
    return {
      orgId: 'ORG-1', agentId: manifest.agentId, name: manifest.name, version: manifest.version,
      role: manifest.role, purpose: manifest.purpose, allowedTools: manifest.allowedTools,
      readScope: manifest.readScope, writeScope: manifest.writeScope,
      autonomousLevel: 'L1', riskLevel: manifest.riskLevel, status: 'registered',
      manifestJson: manifest,
    };
  }

  it('审批创建 → 插入 role 通知（externalRef=approvalId，channel=app）', async () => {
    const ctx = createAgentDb([
      registeredRow(makeManifest({
        approvalRequirement: { autonomousLevel: 'L1', approvalRequiredFor: ['propose_plan'] },
      })),
    ]);
    const result = await ctx.service.executeCommand(
      'ORG-1', AGENT_ID, { command: 'propose_plan', payload: {} }, { userId: 'tester' },
    );
    expect(result.needsApproval).toBe(true);
    expect(ctx.notifications).toHaveLength(1);
    const n = ctx.notifications[0] as Record<string, unknown>;
    expect(n.recipientType).toBe('role');
    expect(n.recipientId).toBe('workshop_lead');
    expect(n.externalRef).toBe(result.approvalId);
    expect(n.severity).toBe('high');
  });

  it('审批角色配置化：EWOH_AGENT_APPROVAL_ROLES 生效', async () => {
    const previous = process.env.EWOH_AGENT_APPROVAL_ROLES;
    process.env.EWOH_AGENT_APPROVAL_ROLES = 'safety_admin,dispatcher';
    try {
      const ctx = createAgentDb([
        registeredRow(makeManifest({
          approvalRequirement: { autonomousLevel: 'L1', approvalRequiredFor: ['propose_plan'] },
        })),
      ]);
      const result = await ctx.service.executeCommand(
        'ORG-1', AGENT_ID, { command: 'propose_plan', payload: {} }, { userId: 'tester' },
      );
      expect(result.needsApproval).toBe(true);
      const n = ctx.notifications[0] as Record<string, unknown>;
      expect(n.recipientId).toBe('safety_admin');
    } finally {
      if (previous === undefined) delete process.env.EWOH_AGENT_APPROVAL_ROLES;
      else process.env.EWOH_AGENT_APPROVAL_ROLES = previous;
    }
  });

  it('待批清单：org 作用域 + 过期显式标记（台账读，跨重启同语义）', async () => {
    const ctx = createAgentDb([
      registeredRow(makeManifest({
        approvalRequirement: { autonomousLevel: 'L1', approvalRequiredFor: ['propose_plan'] },
      })),
    ]);
    const result = await ctx.service.executeCommand(
      'ORG-1', AGENT_ID, { command: 'propose_plan', payload: {} }, { userId: 'tester' },
    );
    expect(result.needsApproval).toBe(true);
    const mine = await ctx.service.listPendingApprovals('ORG-1');
    expect(mine).toHaveLength(1);
    expect((mine[0] as Record<string, unknown>).approvalId).toBe(result.approvalId);
    expect((mine[0] as Record<string, unknown>).expired).toBe(false);
    // 他租户不可见（台账 org 作用域）
    expect(await ctx.service.listPendingApprovals('ORG-OTHER')).toHaveLength(0);
    // 过期显式（推进台账 created_at 越过 TTL——重启后同一事实）
    const row = ctx.approvals.find((a) => a.approvalId === result.approvalId);
    (row as Record<string, unknown>).createdAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const expiredList = await ctx.service.listPendingApprovals('ORG-1');
    expect((expiredList[0] as Record<string, unknown>).expired).toBe(true);
    expect((expiredList[0] as Record<string, unknown>).remainingMs).toBe(0);
  });

  it('跨重启持久化：新服务实例（同台账）可解析既有待批（ADR-039）', async () => {
    const ctx = createAgentDb([
      registeredRow(makeManifest({
        approvalRequirement: { autonomousLevel: 'L1', approvalRequiredFor: ['propose_plan'] },
      })),
    ]);
    const proposed = await ctx.service.executeCommand('ORG-1', AGENT_ID, {
      command: 'propose_plan',
      payload: { kind: 'advisory' },
    });
    // 模拟进程重启：同一台账构造全新服务实例（无内存状态）
    const restarted = createAgentDb(
      [registeredRow(makeManifest({
        approvalRequirement: { autonomousLevel: 'L1', approvalRequiredFor: ['propose_plan'] },
      }))],
      ctx.approvals.map((a) => a as Record<string, unknown>),
    );
    // 待批清单跨重启可见
    const mine = await restarted.service.listPendingApprovals('ORG-1');
    expect(mine).toHaveLength(1);
    expect((mine[0] as Record<string, unknown>).approvalId).toBe(proposed.approvalId);
    // 跨重启可解析（批准 → 执行闭环）
    const resolved = await restarted.service.resolveApproval('ORG-1', proposed.approvalId!, true);
    expect(resolved.outcome).toBe('executed');
    expect(restarted.approvals[0]?.status).toBe('approved');
  });

  it('重复解析 → 显式拒绝（CAS 未命中，§20 幂等不静默）', async () => {
    const ctx = createAgentDb([
      registeredRow(makeManifest({
        approvalRequirement: { autonomousLevel: 'L1', approvalRequiredFor: ['propose_plan'] },
      })),
    ]);
    const proposed = await ctx.service.executeCommand('ORG-1', AGENT_ID, {
      command: 'propose_plan',
      payload: {},
    });
    const first = await ctx.service.resolveApproval('ORG-1', proposed.approvalId!, false);
    expect(first.outcome).toBe('rejected');
    await expect(ctx.service.resolveApproval('ORG-1', proposed.approvalId!, false))
      .rejects.toBeInstanceOf(BadRequestException);
  });
});

