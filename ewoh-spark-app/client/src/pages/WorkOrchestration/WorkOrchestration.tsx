import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { TransformComponent, TransformWrapper } from 'react-zoom-pan-pinch';
import {
  AlertTriangle,
  ArrowRightLeft,
  CheckCircle2,
  ClipboardCheck,
  Database,
  GitBranch,
  GitPullRequest,
  ListChecks,
  Lock,
  PackageSearch,
  ShieldAlert,
  Unlock,
  Users,
} from 'lucide-react';
import QueryState from '../../components/QueryState';
import { queryKeys } from '../../hooks/queryKeys';
import { ADMIN_REFETCH_INTERVAL_MS, QUERY_STALE_TIME_MS } from '../../hooks/queryConfig';
import {
  acquireResourceLock,
  createWorkHandoff,
  getWorkCatalog,
  getWorkEvidenceContent,
  getWorkGitSync,
  getWorkGraph,
  getWorkOverview,
  getWorkSiteReadiness,
  listWorkAgents,
  listWorkEvidence,
  listWorkGates,
  listWorkHandoffs,
  listWorkResources,
  listWorkRisks,
  recordGateDecision,
  recordGateDecisions,
  releaseResourceLock,
  updateWorkHandoffStatus,
  type EvidenceContentPreview,
  type SiteReadinessSummary,
  type WorkEvidence,
  type WorkGraph,
  type WorkOverview,
} from '../../api/work';
import {
  buildGraphLayout,
  filterGraphItems,
  statusTone,
  type WorkGraphScope,
} from './graphLayout';

type TabKey =
  | 'dag'
  | 'gates'
  | 'evidence'
  | 'agents'
  | 'risks'
  | 'resources'
  | 'handoffs'
  | 'catalog'
  | 'git-sync'
  | 'site-readiness';

const TABS: Array<{ key: TabKey; label: string; icon: typeof GitBranch }> = [
  { key: 'dag', label: '因果图', icon: GitBranch },
  { key: 'gates', label: '门禁', icon: ListChecks },
  { key: 'evidence', label: '证据', icon: CheckCircle2 },
  { key: 'agents', label: 'Agent', icon: Users },
  { key: 'risks', label: '风险', icon: ShieldAlert },
  { key: 'resources', label: '资源', icon: Database },
  { key: 'handoffs', label: '交接', icon: ArrowRightLeft },
  { key: 'catalog', label: '资产目录', icon: PackageSearch },
  { key: 'git-sync', label: 'Git 同步', icon: GitPullRequest },
  { key: 'site-readiness', label: '场地就绪', icon: ClipboardCheck },
];

const toneClasses: Record<string, string> = {
  emerald: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  red: 'border-red-200 bg-red-50 text-red-800',
  blue: 'border-blue-200 bg-blue-50 text-blue-800',
  amber: 'border-amber-200 bg-amber-50 text-amber-800',
  slate: 'border-slate-200 bg-slate-50 text-slate-700',
};

const formatTime = (value?: string | null): string =>
  value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';

const formatLockRemaining = (value?: string | null): string => {
  if (!value) return '';
  const ms = Date.parse(value) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return '已过期';
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}分${seconds}秒`;
};

const WorkOrchestration = (): React.ReactElement => {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<TabKey>('dag');
  const [scope, setScope] = useState<WorkGraphScope>('waves-gates');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [resourceId, setResourceId] = useState('');
  const [lockPurpose, setLockPurpose] = useState('');
  const [confirmLock, setConfirmLock] = useState(false);
  const [handoffFrom, setHandoffFrom] = useState('AG-00');
  const [handoffTo, setHandoffTo] = useState('');
  const [handoffScope, setHandoffScope] = useState('');
  const [handoffAcceptance, setHandoffAcceptance] = useState('');
  const [decisionMap, setDecisionMap] = useState<Record<string, string>>({});
  const [batchDecision, setBatchDecision] = useState<'approved' | 'rejected' | 'conditional'>('approved');
  const [nodeQuery, setNodeQuery] = useState('');
  const [gateStatusFilter, setGateStatusFilter] = useState('');
  const [evidenceKindFilter, setEvidenceKindFilter] = useState('');
  const [evidenceResultFilter, setEvidenceResultFilter] = useState('');

  const overviewQuery = useQuery<WorkOverview>({
    queryKey: queryKeys.workOverview,
    queryFn: getWorkOverview,
    refetchInterval: ADMIN_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });
  const graphQuery = useQuery<WorkGraph>({
    queryKey: queryKeys.workGraph,
    queryFn: getWorkGraph,
    refetchInterval: ADMIN_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });
  const gatesQuery = useQuery({
    queryKey: queryKeys.workGates,
    queryFn: listWorkGates,
    refetchInterval: ADMIN_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });
  const evidenceQuery = useQuery({
    queryKey: queryKeys.workEvidence(),
    queryFn: () => listWorkEvidence(),
    refetchInterval: ADMIN_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });
  const agentsQuery = useQuery({
    queryKey: queryKeys.workAgents,
    queryFn: listWorkAgents,
    refetchInterval: ADMIN_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });
  const risksQuery = useQuery({
    queryKey: queryKeys.workRisks,
    queryFn: listWorkRisks,
    refetchInterval: ADMIN_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });
  const resourcesQuery = useQuery({
    queryKey: queryKeys.workResources,
    queryFn: listWorkResources,
    refetchInterval: ADMIN_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });
  const handoffsQuery = useQuery({
    queryKey: queryKeys.workHandoffs,
    queryFn: listWorkHandoffs,
    refetchInterval: ADMIN_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });
  const catalogQuery = useQuery({
    queryKey: queryKeys.workCatalog,
    queryFn: getWorkCatalog,
    staleTime: QUERY_STALE_TIME_MS,
  });
  const gitSyncQuery = useQuery({
    queryKey: queryKeys.workGitSync,
    queryFn: getWorkGitSync,
    staleTime: QUERY_STALE_TIME_MS,
  });
  const siteReadinessQuery = useQuery<SiteReadinessSummary[]>({
    queryKey: queryKeys.workSiteReadiness,
    queryFn: getWorkSiteReadiness,
    staleTime: QUERY_STALE_TIME_MS,
  });

  const lockMutation = useMutation({
    mutationFn: (id: string) =>
      acquireResourceLock(id, {
        purpose: lockPurpose.trim() || undefined,
        confirm: confirmLock,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workResources });
      setResourceId('');
      setLockPurpose('');
      setConfirmLock(false);
    },
  });
  const releaseMutation = useMutation({
    mutationFn: releaseResourceLock,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workResources });
    },
  });
  const handoffMutation = useMutation({
    mutationFn: () =>
      createWorkHandoff({
        fromActor: handoffFrom.trim(),
        toActor: handoffTo.trim(),
        scope: handoffScope.trim(),
        acceptance: handoffAcceptance.trim() || undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workHandoffs });
      setHandoffTo('');
      setHandoffScope('');
      setHandoffAcceptance('');
    },
  });
  const handoffStateMutation = useMutation({
    mutationFn: ({
      handoffId,
      status,
    }: {
      handoffId: string;
      status: 'accepted' | 'rejected' | 'closed';
    }) => updateWorkHandoffStatus(handoffId, { status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workHandoffs });
    },
  });
  const gateDecisionMutation = useMutation({
    mutationFn: (gateId: string) =>
      recordGateDecision(gateId, {
        decision: (decisionMap[gateId] ?? 'approved') as
          | 'approved'
          | 'rejected'
          | 'conditional',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workGates });
      queryClient.invalidateQueries({ queryKey: queryKeys.workOverview });
    },
  });
  const batchDecisionMutation = useMutation({
    mutationFn: (gateIds: string[]) =>
      recordGateDecisions(gateIds, {
        decision: batchDecision,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workGates });
      queryClient.invalidateQueries({ queryKey: queryKeys.workOverview });
    },
  });

  const graph = graphQuery.data;
  const visibleGraphItems = useMemo(() => {
    return filterGraphItems(graph?.items ?? [], nodeQuery);
  }, [graph, nodeQuery]);
  const layout = useMemo(
    () =>
      buildGraphLayout(
        visibleGraphItems,
        graph?.edges ?? [],
        nodeQuery.trim() ? 'all' : scope,
      ),
    [visibleGraphItems, graph?.edges, scope, nodeQuery],
  );
  const selectedNode = useMemo(
    () => layout.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [layout.nodes, selectedNodeId],
  );
  const selectedEvidence = useMemo(() => {
    const evidence = evidenceQuery.data ?? [];
    if (!selectedNode) return [];
    return evidence.filter((entry) => entry.workItemId === selectedNode.id);
  }, [evidenceQuery.data, selectedNode]);
  const overview = overviewQuery.data;
  const writable = overview?.writable ?? false;
  const filteredGates = useMemo(
    () =>
      (gatesQuery.data ?? []).filter(
        (gate) =>
          !gateStatusFilter || gate.calculatedStatus === gateStatusFilter,
      ),
    [gatesQuery.data, gateStatusFilter],
  );

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[hsl(220_14%_14%)]">执行控制台</h1>
          <p className="mt-1 text-sm text-[hsl(218_10%_42%)]">
            {overview?.phase ?? '读取中'} · 关键路径：{overview?.criticalPath ?? '—'}
          </p>
        </div>
        <div
          className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium ${
            writable
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : 'border-amber-200 bg-amber-50 text-amber-800'
          }`}
        >
          <Database className="h-4 w-4" />
          {writable ? '写回已启用' : '只读模式'}
        </div>
      </header>

      {overview && overview.conflicts.length > 0 && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {overview.conflicts.map((conflict) => (
            <div key={conflict} className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {conflict}
            </div>
          ))}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <SummaryTile
          label="任务节点"
          value={overview?.counts.itemCount ?? 0}
          icon={GitBranch}
          tone="blue"
        />
        <SummaryTile
          label="门禁"
          value={overview?.counts.gateCount ?? 0}
          icon={ListChecks}
          tone="emerald"
        />
        <SummaryTile
          label="证据"
          value={overview?.counts.evidenceCount ?? 0}
          icon={CheckCircle2}
          tone="violet"
        />
        <SummaryTile
          label="Agent"
          value={overview?.counts.actorCount ?? 0}
          icon={Users}
          tone="sky"
        />
        <SummaryTile
          label="风险"
          value={overview?.counts.riskCount ?? 0}
          icon={ShieldAlert}
          tone="amber"
        />
        <SummaryTile
          label="冲突"
          value={overview?.counts.conflicts.length ?? 0}
          icon={AlertTriangle}
          tone="red"
        />
      </div>

      <div className="flex flex-wrap items-center gap-1 border-b border-[hsl(220_14%_89%)] bg-white px-2 pt-2">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={`inline-flex h-10 items-center gap-2 rounded-t-lg border-x border-t px-4 text-sm font-medium ${
                activeTab === tab.key
                  ? 'border-[hsl(220_14%_89%)] bg-white text-[hsl(221_83%_53%)]'
                  : 'border-transparent text-[hsl(218_10%_42%)] hover:bg-[hsl(220_14%_96%)]'
              }`}
            >
              <Icon className="h-4 w-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      <QueryState
        isLoading={graphQuery.isLoading || overviewQuery.isLoading}
        isFetching={graphQuery.isFetching}
        isError={graphQuery.isError || overviewQuery.isError}
        isStale={graphQuery.isStale}
        isEmpty={!graph}
        onRefresh={() => {
          graphQuery.refetch();
          overviewQuery.refetch();
        }}
        errorMessage={
          graphQuery.error instanceof Error
            ? graphQuery.error.message
            : '执行控制台数据加载失败'
        }
        loadingMessage="正在索引权威制品"
        updatedAt={Math.max(graphQuery.dataUpdatedAt, overviewQuery.dataUpdatedAt)}
      >
        {activeTab === 'dag' && (
          <div className="rounded-lg border border-[hsl(220_14%_89%)] bg-white">
            <div className="flex flex-wrap items-center gap-3 border-b border-[hsl(220_14%_89%)] px-4 py-3">
              <GitBranch className="h-4 w-4 text-blue-600" />
              <h2 className="font-semibold text-[hsl(220_14%_14%)]">交付因果图</h2>
              <div className="ml-auto flex items-center gap-2">
                <input
                  value={nodeQuery}
                  onChange={(event) => setNodeQuery(event.target.value)}
                  placeholder="搜索任务/Agent/状态"
                  aria-label="搜索因果图节点"
                  className="h-9 w-56 rounded-lg border border-[hsl(220_14%_89%)] px-3 text-sm outline-none focus:border-blue-500"
                />
                {(['all', 'waves-gates', 'waves', 'gates'] as WorkGraphScope[]).map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setScope(value)}
                    className={`rounded-md px-3 py-1.5 text-xs font-medium ${
                      scope === value
                        ? 'bg-blue-600 text-white'
                        : 'bg-[hsl(220_14%_96%)] text-[hsl(218_10%_42%)]'
                    }`}
                  >
                    {value === 'all'
                      ? '全部'
                      : value === 'waves-gates'
                        ? '波次+门禁'
                        : value === 'waves'
                          ? '波次'
                          : '门禁'}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid lg:grid-cols-[260px_1fr]">
              <div className="max-h-[560px] overflow-y-auto border-r border-[hsl(220_14%_89%)] p-3">
                {layout.nodes.length === 0 ? (
                  <p className="p-3 text-sm text-[hsl(218_10%_42%)]">当前范围没有节点。</p>
                ) : (
                  <div className="space-y-1.5">
                    {layout.nodes.map((node) => (
                      <button
                        key={node.id}
                        type="button"
                        onClick={() => setSelectedNodeId(node.id)}
                        className={`w-full rounded-lg border px-3 py-2 text-left text-sm ${
                          selectedNodeId === node.id
                            ? 'border-blue-300 bg-blue-50'
                            : 'border-[hsl(220_14%_89%)] bg-white hover:bg-[hsl(220_14%_96%)]'
                        }`}
                      >
                        <span className="block font-medium text-[hsl(220_14%_14%)]">
                          {node.id}
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-[hsl(218_10%_42%)]">
                          {node.title}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="h-[560px] p-2">
                <TransformWrapper
                  initialScale={0.85}
                  minScale={0.35}
                  maxScale={2.5}
                  centerOnInit
                  wheel={{ step: 0.08 }}
                >
                  <TransformComponent
                    wrapperStyle={{ width: '100%', height: '100%' }}
                  >
                <svg
                  width={layout.width}
                  height={layout.height}
                  viewBox={`0 0 ${layout.width} ${layout.height}`}
                  role="img"
                  aria-label="EWOH work dependency graph"
                  className="min-w-full"
                >
                  <defs>
                    <marker
                      id="arrowhead"
                      markerWidth="8"
                      markerHeight="6"
                      refX="8"
                      refY="3"
                      orient="auto"
                    >
                      <path d="M0,0 L8,3 L0,6 Z" fill="#94a3b8" />
                    </marker>
                  </defs>
                  {layout.edges.map((edge) => {
                    const from = layout.nodes.find((node) => node.id === edge.from);
                    const to = layout.nodes.find((node) => node.id === edge.to);
                    if (!from || !to) return null;
                    const x1 = from.x + from.width;
                    const y1 = from.y + from.height / 2;
                    const x2 = to.x;
                    const y2 = to.y + to.height / 2;
                    const midX = (x1 + x2) / 2;
                    return (
                      <path
                        key={edge.id}
                        d={`M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`}
                        fill="none"
                        stroke={edge.blocking ? '#64748b' : '#94a3b8'}
                        strokeWidth="1.5"
                        markerEnd="url(#arrowhead)"
                      />
                    );
                  })}
                  {layout.nodes.map((node) => {
                    const tone = statusTone(node.status);
                    return (
                      <g key={node.id} onClick={() => setSelectedNodeId(node.id)}>
                        <rect
                          x={node.x}
                          y={node.y}
                          width={node.width}
                          height={node.height}
                          rx={6}
                          className="cursor-pointer"
                          fill="#ffffff"
                          stroke={selectedNodeId === node.id ? '#2563eb' : '#cbd5e1'}
                          strokeWidth={selectedNodeId === node.id ? 2 : 1}
                        />
                        <text x={node.x + 12} y={node.y + 22} fontSize="12" fontWeight="700" fill="#1e293b">
                          {node.id}
                        </text>
                        <text x={node.x + 12} y={node.y + 40} fontSize="11" fill="#475569">
                          {truncate(node.title, 28)}
                        </text>
                        <text x={node.x + 12} y={node.y + 58} fontSize="10" fill="#64748b">
                          {node.type} · {node.owner}
                        </text>
                        <rect
                          x={node.x + node.width - 62}
                          y={node.y + 10}
                          width={50}
                          height={18}
                          rx={4}
                          className={toneClasses[tone]}
                        />
                        <text
                          x={node.x + node.width - 37}
                          y={node.y + 23}
                          fontSize="9"
                          textAnchor="middle"
                          fill="currentColor"
                        >
                          {truncate(node.status, 7)}
                        </text>
                      </g>
                    );
                  })}
                </svg>
                  </TransformComponent>
                </TransformWrapper>
              </div>
            </div>
            {selectedNode && (
              <div className="border-t border-[hsl(220_14%_89%)] px-4 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-semibold text-[hsl(220_14%_14%)]">
                    {selectedNode.id} · {selectedNode.title}
                  </h3>
                  <span
                    className={`rounded-md border px-2 py-1 text-xs font-medium ${toneClasses[statusTone(selectedNode.status)]}`}
                  >
                    {selectedNode.status}
                  </span>
                  <span className="text-xs text-[hsl(218_10%_42%)]">
                    Owner {selectedNode.owner}
                  </span>
                </div>
                {selectedEvidence.length > 0 ? (
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    {selectedEvidence.map((entry) => (
                      <EvidenceRow key={entry.evidenceId} entry={entry} />
                    ))}
                  </div>
                ) : (
                  <p className="mt-3 text-sm text-[hsl(218_10%_42%)]">
                    当前节点暂无已关联证据记录。
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {activeTab === 'gates' && (
          <section className="rounded-lg border border-[hsl(220_14%_89%)] bg-white">
            <div className="flex items-center gap-2 border-b border-[hsl(220_14%_89%)] px-5 py-4">
              <ListChecks className="h-4 w-4 text-emerald-600" />
              <h2 className="font-semibold text-[hsl(220_14%_14%)]">门禁计算</h2>
              <span className="ml-auto text-xs text-[hsl(218_10%_42%)]">
                {gatesQuery.data?.length ?? 0} 个门禁
              </span>
              <select
                value={gateStatusFilter}
                onChange={(event) => setGateStatusFilter(event.target.value)}
                aria-label="按门禁规则状态筛选"
                className="h-9 rounded-lg border border-[hsl(220_14%_89%)] px-2 text-xs outline-none focus:border-blue-500"
              >
                <option value="">全部状态</option>
                <option value="passed">passed</option>
                <option value="in_progress">in_progress</option>
                <option value="requires_approval">requires_approval</option>
                <option value="pending">pending</option>
                <option value="approved">approved</option>
              </select>
              {writable && (
                <>
                  <select
                    value={batchDecision}
                    onChange={(event) =>
                      setBatchDecision(
                        event.target.value as
                          | 'approved'
                          | 'rejected'
                          | 'conditional',
                      )
                    }
                    aria-label="批量门禁决定"
                    className="h-9 rounded-lg border border-[hsl(220_14%_89%)] px-2 text-xs outline-none focus:border-blue-500"
                  >
                    <option value="approved">批准</option>
                    <option value="rejected">驳回</option>
                    <option value="conditional">条件批准</option>
                  </select>
                  <button
                    type="button"
                    disabled={
                      filteredGates.length === 0 ||
                      batchDecisionMutation.isPending
                    }
                    onClick={() =>
                      batchDecisionMutation.mutate(
                        filteredGates.map((gate) => gate.gateId),
                      )
                    }
                    className="inline-flex h-9 items-center gap-2 rounded-lg bg-emerald-600 px-4 text-sm font-medium text-white disabled:opacity-40"
                  >
                    批量记录 {filteredGates.length}
                  </button>
                </>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-left text-sm">
                <thead className="border-b border-[hsl(220_14%_89%)] text-xs text-[hsl(218_10%_42%)]">
                  <tr>
                    <th className="px-5 py-3 font-medium">门禁</th>
                    <th className="px-5 py-3 font-medium">规则状态</th>
                    <th className="px-5 py-3 font-medium">人工决定</th>
                    <th className="px-5 py-3 font-medium">条件</th>
                    <th className="px-5 py-3 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[hsl(220_14%_89%)]">
                  {filteredGates.map((gate) => (
                    <tr key={gate.gateId} className="hover:bg-[hsl(220_14%_96%)]">
                      <td className="px-5 py-3">
                        <div className="font-medium text-[hsl(220_14%_14%)]">
                          {gate.gateId}
                        </div>
                        <div className="text-xs text-[hsl(218_10%_42%)]">
                          {gate.title}
                        </div>
                      </td>
                      <td className="px-5 py-3">
                        <StatusBadge status={gate.calculatedStatus} />
                      </td>
                      <td className="px-5 py-3">
                        {gate.humanDecision ? (
                          <StatusBadge status={gate.humanDecision} />
                        ) : (
                          <span className="text-xs text-[hsl(218_10%_42%)]">未决定</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-xs text-[hsl(218_10%_42%)]">
                        {gate.conditions?.slice(0, 3).join('；') || '—'}
                      </td>
                      <td className="px-5 py-3">
                        {writable && (
                          <div className="flex items-center gap-2">
                            <select
                              value={decisionMap[gate.gateId] ?? 'approved'}
                              onChange={(event) =>
                                setDecisionMap((current) => ({
                                  ...current,
                                  [gate.gateId]: event.target.value,
                                }))
                              }
                              className="h-9 rounded-lg border border-[hsl(220_14%_89%)] px-2 text-xs outline-none focus:border-blue-500"
                            >
                              <option value="approved">批准</option>
                              <option value="rejected">驳回</option>
                              <option value="conditional">条件批准</option>
                            </select>
                            <button
                              type="button"
                              disabled={gateDecisionMutation.isPending}
                              onClick={() => gateDecisionMutation.mutate(gate.gateId)}
                              className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
                            >
                              记录
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {activeTab === 'evidence' && (
          <EvidencePanel
            evidence={evidenceQuery.data ?? []}
            kind={evidenceKindFilter}
            result={evidenceResultFilter}
            onKindChange={setEvidenceKindFilter}
            onResultChange={setEvidenceResultFilter}
          />
        )}

        {activeTab === 'agents' && (
          <section className="rounded-lg border border-[hsl(220_14%_89%)] bg-white">
            <div className="flex items-center gap-2 border-b border-[hsl(220_14%_89%)] px-5 py-4">
              <Users className="h-4 w-4 text-sky-600" />
              <h2 className="font-semibold text-[hsl(220_14%_14%)]">Agent 登记册</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-left text-sm">
                <thead className="border-b border-[hsl(220_14%_89%)] text-xs text-[hsl(218_10%_42%)]">
                  <tr>
                    <th className="px-5 py-3 font-medium">ID</th>
                    <th className="px-5 py-3 font-medium">角色</th>
                    <th className="px-5 py-3 font-medium">类型</th>
                    <th className="px-5 py-3 font-medium">所有权</th>
                    <th className="px-5 py-3 font-medium">状态</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[hsl(220_14%_89%)]">
                  {(agentsQuery.data ?? []).map((agent) => (
                    <tr key={agent.actorId} className="hover:bg-[hsl(220_14%_96%)]">
                      <td className="px-5 py-3 font-mono text-xs">{agent.actorId}</td>
                      <td className="px-5 py-3 font-medium">{agent.role}</td>
                      <td className="px-5 py-3 text-xs text-[hsl(218_10%_42%)]">
                        {agent.kind}
                      </td>
                      <td className="px-5 py-3 font-mono text-xs">
                        {agent.ownership ?? '—'}
                      </td>
                      <td className="px-5 py-3">
                        <StatusBadge status={agent.status ?? 'registered'} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {activeTab === 'risks' && (
          <section className="rounded-lg border border-[hsl(220_14%_89%)] bg-white">
            <div className="flex items-center gap-2 border-b border-[hsl(220_14%_89%)] px-5 py-4">
              <ShieldAlert className="h-4 w-4 text-amber-600" />
              <h2 className="font-semibold text-[hsl(220_14%_14%)]">风险登记</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-left text-sm">
                <thead className="border-b border-[hsl(220_14%_89%)] text-xs text-[hsl(218_10%_42%)]">
                  <tr>
                    <th className="px-5 py-3 font-medium">ID</th>
                    <th className="px-5 py-3 font-medium">风险</th>
                    <th className="px-5 py-3 font-medium">等级</th>
                    <th className="px-5 py-3 font-medium">缓解</th>
                    <th className="px-5 py-3 font-medium">状态</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[hsl(220_14%_89%)]">
                  {(risksQuery.data ?? []).map((risk) => (
                    <tr key={risk.id} className="hover:bg-[hsl(220_14%_96%)]">
                      <td className="px-5 py-3 font-mono text-xs">{risk.id}</td>
                      <td className="px-5 py-3">
                        <div className="font-medium text-[hsl(220_14%_14%)]">
                          {risk.title}
                        </div>
                        {risk.trigger && (
                          <div className="text-xs text-[hsl(218_10%_42%)]">
                            {risk.trigger}
                          </div>
                        )}
                      </td>
                      <td className="px-5 py-3">
                        <StatusBadge status={risk.severity} />
                      </td>
                      <td className="px-5 py-3 text-xs text-[hsl(218_10%_42%)]">
                        {risk.mitigation ?? '—'}
                      </td>
                      <td className="px-5 py-3 text-xs">{risk.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {activeTab === 'resources' && (
          <section className="rounded-lg border border-[hsl(220_14%_89%)] bg-white">
            <div className="flex flex-wrap items-center gap-3 border-b border-[hsl(220_14%_89%)] px-5 py-4">
              <Database className="h-4 w-4 text-violet-600" />
              <h2 className="font-semibold text-[hsl(220_14%_14%)]">资源与锁</h2>
              {writable && (
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <input
                    value={resourceId}
                    onChange={(event) => setResourceId(event.target.value)}
                    placeholder="资源 ID"
                    className="h-9 w-48 rounded-lg border border-[hsl(220_14%_89%)] px-3 text-sm outline-none focus:border-blue-500"
                  />
                  <input
                    value={lockPurpose}
                    onChange={(event) => setLockPurpose(event.target.value)}
                    placeholder="占用目的"
                    className="h-9 w-48 rounded-lg border border-[hsl(220_14%_89%)] px-3 text-sm outline-none focus:border-blue-500"
                  />
                  <label className="flex items-center gap-2 text-xs text-[hsl(218_10%_42%)]">
                    <input
                      type="checkbox"
                      checked={confirmLock}
                      onChange={(event) => setConfirmLock(event.target.checked)}
                      className="h-4 w-4"
                    />
                    双重确认
                  </label>
                  <button
                    type="button"
                    disabled={!resourceId.trim() || lockMutation.isPending}
                    onClick={() => lockMutation.mutate(resourceId.trim())}
                    className="inline-flex h-9 items-center gap-2 rounded-lg bg-violet-600 px-4 text-sm font-medium text-white disabled:opacity-40"
                  >
                    <Lock className="h-4 w-4" />
                    加锁
                  </button>
                </div>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-left text-sm">
                <thead className="border-b border-[hsl(220_14%_89%)] text-xs text-[hsl(218_10%_42%)]">
                  <tr>
                    <th className="px-5 py-3 font-medium">资源</th>
                    <th className="px-5 py-3 font-medium">类型</th>
                    <th className="px-5 py-3 font-medium">状态</th>
                    <th className="px-5 py-3 font-medium">持有者</th>
                    <th className="px-5 py-3 font-medium">获取时间</th>
                    <th className="px-5 py-3 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[hsl(220_14%_89%)]">
                  {(resourcesQuery.data ?? []).map((resource) => (
                    <tr key={resource.resourceId} className="hover:bg-[hsl(220_14%_96%)]">
                      <td className="px-5 py-3">
                        <div className="font-medium text-[hsl(220_14%_14%)]">
                          {resource.name}
                        </div>
                        <div className="font-mono text-xs text-[hsl(218_10%_42%)]">
                          {resource.resourceId}
                        </div>
                      </td>
                      <td className="px-5 py-3 text-xs">{resource.kind}</td>
                      <td className="px-5 py-3">
                        <StatusBadge status={resource.status} />
                      </td>
                      <td className="px-5 py-3 text-xs">
                        {resource.lock?.holder ?? '—'}
                      </td>
                      <td className="px-5 py-3 text-xs">
                        {resource.lock ? formatTime(resource.lock.acquiredAt) : '—'}
                        {resource.lock?.expiresAt && (
                          <div className="mt-0.5 text-[10px] text-[hsl(218_10%_42%)]">
                            剩余 {formatLockRemaining(resource.lock.expiresAt)}
                          </div>
                        )}
                      </td>
                      <td className="px-5 py-3">
                        {writable &&
                          (resource.lock ? (
                            <button
                              type="button"
                              disabled={releaseMutation.isPending}
                              onClick={() =>
                                releaseMutation.mutate(resource.resourceId)
                              }
                              className="inline-flex items-center gap-1.5 rounded-lg border border-[hsl(220_14%_89%)] px-3 py-1.5 text-xs font-medium text-[hsl(220_14%_14%)] disabled:opacity-40"
                            >
                              <Unlock className="h-3.5 w-3.5" />
                              释放
                            </button>
                          ) : (
                            <span className="text-xs text-[hsl(218_10%_42%)]">空闲</span>
                          ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {activeTab === 'handoffs' && (
          <section className="rounded-lg border border-[hsl(220_14%_89%)] bg-white">
            <div className="flex items-center gap-2 border-b border-[hsl(220_14%_89%)] px-5 py-4">
              <ArrowRightLeft className="h-4 w-4 text-blue-600" />
              <h2 className="font-semibold text-[hsl(220_14%_14%)]">交接记录</h2>
            </div>
            {writable && (
              <div className="flex flex-wrap items-center gap-2 border-b border-[hsl(220_14%_89%)] px-5 py-4">
                <input
                  value={handoffFrom}
                  onChange={(event) => setHandoffFrom(event.target.value)}
                  placeholder="来源 Agent"
                  className="h-9 w-40 rounded-lg border border-[hsl(220_14%_89%)] px-3 text-sm outline-none focus:border-blue-500"
                />
                <input
                  value={handoffTo}
                  onChange={(event) => setHandoffTo(event.target.value)}
                  placeholder="接收 Agent"
                  className="h-9 w-40 rounded-lg border border-[hsl(220_14%_89%)] px-3 text-sm outline-none focus:border-blue-500"
                />
                <input
                  value={handoffScope}
                  onChange={(event) => setHandoffScope(event.target.value)}
                  placeholder="交接范围"
                  className="h-9 w-64 rounded-lg border border-[hsl(220_14%_89%)] px-3 text-sm outline-none focus:border-blue-500"
                />
                <input
                  value={handoffAcceptance}
                  onChange={(event) => setHandoffAcceptance(event.target.value)}
                  placeholder="验收标准"
                  className="h-9 w-64 rounded-lg border border-[hsl(220_14%_89%)] px-3 text-sm outline-none focus:border-blue-500"
                />
                <button
                  type="button"
                  disabled={
                    !handoffTo.trim() ||
                    !handoffScope.trim() ||
                    handoffMutation.isPending
                  }
                  onClick={() => handoffMutation.mutate()}
                  className="inline-flex h-9 items-center gap-2 rounded-lg bg-blue-600 px-4 text-sm font-medium text-white disabled:opacity-40"
                >
                  登记交接
                </button>
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-left text-sm">
                <thead className="border-b border-[hsl(220_14%_89%)] text-xs text-[hsl(218_10%_42%)]">
                  <tr>
                    <th className="px-5 py-3 font-medium">交接</th>
                    <th className="px-5 py-3 font-medium">范围</th>
                    <th className="px-5 py-3 font-medium">来源</th>
                    <th className="px-5 py-3 font-medium">接收</th>
                    <th className="px-5 py-3 font-medium">状态</th>
                    <th className="px-5 py-3 font-medium">创建时间</th>
                    <th className="px-5 py-3 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[hsl(220_14%_89%)]">
                  {(handoffsQuery.data ?? []).map((handoff) => (
                    <tr key={handoff.handoffId} className="hover:bg-[hsl(220_14%_96%)]">
                      <td className="px-5 py-3 font-mono text-xs">{handoff.handoffId}</td>
                      <td className="px-5 py-3 font-medium">{handoff.scope}</td>
                      <td className="px-5 py-3">{handoff.fromActor}</td>
                      <td className="px-5 py-3">{handoff.toActor}</td>
                      <td className="px-5 py-3">
                        <StatusBadge status={handoff.status} />
                      </td>
                      <td className="px-5 py-3 text-xs text-[hsl(218_10%_42%)]">
                        {formatTime(handoff.createdAt)}
                      </td>
                      <td className="px-5 py-3">
                        {writable && handoff.status === 'open' && (
                          <div className="flex gap-2">
                            <button
                              type="button"
                              disabled={handoffStateMutation.isPending}
                              onClick={() =>
                                handoffStateMutation.mutate({
                                  handoffId: handoff.handoffId,
                                  status: 'accepted',
                                })
                              }
                              className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
                            >
                              接收
                            </button>
                            <button
                              type="button"
                              disabled={handoffStateMutation.isPending}
                              onClick={() =>
                                handoffStateMutation.mutate({
                                  handoffId: handoff.handoffId,
                                  status: 'rejected',
                                })
                              }
                              className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
                            >
                              拒绝
                            </button>
                            <button
                              type="button"
                              disabled={handoffStateMutation.isPending}
                              onClick={() =>
                                handoffStateMutation.mutate({
                                  handoffId: handoff.handoffId,
                                  status: 'closed',
                                })
                              }
                              className="rounded-md border border-[hsl(220_14%_89%)] px-3 py-1.5 text-xs font-medium text-[hsl(220_14%_14%)] disabled:opacity-40"
                            >
                              关闭
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {activeTab === 'catalog' && (
          <section className="rounded-lg border border-[hsl(220_14%_89%)] bg-white">
            <div className="flex items-center gap-2 border-b border-[hsl(220_14%_89%)] px-5 py-4">
              <PackageSearch className="h-4 w-4 text-emerald-600" />
              <h2 className="font-semibold text-[hsl(220_14%_14%)]">Final 6 资产目录</h2>
              <span className="ml-auto text-xs text-[hsl(218_10%_42%)]">
                {catalogQuery.data?.assets.length ?? 0} 个资产包
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[800px] text-left text-sm">
                <thead className="border-b border-[hsl(220_14%_89%)] text-xs text-[hsl(218_10%_42%)]">
                  <tr>
                    <th className="px-5 py-3 font-medium">资产</th>
                    <th className="px-5 py-3 font-medium">类型</th>
                    <th className="px-5 py-3 font-medium">版本</th>
                    <th className="px-5 py-3 font-medium">状态</th>
                    <th className="px-5 py-3 font-medium">来源</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[hsl(220_14%_89%)]">
                  {(catalogQuery.data?.assets ?? []).map((asset) => (
                    <tr key={asset.packageId} className="hover:bg-[hsl(220_14%_96%)]">
                      <td className="px-5 py-3">
                        <div className="font-medium text-[hsl(220_14%_14%)]">
                          {asset.name}
                        </div>
                        <div className="font-mono text-xs text-[hsl(218_10%_42%)]">
                          {asset.packageId}
                        </div>
                      </td>
                      <td className="px-5 py-3 text-xs">{asset.packageType}</td>
                      <td className="px-5 py-3 font-mono text-xs">{asset.version}</td>
                      <td className="px-5 py-3">
                        <StatusBadge status={asset.status} />
                      </td>
                      <td className="px-5 py-3 font-mono text-xs">
                        {asset.sourcePath ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {activeTab === 'git-sync' && (
          <section className="rounded-lg border border-[hsl(220_14%_89%)] bg-white">
            <div className="flex flex-wrap items-center gap-2 border-b border-[hsl(220_14%_89%)] px-5 py-4">
              <GitPullRequest className="h-4 w-4 text-slate-600" />
              <h2 className="font-semibold text-[hsl(220_14%_14%)]">GitHub Issue/PR 同步</h2>
              <span className="ml-auto text-xs text-[hsl(218_10%_42%)]">
                {gitSyncQuery.data?.trackedCount ?? 0} 已关联 /{' '}
                {gitSyncQuery.data?.missingCount ?? 0} 待同步
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1000px] text-left text-sm">
                <thead className="border-b border-[hsl(220_14%_89%)] text-xs text-[hsl(218_10%_42%)]">
                  <tr>
                    <th className="px-5 py-3 font-medium">任务</th>
                    <th className="px-5 py-3 font-medium">Issue</th>
                    <th className="px-5 py-3 font-medium">PR</th>
                    <th className="px-5 py-3 font-medium">分支</th>
                    <th className="px-5 py-3 font-medium">Commit</th>
                    <th className="px-5 py-3 font-medium">状态</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[hsl(220_14%_89%)]">
                  {(gitSyncQuery.data?.items ?? []).map((entry) => (
                    <tr key={entry.workItemId} className="hover:bg-[hsl(220_14%_96%)]">
                      <td className="px-5 py-3">
                        <div className="font-medium text-[hsl(220_14%_14%)]">
                          {entry.workItemId} · {entry.title}
                        </div>
                        <div className="text-xs text-[hsl(218_10%_42%)]">
                          {entry.type} · {entry.owner} · {entry.status}
                        </div>
                      </td>
                      <td className="px-5 py-3 font-mono text-xs">
                        {entry.issueNumber ? `#${entry.issueNumber}` : '—'}
                      </td>
                      <td className="px-5 py-3 font-mono text-xs">
                        {entry.prNumber ? `#${entry.prNumber}` : '—'}
                      </td>
                      <td className="px-5 py-3 font-mono text-xs">{entry.branch ?? '—'}</td>
                      <td className="px-5 py-3 font-mono text-xs">
                        {entry.commitSha ? entry.commitSha.slice(0, 8) : '—'}
                      </td>
                      <td className="px-5 py-3">
                        <StatusBadge status={entry.state} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {activeTab === 'site-readiness' && (
          <section className="rounded-lg border border-[hsl(220_14%_89%)] bg-white">
            <div className="flex flex-wrap items-center gap-2 border-b border-[hsl(220_14%_89%)] px-5 py-4">
              <ClipboardCheck className="h-4 w-4 text-emerald-600" />
              <h2 className="font-semibold text-[hsl(220_14%_14%)]">工厂场地就绪</h2>
              <span className="ml-auto text-xs text-[hsl(218_10%_42%)]">
                {siteReadinessQuery.data?.length ?? 0} 份报告
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-left text-sm">
                <thead className="border-b border-[hsl(220_14%_89%)] text-xs text-[hsl(218_10%_42%)]">
                  <tr>
                    <th className="px-5 py-3 font-medium">工厂</th>
                    <th className="px-5 py-3 font-medium">联系人</th>
                    <th className="px-5 py-3 font-medium">结论</th>
                    <th className="px-5 py-3 font-medium">必填项</th>
                    <th className="px-5 py-3 font-medium">来源</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[hsl(220_14%_89%)]">
                  {(siteReadinessQuery.data ?? []).map((report) => (
                    <tr key={report.sourcePath} className="hover:bg-[hsl(220_14%_96%)]">
                      <td className="px-5 py-3">
                        <div className="font-medium text-[hsl(220_14%_14%)]">
                          {report.factoryName ?? '未命名工厂'}
                        </div>
                        {report.example && (
                          <div className="text-xs text-[hsl(218_10%_42%)]">
                            契约示例，非现场证据
                          </div>
                        )}
                      </td>
                      <td className="px-5 py-3 text-xs">{report.siteContact ?? '—'}</td>
                      <td className="px-5 py-3">
                        <StatusBadge status={report.ready ? 'passed' : 'blocked'} />
                        {report.error && (
                          <div className="mt-1 text-xs text-red-600">{report.error}</div>
                        )}
                      </td>
                      <td className="px-5 py-3 text-xs">
                        {report.requiredPassed ?? 0} / {report.requiredCount ?? 0} 通过
                        {report.requiredFailed ? ` · ${report.requiredFailed} 未通过` : ''}
                      </td>
                      <td className="px-5 py-3 font-mono text-xs">{report.sourcePath}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </QueryState>
    </div>
  );
};

const SummaryTile = ({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string;
  value: number;
  icon: typeof GitBranch;
  tone: 'blue' | 'emerald' | 'violet' | 'sky' | 'amber' | 'red';
}): React.ReactElement => {
  const iconTones: Record<string, string> = {
    blue: 'bg-blue-50 text-blue-600',
    emerald: 'bg-emerald-50 text-emerald-600',
    violet: 'bg-violet-50 text-violet-600',
    sky: 'bg-sky-50 text-sky-600',
    amber: 'bg-amber-50 text-amber-600',
    red: 'bg-red-50 text-red-600',
  };
  return (
    <div className="flex items-center gap-3 rounded-lg border border-[hsl(220_14%_89%)] bg-white p-4">
      <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${iconTones[tone]}`}>
        <Icon className="h-4 w-4" />
      </div>
      <div>
        <p className="text-xs text-[hsl(218_10%_42%)]">{label}</p>
        <p className="mt-0.5 text-2xl font-semibold text-[hsl(220_14%_14%)]">{value}</p>
      </div>
    </div>
  );
};

const StatusBadge = ({ status }: { status: string }): React.ReactElement => (
  <span
    className={`inline-flex rounded-md border px-2 py-1 text-xs font-medium ${toneClasses[statusTone(status)]}`}
  >
    {status || '—'}
  </span>
);

const EvidenceRow = ({
  entry,
  onPreview,
}: {
  entry: WorkEvidence;
  onPreview?: (entry: WorkEvidence) => void;
}): React.ReactElement => (
  <div className="rounded-lg border border-[hsl(220_14%_89%)] bg-[hsl(220_14%_96%)] px-4 py-3">
    <div className="flex items-center gap-2">
      <CheckCircle2 className="h-4 w-4 text-emerald-600" />
      <span className="font-medium text-[hsl(220_14%_14%)]">
        {entry.title || entry.evidenceId}
      </span>
      <span className="ml-auto text-xs text-[hsl(218_10%_42%)]">{entry.kind}</span>
      {onPreview && (
        <button
          type="button"
          onClick={() => onPreview(entry)}
          className="rounded-md border border-[hsl(220_14%_89%)] bg-white px-2 py-1 text-xs font-medium text-[hsl(220_14%_14%)] hover:bg-[hsl(220_14%_96%)]"
        >
          预览
        </button>
      )}
    </div>
    <p className="mt-1 font-mono text-xs text-[hsl(218_10%_42%)]">{entry.path}</p>
    <p className="mt-1 text-xs text-[hsl(218_10%_42%)]">
      校验 {entry.checksum.slice(0, 12)} · 结果 {entry.result ?? 'unknown'}
    </p>
    {(entry.status || entry.commitSha || entry.expiresAt || entry.verifier) && (
      <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-[hsl(218_10%_42%)]">
        <StatusBadge status={entry.status ?? 'unbound'} />
        {entry.commitSha && <span>提交 {entry.commitSha.slice(0, 8)}</span>}
        {entry.expiresAt && <span>到期 {formatTime(entry.expiresAt)}</span>}
        {entry.verifier && <span>验证人 {entry.verifier}</span>}
      </p>
    )}
  </div>
);

const EvidencePanel = ({
  evidence,
  kind,
  result,
  onKindChange,
  onResultChange,
}: {
  evidence: WorkEvidence[];
  kind: string;
  result: string;
  onKindChange: (value: string) => void;
  onResultChange: (value: string) => void;
}): React.ReactElement => {
  const [preview, setPreview] = useState<EvidenceContentPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const filtered = evidence.filter((entry) => {
    if (kind && entry.kind !== kind) return false;
    if (result && entry.result !== result) return false;
    return true;
  });
  const loadPreview = async (entry: WorkEvidence) => {
    setPreviewLoading(true);
    setPreviewError('');
    try {
      setPreview(await getWorkEvidenceContent(entry.evidenceId, 200));
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : '证据预览失败');
    } finally {
      setPreviewLoading(false);
    }
  };
  return (
    <section className="rounded-lg border border-[hsl(220_14%_89%)] bg-white">
      <div className="flex flex-wrap items-center gap-2 border-b border-[hsl(220_14%_89%)] px-5 py-4">
        <CheckCircle2 className="h-4 w-4 text-violet-600" />
        <h2 className="font-semibold text-[hsl(220_14%_14%)]">证据抽屉</h2>
        <div className="ml-auto flex items-center gap-2">
          <select
            value={kind}
            onChange={(event) => onKindChange(event.target.value)}
            aria-label="按证据类型筛选"
            className="h-9 rounded-lg border border-[hsl(220_14%_89%)] px-2 text-xs outline-none focus:border-blue-500"
          >
            <option value="">全部类型</option>
            <option value="test">test</option>
            <option value="review">review</option>
            <option value="evidence">evidence</option>
          </select>
          <select
            value={result}
            onChange={(event) => onResultChange(event.target.value)}
            aria-label="按证据结果筛选"
            className="h-9 rounded-lg border border-[hsl(220_14%_89%)] px-2 text-xs outline-none focus:border-blue-500"
          >
            <option value="">全部结果</option>
            <option value="passed">passed</option>
            <option value="failed">failed</option>
            <option value="unknown">unknown</option>
          </select>
          <span className="text-xs text-[hsl(218_10%_42%)]">
            {filtered.length} / {evidence.length} 条
          </span>
        </div>
      </div>
      <div className="grid gap-2 p-4 sm:grid-cols-2 lg:grid-cols-3">
        {filtered.length === 0 ? (
          <p className="col-span-full text-sm text-[hsl(218_10%_42%)]">
            暂无匹配证据记录。
          </p>
        ) : (
          filtered.map((entry) => (
            <EvidenceRow
              key={entry.evidenceId}
              entry={entry}
              onPreview={loadPreview}
            />
          ))
        )}
      </div>
      {(preview || previewLoading || previewError) && (
        <div className="border-t border-[hsl(220_14%_89%)] px-5 py-4">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-[hsl(220_14%_14%)]">证据预览</h3>
            {preview && (
              <span className="text-xs text-[hsl(218_10%_42%)]">
                {preview.path} · {preview.lines} 行
                {preview.truncated ? ' · 已截断' : ''}
              </span>
            )}
            <button
              type="button"
              onClick={() => {
                setPreview(null);
                setPreviewError('');
              }}
              className="ml-auto rounded-md border border-[hsl(220_14%_89%)] bg-white px-3 py-1.5 text-xs font-medium text-[hsl(220_14%_14%)]"
            >
              关闭
            </button>
          </div>
          {previewLoading && (
            <p className="mt-3 text-sm text-[hsl(218_10%_42%)]">正在读取证据内容...</p>
          )}
          {previewError && (
            <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
              {previewError}
            </p>
          )}
          {preview && (
            <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-[hsl(220_14%_89%)] bg-[hsl(220_14%_96%)] p-3 text-xs leading-5 text-[hsl(220_14%_14%)]">
              {preview.content}
            </pre>
          )}
        </div>
      )}
    </section>
  );
};

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export default WorkOrchestration;
