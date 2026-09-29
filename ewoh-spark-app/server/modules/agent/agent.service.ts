import {
  BadRequestException,
  InternalServerErrorException,
  Injectable,
  Inject,
  Logger,
  Optional,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { ewohAgentApproval, ewohAgentManifest, ewohEvent, ewohNotification } from '@server/database/schema';
import { eq, and, desc } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { resolveNotificationsFor } from '../notification/notification-resolution.link';
import { validateAgentManifest } from '@shared/agent-manifest';
import { isCatalogEventType } from '@shared/event-catalog';
import { buildEventEnvelope, envelopeForEvidence } from '@shared/event-envelope';
import { isRegisteredAgentTool } from './agent-tools';
import { AuditService } from '../shared/audit.service';
import { WorldStateSnapshotService } from '../scheduler/world-state.service';
import { WorkOrderService, type CreateWorkOrderInput } from '../workorder/workorder.service';
import { KnowledgeService, type RegisterKnowledgeEntryInput } from '../knowledge/knowledge.service';
import { AgentMetricsService } from './agent-metrics.service';
import { currentTraceId } from '../../common/request-context';
import {
  projectAgentApprovalDecision,
  type AgentApprovalDecisionInput,
} from '../scheduler/decision-projection';
import type { DecisionRecord } from '@shared/decision';
import type { OrgContext } from '../shared/org-context.interceptor';

/** NO-06d：Agent 审批有效期（超期解析为拒绝留痕，不无限悬挂）。 */
export const AGENT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

/** NO-12f/ADR-030：Agent 审批角色（部署级默认，逗号分隔；可经 env 配置）。 */
export function agentApprovalRoles(): string[] {
  const raw = (process.env.EWOH_AGENT_APPROVAL_ROLES || '').trim();
  const roles = raw
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r !== '');
  return roles.length > 0 ? roles : ['workshop_lead'];
}

export type RegisterAgentManifestInput = Record<string, unknown>;

export interface ExecuteAgentCommandInput {
  command: string;
  payload?: Record<string, unknown>;
}

export interface ExecuteAgentCommandResult {
  executed: boolean;
  needsApproval: boolean;
  outcome: 'proposed' | 'executed' | 'rejected' | 'failed' | 'delegated';
  delegated?: boolean;
  safeIdle?: boolean;
  approvalId?: string;
  detail?: string;
}

/** 内置 FactorySupervisor（L1 建议型）注册清单——首个真实 Agent（NO-06c）。 */
export const BUILTIN_SUPERVISOR_MANIFEST: RegisterAgentManifestInput = {
  agentId: 'agent:ewoh-factory-supervisor',
  name: '工厂主管 Agent',
  version: 1,
  role: 'FactorySupervisor',
  purpose: '读取工厂世界状态，生成结构化运营建议（L1：建议一律人工审批，绝不自动执行）',
  allowedTools: ['tool:world-snapshot', 'tool:world-replay', 'tool:record-evidence'],
  readScope: ['worldSnapshot', 'worldReplay'],
  writeScope: { tokens: [], commands: ['propose_plan', 'record_evidence'] },
  approvalRequirement: { autonomousLevel: 'L1', approvalRequiredFor: ['propose_plan', 'record_evidence'] },
  riskLevel: 'medium',
  inputContract: { schemaRef: 'catalog://agent/inputs/supervisor-summary' },
  outputContract: { schemaRef: 'catalog://agent/outputs/supervisor-suggestion' },
  auditTrail: true,
  budget: { maxSteps: 8, maxTokens: 20000, maxDurationSec: 300 },
  timeoutSec: 60,
  fallback: { onFailure: 'delegateHuman' },
};

/** 内置 Knowledge Agent（L1 建议型）注册清单——NO-07b 知识运行时入口。 */
export const BUILTIN_KNOWLEDGE_MANIFEST: RegisterAgentManifestInput = {
  agentId: 'agent:ewoh-knowledge-agent',
  name: '知识 Agent',
  version: 1,
  role: 'Knowledge',
  purpose: '检索工厂知识库（五层 scope 阶梯，绝不越过 private_operational 边界）并沉淀结构化知识条目（注册需人工审批）',
  allowedTools: ['tool:knowledge-search', 'tool:knowledge-register', 'tool:record-evidence'],
  readScope: ['knowledgeData'],
  writeScope: { tokens: [], commands: ['register_knowledge'] },
  approvalRequirement: { autonomousLevel: 'L1', approvalRequiredFor: ['register_knowledge'] },
  riskLevel: 'medium',
  inputContract: { schemaRef: 'catalog://agent/inputs/knowledge-query' },
  outputContract: { schemaRef: 'catalog://agent/outputs/knowledge-summary' },
  auditTrail: true,
  budget: { maxSteps: 8, maxTokens: 20000, maxDurationSec: 300 },
  timeoutSec: 60,
  fallback: { onFailure: 'delegateHuman' },
};

/**
 * Agent 运行时服务（ADR-016 / NO-06b）。
 *
 * 注册唯一入口：validateAgentManifest 契约校验 fail-closed + Tool 注册表
 * 校验 + ewoh_agent_manifest 持久化（TENANT_SCOPED RLS，standalone_037）。
 * 执行强制：command ∈ writeScope.commands；L0 无写能力；L1 写命令一律
 * needsApproval；L2/L3 按 approvalRequiredFor 门控；budget.maxSteps /
 * timeoutSec 强制（超时/超步数 fail-closed）；fallback.onFailure 显式语义
 * （fail/retry/delegateHuman/safeIdle——无静默吞）。
 * 事件：AgentTaskProposed / AgentDecisionRecorded（Canonical Catalog 信封，
 * evidenceJson 落库，审计同源）。
 */
@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly auditService: AuditService,
    private readonly worldStateService: WorldStateSnapshotService,
    private readonly workOrderService: WorkOrderService,
    private readonly knowledgeService: KnowledgeService,
    @Optional() private readonly agentMetrics?: AgentMetricsService,
  ) {}

  // ── 注册（唯一入口，契约校验 fail-closed） ────────────────────────────────

  async registerManifest(
    manifest: RegisterAgentManifestInput,
    orgId: string,
    actor?: { userId: string },
  ): Promise<Record<string, unknown>> {
    if (!orgId?.trim()) {
      throw new BadRequestException('org 上下文缺失，Agent 注册显式失败（RLS 下不静默写全局）');
    }
    const errors = validateAgentManifest(manifest);
    if (errors.length > 0) {
      throw new BadRequestException(`agent_manifest_invalid:${errors[0]}`);
    }
    const tools = manifest.allowedTools as string[];
    for (const tool of tools) {
      if (!isRegisteredAgentTool(tool)) {
        throw new BadRequestException(`unregistered_tool:${tool}`);
      }
    }
    const agentId = manifest.agentId as string;
    const existing = await this.db
      .select()
      .from(ewohAgentManifest)
      .where(and(eq(ewohAgentManifest.orgId, orgId), eq(ewohAgentManifest.agentId, agentId)));
    if (existing.length > 0) {
      const currentVersion = existing[0]?.version ?? 0;
      const newVersion = manifest.version as number;
      if (newVersion < currentVersion) {
        throw new BadRequestException(`agent_version_regression:${newVersion}<${currentVersion}`);
      }
      if (newVersion === currentVersion) {
        return existing[0]?.manifestJson as Record<string, unknown>; // 幂等重注册
      }
      await this.db
        .update(ewohAgentManifest)
        .set({
          name: manifest.name as string,
          version: newVersion,
          role: manifest.role as string,
          purpose: manifest.purpose as string,
          allowedTools: tools,
          readScope: manifest.readScope as string[],
          writeScope: manifest.writeScope as Record<string, unknown>,
          autonomousLevel: (manifest.approvalRequirement as Record<string, unknown>)
            .autonomousLevel as string,
          riskLevel: manifest.riskLevel as string,
          manifestJson: manifest,
        })
        .where(and(eq(ewohAgentManifest.orgId, orgId), eq(ewohAgentManifest.agentId, agentId)));
      this.agentMetrics?.recordManifestRegistered(manifest.role as string);
      await this.auditAppend(orgId, 'agent.manifest.update', agentId, actor);
      return manifest;
    }
    const approval = manifest.approvalRequirement as Record<string, unknown>;
    this.agentMetrics?.recordManifestRegistered(manifest.role as string);
    await this.db.insert(ewohAgentManifest).values({
      orgId,
      agentId,
      name: manifest.name as string,
      version: manifest.version as number,
      role: manifest.role as string,
      purpose: manifest.purpose as string,
      allowedTools: tools,
      readScope: manifest.readScope as string[],
      writeScope: manifest.writeScope as Record<string, unknown>,
      autonomousLevel: approval.autonomousLevel as string,
      riskLevel: manifest.riskLevel as string,
      status: 'registered',
      manifestJson: manifest,
    });
    await this.auditAppend(orgId, 'agent.manifest.register', agentId, actor);
    return manifest;
  }

  async listManifests(orgId: string): Promise<Record<string, unknown>[]> {
    if (!orgId?.trim()) {
      throw new BadRequestException('org 上下文缺失');
    }
    const rows = await this.db
      .select()
      .from(ewohAgentManifest)
      .where(eq(ewohAgentManifest.orgId, orgId))
      .orderBy(desc(ewohAgentManifest.createdAt));
    return rows.map((r) => ({
      agentId: r.agentId,
      name: r.name,
      version: r.version,
      role: r.role,
      status: r.status,
      autonomousLevel: r.autonomousLevel,
      riskLevel: r.riskLevel,
      manifest: r.manifestJson,
    }));
  }

  async getManifest(orgId: string, agentId: string): Promise<Record<string, unknown> | null> {
    const rows = await this.db
      .select()
      .from(ewohAgentManifest)
      .where(and(eq(ewohAgentManifest.orgId, orgId), eq(ewohAgentManifest.agentId, agentId)));
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      agentId: r.agentId,
      name: r.name,
      version: r.version,
      role: r.role,
      status: r.status,
      autonomousLevel: r.autonomousLevel,
      riskLevel: r.riskLevel,
      manifest: r.manifestJson,
    };
  }

  // ── 执行（审批门控 + 预算/超时/回退强制） ─────────────────────────────────

  async executeCommand(
    orgId: string,
    agentId: string,
    input: ExecuteAgentCommandInput,
    actor?: { userId: string },
  ): Promise<ExecuteAgentCommandResult> {
    const manifest = await this.getManifest(orgId, agentId);
    if (!manifest) {
      throw new BadRequestException('agent_not_registered');
    }
    if (manifest.status === 'suspended') {
      throw new BadRequestException('agent_suspended');
    }
    const full = manifest.manifest as Record<string, unknown>;
    const writeScope = full.writeScope as Record<string, unknown>;
    const commands = (writeScope.commands ?? []) as string[];
    const approval = full.approvalRequirement as Record<string, unknown>;
    const level = approval.autonomousLevel as string;
    const approvalRequiredFor = (approval.approvalRequiredFor ?? []) as string[];
    const budget = full.budget as Record<string, unknown>;
    const maxSteps = budget.maxSteps as number;
    const timeoutSec = full.timeoutSec as number;
    const fallback = full.fallback as Record<string, unknown>;
    const onFailure = fallback.onFailure as string;

    if (!commands.includes(input.command)) {
      throw new BadRequestException(`command_not_allowed:${input.command}`);
    }
    if (level === 'L0') {
      throw new BadRequestException('advisory_only: L0 无写命令能力');
    }
    // 审批门控：L1 写命令一律人审；L2/L3 按 approvalRequiredFor。
    const needsApproval =
      level === 'L1' || approvalRequiredFor.includes(input.command);
    if (needsApproval) {
      // NO-12p/ADR-039：审批桥接——待批事实落 ewoh_agent_approval 台账
      // （跨重启持久化，ADR-030 决策 4 边界收口）；批准后经 resolveApproval
      // 读台账重放执行。
      const roles = agentApprovalRoles();
      const approvalId = `appr-${randomUUID().slice(0, 12)}`;
      await this.db.insert(ewohAgentApproval).values({
        orgId,
        approvalId,
        agentId,
        command: input.command,
        payloadJson: input.payload ?? {},
        rolesJson: roles,
        status: 'pending',
      });
      // NO-12f/ADR-030：通知闭环——审批创建即插 in-app 通知（指向真实审批实例）
      await this.notifyApprovalPending(orgId, agentId, input.command, approvalId, roles);
      await this.recordDecisionEvent(orgId, full, input, 'proposed', {
        needsApproval: true,
        command: input.command,
        approvalId,
      });
      this.agentMetrics?.recordCommand('proposed', String(full.role ?? ''), input.command);
      await this.auditAppend(orgId, 'agent.command.proposed', agentId, actor);
      return {
        executed: false,
        needsApproval: true,
        outcome: 'proposed',
        approvalId,
        detail: `command ${input.command} 需要人工审批（level=${level}，approval=${approvalId}）`,
      };
    }

    // NEST-329：步数预算服务端累计计数（原先 payload.stepsUsed 客户端可控，
    // 传 0 即绕过 maxSteps）。计数键 = (org, agent)；进程内累计，重启清零
    // （预算是防风暴护栏而非硬配额，重启放宽可接受且诚实）。
    const stepsUsed = this.serverStepsUsed(orgId, agentId);
    if (stepsUsed >= maxSteps) {
      throw new BadRequestException(`budget_exceeded:maxSteps=${maxSteps}`);
    }

    const run = async (): Promise<ExecuteAgentCommandResult> => {
      const result = await this.dispatchCommand(orgId, full, input);
      this.bumpServerStepsUsed(orgId, agentId);
      this.agentMetrics?.recordCommand('executed', String(full.role ?? ''), input.command);
      await this.recordDecisionEvent(orgId, full, input, 'executed', result);
      return { executed: true, needsApproval: false, outcome: 'executed' };
    };

    try {
      return await this.withTimeout(run(), timeoutSec);
    } catch (error) {
      this.logger.warn(`agent 执行失败 agent=${agentId} command=${input.command}: ${String(error)}`);
      await this.recordDecisionEvent(orgId, full, input, 'failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      // fallback 显式语义（无静默吞）
      if (onFailure === 'fail') {
        throw error;
      }
      if (onFailure === 'retry') {
        try {
          await this.dispatchCommand(orgId, full, input);
          this.agentMetrics?.recordCommand('executed', String(full.role ?? ''), input.command);
          await this.recordDecisionEvent(orgId, full, input, 'executed', { retried: true });
          return { executed: true, needsApproval: false, outcome: 'executed' };
        } catch (retryError) {
          await this.recordDecisionEvent(orgId, full, input, 'failed', {
            error: `retry_failed:${retryError instanceof Error ? retryError.message : String(retryError)}`,
          });
          throw retryError;
        }
      }
      if (onFailure === 'delegateHuman') {
        this.agentMetrics?.recordCommand('delegated', String(full.role ?? ''), input.command);
        await this.recordDecisionEvent(orgId, full, input, 'delegated', {});
        return { executed: false, needsApproval: false, outcome: 'delegated', delegated: true };
      }
      // safeIdle
      this.agentMetrics?.recordCommand('rejected', String(full.role ?? ''), input.command);
      await this.recordDecisionEvent(orgId, full, input, 'rejected', { safeIdle: true });
      return { executed: false, needsApproval: false, outcome: 'rejected', safeIdle: true };
    }
  }

  private async dispatchCommand(
    orgId: string,
    full: Record<string, unknown>,
    input: ExecuteAgentCommandInput,
  ): Promise<Record<string, unknown>> {
    if (input.command === 'record_evidence') {
      // 真实落账：审计事实 + 决策事件（executeCommand 成功路径已记 decision 事件）
      await this.auditAppend(orgId, 'agent.evidence.recorded', String(full.agentId ?? ''));
      return { command: input.command, payload: input.payload ?? {} };
    }
    if (input.command === 'propose_plan') {
      return { command: input.command, proposal: input.payload ?? {} };
    }
    if (input.command === 'create_work_order') {
      // NO-06d：接入真实 Domain Service（WorkOrder 权威写路径，契约 fail-closed）
      const body = input.payload as unknown as CreateWorkOrderInput;
      if (!body?.origin?.kind || !body?.origin?.id || !body?.subjectEntityId) {
        throw new BadRequestException('create_work_order 载荷缺 origin/subjectEntityId');
      }
      const workOrder = await this.workOrderService.createWorkOrder(body, orgId);
      return { command: input.command, workOrder };
    }
    if (input.command === 'register_knowledge') {
      // NO-07b：接入真实 Domain Service（Knowledge 权威写路径，契约 fail-closed；
      // 五层 scope 阶梯 + RLS 双强制，L1 注册一律经审批桥接）
      const body = input.payload as unknown as RegisterKnowledgeEntryInput;
      if (!body?.kind || !body?.scope || !body?.title || !body?.body) {
        throw new BadRequestException('register_knowledge 载荷缺 kind/scope/title/body');
      }
      if (!Array.isArray(body.sourceEvidenceIds)) {
        throw new BadRequestException('register_knowledge 载荷缺 sourceEvidenceIds（非空证据链）');
      }
      const entry = await this.knowledgeService.registerEntry(body, orgId);
      return { command: input.command, entry };
    }
    // 其余命令的领域服务接线随后续轮次（fail-closed：绝不静默假装执行成功）
    throw new BadRequestException(`tool_execution_not_implemented:${input.command}`);
  }

  // ── NO-12f/ADR-030：待批清单 + 通知闭环 ────────────────────────────────────

  /** 待批清单（org 作用域）：ewoh_agent_approval 台账（跨重启持久化，
   *  ADR-039/NO-12p）；过期是显式状态（expired=true），绝不静默消失（§33）。 */
  async listPendingApprovals(orgId: string): Promise<Array<Record<string, unknown>>> {
    const rows = await this.db
      .select()
      .from(ewohAgentApproval)
      .where(and(eq(ewohAgentApproval.orgId, orgId), eq(ewohAgentApproval.status, 'pending')))
      .orderBy(desc(ewohAgentApproval.createdAt));
    const now = Date.now();
    return rows.map((row) => {
      const createdAtMs = row.createdAt.getTime();
      return {
        approvalId: row.approvalId,
        agentId: row.agentId,
        command: row.command,
        payload: (row.payloadJson ?? {}) as Record<string, unknown>,
        roles: Array.isArray(row.rolesJson) ? (row.rolesJson as string[]) : [],
        createdAt: row.createdAt.toISOString(),
        expiresAtMs: createdAtMs + AGENT_APPROVAL_TTL_MS,
        remainingMs: Math.max(0, createdAtMs + AGENT_APPROVAL_TTL_MS - now),
        expired: now - createdAtMs > AGENT_APPROVAL_TTL_MS,
      };
    });
  }

  /**
   * NO-47a：Agent 待批命令提醒的通知号前缀（处置侧据此限定范围）。
   *
   * 确定性 id 的理由与安灯一致：随机 id 既不幂等（重试/重放会重复打扰），
   * 也无法被治理度量按类型归类（实测：度量词表里认不出这类提醒）。
   */
  private agentApprovalNotificationPrefix(approvalId: string): string {
    return `NTF-AGENT-${String(approvalId).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80)}-`;
  }

  private async notifyApprovalPending(
    orgId: string,
    agentId: string,
    command: string,
    approvalId: string,
    roles: string[],
  ): Promise<void> {
    try {
      await this.db.insert(ewohNotification).values({
        notificationId: `${this.agentApprovalNotificationPrefix(approvalId)}pending-app`,
        orgId,
        recipientType: 'role',
        recipientId: roles[0] ?? 'workshop_lead',
        channel: 'app',
        title: `Agent 命令待审批：${command}`,
        body: `Agent ${agentId} 请求执行 ${command}，请值班长审批（approval=${approvalId}）`,
        severity: 'high',
        status: 'pending',
        externalRef: approvalId,
      }).onConflictDoNothing({
        // standalone_100：唯一性收敛为 (org_id, notification_id)——target 必须与
        // 仲裁索引逐列一致（与 deterministic-notifications 同步修改，实测事故）。
        target: [ewohNotification.orgId, ewohNotification.notificationId],
      });
    } catch (error) {
      // 通知旁路：失败显式留痕不阻断审批主流程（审批实例本身是事实源）。
      // NEST-341（裁决文档化）：通知是旁路证据，非事实链——审批台账行
      // （ewoh_agent_approval）才是权威事实；重试/outbox 属通知可靠性域
      // （channel-dispatcher 已有失败留痕 + 人审重放），不在审批主流程补重试。
      this.logger.warn(`agent approval 通知写入失败 ${approvalId}: ${String(error)}`);
    }
  }

  // ── NO-12p/ADR-039：审批解析（台账 CAS + 批准→执行 / 驳回→拒绝留痕，
  //    跨重启持久化，闭环无静默） ────────────────────────────────────────────

  async resolveApproval(
    orgId: string,
    approvalId: string,
    approved: boolean,
    actor?: { userId: string; roles?: string[] },
    reason?: string,
  ): Promise<ExecuteAgentCommandResult> {
    // 待批事实 = ewoh_agent_approval 台账行（进程重启后仍可解析，ADR-039）。
    // NEST-305：按 (orgId, approvalId) 定位——他租户审批不可被解析（404 语义）。
    if (!orgId?.trim()) {
      throw new BadRequestException('org 上下文缺失：审批解析必须带租户上下文');
    }
    const [row] = await this.db
      .select()
      .from(ewohAgentApproval)
      .where(
        and(eq(ewohAgentApproval.orgId, orgId), eq(ewohAgentApproval.approvalId, approvalId)),
      )
      .limit(1);
    if (!row) {
      throw new BadRequestException('approval_not_found_for_agent_command');
    }
    if (row.status !== 'pending') {
      throw new BadRequestException(`approval_already_resolved:${row.status}`);
    }
    // FR5（2026-09-13）：审批角色强制。台账 rolesJson（NO-12f：通知发给"值班长"）
    // 记录了**谁能批**，但解析端点此前只看"是谁"不看"有没有资格角色"——
    // viewer/worker 等任意已认证角色都能批准 L1 agent 任务（写命令！）。
    // 现在强制：rolesJson 非空时 actor.roles 必须与其有交集，否则 403 fail-closed。
    // rolesJson 为空 = 部署未声明约束（不发明约束，放行并保持原语义）；
    // TTL 超期解析在下方按 policy 权威执行，不受本闸门约束（无人工操作者）。
    const requiredApprovalRoles = Array.isArray(row.rolesJson)
      ? (row.rolesJson as string[]).filter((r) => typeof r === 'string' && r.trim() !== '')
      : [];
    const actorApprovalRoles = Array.isArray(actor?.roles) ? actor!.roles! : [];
    if (
      requiredApprovalRoles.length > 0
      && !actorApprovalRoles.some((r) => requiredApprovalRoles.includes(r))
    ) {
      throw new ForbiddenException(
        'AGENT_APPROVAL_ROLE_FORBIDDEN: 该审批需要角色 '
          + requiredApprovalRoles.join('/')
          + '（当前账号角色：'
          + (actorApprovalRoles.join('/') || '无')
          + '）',
      );
    }
    const normalizedReason = reason?.trim() ?? '';
    if (!approved && !normalizedReason) {
      throw new BadRequestException('人工驳回必须带非空 reason（拒绝事实不允许静默）');
    }
    const agentId = row.agentId;
    const command = row.command;
    const payload = (row.payloadJson ?? {}) as Record<string, unknown>;
    const pendingInput: ExecuteAgentCommandInput = { command, payload };

    const manifest = await this.getManifest(orgId, agentId);
    if (!manifest) {
      throw new BadRequestException('agent_not_registered');
    }
    const full = manifest.manifest as Record<string, unknown>;
    const createdAtMs = row.createdAt.getTime();
    // NO-06d：审批超时语义（超 24h 解析为拒绝留痕，不无限悬挂）
    if (Date.now() - createdAtMs > AGENT_APPROVAL_TTL_MS) {
      // NO-13j / ADR-059：TTL 超期解析 = policy 权威决策（无人工操作者）。
      const expiredDecision = this.projectApprovalDecision({
        approvalId, agentId, command, orgId,
        manifestRiskLevel: typeof full.riskLevel === 'string' ? full.riskLevel : null,
        outcome: 'expired', now: new Date(),
      });
      await this.resolveRow(approvalId, orgId, 'expired', actor, { approved: false, expired: true }, expiredDecision);
      await this.recordDecisionEvent(orgId, full, pendingInput, 'rejected', {
        approvalId,
        approved: false,
        expired: true,
      });
      await this.auditAppend(orgId, 'agent.command.approval_expired', agentId, actor);
      return {
        executed: false,
        needsApproval: false,
        outcome: 'rejected',
        detail: 'approval_expired（超 24h，拒绝留痕）',
      };
    }
    if (!approved) {
      // NO-13j / ADR-059：人工驳回决策留痕（决策记录随台账行同事务落库）。
      const rejectedDecision = this.projectApprovalDecision({
        approvalId, agentId, command, orgId,
        manifestRiskLevel: typeof full.riskLevel === 'string' ? full.riskLevel : null,
        outcome: 'rejected', operator: actor?.userId ?? null, reason: normalizedReason, now: new Date(),
      });
      await this.resolveRow(approvalId, orgId, 'rejected', actor, { approved: false, rejectedReason: normalizedReason }, rejectedDecision);
      await this.recordDecisionEvent(orgId, full, pendingInput, 'rejected', {
        approvalId,
        approved: false,
      });
      this.agentMetrics?.recordApprovalResolved('rejected');
      this.agentMetrics?.recordCommand('rejected', String(full.role ?? ''), command);
      await this.auditAppend(orgId, 'agent.command.rejected', agentId, actor);
      return { executed: false, needsApproval: false, outcome: 'rejected', detail: '人工驳回' };
    }
    // 批准：先 CAS 落 approved 再执行（重复解析显式拒绝；执行仍受
    // budget/timeout/fallback 强制）。
    const approvedDecision = this.projectApprovalDecision({
      approvalId, agentId, command, orgId,
      manifestRiskLevel: typeof full.riskLevel === 'string' ? full.riskLevel : null,
      outcome: 'approved', operator: actor?.userId ?? null, now: new Date(),
    });
    await this.resolveRow(approvalId, orgId, 'approved', actor, { approved: true }, approvedDecision);
    this.agentMetrics?.recordApprovalResolved('approved');
    return this.executeAuthorized(orgId, agentId, pendingInput, actor);
  }

  /**
   * NO-13j / ADR-059：agent_approval 决策投影（ADR-047 契约门）。
   * 投影失败 → 记录错误并 fail-closed 抛出 500；没有可追溯决策记录时，
   * 不允许授权终态落地，避免无审计批准。
   */
  private projectApprovalDecision(
    input: Omit<AgentApprovalDecisionInput, 'operator' | 'reason'> &
      Partial<Pick<AgentApprovalDecisionInput, 'operator' | 'reason'>>,
  ): DecisionRecord {
    const { record, issues } = projectAgentApprovalDecision(input as AgentApprovalDecisionInput);
    if (!record) {
      this.logger.error(
        `agent approval 决策投影失败 ${input.approvalId}（fail-closed）：${issues.join(',')}`,
      );
      throw new InternalServerErrorException(
        `DECISION_PROJECTION_FAILED: agent approval ${input.approvalId} 的授权决策无法留痕，已拒绝解析`,
      );
    }
    return record;
  }

  /** CAS 落解析状态（WHERE status='pending' RETURNING；未命中=他请求已解析）。 */
  private async resolveRow(
    approvalId: string,
    orgId: string,
    status: 'approved' | 'rejected' | 'expired',
    actor: { userId?: string } | undefined,
    resolution: Record<string, unknown>,
    decisionJson?: DecisionRecord | null,
  ): Promise<void> {
    // NO-47a：台账 CAS 与"待审批提醒终态"同事务——命令已被人处理（或超时作废）后，
    // 那条"请值班长审批"的提醒就不再需要人处理；分开提交会留下"已处置但仍待办"的噪音。
    await this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(ewohAgentApproval)
        .set({
          status,
          resolvedAt: new Date(),
          resolvedBy: actor?.userId ?? 'system',
          resolutionJson: resolution,
          ...(decisionJson ? { decisionJson } : {}),
          updatedAt: new Date(),
        })
        .where(and(
          eq(ewohAgentApproval.orgId, orgId),
          eq(ewohAgentApproval.approvalId, approvalId),
          eq(ewohAgentApproval.status, 'pending'),
        ))
        .returning();
      if (!updated) {
        throw new BadRequestException(`approval_already_resolved:${status}`);
      }
      await resolveNotificationsFor(tx, {
        orgId,
        externalRef: approvalId,
        notificationIdPrefix: this.agentApprovalNotificationPrefix(approvalId),
        resolution: status === 'expired' ? 'agent_approval_expired' : 'agent_approval_decided',
        resolvedBy: actor?.userId ?? 'system:agent-approval',
        resolutionRef: approvalId,
      });
    });
  }

  private async executeAuthorized(
    orgId: string,
    agentId: string,
    input: ExecuteAgentCommandInput,
    actor?: { userId: string },
  ): Promise<ExecuteAgentCommandResult> {
    const manifest = await this.getManifest(orgId, agentId);
    if (!manifest) {
      throw new BadRequestException('agent_not_registered');
    }
    const full = manifest.manifest as Record<string, unknown>;
    const budget = full.budget as Record<string, unknown>;
    const maxSteps = budget.maxSteps as number;
    const timeoutSec = full.timeoutSec as number;
    const fallback = full.fallback as Record<string, unknown>;
    const onFailure = fallback.onFailure as string;
    // NEST-329：服务端步数计数（同 executeCommand 直发路径）。
    const stepsUsed = this.serverStepsUsed(orgId, agentId);
    if (stepsUsed >= maxSteps) {
      throw new BadRequestException(`budget_exceeded:maxSteps=${maxSteps}`);
    }
    try {
      // NEST-327：审批后执行同样受 timeoutSec 强制（原先仅直发路径包
      // withTimeout，审批后命令可无限期挂起）。
      await this.withTimeout(
        (async () => {
          await this.dispatchCommand(orgId, full, input);
        })(),
        timeoutSec,
      );
      this.bumpServerStepsUsed(orgId, agentId);
      this.agentMetrics?.recordCommand('executed', String(full.role ?? ''), input.command);
      await this.recordDecisionEvent(orgId, full, input, 'executed', { approved: true });
      await this.auditAppend(orgId, 'agent.command.executed', agentId, actor);
      return { executed: true, needsApproval: false, outcome: 'executed' };
    } catch (error) {
      await this.recordDecisionEvent(orgId, full, input, 'failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      if (onFailure === 'delegateHuman') {
        this.agentMetrics?.recordCommand('delegated', String(full.role ?? ''), input.command);
        await this.recordDecisionEvent(orgId, full, input, 'delegated', {});
        return { executed: false, needsApproval: false, outcome: 'delegated', delegated: true };
      }
      throw error;
    }
  }

  // ── NO-06c：内置 FactorySupervisor（L1 建议型）端到端 ─────────────────────

  async ensureBuiltinSupervisor(orgId: string): Promise<Record<string, unknown>> {
    return this.registerManifest(BUILTIN_SUPERVISOR_MANIFEST, orgId);
  }

  // ── NO-07b：内置 Knowledge Agent（L1 建议型）端到端 ────────────────────────

  async ensureBuiltinKnowledge(orgId: string): Promise<Record<string, unknown>> {
    return this.registerManifest(BUILTIN_KNOWLEDGE_MANIFEST, orgId);
  }

  /**
   * 知识 Agent 检索流：五层 scope 阶梯（共享层 ∪ 本租户层；绝不越过
   * private_operational 边界——由 KnowledgeService + RLS 双强制）。
   */
  async runKnowledgeSearch(
    orgId: string,
    filters?: { kind?: string; scope?: string },
  ): Promise<Record<string, unknown>[]> {
    await this.ensureBuiltinKnowledge(orgId);
    return this.knowledgeService.retrieveEntries(orgId, filters);
  }

  /**
   * 工厂主管 Agent 建议流：读世界状态 → 确定性建议 → propose_plan → 审批桥接。
   * 建议内容来自真实 World State 数字（可解释，非编造）；L1 一律人审。
   */
  async runSupervisorSuggestion(
    orgId: string,
    actor?: OrgContext,
  ): Promise<{ suggestion: Record<string, unknown>; result: ExecuteAgentCommandResult }> {
    // R2-SBZ-002：supervisor 建议流的世界状态读取必须带租户上下文——
    // 缺失或与 orgId 不一致时 fail-closed 拒绝（参照 NEST-213 actorOf 模式），
    // 绝不回退全租户聚合（RLS 缺失/降级环境下应用层零防御）。
    const ctxOrgId = actor?.primaryOrgId?.trim();
    if (!orgId?.trim() || !ctxOrgId || ctxOrgId !== orgId.trim()) {
      throw new UnauthorizedException(
        'org 上下文缺失或不一致：supervisor 建议流世界状态读取需要租户上下文',
      );
    }
    await this.ensureBuiltinSupervisor(orgId);
    // R2-SBZ-002：透传 OrgContext，collectState 按 primaryOrgId 加 org 谓词（NEST-101），
    // 建议 facts 与 propose_plan 审批载荷不再聚合他租户世界状态。
    const world = await this.worldStateService.getCurrentWorldState(actor);
    const highSeverityEvents = (world.events ?? []).filter(
      (e) => e.severity === 'critical' || e.severity === 'high',
    ).length;
    const backlogStations = (world.stations ?? []).filter(
      (s) => (s.queue ?? []).length > 0,
    ).length;
    const deviceCount = (world.devices ?? []).length;
    const personCount = (world.persons ?? []).length;
    const suggestion: Record<string, unknown> = {
      kind: 'supervisor_advisory',
      generatedAt: new Date().toISOString(),
      facts: {
        highSeverityEvents,
        backlogStations,
        deviceCount,
        personCount,
      },
      recommendations: [] as string[],
    };
    if (highSeverityEvents > 0) {
      (suggestion.recommendations as string[]).push(
        `存在 ${highSeverityEvents} 条 critical/high 事件，建议值班长复核事件处置状态`,
      );
    }
    if (backlogStations > 0) {
      (suggestion.recommendations as string[]).push(
        `${backlogStations} 个工位存在积压，建议复核派工与补员`,
      );
    }
    const result = await this.executeCommand(
      orgId,
      BUILTIN_SUPERVISOR_MANIFEST.agentId as string,
      { command: 'propose_plan', payload: suggestion },
      actor,
    );
    return { suggestion, result };
  }

  /**
   * NEST-329：服务端步数累计（进程内，键 = org:agent）。
   * payload.stepsUsed 不再被信任（客户端可控）。
   */
  private readonly stepCounters = new Map<string, number>();

  private serverStepsUsed(orgId: string, agentId: string): number {
    return this.stepCounters.get(`${orgId}:${agentId}`) ?? 0;
  }

  private bumpServerStepsUsed(orgId: string, agentId: string): void {
    const key = `${orgId}:${agentId}`;
    this.stepCounters.set(key, (this.stepCounters.get(key) ?? 0) + 1);
  }

  /**
   * NEST-328（2026-08-17 审计整改）：超时竞争 + 可选外部 AbortSignal。
   * 超时后底层 promise 可能仍会落定——Promise.race 已为其挂接 handler，
   * 不会产生 unhandled rejection；调用方如需真正取消底层工作（如中断
   * DB 事务/HTTP 请求）应传入 AbortSignal，信号触发立即按超时语义拒绝。
   */
  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutSec: number,
    signal?: AbortSignal,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    let rejectAbort: () => void = () => undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`agent_timeout:${timeoutSec}s`)), timeoutSec * 1000);
    });
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      rejectAbort();
    };
    const externalAbort = signal
      ? new Promise<never>((_resolve, reject) => {
          rejectAbort = () => reject(new Error(`agent_aborted:${timeoutSec}s`));
          signal.addEventListener('abort', onAbort, { once: true });
        })
      : null;
    try {
      return externalAbort
        ? await Promise.race([promise, timeout, externalAbort])
        : await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  private async recordDecisionEvent(
    orgId: string,
    full: Record<string, unknown>,
    input: ExecuteAgentCommandInput,
    outcome: 'proposed' | 'executed' | 'rejected' | 'failed' | 'delegated',
    detail: Record<string, unknown>,
  ): Promise<void> {
    try {
      const now = new Date();
      const nowIso = now.toISOString();
      const agentId = full.agentId as string;
      const eventType = input.command === 'propose_plan' && outcome === 'proposed'
        ? 'AgentTaskProposed'
        : 'AgentDecisionRecorded';
      if (!isCatalogEventType(eventType)) {
        this.logger.error(`agent 事件类型不在目录: ${eventType}`);
        return;
      }
      const envelope = buildEventEnvelope({
        eventId: `EVT-${Math.floor(Date.now() / 1000)}-${randomUUID().slice(0, 8)}`,
        eventType,
        occurredAt: nowIso,
        observedAt: nowIso,
        receivedAt: nowIso,
        source: 'cloud:agent-runtime',
        subject: agentId,
        correlationId: currentTraceId() ?? null,
      });
      const envelopeRecord = envelopeForEvidence(envelope);
      await this.db.insert(ewohEvent).values({
        eventId: envelope.eventId,
        deviceId: null,
        eventCode: eventType === 'AgentTaskProposed' ? 'AGENT_TASK_PROPOSED' : 'AGENT_DECISION_RECORDED',
        eventType,
        severity: 'low',
        title: `agent:${full.role ?? ''} ${input.command} ${outcome}`,
        status: 'open',
        createdAt: now,
        // ADR-009 / standalone_066: Event Envelope fields.
        occurredAt: now,
        receivedAt: now,
        schemaVersion: '1.0.0',
        correlationId: null,
        causationId: null,
        confidence: null,
        sourceType: 'real',
        orgId,
        evidenceJson: {
          envelope: envelopeRecord.envelope,
          envelopeSemantics: envelopeRecord.envelopeSemantics,
          agentId,
          command: input.command,
          outcome,
          ...detail,
        },
      });
    } catch (error) {
      this.logger.error(`agent 决策事件写入失败: ${String(error)}`);
    }
  }

  private async auditAppend(
    orgId: string,
    action: string,
    agentId: string,
    actor?: { userId: string },
  ): Promise<void> {
    try {
      await this.auditService.appendAuditLog({
        actorId: actor?.userId ?? 'agent-runtime',
        orgId,
        action,
        entityType: 'agent',
        entityId: agentId,
        before: null,
        after: { agentId },
      });
    } catch (error) {
      this.logger.warn(`agent 审计写入失败: ${String(error)}`);
    }
  }
}
