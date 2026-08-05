import { useState } from 'react';
import { Link2, Copy, ChevronDown, ChevronRight, Download } from 'lucide-react';
import type { TimelineEvent } from '../lib/timelineModel';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { Badge } from './ui/badge';

/**
 * 统一对象时间线组件。
 *
 * 只消费统一的 TimelineEvent 模型（见 lib/timelineModel.ts），不支持其他
 * 拼装结构。提供：锚点链接（hash 到事件 id）、证据预览切换、复制 id 按钮、
 * 审计导出（CSV / JSON 下载）。
 */

const SOURCE_LABELS: Record<string, string> = {
  workflow: '工作流',
  alert: '告警',
  device: '设备',
  system: '系统',
  user: '用户',
  edge: '边缘',
  evidence: '证据',
};

const SOURCE_STYLES: Record<string, string> = {
  workflow: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
  alert: 'bg-red-500/15 text-red-300 border-red-500/30',
  device: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30',
  system: 'bg-gray-500/15 text-gray-300 border-gray-500/30',
  user: 'bg-green-500/15 text-green-300 border-green-500/30',
  edge: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  evidence: 'bg-blue-500/15 text-blue-300 border-blue-500/30',
};

function severityClass(severity?: string): string {
  switch (severity) {
    case 'L3':
      return 'bg-red-500';
    case 'L2':
      return 'bg-orange-500';
    case 'L1':
      return 'bg-green-500';
    default:
      return 'bg-gray-500';
  }
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN', { hour12: false });
}

/** 序列化统一时间线事件为行对象（用于 CSV/JSON 导出）。 */
export function serializeTimelineEvents(events: TimelineEvent[]): Record<string, unknown>[] {
  return events.map((ev) => ({
    id: ev.id,
    timestamp: ev.timestamp,
    actor: ev.actor,
    source: ev.source,
    objectType: ev.objectType,
    objectId: ev.objectId,
    action: ev.action,
    previousState: ev.previousState,
    currentState: ev.currentState,
    correlationId: ev.correlationId,
    causationId: ev.causationId,
    permissionVisibility: ev.permissionVisibility,
    severity: ev.severity ?? '',
    title: ev.title ?? '',
    status: ev.status ?? '',
    riskLevel: ev.riskLevel ?? '',
    evidenceCount: ev.evidence.length,
    credibilitySource: ev.credibility.sourceType ?? '',
  }));
}

/** 导出为 CSV（含表头）。 */
export function exportTimelineCsv(events: TimelineEvent[]): string {
  const rows = serializeTimelineEvents(events);
  const headers = [
    'id',
    'timestamp',
    'actor',
    'source',
    'objectType',
    'objectId',
    'action',
    'previousState',
    'currentState',
    'correlationId',
    'causationId',
    'permissionVisibility',
    'severity',
    'title',
    'status',
    'riskLevel',
    'evidenceCount',
    'credibilitySource',
  ];
  const escape = (v: unknown): string => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escape(row[h])).join(','));
  }
  return lines.join('\n');
}

/** 导出为 JSON（格式化）。 */
export function exportTimelineJson(events: TimelineEvent[]): string {
  return JSON.stringify(serializeTimelineEvents(events), null, 2);
}

/** 触发浏览器下载。 */
export function downloadTextFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export interface TimelineProps {
  events: TimelineEvent[];
  /** 默认展开证据预览的事件 id 集合（受控时可传）。 */
  expandedIds?: string[];
  className?: string;
}

export default function Timeline({
  events,
  expandedIds,
  className,
}: TimelineProps): React.ReactElement {
  const [internalExpanded, setInternalExpanded] = useState<Set<string>>(new Set());

  const isExpanded = (id: string): boolean =>
    expandedIds ? expandedIds.includes(id) : internalExpanded.has(id);

  const toggle = (id: string) => {
    if (expandedIds) return; // 受控模式由外部管理
    setInternalExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const copyId = (id: string) => {
    const text = `tl:${id}`;
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(id);
    } else {
      // 兼容非安全上下文
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } finally {
        document.body.removeChild(ta);
      }
    }
  };

  if (events.length === 0) {
    return (
      <div className={cn('text-sm text-[hsl(218_10%_42%)] py-8 text-center', className)}>
        暂无时间线事件
      </div>
    );
  }

  return (
    <div className={cn('space-y-3', className)}>
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-[hsl(220_14%_14%)]">
          对象时间线（{events.length}）
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => downloadTextFile('timeline-audit.csv', exportTimelineCsv(events), 'text/csv')}
          >
            <Download className="w-3 h-3 mr-1" />
            导出 CSV
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() =>
              downloadTextFile('timeline-audit.json', exportTimelineJson(events), 'application/json')
            }
          >
            <Download className="w-3 h-3 mr-1" />
            导出 JSON
          </Button>
        </div>
      </div>

      <ol className="relative space-y-2 border-l border-[hsl(220_14%_89%)] pl-4">
        {events.map((ev) => (
          <li key={ev.id} id={`tl-${ev.id}`} className="relative">
            <span
              className={cn(
                'absolute -left-[23px] top-1.5 w-2.5 h-2.5 rounded-full ring-2 ring-white',
                severityClass(ev.severity),
              )}
            />
            <div className="rounded-lg border border-[hsl(220_14%_89%)] bg-white p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <a
                      href={`#tl-${ev.id}`}
                      aria-label={`锚定到事件 ${ev.id}`}
                      className="inline-flex items-center text-xs font-mono text-[hsl(221_83%_53%)] hover:underline"
                    >
                      <Link2 className="w-3 h-3 mr-1" />
                      {ev.id}
                    </a>
                    <Badge className={cn('text-[9px] px-1.5 py-0', SOURCE_STYLES[ev.source] ?? SOURCE_STYLES.system)}>
                      {SOURCE_LABELS[ev.source] ?? ev.source}
                    </Badge>
                    {ev.severity && (
                      <Badge variant="outline" className="text-[9px] px-1.5 py-0 text-[hsl(218_10%_42%)]">
                        {ev.severity}
                      </Badge>
                    )}
                    {ev.status && (
                      <Badge variant="outline" className="text-[9px] px-1.5 py-0 text-[hsl(218_10%_42%)]">
                        {ev.status}
                      </Badge>
                    )}
                  </div>
                  <div className="mt-1 text-sm font-medium text-[hsl(220_14%_14%)]">
                    {ev.title ?? `${ev.objectType} · ${ev.action}`}
                  </div>
                  <div className="mt-0.5 text-xs text-[hsl(218_10%_42%)]">
                    {formatTime(ev.timestamp)} · {ev.objectType} · {ev.objectId} · 执行者 {ev.actor}
                    {ev.riskLevel ? ` · 风险 ${ev.riskLevel}` : ''}
                  </div>
                  {ev.action && (
                    <div className="mt-1 text-xs text-[hsl(218_10%_42%)]">
                      动作：{ev.action}
                      {ev.previousState != null && ev.currentState != null
                        ? `（${ev.previousState} → ${ev.currentState}）`
                        : ev.previousState != null
                          ? `（${ev.previousState} → —）`
                          : ev.currentState != null
                            ? `（— → ${ev.currentState}）`
                            : ''}
                    </div>
                  )}
                  {ev.correlationId && (
                    <div className="mt-0.5 text-[10px] text-[hsl(218_10%_42%)]">
                      关联：{ev.correlationId}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => copyId(ev.id)}
                    aria-label={`复制事件 ID ${ev.id}`}
                    className="rounded p-1.5 text-[hsl(218_10%_42%)] hover:bg-[hsl(220_14%_96%)]"
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </button>
                  {ev.evidence.length > 0 && (
                    <button
                      type="button"
                      onClick={() => toggle(ev.id)}
                      aria-expanded={isExpanded(ev.id)}
                      aria-label={`切换证据预览（${ev.evidence.length} 条）`}
                      className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[10px] font-medium text-[hsl(221_83%_53%)] hover:bg-[hsl(220_14%_96%)]"
                    >
                      {isExpanded(ev.id) ? (
                        <ChevronDown className="w-3 h-3" />
                      ) : (
                        <ChevronRight className="w-3 h-3" />
                      )}
                      证据（{ev.evidence.length}）
                    </button>
                  )}
                </div>
              </div>

              {ev.evidence.length > 0 && isExpanded(ev.id) && (
                <div className="mt-2 rounded bg-[hsl(220_14%_96%)] p-2 text-xs">
                  {ev.evidence.map((e) => (
                    <div key={e.id} className="flex items-center gap-2 py-0.5">
                      <span className="font-mono text-[hsl(218_10%_42%)]">{e.id}</span>
                      {e.type && <span className="text-[hsl(218_10%_42%)]">[{e.type}]</span>}
                      {e.label && <span className="text-[hsl(220_14%_14%)]">{e.label}</span>}
                      {e.url ? (
                        <a
                          href={e.url}
                          target="_blank"
                          rel="noreferrer"
                          className="ml-auto text-[hsl(221_83%_53%)] hover:underline"
                        >
                          查看
                        </a>
                      ) : e.ref ? (
                        <span className="ml-auto font-mono text-[hsl(218_10%_42%)]">{e.ref}</span>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
