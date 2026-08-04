import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { load } from 'js-yaml';

const HANDOFF_TRANSITIONS: Record<string, string[]> = {
  open: ['accepted', 'rejected'],
  accepted: ['closed'],
  rejected: ['closed'],
  closed: [],
};

export interface WorkItem {
  id: string;
  title: string;
  type: string;
  status: string;
  owner: string;
  agents?: string[];
  wave?: string;
  evidence?: string;
  summary?: string;
}

interface WorkEdge {
  id: string;
  from: string;
  to: string;
  edgeType: string;
  blocking?: boolean;
  condition?: string;
  evidenceRequirement?: string;
}

export interface WorkActor {
  actorId: string;
  name: string;
  kind: string;
  role: string;
  ownership?: string;
  permissions?: string[];
  runtime?: string;
  status?: string;
}

export interface WorkEvidence {
  evidenceId: string;
  workItemId: string;
  title?: string;
  kind: string;
  path: string;
  checksum: string;
  result?: string;
  branch?: string;
  commitSha?: string;
  buildVersion?: string;
  envFingerprint?: string;
  dependencyVersion?: string;
  testTime?: string;
  verifier?: string;
  expiresAt?: string;
  status?: string;
  staleReason?: string;
}

export interface WorkGate {
  gateId: string;
  title: string;
  calculatedStatus: string;
  humanDecision?: string | null;
  conditions?: string[];
  approver?: string | null;
  decidedAt?: string | null;
}

interface WorkResource {
  resourceId: string;
  name: string;
  kind: string;
  status: string;
  purpose?: string;
}

export interface WorkGraph {
  schema: string;
  generatedAt: string;
  sourceRoot: string;
  criticalPath: string;
  summary: {
    itemCount: number;
    edgeCount: number;
    actorCount: number;
    artifactCount: number;
    evidenceCount: number;
    gateCount: number;
    riskCount: number;
    decisionCount: number;
    statusCounts: Record<string, number>;
    conflicts: string[];
  };
  items: WorkItem[];
  edges: WorkEdge[];
  actors: WorkActor[];
  artifacts: Array<{ artifactId: string; path: string; mediaType: string; checksum: string }>;
  evidence: WorkEvidence[];
  gates: WorkGate[];
  risks: Array<{ id: string; title: string; severity: string; status: string }>;
  decisions: Array<{ id: string; title: string; date: string }>;
  resources: WorkResource[];
  handoffs: Array<{ handoffId: string; fromActor: string; toActor: string; status: string; createdAt: string }>;
}

interface WorkIndexerModule {
  findArtifactsDir(cwd: string): string;
  indexWorkGraph(artifactsDir: string, options?: { root?: string }): WorkGraph;
}

interface GateEngineModule {
  calculate(
    gates: WorkGate[],
    humanDecisions: Array<{
      gateId: string;
      decision: string;
      approver?: string;
      decidedAt?: string;
    }>,
    artifactsDir: string,
  ): Array<WorkGate & { baseStatus: string }>;
}

interface GitSyncModule {
  buildGitSyncPlan(
    items: WorkItem[],
    registry: Array<Record<string, unknown>>,
    git: { branch?: string; headSha?: string; remote?: string },
  ): Record<string, unknown>;
  gitInfo(root: string): { branch: string; headSha: string; remote: string };
  liveApply(
    plan: Record<string, unknown>,
    registryFile: string,
    root: string,
  ): { created: Array<Record<string, unknown>>; registryFile: string };
}

interface SiteReadinessModule {
  evaluateSiteReadiness(report: Record<string, unknown>): {
    factoryName: string;
    siteContact: string;
    ready: boolean;
    requiredCount: number;
    requiredPassed: number;
    requiredFailed: number;
    checks: Array<{ id: string; label: string; passed: boolean; status: string }>;
  };
}

export interface GateDecisionRecord {
  gateId: string;
  decision: 'approved' | 'rejected' | 'conditional';
  approver?: string;
  decidedAt?: string;
  conditions?: string[];
}

export interface GateHistoryRecord extends GateDecisionRecord {
  action?: 'decision' | 'revoked';
  reason?: string;
  revokedAt?: string;
  revokedBy?: string;
}

export interface ResourceLockRecord {
  resourceId: string;
  holder: string;
  purpose?: string;
  acquiredAt: string;
  expiresAt?: string;
  active: boolean;
}

@Injectable()
export class WorkOrchestrationService {
  private indexerModule: WorkIndexerModule | null = null;
  private gateEngineModule: GateEngineModule | null = null;
  private gitSyncModule: GitSyncModule | null = null;
  private siteReadinessModule: SiteReadinessModule | null = null;
  private readonly locks = new Map<string, ResourceLockRecord>();

  getGraph(): WorkGraph {
    return this.indexer().indexWorkGraph(this.artifactsDir(), {
      root: this.repoRoot(),
    });
  }

  getOverview() {
    const graph = this.getGraph();
    return {
      generatedAt: graph.generatedAt,
      phase: this.currentPhase(),
      criticalPath: graph.criticalPath,
      counts: graph.summary,
      gates: this.getGates(),
      conflicts: graph.summary.conflicts,
      writable: this.isWritable(),
    };
  }

  getItems(filters: {
    status?: string;
    type?: string;
    owner?: string;
    wave?: string;
    q?: string;
    limit?: number;
    offset?: number;
  }) {
    const graph = this.getGraph();
    const needle = filters.q?.trim().toLowerCase();
    const filtered = graph.items.filter((item) => {
      if (filters.status && item.status !== filters.status) return false;
      if (filters.type && item.type !== filters.type) return false;
      if (filters.owner && item.owner !== filters.owner) return false;
      if (filters.wave && item.wave !== filters.wave) return false;
      if (needle) {
        const haystack = [
          item.id,
          item.title,
          item.owner,
          item.status,
          item.wave,
          item.summary,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
    const offset = Math.max(0, Number(filters.offset ?? 0));
    const limit = filters.limit === undefined ? undefined : Math.max(1, Number(filters.limit));
    return limit === undefined ? filtered.slice(offset) : filtered.slice(offset, offset + limit);
  }

  getEvidence(filters: {
    kind?: string;
    result?: string;
    q?: string;
    limit?: number;
    offset?: number;
  }) {
    const graph = this.getGraph();
    const needle = filters.q?.trim().toLowerCase();
    const filtered = graph.evidence.filter((entry) => {
      if (filters.kind && entry.kind !== filters.kind) return false;
      if (filters.result && entry.result !== filters.result) return false;
      if (needle) {
        const haystack = [entry.evidenceId, entry.title, entry.path, entry.kind, entry.result]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
    const offset = Math.max(0, Number(filters.offset ?? 0));
    const limit = filters.limit === undefined ? undefined : Math.max(1, Number(filters.limit));
    return limit === undefined ? filtered.slice(offset) : filtered.slice(offset, offset + limit);
  }

  getEvidenceContent(evidenceId: string, limit?: number) {
    const entry = this.getGraph().evidence.find(
      (candidate) => candidate.evidenceId === evidenceId,
    );
    if (!entry) {
      throw new NotFoundException(`Evidence ${evidenceId} not found`);
    }
    const relative = entry.path.replace(/^\.codex\/artifacts\//, '');
    const file = resolve(this.artifactsDir(), relative);
    const evidenceRoot = resolve(this.artifactsDir(), 'work', 'evidence');
    if (!file.startsWith(`${evidenceRoot}/`) || !existsSync(file)) {
      throw new NotFoundException(`Evidence file ${entry.path} not found`);
    }
    const text = readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/);
    const max = Math.min(Math.max(1, Number(limit ?? 200)), 500);
    return {
      evidenceId,
      path: entry.path,
      lines: lines.length,
      truncated: lines.length > max,
      content: lines.slice(0, max).join('\n'),
    };
  }

  getAgents() {
    return this.getGraph().actors;
  }

  getGates() {
    const graph = this.getGraph();
    const decisions = this.loadGateDecisions();
    return this.gateEngine().calculate(graph.gates, decisions, this.artifactsDir());
  }

  getRisks() {
    return this.getGraph().risks;
  }

  getResources() {
    const graph = this.getGraph();
    return graph.resources.map((resource) => {
      const lock = this.locks.get(resource.resourceId) || this.loadLockFile(resource.resourceId);
      if (lock && this.isLockExpired(lock)) {
        this.releaseExpiredLock(resource.resourceId);
        return {
          ...resource,
          lock: null,
        };
      }
      return {
        ...resource,
        lock: lock?.active
          ? {
              holder: lock.holder,
              purpose: lock.purpose,
              acquiredAt: lock.acquiredAt,
              expiresAt: lock.expiresAt,
            }
          : null,
      };
    });
  }

  getHandoffs() {
    return this.getGraph().handoffs;
  }

  getGitSyncStatus() {
    const graph = this.getGraph();
    const registry = this.loadGitSyncRegistry();
    const sync = this.gitSync();
    return sync.buildGitSyncPlan(
      graph.items,
      registry,
      sync.gitInfo(this.repoRoot()),
    );
  }

  applyGitSync(body: {
    idempotencyKey?: string;
    approved?: boolean;
    reason?: string;
    actor?: string;
  }) {
    if (!this.isWritable()) {
      throw new BadRequestException('EWOH_WORK_WRITABLE is not enabled');
    }
    if (body.approved !== true) {
      throw new BadRequestException(
        'git-sync apply requires approved=true (approval gate)',
      );
    }
    if (!body.idempotencyKey || typeof body.idempotencyKey !== 'string') {
      throw new BadRequestException('idempotencyKey is required for git-sync apply');
    }
    const prior = this.loadGitSyncApply(body.idempotencyKey);
    if (prior) {
      return prior.result;
    }
    const graph = this.getGraph();
    const registry = this.loadGitSyncRegistry();
    const sync = this.gitSync();
    const plan = sync.buildGitSyncPlan(
      graph.items,
      registry,
      sync.gitInfo(this.repoRoot()),
    );
    let result: Record<string, unknown>;
    try {
      result = sync.liveApply(
        plan,
        join(this.artifactsDir(), 'work', 'git-sync.json'),
        this.repoRoot(),
      );
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : 'live GitHub sync failed',
      );
    }
    const response = {
      status: 'live',
      appliedAt: new Date().toISOString(),
      actor: body.actor ?? 'anonymous',
      reason: body.reason ?? '',
      ...result,
    };
    this.recordGitSyncApply({ idempotencyKey: body.idempotencyKey, result: response });
    return response;
  }

  getSiteReadiness() {
    const directory = join(this.repoRoot(), 'catalog', 'factory-sites');
    if (!existsSync(directory)) return [];
    const entries: Array<Record<string, unknown>> = [];
    for (const file of readdirSync(directory).sort()) {
      if (!file.endsWith('.json')) continue;
      const sourcePath = `catalog/factory-sites/${file}`;
      try {
        const report = JSON.parse(
          readFileSync(join(directory, file), 'utf8'),
        ) as Record<string, unknown>;
        const result = this.siteReadiness().evaluateSiteReadiness(report);
        entries.push({
          sourcePath,
          example: file.includes('.example.'),
          ...result,
        });
      } catch (error) {
        entries.push({
          sourcePath,
          example: file.includes('.example.'),
          ready: false,
          error: 'Invalid site readiness report',
        });
      }
    }
    return entries;
  }

  getCatalog() {
    const root = this.repoRoot();
    const catalogRoot = join(root, 'catalog');
    if (!existsSync(catalogRoot)) {
      return { schemaVersion: 'ewoh:///asset-catalog/v1', catalogId: 'none', generatedAt: new Date().toISOString(), assets: [] };
    }
    const assets: Array<Record<string, unknown>> = [];
    const walk = (directory: string, packageType: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(full, packageType);
        } else if (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')) {
          try {
            const manifest = load(readFileSync(full, 'utf8')) as {
              metadata?: { name?: string; version?: string };
            };
            assets.push({
              packageId: `${packageType}-${manifest?.metadata?.name ?? entry.name}`,
              packageType,
              name: manifest?.metadata?.name ?? entry.name,
              version: manifest?.metadata?.version ?? '0.0.0',
              status: 'catalog',
              sourcePath: full.replace(`${root}/`, ''),
            });
          } catch {
            // malformed catalog entries are skipped in the read model
          }
        }
      }
    };
    walk(join(catalogRoot, 'scenarios'), 'scenario');
    walk(join(catalogRoot, 'connectors'), 'connector');
    walk(join(catalogRoot, 'mappings'), 'mapping');
    return {
      schemaVersion: 'ewoh:///asset-catalog/v1',
      catalogId: 'ewoh-final6-catalog',
      generatedAt: new Date().toISOString(),
      assets,
    };
  }

  acquireResource(
    resourceId: string,
    body: { purpose?: string; expiresAt?: string; confirm?: boolean },
    actor: { userId: string; primaryOrgId: string } | undefined,
  ) {
    const resource = this.getResources().find((entry) => entry.resourceId === resourceId);
    if (!resource) {
      throw new NotFoundException(`Resource ${resourceId} not found`);
    }
    this.assertWritable();
    if (/device|production|environment/i.test(resource.kind) && body.confirm !== true) {
      throw new BadRequestException('double confirmation required for this resource kind');
    }
    const existing = this.locks.get(resourceId) || this.loadLockFile(resourceId);
    if (existing?.active && !this.isLockExpired(existing)) {
      throw new ConflictException(`Resource ${resourceId} is locked by ${existing.holder}`);
    }
    const record: ResourceLockRecord = {
      resourceId,
      holder: actor?.userId ?? 'anonymous',
      purpose: body.purpose,
      acquiredAt: new Date().toISOString(),
      expiresAt: body.expiresAt,
      active: true,
    };
    this.locks.set(resourceId, record);
    this.writeLockFile(resourceId, record);
    return record;
  }

  releaseResource(
    resourceId: string,
    actor: { userId: string; primaryOrgId: string; isGlobalAdmin?: boolean } | undefined,
  ) {
    const existing = this.locks.get(resourceId) || this.loadLockFile(resourceId);
    if (!existing?.active) {
      throw new NotFoundException(`Resource ${resourceId} is not locked`);
    }
    if (existing.holder !== actor?.userId && !actor?.isGlobalAdmin) {
      throw new BadRequestException('only the lock holder or a global admin can release this lock');
    }
    this.locks.delete(resourceId);
    this.deleteLockFile(resourceId);
    return { resourceId, released: true, holder: existing.holder };
  }

  createHandoff(
    body: {
      fromActor: string;
      toActor: string;
      scope: string;
      contextPack?: string;
      openQuestions?: string[];
      acceptance?: string;
    },
    actor: { userId: string; primaryOrgId: string } | undefined,
  ) {
    if (!body.fromActor?.trim() || !body.toActor?.trim() || !body.scope?.trim()) {
      throw new BadRequestException('fromActor, toActor, and scope are required');
    }
    this.assertWritable();
    const id = `HO-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const createdAt = new Date().toISOString();
    const file = join(this.artifactsDir(), 'work', 'handoffs', `${id}.md`);
    mkdirSync(join(this.artifactsDir(), 'work', 'handoffs'), { recursive: true });
    const content = [
      `# ${body.scope}`,
      '',
      `From: ${body.fromActor}`,
      `To: ${body.toActor}`,
      `Status: open`,
      `Created: ${createdAt}`,
      `Actor: ${actor?.userId ?? 'anonymous'}`,
      '',
      body.contextPack ? `Context: ${body.contextPack}` : '',
      body.acceptance ? `Acceptance: ${body.acceptance}` : '',
      body.openQuestions?.length ? `Questions: ${body.openQuestions.join('; ')}` : '',
    ]
      .filter((line) => line !== undefined)
      .join('\n');
    writeFileSync(file, `${content}\n`, 'utf8');
    return {
      handoffId: id,
      fromActor: body.fromActor,
      toActor: body.toActor,
      scope: body.scope,
      contextPack: body.contextPack,
      openQuestions: body.openQuestions ?? [],
      acceptance: body.acceptance,
      status: 'open',
      createdAt,
      source: `.codex/artifacts/work/handoffs/${id}.md`,
    };
  }

  updateHandoffStatus(
    handoffId: string,
    body: { status: 'accepted' | 'rejected' | 'closed'; reason?: string },
    actor: { userId: string; primaryOrgId: string } | undefined,
  ) {
    if (!/^HO-[A-Za-z0-9-]+$/.test(handoffId)) {
      throw new NotFoundException(`Handoff ${handoffId} not found`);
    }
    const handoff = this.getGraph().handoffs.find(
      (candidate) => candidate.handoffId === handoffId,
    );
    if (!handoff) {
      throw new NotFoundException(`Handoff ${handoffId} not found`);
    }
    if (!['accepted', 'rejected', 'closed'].includes(body.status)) {
      throw new BadRequestException('status must be accepted, rejected, or closed');
    }
    if (!HANDOFF_TRANSITIONS[handoff.status]?.includes(body.status)) {
      throw new BadRequestException(
        `Handoff transition ${handoff.status} -> ${body.status} not allowed`,
      );
    }
    this.assertWritable();
    const file = join(this.artifactsDir(), 'work', 'handoffs', `${handoffId}.md`);
    if (!existsSync(file)) {
      throw new NotFoundException(`Handoff file ${handoffId}.md not found`);
    }
    const text = readFileSync(file, 'utf8')
      .replace(/^Status:\s*.+$/m, `Status: ${body.status}`)
      .replace(/\s*$/, '');
    const updatedAt = new Date().toISOString();
    const updatedBy = actor?.userId ?? 'anonymous';
    writeFileSync(
      file,
      `${text}\nUpdatedAt: ${updatedAt}\nUpdatedBy: ${updatedBy}\nReason: ${body.reason ?? ''}\n`,
      'utf8',
    );
    return {
      handoffId,
      status: body.status,
      reason: body.reason ?? '',
      updatedBy,
      updatedAt,
    };
  }

  recordGateDecision(
    gateId: string,
    body: { decision: 'approved' | 'rejected' | 'conditional'; conditions?: string[] },
    actor: { userId: string; primaryOrgId: string } | undefined,
  ) {
    const gate = this.getGates().find((entry) => entry.gateId === gateId);
    if (!gate) {
      throw new NotFoundException(`Gate ${gateId} not found`);
    }
    if (!['approved', 'rejected', 'conditional'].includes(body.decision)) {
      throw new BadRequestException('decision must be approved, rejected, or conditional');
    }
    this.assertWritable();
    const record: GateDecisionRecord = {
      gateId,
      decision: body.decision,
      approver: actor?.userId ?? 'anonymous',
      decidedAt: new Date().toISOString(),
      conditions: body.conditions,
    };
    const decisions = this.loadGateDecisions();
    const existingIndex = decisions.findIndex((entry) => entry.gateId === gateId);
    if (existingIndex >= 0) {
      const existing = decisions[existingIndex];
      if (
        existing.decision === record.decision &&
        JSON.stringify(existing.conditions ?? null) ===
          JSON.stringify(record.conditions ?? null)
      ) {
        return existing;
      }
      this.appendGateDecisionHistory(existing);
      decisions.splice(existingIndex, 1);
    }
    decisions.push(record);
    const file = join(this.artifactsDir(), 'work', 'gate-decisions.json');
    mkdirSync(join(this.artifactsDir(), 'work'), { recursive: true });
    writeFileSync(file, `${JSON.stringify(decisions, null, 2)}\n`, 'utf8');
    return record;
  }

  recordGateDecisions(
    body: {
      gateIds: string[];
      decision: 'approved' | 'rejected' | 'conditional';
      conditions?: string[];
    },
    actor: { userId: string; primaryOrgId: string } | undefined,
  ) {
    if (!Array.isArray(body.gateIds) || body.gateIds.length === 0) {
      throw new BadRequestException('gateIds must be a non-empty array');
    }
    if (!['approved', 'rejected', 'conditional'].includes(body.decision)) {
      throw new BadRequestException('decision must be approved, rejected, or conditional');
    }
    this.assertWritable();
    const knownGates = new Set(this.getGates().map((gate) => gate.gateId));
    const missing = body.gateIds.filter((gateId) => !knownGates.has(gateId));
    if (missing.length > 0) {
      throw new NotFoundException(`Gates not found: ${missing.join(', ')}`);
    }
    const decisions = this.loadGateDecisions();
    const records: GateDecisionRecord[] = [];
    for (const gateId of body.gateIds) {
      const record: GateDecisionRecord = {
        gateId,
        decision: body.decision,
        approver: actor?.userId ?? 'anonymous',
        decidedAt: new Date().toISOString(),
        conditions: body.conditions,
      };
      const existingIndex = decisions.findIndex((entry) => entry.gateId === gateId);
      if (existingIndex >= 0) {
        const existing = decisions[existingIndex];
        if (
          existing.decision === record.decision &&
          JSON.stringify(existing.conditions ?? null) ===
            JSON.stringify(record.conditions ?? null)
        ) {
          records.push(existing);
          continue;
        }
        this.appendGateDecisionHistory(existing);
        decisions.splice(existingIndex, 1);
      }
      decisions.push(record);
      records.push(record);
    }
    const file = join(this.artifactsDir(), 'work', 'gate-decisions.json');
    mkdirSync(join(this.artifactsDir(), 'work'), { recursive: true });
    writeFileSync(file, `${JSON.stringify(decisions, null, 2)}\n`, 'utf8');
    return { recorded: records.length, records };
  }

  /**
   * 撤销某门禁的当前人工决定。若历史中存在该门禁的前一条决定则回滚恢复，
   * 否则该门禁回到无决定状态。撤销本身会作为一条 action='revoked' 的审计记录追加到历史。
   */
  revokeGateDecision(
    gateId: string,
    body: { reason?: string },
    actor: { userId: string; primaryOrgId: string } | undefined,
  ) {
    const gate = this.getGates().find((entry) => entry.gateId === gateId);
    if (!gate) {
      throw new NotFoundException(`Gate ${gateId} not found`);
    }
    this.assertWritable();
    const decisions = this.loadGateDecisions();
    const index = decisions.findIndex((entry) => entry.gateId === gateId);
    if (index < 0) {
      throw new BadRequestException(`Gate ${gateId} has no decision to revoke`);
    }
    const current = decisions[index];
    const history = this.loadGateHistory();
    const previous = [...history]
      .reverse()
      .find(
        (entry) =>
          entry.gateId === gateId &&
          (entry.action === undefined || entry.action === 'decision'),
      );
    const revokedAt = new Date().toISOString();
    const revokedBy = actor?.userId ?? 'anonymous';
    this.appendGateHistory({
      gateId,
      decision: current.decision,
      approver: current.approver,
      decidedAt: current.decidedAt,
      conditions: current.conditions,
      action: 'revoked',
      reason: body.reason,
      revokedAt,
      revokedBy,
    });
    decisions.splice(index, 1);
    if (previous) {
      decisions.push({
        gateId: previous.gateId,
        decision: previous.decision,
        approver: previous.approver,
        decidedAt: previous.decidedAt,
        conditions: previous.conditions,
      });
    }
    const file = join(this.artifactsDir(), 'work', 'gate-decisions.json');
    mkdirSync(join(this.artifactsDir(), 'work'), { recursive: true });
    writeFileSync(file, `${JSON.stringify(decisions, null, 2)}\n`, 'utf8');
    return {
      gateId,
      revoked: true,
      revokedAt,
      revokedBy,
      reason: body.reason ?? '',
      restored: previous
        ? { gateId: previous.gateId, decision: previous.decision }
        : null,
    };
  }

  /**
   * 返回某门禁在 gate-decision-history.json 中的完整历史记录（含决定/撤销，时间、actor、reason）。
   * 历史中未标注 action 的旧记录按 decision 处理。
   */
  getGateHistory(gateId: string) {
    const gate = this.getGates().find((entry) => entry.gateId === gateId);
    if (!gate) {
      throw new NotFoundException(`Gate ${gateId} not found`);
    }
    return this.loadGateHistory()
      .filter((entry) => entry.gateId === gateId)
      .map((entry) => ({ ...entry, action: entry.action ?? 'decision' }));
  }

  /**
   * 为你一个 work item 解析前置依赖（blocking/depends 边）与门禁状态，
   * 返回自然语言中文解释，说明该节点当前为什么被阻塞。
   */
  getBlockedReason(itemId: string) {
    const graph = this.getGraph();
    const item = graph.items.find((candidate) => candidate.id === itemId);
    if (!item) {
      throw new NotFoundException(`Work item ${itemId} not found`);
    }
    const gates = this.getGates();
    const byId = new Map(graph.items.map((entry) => [entry.id, entry]));
    const segments: string[] = [];
    const ownedGate = gates.find((gate) => gate.gateId === itemId);
    if (
      ownedGate &&
      (ownedGate.calculatedStatus === 'requires_approval' ||
        ownedGate.calculatedStatus === 'pending') &&
      !ownedGate.humanDecision
    ) {
      segments.push(`${itemId} 的门禁待人工批准`);
    }
    const incoming = graph.edges.filter(
      (edge) =>
        edge.to === itemId &&
        (edge.blocking === true || /depends|block/i.test(edge.edgeType)),
    );
    for (const edge of incoming) {
      const upstream = byId.get(edge.from);
      if (!upstream) continue;
      const causes: string[] = [];
      if (!/done|completed|closed|passed/i.test(upstream.status)) {
        causes.push(`${edge.from} 尚未完成`);
      }
      const upstreamGate = gates.find((gate) => gate.gateId === edge.from);
      if (
        upstreamGate &&
        (upstreamGate.calculatedStatus === 'requires_approval' ||
          upstreamGate.calculatedStatus === 'pending') &&
        !upstreamGate.humanDecision
      ) {
        causes.push(`${edge.from} 门禁待批准`);
      }
      const staleEvidence = graph.evidence.filter(
        (entry) =>
          entry.workItemId === edge.from && this.isEvidenceStale(entry),
      );
      if (staleEvidence.length > 0) {
        causes.push(`${edge.from} 的依赖 Evidence 过期`);
      }
      if (causes.length > 0) {
        segments.push(`${itemId} 被 ${edge.from} 阻塞：${causes.join('，')}`);
      }
    }
    const blocked = segments.length > 0;
    return {
      itemId,
      blocked,
      explanation: blocked ? segments.join('；') : `${itemId} 当前未受阻塞`,
    };
  }

  private currentPhase(): string {
    const file = join(this.artifactsDir(), 'phase-state.md');
    if (!existsSync(file)) return 'unknown';
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    let capture = false;
    for (const line of lines) {
      if (/^## Current Phase/i.test(line)) {
        capture = true;
        continue;
      }
      if (capture) {
        if (/^#{1,4}\s/.test(line) || !line.trim()) {
          if (/^#{1,4}\s/.test(line)) break;
          continue;
        }
        return line.trim();
      }
    }
    return 'not specified';
  }

  private loadGateDecisions(): GateDecisionRecord[] {
    const file = join(this.artifactsDir(), 'work', 'gate-decisions.json');
    if (!existsSync(file)) return [];
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as GateDecisionRecord[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private appendGateDecisionHistory(record: GateDecisionRecord): void {
    const file = join(this.artifactsDir(), 'work', 'gate-decision-history.json');
    let history: GateDecisionRecord[] = [];
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as GateDecisionRecord[];
        if (Array.isArray(parsed)) {
          history = parsed;
        }
      } catch {
        history = [];
      }
    }
    history.push(record);
    mkdirSync(join(this.artifactsDir(), 'work'), { recursive: true });
    writeFileSync(file, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
  }

  private loadGateHistory(): GateHistoryRecord[] {
    const file = join(this.artifactsDir(), 'work', 'gate-decision-history.json');
    if (!existsSync(file)) return [];
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as GateHistoryRecord[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private appendGateHistory(record: GateHistoryRecord): void {
    const history = this.loadGateHistory();
    history.push(record);
    mkdirSync(join(this.artifactsDir(), 'work'), { recursive: true });
    writeFileSync(
      join(this.artifactsDir(), 'work', 'gate-decision-history.json'),
      `${JSON.stringify(history, null, 2)}\n`,
      'utf8',
    );
  }

  private isEvidenceStale(evidence: WorkEvidence): boolean {
    if (evidence.status && /stale|expired/i.test(evidence.status)) return true;
    if (evidence.expiresAt && Number.isFinite(Date.parse(evidence.expiresAt))) {
      return Date.parse(evidence.expiresAt) <= Date.now();
    }
    return false;
  }

  private loadGitSyncRegistry(): Array<Record<string, unknown>> {
    const file = join(this.artifactsDir(), 'work', 'git-sync.json');
    if (!existsSync(file)) return [];
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Array<Record<string, unknown>>;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private loadGitSyncApply(idempotencyKey: string): { result: Record<string, unknown> } | null {
    const file = join(this.artifactsDir(), 'work', 'git-sync-apply.json');
    if (!existsSync(file)) return null;
    try {
      const parsed = JSON.parse(
        readFileSync(file, 'utf8'),
      ) as Array<{ idempotencyKey: string; result: Record<string, unknown> }>;
      if (!Array.isArray(parsed)) return null;
      return parsed.find((entry) => entry.idempotencyKey === idempotencyKey) ?? null;
    } catch {
      return null;
    }
  }

  private recordGitSyncApply(record: {
    idempotencyKey: string;
    result: Record<string, unknown>;
  }) {
    const dir = join(this.artifactsDir(), 'work');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'git-sync-apply.json');
    let records: Array<{ idempotencyKey: string; result: Record<string, unknown> }> = [];
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        if (Array.isArray(parsed)) records = parsed;
      } catch {
        records = [];
      }
    }
    records.push(record);
    writeFileSync(file, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
  }

  private loadLockFile(resourceId: string): ResourceLockRecord | null {
    const file = join(this.artifactsDir(), 'work', 'locks', `${resourceId}.json`);
    if (!existsSync(file)) return null;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as ResourceLockRecord;
      return parsed;
    } catch {
      return null;
    }
  }

  private writeLockFile(resourceId: string, record: ResourceLockRecord) {
    const dir = join(this.artifactsDir(), 'work', 'locks');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${resourceId}.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  }

  private deleteLockFile(resourceId: string) {
    const file = join(this.artifactsDir(), 'work', 'locks', `${resourceId}.json`);
    if (existsSync(file)) {
      rmSync(file, { force: true });
    }
  }

  private assertWritable() {
    if (!this.isWritable()) {
      throw new BadRequestException('EWOH_WORK_WRITABLE is not enabled');
    }
  }

  private isLockExpired(record: ResourceLockRecord): boolean {
    return (
      Boolean(record.expiresAt) &&
      Number.isFinite(Date.parse(record.expiresAt as string)) &&
      Date.parse(record.expiresAt as string) <= Date.now()
    );
  }

  private releaseExpiredLock(resourceId: string) {
    this.locks.delete(resourceId);
    this.deleteLockFile(resourceId);
  }

  private isWritable(): boolean {
    const value = process.env.EWOH_WORK_WRITABLE;
    return ['true', '1', 'yes'].includes(String(value).toLowerCase());
  }

  private artifactsDir(): string {
    const explicit = process.env.EWOH_WORK_ARTIFACTS_DIR;
    if (explicit) return resolve(explicit);
    const candidates = [
      resolve(process.cwd(), '.codex', 'artifacts'),
      resolve(process.cwd(), '..', '.codex', 'artifacts'),
      resolve(process.cwd(), '..', '..', '.codex', 'artifacts'),
    ];
    return (
      candidates.find((candidate) => existsSync(join(candidate, 'task-board.md'))) ??
      candidates[0]
    );
  }

  private repoRoot(): string {
    const fromArtifacts = resolve(this.artifactsDir(), '..');
    if (process.env.EWOH_WORK_ARTIFACTS_DIR) {
      return fromArtifacts;
    }
    if (
      existsSync(join(fromArtifacts, 'catalog')) ||
      existsSync(join(fromArtifacts, '.git'))
    ) {
      return fromArtifacts;
    }
    for (const candidate of [process.cwd(), resolve(process.cwd(), '..')]) {
      if (existsSync(join(candidate, 'catalog'))) return candidate;
    }
    return fromArtifacts;
  }

  private indexer(): WorkIndexerModule {
    if (!this.indexerModule) {
      const toolsDir = this.toolsDir();
      const requireFromTools = createRequire(join(toolsDir, 'work-indexer', 'index.js'));
      this.indexerModule = requireFromTools(
        join(toolsDir, 'work-indexer', 'index.js'),
      ) as WorkIndexerModule;
    }
    return this.indexerModule;
  }

  private gateEngine(): GateEngineModule {
    if (!this.gateEngineModule) {
      const toolsDir = this.toolsDir();
      const requireFromTools = createRequire(join(toolsDir, 'gate-engine', 'index.js'));
      this.gateEngineModule = requireFromTools(
        join(toolsDir, 'gate-engine', 'index.js'),
      ) as GateEngineModule;
    }
    return this.gateEngineModule;
  }

  private gitSync(): GitSyncModule {
    if (!this.gitSyncModule) {
      const toolsDir = this.toolsDir();
      const requireFromTools = createRequire(join(toolsDir, 'git-sync', 'index.js'));
      this.gitSyncModule = requireFromTools(
        join(toolsDir, 'git-sync', 'index.js'),
      ) as GitSyncModule;
    }
    return this.gitSyncModule;
  }

  private siteReadiness(): SiteReadinessModule {
    if (!this.siteReadinessModule) {
      const toolsDir = this.toolsDir();
      const requireFromTools = createRequire(
        join(toolsDir, 'factory-replication', 'site-readiness.js'),
      );
      this.siteReadinessModule = requireFromTools(
        join(toolsDir, 'factory-replication', 'site-readiness.js'),
      ) as SiteReadinessModule;
    }
    return this.siteReadinessModule;
  }

  private toolsDir(): string {
    const explicit = process.env.EWOH_WORK_TOOLS_DIR;
    if (explicit) return resolve(explicit);
    const candidates = [
      resolve(process.cwd(), 'tools'),
      resolve(process.cwd(), '..', 'tools'),
      resolve(process.cwd(), '..', '..', 'tools'),
    ];
    return (
      candidates.find((candidate) => existsSync(join(candidate, 'work-indexer', 'index.js'))) ??
      candidates[0]
    );
  }
}
