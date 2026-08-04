import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowRightLeft,
  CheckCircle2,
  ClipboardCheck,
  Database,
  GitBranch,
  GitPullRequest,
  LayoutDashboard,
  ListChecks,
  PackageSearch,
  Search,
  ShieldAlert,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { queryKeys } from '../../hooks/queryKeys';
import { ADMIN_REFETCH_INTERVAL_MS, QUERY_STALE_TIME_MS } from '../../hooks/queryConfig';
import { getWorkOverview, type WorkOverview } from '../../api/work';
import { useUrlParam } from './shared';
import ExecutionOverview from './ExecutionOverview';
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
  | 'overview'
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
  { key: 'overview', label: '执行态势', icon: LayoutDashboard },
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

/** W3.2 命令面板：Cmd/Ctrl+K 快速切换控制台分区。 */
const CommandPalette = ({
  open,
  onClose,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (key: TabKey) => void;
}): React.ReactElement | null => {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      window.requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  if (!open) return null;

  const filtered = TABS.filter((tab) =>
    [tab.label, tab.key].some((text) => text.toLowerCase().includes(query.trim().toLowerCase())),
  );

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-24"
      role="dialog"
      aria-modal="true"
      aria-label="命令面板"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-lg border border-[hsl(220_14%_89%)] bg-white shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-[hsl(220_14%_89%)] px-4 py-3">
          <Search className="h-4 w-4 text-[hsl(218_10%_42%)]" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="搜索控制台分区…"
            aria-label="搜索控制台分区"
            className="h-8 flex-1 bg-transparent text-sm outline-none placeholder:text-[hsl(218_10%_42%)]"
          />
          <kbd className="rounded border border-[hsl(220_14%_89%)] px-1.5 text-xs text-[hsl(218_10%_42%)]">
            ESC
          </kbd>
        </div>
        <ul className="max-h-80 overflow-y-auto p-2">
          {filtered.length === 0 ? (
            <li className="px-3 py-4 text-center text-sm text-[hsl(218_10%_42%)]">
              没有匹配的分区。
            </li>
          ) : (
            filtered.map((tab) => {
              const Icon = tab.icon;
              return (
                <li key={tab.key}>
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(tab.key);
                      onClose();
                    }}
                    className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm hover:bg-[hsl(220_14%_96%)]"
                  >
                    <Icon className="h-4 w-4 text-[hsl(218_10%_42%)]" />
                    <span className="font-medium text-[hsl(220_14%_14%)]">{tab.label}</span>
                    <span className="ml-auto font-mono text-xs text-[hsl(218_10%_42%)]">
                      {tab.key}
                    </span>
                  </button>
                </li>
              );
            })
          )}
        </ul>
      </div>
    </div>
  );
};

const WorkOrchestration = (): React.ReactElement => {
  const [tab, setTab] = useUrlParam('tab');
  const activeTab: TabKey = isTabKey(tab) ? tab : 'overview';
  const [paletteOpen, setPaletteOpen] = useState(false);

  const overviewQuery = useQuery<WorkOverview>({
    queryKey: queryKeys.workOverview,
    queryFn: getWorkOverview,
    refetchInterval: ADMIN_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });

  const overview = overviewQuery.data;
  const writable = overview?.writable ?? false;

  // W3.2：Cmd/Ctrl+K 打开命令面板。
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((value) => !value);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const activeLabel = useMemo(
    () => TABS.find((tab) => tab.key === activeTab)?.label ?? '执行态势',
    [activeTab],
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
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-[hsl(220_14%_89%)] bg-white px-3 text-sm font-medium text-[hsl(220_14%_14%)] hover:bg-[hsl(220_14%_96%)]"
          >
            <Search className="h-4 w-4" />
            <span className="hidden sm:inline">命令面板</span>
            <kbd className="rounded border border-[hsl(220_14%_89%)] px-1 text-[10px] text-[hsl(218_10%_42%)]">
              ⌘K
            </kbd>
          </button>
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

      {/* W3.2：响应式侧边导航（桌面为垂直侧栏，移动端为横向滚动条） */}
      <div className="flex flex-col gap-0 lg:flex-row lg:gap-5">
        <nav
          aria-label="控制台分区"
          className="flex shrink-0 gap-1 overflow-x-auto border-b border-[hsl(220_14%_89%)] bg-white pb-1 lg:w-44 lg:flex-col lg:overflow-visible lg:border-b-0 lg:border-r lg:pb-0 lg:pr-2"
        >
          {TABS.map((tabItem) => {
            const Icon = tabItem.icon;
            const active = activeTab === tabItem.key;
            return (
              <button
                key={tabItem.key}
                type="button"
                onClick={() => setTab(tabItem.key)}
                aria-pressed={active}
                className={`inline-flex h-9 shrink-0 items-center gap-2 rounded-lg px-3 text-sm font-medium lg:w-full ${
                  active
                    ? 'bg-blue-600 text-white'
                    : 'text-[hsl(218_10%_42%)] hover:bg-[hsl(220_14%_96%)] hover:text-[hsl(220_14%_14%)]'
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="whitespace-nowrap">{tabItem.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="min-w-0 flex-1">
          <p className="mb-3 text-sm font-semibold text-[hsl(220_14%_14%)] lg:hidden">
            {activeLabel}
          </p>
          {activeTab === 'overview' && <ExecutionOverview writable={writable} />}
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
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onSelect={(key) => setTab(key)}
      />
    </div>
  );
};

export default WorkOrchestration;