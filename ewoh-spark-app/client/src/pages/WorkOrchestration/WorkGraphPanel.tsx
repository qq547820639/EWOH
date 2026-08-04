import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { TransformComponent, TransformWrapper, useTransformContext } from 'react-zoom-pan-pinch';
import { FileText, GitBranch, Save, RotateCcw } from 'lucide-react';
import QueryState from '../../components/QueryState';
import { queryKeys } from '../../hooks/queryKeys';
import { ADMIN_REFETCH_INTERVAL_MS, QUERY_STALE_TIME_MS } from '../../hooks/queryConfig';
import { getWorkGraph, getWorkOverview, listWorkEvidence, type WorkOverview } from '../../api/work';
import { buildGraphLayout, filterGraphItems, statusTone, type WorkGraphScope } from './graphLayout';
import { buildGraphTextAlt, graphTextToPlainText } from './graphText';
import { UI_ARIA_LABELS } from '../../lib/a11y';
import {
  hasMoreItems,
  nextProgressiveLimit,
  progressiveSlice,
  PROGRESSIVE_STEP,
} from '../../lib/progressiveList';
import {
  EvidenceRow,
  toneClasses,
  truncate,
  useElementSize,
  useUrlParam,
} from './shared';

/** 超过该节点数时启用窗口化渲染（只渲染视口内节点）。 */
const WINDOW_THRESHOLD = 300;
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 480;
const VIEW_KEY = 'ewoh.workGraph.view';

interface SavedView {
  q?: string;
  scope?: WorkGraphScope;
  time?: string;
  node?: string;
  sidebarWidth?: number;
}

const SCOPE_OPTIONS: Array<{ value: WorkGraphScope; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'waves-gates', label: '波次+门禁' },
  { value: 'waves', label: '波次' },
  { value: 'gates', label: '门禁' },
];

const TIME_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'all', label: '全部时间' },
  { value: '24h', label: '近 24 小时' },
  { value: '7d', label: '近 7 天' },
];

/** 从 overview.criticalPath 字符串解析关键路径节点 id。 */
function parseCriticalNodeIds(criticalPath?: string): Set<string> {
  const ids = new Set<string>();
  if (!criticalPath) return ids;
  for (const token of criticalPath.split(/[→>,\s]+/)) {
    const trimmed = token.trim();
    if (trimmed) ids.add(trimmed);
  }
  return ids;
}

const GraphCanvas = ({
  layout,
  size,
  selectedNodeId,
  criticalNodeIds,
  onSelect,
}: {
  layout: ReturnType<typeof buildGraphLayout>;
  size: { width: number; height: number };
  selectedNodeId: string | null;
  criticalNodeIds: Set<string>;
  onSelect: (id: string) => void;
}): React.ReactElement => {
  const { state } = useTransformContext();
  const { scale, positionX, positionY } = state;

  // 窗口化渲染：只渲染视口（含边距）内的节点及其关联边。
  const shouldRenderAll = size.width === 0 || layout.nodes.length <= WINDOW_THRESHOLD;
  const visible = useMemo(() => {
    if (shouldRenderAll) return new Set(layout.nodes.map((node) => node.id));
    const set = new Set<string>();
    const margin = 60;
    for (const node of layout.nodes) {
      const left = node.x * scale + positionX;
      const top = node.y * scale + positionY;
      const right = left + node.width * scale;
      const bottom = top + node.height * scale;
      if (
        right > -margin &&
        left < size.width + margin &&
        bottom > -margin &&
        top < size.height + margin
      ) {
        set.add(node.id);
      }
    }
    return set;
  }, [shouldRenderAll, layout.nodes, scale, positionX, positionY, size.width, size.height]);

  const visibleNodes = shouldRenderAll
    ? layout.nodes
    : layout.nodes.filter((node) => visible.has(node.id));
  const visibleEdges = shouldRenderAll
    ? layout.edges
    : layout.edges.filter((edge) => visible.has(edge.from) || visible.has(edge.to));

  return (
    <svg
      width={layout.width}
      height={layout.height}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      role="img"
      aria-label="交付因果图（图形视图）"
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
      {visibleEdges.map((edge) => {
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
            stroke={edge.blocking ? '#dc2626' : '#94a3b8'}
            strokeWidth={edge.blocking ? 2.5 : 1.5}
            strokeDasharray={edge.blocking ? '5 3' : undefined}
            markerEnd="url(#arrowhead)"
          />
        );
      })}
      {visibleNodes.map((node) => {
        const tone = statusTone(node.status);
        const isSelected = selectedNodeId === node.id;
        const isCritical = criticalNodeIds.has(node.id);
        return (
          <g
            key={node.id}
            onClick={() => onSelect(node.id)}
            className="cursor-pointer"
            role="button"
            tabIndex={-1}
          >
            <rect
              x={node.x}
              y={node.y}
              width={node.width}
              height={node.height}
              rx={6}
              fill="#ffffff"
              stroke={
                isSelected
                  ? '#2563eb'
                  : isCritical
                    ? '#f59e0b'
                    : statusTone(node.status) === 'red'
                      ? '#dc2626'
                      : '#cbd5e1'
              }
              strokeWidth={isSelected || isCritical ? 2.5 : 1}
            />
            <text x={node.x + 12} y={node.y + 22} fontSize="12" fontWeight={isCritical ? 800 : 700} fill="#1e293b">
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
  );
};

const WorkGraphPanel = (): React.ReactElement => {
  const [nodeQuery, setNodeQuery] = useUrlParam('q');
  const [scope, setScope] = useUrlParam('scope');
  const [selectedNodeId, setSelectedNodeId] = useUrlParam('node');
  const [timeRange, setTimeRange] = useUrlParam('time');
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const [dragging, setDragging] = useState(false);
  const [textView, setTextView] = useState(false);
  const [nodeListLimit, setNodeListLimit] = useState(PROGRESSIVE_STEP);
  const { ref: viewportRef, size: viewportSize } = useElementSize<HTMLDivElement>();

  const graphQuery = useQuery({
    queryKey: queryKeys.workGraph,
    queryFn: getWorkGraph,
    refetchInterval: ADMIN_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });
  const overviewQuery = useQuery<WorkOverview>({
    queryKey: queryKeys.workOverview,
    queryFn: getWorkOverview,
    refetchInterval: ADMIN_REFETCH_INTERVAL_MS,
    staleTime: QUERY_STALE_TIME_MS,
  });
  const evidenceQuery = useQuery({
    queryKey: queryKeys.workEvidence(),
    queryFn: () => listWorkEvidence(),
    staleTime: QUERY_STALE_TIME_MS,
  });

  const graph = graphQuery.data;
  const scopeValue: WorkGraphScope =
    scope === 'all' || scope === 'waves' || scope === 'gates' ? scope : 'waves-gates';
  const visibleGraphItems = useMemo(
    () => filterGraphItems(graph?.items ?? [], nodeQuery),
    [graph, nodeQuery],
  );
  const layout = useMemo(
    () =>
      buildGraphLayout(visibleGraphItems, graph?.edges ?? [], nodeQuery.trim() ? 'all' : scopeValue),
    [visibleGraphItems, graph?.edges, scopeValue, nodeQuery],
  );
  // 节点数变化时重置侧边栏渐进式加载步长。
  useEffect(() => {
    setNodeListLimit(PROGRESSIVE_STEP);
  }, [layout.nodes.length]);
  const sidebarNodes = progressiveSlice(layout.nodes, nodeListLimit);
  const sidebarHasMore = hasMoreItems(layout.nodes, nodeListLimit);
  const selectedNode = useMemo(
    () => layout.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [layout.nodes, selectedNodeId],
  );
  const criticalNodeIds = useMemo(
    () => parseCriticalNodeIds(overviewQuery.data?.criticalPath),
    [overviewQuery.data?.criticalPath],
  );
  const graphTextAlt = useMemo(
    () => buildGraphTextAlt(layout.nodes, layout.edges, overviewQuery.data?.criticalPath),
    [layout.nodes, layout.edges, overviewQuery.data?.criticalPath],
  );
  const selectedEvidence = useMemo(() => {
    const evidence = evidenceQuery.data ?? [];
    if (!selectedNode) return [];
    const now = Date.now();
    return evidence.filter((entry) => {
      if (entry.workItemId !== selectedNode.id) return false;
      if (timeRange === '24h') {
        return entry.expiresAt ? Date.parse(entry.expiresAt) - now <= 24 * 3600 * 1000 : true;
      }
      if (timeRange === '7d') {
        return entry.expiresAt ? Date.parse(entry.expiresAt) - now <= 7 * 24 * 3600 * 1000 : true;
      }
      return true;
    });
  }, [evidenceQuery.data, selectedNode, timeRange]);

  const moveSelection = (dir: 1 | -1) => {
    const current = layout.nodes.findIndex((node) => node.id === selectedNodeId);
    const next = current + dir;
    if (next >= 0 && next < layout.nodes.length) {
      setSelectedNodeId(layout.nodes[next].id);
    }
  };

  const handleListKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveSelection(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveSelection(-1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setSelectedNodeId('');
    }
  };

  const handleCanvasKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      event.preventDefault();
      moveSelection(1);
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault();
      moveSelection(-1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setSelectedNodeId('');
    }
  };

  const saveView = () => {
    const view: SavedView = {
      q: nodeQuery || undefined,
      scope: scopeValue,
      time: timeRange || undefined,
      node: selectedNodeId || undefined,
      sidebarWidth,
    };
    localStorage.setItem(VIEW_KEY, JSON.stringify(view));
  };

  const restoreView = () => {
    try {
      const raw = localStorage.getItem(VIEW_KEY);
      if (!raw) return;
      const view = JSON.parse(raw) as SavedView;
      if (view.q) setNodeQuery(view.q);
      if (view.scope) setScope(view.scope);
      if (view.time) setTimeRange(view.time);
      if (view.node) setSelectedNodeId(view.node);
      if (view.sidebarWidth) setSidebarWidth(view.sidebarWidth);
    } catch {
      // 忽略损坏的本地视图。
    }
  };

  const startDrag = (event: React.MouseEvent) => {
    event.preventDefault();
    setDragging(true);
    const onMove = (moveEvent: MouseEvent) => {
      const width = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, moveEvent.clientX));
      setSidebarWidth(width);
    };
    const onUp = () => {
      setDragging(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
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
      errorMessage={graphQuery.error instanceof Error ? graphQuery.error.message : '因果图加载失败'}
      loadingMessage="正在构建因果图"
      updatedAt={Math.max(graphQuery.dataUpdatedAt, overviewQuery.dataUpdatedAt)}
    >
      <div className="rounded-lg border border-[hsl(220_14%_89%)] bg-white">
        <div className="flex flex-wrap items-center gap-3 border-b border-[hsl(220_14%_89%)] px-4 py-3">
          <GitBranch className="h-4 w-4 text-blue-600" />
          <h2 className="font-semibold text-[hsl(220_14%_14%)]">交付因果图</h2>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <input
              value={nodeQuery}
              onChange={(event) => setNodeQuery(event.target.value)}
              placeholder="搜索任务/Agent/状态"
              aria-label="搜索因果图节点"
              className="h-9 w-56 rounded-lg border border-[hsl(220_14%_89%)] px-3 text-sm outline-none focus:border-blue-500"
            />
            <select
              value={timeRange}
              onChange={(event) => setTimeRange(event.target.value)}
              aria-label="时间范围"
              className="h-9 rounded-lg border border-[hsl(220_14%_89%)] px-2 text-xs outline-none focus:border-blue-500"
            >
              {TIME_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {SCOPE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setScope(option.value)}
                aria-pressed={scopeValue === option.value}
                className={`rounded-md px-3 py-1.5 text-xs font-medium ${
                  scopeValue === option.value
                    ? 'bg-blue-600 text-white'
                    : 'bg-[hsl(220_14%_96%)] text-[hsl(218_10%_42%)]'
                }`}
              >
                {option.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setTextView((value) => !value)}
              aria-pressed={textView}
              title={textView ? UI_ARIA_LABELS.graphGraphView : UI_ARIA_LABELS.graphTextView}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[hsl(220_14%_89%)] px-3 text-xs font-medium text-[hsl(220_14%_14%)] hover:bg-[hsl(220_14%_96%)]"
            >
              <FileText className="h-3.5 w-3.5" />
              {textView ? '图形视图' : '文本视图'}
            </button>
            <button
              type="button"
              onClick={saveView}
              title="保存当前视图到本地"
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[hsl(220_14%_89%)] px-3 text-xs font-medium text-[hsl(220_14%_14%)] hover:bg-[hsl(220_14%_96%)]"
            >
              <Save className="h-3.5 w-3.5" />
              保存视图
            </button>
            <button
              type="button"
              onClick={restoreView}
              title="从本地恢复已保存视图"
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[hsl(220_14%_89%)] px-3 text-xs font-medium text-[hsl(220_14%_14%)] hover:bg-[hsl(220_14%_96%)]"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              恢复
            </button>
            {layout.nodes.length > WINDOW_THRESHOLD && (
              <span className="text-xs text-[hsl(218_10%_42%)]">
                窗口化渲染 {layout.nodes.length} 节点
              </span>
            )}
          </div>
        </div>
        {textView ? (
          <section
            aria-label={UI_ARIA_LABELS.graphSummary}
            className="max-h-[560px] overflow-auto p-4"
          >
            <h3 className="mb-2 font-semibold text-[hsl(220_14%_14%)]">
              {UI_ARIA_LABELS.graphSummary}
            </h3>
            <p className="mb-2 text-sm text-[hsl(218_10%_42%)]">
              节点数：{graphTextAlt.nodeCount}，依赖边数：{graphTextAlt.edgeCount}
              {graphTextAlt.criticalPath && (
                <span className="ml-2">
                  {UI_ARIA_LABELS.graphCriticalPath}：{graphTextAlt.criticalPath}
                </span>
              )}
            </p>
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="border-b border-[hsl(220_14%_89%)] text-xs text-[hsl(218_10%_42%)]">
                <tr>
                  <th className="px-3 py-2 font-medium">节点</th>
                  <th className="px-3 py-2 font-medium">标题</th>
                  <th className="px-3 py-2 font-medium">类型</th>
                  <th className="px-3 py-2 font-medium">状态</th>
                  <th className="px-3 py-2 font-medium">负责人</th>
                  <th className="px-3 py-2 font-medium">关键路径</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[hsl(220_14%_89%)]">
                {graphTextAlt.nodes.map((node) => (
                  <tr key={node.id}>
                    <td className="px-3 py-2 font-medium text-[hsl(220_14%_14%)]">
                      {node.id}
                    </td>
                    <td className="px-3 py-2 text-[hsl(218_10%_42%)]">{node.title}</td>
                    <td className="px-3 py-2">{node.type}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`rounded-md border px-2 py-1 text-xs font-medium ${toneClasses[statusTone(node.status)]}`}
                      >
                        {node.status}
                      </span>
                    </td>
                    <td className="px-3 py-2">{node.owner}</td>
                    <td className="px-3 py-2">{node.critical ? '是' : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {graphTextAlt.edges.length > 0 && (
              <div className="mt-3">
                <h4 className="mb-1 text-sm font-semibold text-[hsl(220_14%_14%)]">
                  依赖关系
                </h4>
                <ul className="space-y-1 text-sm text-[hsl(218_10%_42%)]">
                  {graphTextAlt.edges.map((edge) => (
                    <li key={edge.id}>
                      {edge.from} → {edge.to}
                      {edge.blocking ? '（阻塞）' : ''}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <pre className="mt-3 sr-only">{graphTextToPlainText(graphTextAlt)}</pre>
          </section>
        ) : (
        <div className="grid" style={{ gridTemplateColumns: `${sidebarWidth}px 6px 1fr` }}>
          <div
            className="max-h-[560px] overflow-y-auto border-r border-[hsl(220_14%_89%)] p-3"
            role="listbox"
            aria-label="节点列表"
            tabIndex={0}
            onKeyDown={handleListKeyDown}
          >
            {layout.nodes.length === 0 ? (
              <p className="p-3 text-sm text-[hsl(218_10%_42%)]">当前范围没有节点。</p>
            ) : (
              <div className="space-y-1.5">
                {sidebarNodes.map((node) => (
                  <button
                    key={node.id}
                    type="button"
                    tabIndex={0}
                    onClick={() => setSelectedNodeId(node.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        setSelectedNodeId(node.id);
                      }
                    }}
                    className={`w-full rounded-lg border px-3 py-2 text-left text-sm ${
                      selectedNodeId === node.id
                        ? 'border-blue-300 bg-blue-50'
                        : 'border-[hsl(220_14%_89%)] bg-white hover:bg-[hsl(220_14%_96%)]'
                    }`}
                  >
                    <span className="block font-medium text-[hsl(220_14%_14%)]">
                      {node.id}
                      {criticalNodeIds.has(node.id) && (
                        <span className="ml-1.5 rounded bg-amber-100 px-1 text-[10px] font-semibold text-amber-700">
                          关键路径
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-[hsl(218_10%_42%)]">
                      {node.title}
                    </span>
                  </button>
                ))}
                {sidebarHasMore && (
                  <button
                    type="button"
                    onClick={() => setNodeListLimit(nextProgressiveLimit(nodeListLimit))}
                    className="w-full rounded-lg border border-dashed border-[hsl(220_14%_89%)] px-3 py-2 text-center text-xs font-medium text-[hsl(218_10%_42%)] hover:bg-[hsl(220_14%_96%)]"
                  >
                    加载更多（{sidebarNodes.length} / {layout.nodes.length}）
                  </button>
                )}
              </div>
            )}
          </div>
          <div
            className="cursor-col-resize bg-[hsl(220_14%_89%)] hover:bg-blue-400"
            onMouseDown={startDrag}
            role="separator"
            aria-orientation="vertical"
            aria-label="调整侧边栏宽度"
            title="拖动调整列表宽度"
          />
          <div
            ref={viewportRef}
            className="h-[560px] p-2"
            tabIndex={0}
            onKeyDown={handleCanvasKeyDown}
            aria-label="因果图画布"
          >
            <TransformWrapper
              initialScale={0.85}
              minScale={0.35}
              maxScale={2.5}
              centerOnInit
              wheel={{ step: 0.08 }}
            >
              <TransformComponent wrapperStyle={{ width: '100%', height: '100%' }}>
                <GraphCanvas
                  layout={layout}
                  size={viewportSize}
                  selectedNodeId={selectedNodeId}
                  criticalNodeIds={criticalNodeIds}
                  onSelect={setSelectedNodeId}
                />
              </TransformComponent>
            </TransformWrapper>
          </div>
        </div>
        )}
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
    </QueryState>
  );
};

export default WorkGraphPanel;