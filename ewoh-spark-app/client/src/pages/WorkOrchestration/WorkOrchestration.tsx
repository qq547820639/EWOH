import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowRightLeft,
  CheckCircle2,
  ClipboardCheck,
  Database,
  GitBranch,
  GitPullRequest,
  ListChecks,
  PackageSearch,
  ShieldAlert,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { queryKeys } from '../../hooks/queryKeys';
import { ADMIN_REFETCH_INTERVAL_MS, QUERY_STALE_TIME_MS } from '../../hooks/queryConfig';
import { getWorkOverview, type WorkOverview } from '../../api/work';
import { SummaryTile, useUrlParam } from './shared';
import WorkGraphPanel from './WorkGraphPanel';
import GatesPanel from './GatesPanel';
import EvidencePanel from './EvidencePanel';
import AgentsPanel from './AgentsPanel';
import RisksPanel from './RisksPanel';
import ResourcesPanel from './ResourcesPanel';
import HandoffsPanel from './HandoffsPanel';
import CatalogPanel from './CatalogPanel';
import GitSyncPanel from './GitSyncPanel';
import SiteReadinessPanel from './SiteReadinessPanel';

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

const TABS: Array<{ key: TabKey; label: string; icon: LucideIcon }> = [
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

const isTabKey = (value: string): value is TabKey =>
  TABS.some((tab) => tab.key === value);

const WorkOrchestration = (): React.ReactElement => {
  const [tab, setTab] = useUrlParam('tab');
  const activeTab: TabKey = isTabKey(tab) ? tab : 'dag';

  const overviewQuery = useQuery<WorkOverview>({
    queryKey: queryKeys.workOverview,
    queryFn: getWorkOverview,
    refetchInterval: ADMIN_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });

  const overview = overviewQuery.data;
  const writable = overview?.writable ?? false;

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
        {TABS.map((tabItem) => {
          const Icon = tabItem.icon;
          return (
            <button
              key={tabItem.key}
              type="button"
              onClick={() => setTab(tabItem.key)}
              aria-pressed={activeTab === tabItem.key}
              className={`inline-flex h-10 items-center gap-2 rounded-t-lg border-x border-t px-4 text-sm font-medium ${
                activeTab === tabItem.key
                  ? 'border-[hsl(220_14%_89%)] bg-white text-[hsl(221_83%_53%)]'
                  : 'border-transparent text-[hsl(218_10%_42%)] hover:bg-[hsl(220_14%_96%)]'
              }`}
            >
              <Icon className="h-4 w-4" />
              {tabItem.label}
            </button>
          );
        })}
      </div>

      {activeTab === 'dag' && <WorkGraphPanel />}
      {activeTab === 'gates' && <GatesPanel writable={writable} />}
      {activeTab === 'evidence' && <EvidencePanel />}
      {activeTab === 'agents' && <AgentsPanel />}
      {activeTab === 'risks' && <RisksPanel />}
      {activeTab === 'resources' && <ResourcesPanel writable={writable} />}
      {activeTab === 'handoffs' && <HandoffsPanel writable={writable} />}
      {activeTab === 'catalog' && <CatalogPanel />}
      {activeTab === 'git-sync' && <GitSyncPanel />}
      {activeTab === 'site-readiness' && <SiteReadinessPanel />}
    </div>
  );
};

export default WorkOrchestration;