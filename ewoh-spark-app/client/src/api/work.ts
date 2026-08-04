import { axiosForBackend } from '../lib/http';

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

export interface WorkEdge {
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
  baseStatus?: string;
  humanDecision?: string | null;
  conditions?: string[];
  approver?: string | null;
  decidedAt?: string | null;
}

export interface WorkRisk {
  id: string;
  title: string;
  severity: string;
  likelihood?: string;
  trigger?: string;
  owner?: string;
  mitigation?: string;
  status: string;
}

export interface WorkResource {
  resourceId: string;
  name: string;
  kind: string;
  status: string;
  purpose?: string;
  lock?: {
    holder: string;
    purpose?: string;
    acquiredAt: string;
    expiresAt?: string;
  } | null;
}

export interface WorkHandoff {
  handoffId: string;
  fromActor: string;
  toActor: string;
  scope: string;
  contextPack?: string;
  openQuestions?: string[];
  acceptance?: string;
  status: string;
  createdAt: string;
}

export interface WorkCatalog {
  schemaVersion: string;
  catalogId: string;
  generatedAt: string;
  assets: Array<{
    packageId: string;
    packageType: string;
    name: string;
    version: string;
    status: string;
    sourcePath?: string;
  }>;
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
  evidence: WorkEvidence[];
  gates: WorkGate[];
  risks: WorkRisk[];
  resources: WorkResource[];
  handoffs: WorkHandoff[];
}

export interface WorkOverview {
  generatedAt: string;
  phase: string;
  criticalPath: string;
  counts: WorkGraph['summary'];
  gates: WorkGate[];
  conflicts: string[];
  writable: boolean;
}

export interface ResourceLockRecord {
  resourceId: string;
  holder: string;
  purpose?: string;
  acquiredAt: string;
  expiresAt?: string;
  active: boolean;
}

export interface GateDecisionRecord {
  gateId: string;
  decision: 'approved' | 'rejected' | 'conditional';
  approver?: string;
  decidedAt?: string;
  conditions?: string[];
}

export interface GitSyncEntry {
  workItemId: string;
  title: string;
  type: string;
  status: string;
  owner: string;
  issueNumber: number | null;
  prNumber: number | null;
  branch: string | null;
  commitSha: string | null;
  state: string;
  missing: boolean;
}

export interface GitSyncPlan {
  schema: string;
  generatedAt: string;
  repository: string;
  branch: string;
  headSha: string;
  itemCount: number;
  trackedCount: number;
  missingCount: number;
  status: string;
  source: string;
  items: GitSyncEntry[];
}

export interface EvidenceContentPreview {
  evidenceId: string;
  path: string;
  lines: number;
  truncated: boolean;
  content: string;
}

export interface SiteReadinessSummary {
  sourcePath: string;
  example: boolean;
  factoryName?: string;
  siteContact?: string;
  ready: boolean;
  requiredCount?: number;
  requiredPassed?: number;
  requiredFailed?: number;
  checks?: Array<{
    id: string;
    label: string;
    passed: boolean;
    status: string;
  }>;
  error?: string;
}

export async function getWorkOverview(): Promise<WorkOverview> {
  const res = await axiosForBackend({ url: '/api/work/overview', method: 'GET' });
  return res.data;
}

export async function getWorkGraph(): Promise<WorkGraph> {
  const res = await axiosForBackend({ url: '/api/work/graph', method: 'GET' });
  return res.data;
}

export async function listWorkItems(filters: {
  status?: string;
  type?: string;
  owner?: string;
  wave?: string;
  q?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<WorkItem[]> {
  const res = await axiosForBackend({
    url: '/api/work/items',
    method: 'GET',
    params: filters,
  });
  return res.data;
}

export async function listWorkEvidence(filters: {
  kind?: string;
  result?: string;
  q?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<WorkEvidence[]> {
  const res = await axiosForBackend({
    url: '/api/work/evidence',
    method: 'GET',
    params: filters,
  });
  return res.data;
}

export async function listWorkAgents(): Promise<WorkActor[]> {
  const res = await axiosForBackend({ url: '/api/work/agents', method: 'GET' });
  return res.data;
}

export async function listWorkGates(): Promise<WorkGate[]> {
  const res = await axiosForBackend({ url: '/api/work/gates', method: 'GET' });
  return res.data;
}

export async function listWorkRisks(): Promise<WorkRisk[]> {
  const res = await axiosForBackend({ url: '/api/work/risks', method: 'GET' });
  return res.data;
}

export async function listWorkResources(): Promise<WorkResource[]> {
  const res = await axiosForBackend({ url: '/api/work/resources', method: 'GET' });
  return res.data;
}

export async function listWorkHandoffs(): Promise<WorkHandoff[]> {
  const res = await axiosForBackend({ url: '/api/work/handoffs', method: 'GET' });
  return res.data;
}

export async function getWorkCatalog(): Promise<WorkCatalog> {
  const res = await axiosForBackend({ url: '/api/work/catalog', method: 'GET' });
  return res.data;
}

export async function getWorkGitSync(): Promise<GitSyncPlan> {
  const res = await axiosForBackend({ url: '/api/work/git-sync', method: 'GET' });
  return res.data;
}

/**
 * 将离线 Git 同步计划应用到 GitHub（服务端已做审批门禁）。
 * 调用方需先行获得审批；高风险写操作（创建/合并/关闭 PR）未经批准不得调用。
 */
export async function applyWorkGitSync(body: {
  idempotencyKey: string;
  approved: boolean;
  reason?: string;
  actor?: string;
}): Promise<{ created: Array<{ workItemId: string; issueNumber: number }> }> {
  const res = await axiosForBackend({
    url: '/api/work/git-sync/apply',
    method: 'POST',
    data: body,
  });
  return res.data;
}

export async function getWorkEvidenceContent(
  evidenceId: string,
  limit = 200,
): Promise<EvidenceContentPreview> {
  const res = await axiosForBackend({
    url: `/api/work/evidence/${encodeURIComponent(evidenceId)}/content`,
    method: 'GET',
    params: { limit },
  });
  return res.data;
}

export async function getWorkSiteReadiness(): Promise<SiteReadinessSummary[]> {
  const res = await axiosForBackend({
    url: '/api/work/site-readiness',
    method: 'GET',
  });
  return res.data;
}

export async function acquireResourceLock(
  resourceId: string,
  body: { purpose?: string; expiresAt?: string; confirm?: boolean },
): Promise<ResourceLockRecord> {
  const res = await axiosForBackend({
    url: `/api/work/resources/${encodeURIComponent(resourceId)}/lock`,
    method: 'POST',
    data: body,
  });
  return res.data;
}

export async function releaseResourceLock(
  resourceId: string,
): Promise<{ resourceId: string; released: boolean }> {
  const res = await axiosForBackend({
    url: `/api/work/resources/${encodeURIComponent(resourceId)}/release`,
    method: 'POST',
  });
  return res.data;
}

export async function createWorkHandoff(body: {
  fromActor: string;
  toActor: string;
  scope: string;
  contextPack?: string;
  openQuestions?: string[];
  acceptance?: string;
}): Promise<WorkHandoff> {
  const res = await axiosForBackend({
    url: '/api/work/handoffs',
    method: 'POST',
    data: body,
  });
  return res.data;
}

export async function updateWorkHandoffStatus(
  handoffId: string,
  body: { status: 'accepted' | 'rejected' | 'closed'; reason?: string },
): Promise<{
  handoffId: string;
  status: string;
  reason: string;
  updatedBy: string;
  updatedAt: string;
}> {
  const res = await axiosForBackend({
    url: `/api/work/handoffs/${encodeURIComponent(handoffId)}/state`,
    method: 'POST',
    data: body,
  });
  return res.data;
}

export async function recordGateDecision(
  gateId: string,
  body: { decision: 'approved' | 'rejected' | 'conditional'; conditions?: string[] },
): Promise<GateDecisionRecord> {
  const res = await axiosForBackend({
    url: `/api/work/gates/${encodeURIComponent(gateId)}/decision`,
    method: 'POST',
    data: body,
  });
  return res.data;
}

export async function recordGateDecisions(
  gateIds: string[],
  body: { decision: 'approved' | 'rejected' | 'conditional'; conditions?: string[] },
): Promise<{ recorded: number; records: GateDecisionRecord[] }> {
  const res = await axiosForBackend({
    url: '/api/work/gates/batch-decision',
    method: 'POST',
    data: { gateIds, ...body },
  });
  return res.data;
}
