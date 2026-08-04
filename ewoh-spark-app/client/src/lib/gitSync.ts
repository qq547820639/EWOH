// UX-010「GitHub 与实时协作闭环」—— 纯逻辑层（无后端依赖，可离线测试）。
//
// 说明：本项目处于「离线文件化」模式，Git 历史 / 仓库文件是权威事实源。
// 本模块只做纯函数派生（映射、dry-run 预览、冲突检测、CI 汇总、审批门禁、
// 失败补偿、幂等键、增量同步、时间线合并），不发起任何真实 GitHub 请求，
// 也不伪造真实 CI/PR 状态。真实 GitHub 数据的接入点统一收敛到
// `GitSyncProvider`（见 buildProviderData 的 providerConnected 标志），
// 待接入真实 GitHub 连接器/凭据后由调用方注入，本模块保持离线可测。

import { diffValues } from './offlineConflict';

/* ------------------------------------------------------------------ *
 * 1. WorkItem ↔ Issue/PR 可追踪映射
 * ------------------------------------------------------------------ */

export type MappingStatus = 'unlinked' | 'issue_only' | 'pr_only' | 'bidirectional';

export interface GitMappingRow {
  workItemId: string;
  title: string;
  issueNumber: number | null;
  prNumber: number | null;
  branch: string | null;
  commitSha: string | null;
  state: string;
  missing: boolean;
  /** 来自工作图的展示元数据（可选，供 UI 展示）。 */
  type?: string;
  owner?: string;
  status?: string;
  wave?: string;
  evidence?: string | null;
}

/** 由 issue/pr 编号推导双向映射状态。 */
export function buildMappingStatus(entry: {
  issueNumber: number | null | undefined;
  prNumber: number | null | undefined;
}): MappingStatus {
  const hasIssue = Number.isInteger(entry.issueNumber);
  const hasPr = Number.isInteger(entry.prNumber);
  if (hasIssue && hasPr) return 'bidirectional';
  if (hasIssue) return 'issue_only';
  if (hasPr) return 'pr_only';
  return 'unlinked';
}

/** 为映射表行补充派生字段，供 UI 渲染。 */
export function buildMappingView(
  rows: GitMappingRow[],
): Array<GitMappingRow & { mappingStatus: MappingStatus }> {
  return rows.map((row) => ({ ...row, mappingStatus: buildMappingStatus(row) }));
}

/** 生成 Issue/PR 的链接文案（`#123`），无编号返回 null。 */
export function linkLabel(number: number | null | undefined): string | null {
  return Number.isInteger(number) ? `#${number}` : null;
}

/** 汇总映射状态计数，用于头部统计。 */
export function summarizeMapping(
  rows: GitMappingRow[],
): Record<MappingStatus, number> & { tracked: number; missing: number } {
  const counts: Record<MappingStatus, number> = {
    unlinked: 0,
    issue_only: 0,
    pr_only: 0,
    bidirectional: 0,
  };
  for (const row of rows) {
    counts[buildMappingStatus(row)] += 1;
  }
  return {
    ...counts,
    tracked: counts.bidirectional + counts.issue_only + counts.pr_only,
    missing: counts.unlinked,
  };
}

/* ------------------------------------------------------------------ *
 * 2. Dry Run 与变更预览
 * ------------------------------------------------------------------ */

export interface FileChange {
  file: string;
  added: number;
  deleted: number;
}

export interface DryRunPreview {
  files: Array<FileChange & { lines: number }>;
  totalFiles: number;
  totalAdded: number;
  totalDeleted: number;
  totalLines: number;
}

/** 由文件级变更汇总出 dry-run 预览（新增/删除/行数）。 */
export function buildDryRunPreview(changes: FileChange[]): DryRunPreview {
  const files = changes.map((c) => ({ ...c, lines: c.added + c.deleted }));
  const totalAdded = files.reduce((sum, f) => sum + f.added, 0);
  const totalDeleted = files.reduce((sum, f) => sum + f.deleted, 0);
  return {
    files,
    totalFiles: files.length,
    totalAdded,
    totalDeleted,
    totalLines: totalAdded + totalDeleted,
  };
}

/* ------------------------------------------------------------------ *
 * 3. 冲突检测（本地值 / 服务端值 / 差异）
 * ------------------------------------------------------------------ */

export interface ConflictReport {
  workItemId: string;
  field: string;
  local: unknown;
  server: unknown;
  recommended: 'local' | 'server';
}

export interface ConflictInput {
  workItemId: string;
  local: unknown;
  server: unknown;
}

/**
 * 对每条 WorkItem 的本地态与服务端态做差异，输出字段级冲突。
 * 复用 offlineConflict.diffValues 保证「本地值/服务端值/差异」语义一致。
 */
export function detectConflicts(inputs: ConflictInput[]): ConflictReport[] {
  const reports: ConflictReport[] = [];
  for (const input of inputs) {
    const diffs = diffValues(input.local, input.server);
    for (const diff of diffs) {
      reports.push({
        workItemId: input.workItemId,
        field: diff.path || '(root)',
        local: diff.local,
        server: diff.server,
        recommended: diff.server === null || diff.server === undefined ? 'local' : 'server',
      });
    }
  }
  return reports;
}

/* ------------------------------------------------------------------ *
 * 4. CI 状态回写
 * ------------------------------------------------------------------ */

export type CiStatus = 'pending' | 'success' | 'failed' | 'unknown';

export interface CiCheck {
  ref: string;
  kind: 'commit' | 'pr';
  status: CiStatus;
  name?: string;
  url?: string;
  updatedAt?: string;
}

export interface CiSummary {
  pending: number;
  success: number;
  failed: number;
  unknown: number;
  total: number;
  status: CiStatus;
}

/** 汇总一批 CI 检查，推导整体状态（任一 failed=>failed，否则 pending 优先）。 */
export function summarizeCi(checks: CiCheck[]): CiSummary {
  const counts: Pick<CiSummary, 'pending' | 'success' | 'failed' | 'unknown'> = {
    pending: 0,
    success: 0,
    failed: 0,
    unknown: 0,
  };
  for (const check of checks) {
    counts[check.status] = (counts[check.status] ?? 0) + 1;
  }
  const total = checks.length;
  let status: CiStatus = 'unknown';
  if (total > 0) {
    if (counts.failed > 0) status = 'failed';
    else if (counts.pending > 0) status = 'pending';
    else if (counts.success === total) status = 'success';
  }
  return { ...counts, total, status };
}

/* ------------------------------------------------------------------ *
 * 5. 审批后执行（高风险写操作必须经审批）
 * ------------------------------------------------------------------ */

export type WriteOperation = 'create_issue' | 'create_pr' | 'merge_pr' | 'close_pr';

export const ALL_WRITE_OPERATIONS: WriteOperation[] = [
  'create_issue',
  'create_pr',
  'merge_pr',
  'close_pr',
];

/** 高风险写操作：创建/合并/关闭 PR，未经批准不得执行。 */
export const HIGH_RISK_OPERATIONS: WriteOperation[] = ['create_pr', 'merge_pr', 'close_pr'];

export interface ApprovalPacket {
  operation: WriteOperation;
  workItemId: string;
  reason: string;
  actor: string;
  timestamp: string;
  rollbackPoint: string;
  approved: boolean;
}

export function isHighRisk(operation: WriteOperation): boolean {
  return HIGH_RISK_OPERATIONS.includes(operation);
}

/** 构建审批包：reason / actor / timestamp / rollback point，默认未批准。 */
export function buildApprovalPacket(opts: {
  operation: WriteOperation;
  workItemId: string;
  reason: string;
  actor: string;
  rollbackPoint: string;
}): ApprovalPacket {
  return {
    ...opts,
    timestamp: new Date().toISOString(),
    approved: false,
  };
}

/** 是否允许执行：高风险操作必须已批准，否则禁止。 */
export function canExecute(operation: WriteOperation, packet: ApprovalPacket): boolean {
  return isHighRisk(operation) ? packet.approved : true;
}

/* ------------------------------------------------------------------ *
 * 6. 失败补偿
 * ------------------------------------------------------------------ */

export interface FailureRecord {
  operation: WriteOperation;
  workItemId: string;
  reason: string;
  retryable: boolean;
  idempotencyKey: string;
  retryCount: number;
  attemptedAt: string;
}

const TRANSIENT_MARKERS = /timeout|network|超时|网络|conflict|冲突|retry|temporary|临时/i;

/** 判别失败是否可重试（网络/超时/临时冲突等可重试，校验/权限类不可）。 */
export function isRetryableFailure(reason: string): boolean {
  return TRANSIENT_MARKERS.test(reason);
}

export function buildFailureRecord(opts: {
  operation: WriteOperation;
  workItemId: string;
  reason: string;
  idempotencyKey: string;
  retryCount?: number;
}): FailureRecord {
  return {
    operation: opts.operation,
    workItemId: opts.workItemId,
    reason: opts.reason,
    retryable: isRetryableFailure(opts.reason),
    idempotencyKey: opts.idempotencyKey,
    retryCount: opts.retryCount ?? 0,
    attemptedAt: new Date().toISOString(),
  };
}

/** 为一次失败给出可重试动作建议。 */
export function suggestRetry(failure: FailureRecord): { retryable: boolean; message: string } {
  if (!failure.retryable) {
    return { retryable: false, message: '非可重试错误，请检查后重试或联系管理员' };
  }
  if (failure.retryCount >= 3) {
    return { retryable: false, message: '已达最大重试次数，请人工介入' };
  }
  return { retryable: true, message: '可重试，将复用同一幂等键避免重复提交' };
}

/* ------------------------------------------------------------------ *
 * 7. 重复事件幂等（写操作幂等键）
 * ------------------------------------------------------------------ */

/** FNV-1a 32 位哈希，确定性生成幂等键（无密码学诉求，纯函数可测）。 */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** 为写操作生成幂等键：同一操作+同一目标+同一 ref 必然得到相同键。 */
export function createIdempotencyKey(
  operation: string,
  workItemId: string,
  ref: string,
): string {
  return fnv1a(`${operation}:${workItemId}:${ref}`);
}

/* ------------------------------------------------------------------ *
 * 8. Webhook / 轮询增量同步
 * ------------------------------------------------------------------ */

export interface SyncStamp {
  workItemId: string;
  updatedAt: string;
}

export interface IncrementalSyncResult {
  added: string[];
  removed: string[];
  changed: string[];
  nextCursor: string;
}

/** 对比相邻两次快照，输出新增/删除/变更集合与下一次游标。 */
export function computeIncrementalSync(
  prev: SyncStamp[],
  next: SyncStamp[],
): IncrementalSyncResult {
  const prevMap = new Map(prev.map((p) => [p.workItemId, p.updatedAt]));
  const nextMap = new Map(next.map((n) => [n.workItemId, n.updatedAt]));
  const added: string[] = [];
  const changed: string[] = [];
  for (const [id, updatedAt] of nextMap) {
    if (!prevMap.has(id)) added.push(id);
    else if (prevMap.get(id) !== updatedAt) changed.push(id);
  }
  const removed = [...prevMap.keys()].filter((id) => !nextMap.has(id));
  let maxTs = 0;
  for (const updatedAt of nextMap.values()) {
    const ts = Date.parse(updatedAt);
    if (Number.isFinite(ts) && ts > maxTs) maxTs = ts;
  }
  return {
    added,
    removed,
    changed,
    nextCursor: maxTs === 0 ? '' : new Date(maxTs).toISOString(),
  };
}

/* ------------------------------------------------------------------ *
 * 9. Agent / PR / 测试 / Evidence / Gate 统一时间线
 * ------------------------------------------------------------------ */

export type TimelineKind =
  | 'agent'
  | 'pr'
  | 'test'
  | 'evidence'
  | 'gate'
  | 'ci'
  | 'sync'
  | 'approval';

export interface TimelineEvent {
  id: string;
  kind: TimelineKind;
  at: string;
  summary: string;
  workItemId?: string;
  status?: string;
}

/** 将各类事件合并为一条时间线（按时间倒序）。 */
export function mergeTimeline(events: TimelineEvent[]): TimelineEvent[] {
  return [...events].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export interface TimelineSource {
  evidence?: Array<{
    id?: string;
    workItemId?: string;
    kind?: string;
    result?: string;
    testTime?: string;
    status?: string;
  }>;
  gates?: Array<{
    gateId?: string;
    workItemId?: string;
    title?: string;
    calculatedStatus?: string;
    decidedAt?: string | null;
    approver?: string | null;
  }>;
  agents?: Array<{ actorId?: string; name?: string; status?: string; at?: string }>;
  pulls?: Array<{ prNumber?: number; workItemId?: string; state?: string; at?: string }>;
  tests?: Array<{ id?: string; workItemId?: string; name?: string; result?: string; at?: string }>;
}

/**
 * 从工作图（Evidence/Gate/Agent/PR/Test）与附加事件构建统一时间线。
 * 仅收录带时间戳的事件，避免伪造时序。
 */
export function buildTimelineFromSources(
  sources: TimelineSource,
  extra: TimelineEvent[] = [],
): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (const ev of sources.evidence ?? []) {
    if (ev.testTime) {
      events.push({
        id: `evidence:${ev.id ?? ev.workItemId ?? 'unknown'}`,
        kind: 'evidence',
        at: ev.testTime,
        summary: `证据 ${ev.kind ?? 'evidence'} 结果 ${ev.result ?? 'unknown'}`,
        workItemId: ev.workItemId,
        status: ev.status,
      });
    }
  }
  for (const gate of sources.gates ?? []) {
    if (gate.decidedAt) {
      events.push({
        id: `gate:${gate.gateId}`,
        kind: 'gate',
        at: gate.decidedAt,
        summary: `门禁 ${gate.title ?? gate.gateId} ${gate.calculatedStatus ?? ''}`,
        workItemId: gate.workItemId,
        status: gate.calculatedStatus,
      });
    }
  }
  for (const agent of sources.agents ?? []) {
    if (agent.at) {
      events.push({
        id: `agent:${agent.actorId}`,
        kind: 'agent',
        at: agent.at,
        summary: `智能体 ${agent.name ?? agent.actorId} ${agent.status ?? ''}`,
        status: agent.status,
      });
    }
  }
  for (const pull of sources.pulls ?? []) {
    if (pull.at) {
      events.push({
        id: `pr:${pull.prNumber}`,
        kind: 'pr',
        at: pull.at,
        summary: `PR #${pull.prNumber} ${pull.state ?? ''}`,
        workItemId: pull.workItemId,
        status: pull.state,
      });
    }
  }
  for (const test of sources.tests ?? []) {
    if (test.at) {
      events.push({
        id: `test:${test.id ?? test.name ?? test.workItemId ?? 'unknown'}`,
        kind: 'test',
        at: test.at,
        summary: `测试 ${test.name ?? test.id ?? ''} ${test.result ?? ''}`,
        workItemId: test.workItemId,
        status: test.result,
      });
    }
  }
  return mergeTimeline([...events, ...extra]);
}

/* ------------------------------------------------------------------ *
 * 10. 组合视图（供面板一次派生，所有派生均为纯函数）
 * ------------------------------------------------------------------ */

export interface GitSyncProviderData {
  mapping: ReturnType<typeof buildMappingView>;
  mappingSummary: ReturnType<typeof summarizeMapping>;
  dryRun: DryRunPreview;
  conflicts: ConflictReport[];
  ci: CiSummary;
  timeline: TimelineEvent[];
  /** 是否已接入真实 GitHub 连接器/凭据（离线模式下为 false）。 */
  providerConnected: boolean;
}

/**
 * 由计划数据 + 工作图源 + 可选真实状态聚合出面板所需的全部派生视图。
 * 离线模式下 providerConnected=false，CI/冲突等以占位展示，等待真实连接器注入。
 */
export function buildProviderData(opts: {
  rows: GitMappingRow[];
  changes?: FileChange[];
  conflicts?: ConflictInput[];
  ciChecks?: CiCheck[];
  timelineSources?: TimelineSource;
  timelineExtra?: TimelineEvent[];
  providerConnected?: boolean;
}): GitSyncProviderData {
  const mapping = buildMappingView(opts.rows);
  return {
    mapping,
    mappingSummary: summarizeMapping(opts.rows),
    dryRun: buildDryRunPreview(opts.changes ?? []),
    conflicts: detectConflicts(opts.conflicts ?? []),
    ci: summarizeCi(opts.ciChecks ?? []),
    timeline: buildTimelineFromSources(opts.timelineSources ?? {}, opts.timelineExtra ?? []),
    providerConnected: opts.providerConnected ?? false,
  };
}