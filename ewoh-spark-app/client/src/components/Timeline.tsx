import { useState } from 'react';
import { Link2, Copy, ChevronDown, ChevronRight, Download } from 'lucide-react';
import { toast } from 'sonner';
import type { TimelineEvent } from '../lib/timelineModel';
import { cn } from '../lib/utils';
import { DISPLAY_TIME_OPTS } from '../lib/intl';
import { sanitizeUrl } from '../lib/urlSafety';
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
  workflow: 'bg-risk-conflict-soft text-risk-conflict-foreground border-risk-conflict-border',
  alert: 'bg-risk-blocked-soft text-risk-blocked-foreground border-risk-blocked-border',
  device: 'bg-risk-offline-soft text-risk-offline-foreground border-risk-offline-border',
  system: 'bg-risk-unknown-soft text-risk-unknown-foreground border-risk-unknown-border',
  user: 'bg-risk-normal-soft text-risk-normal-foreground border-risk-normal-border',
  edge: 'bg-risk-degraded-soft text-risk-degraded-foreground border-risk-degraded-border',
  evidence: 'bg-info/10 text-primary border-info/30',
};

// ADR-027 规范词表：critical=红 / high=橙 / medium=黄 / low=绿 / unknown=灰。
function severityClass(severity?: string): string {
  switch (severity) {
    case 'critical':
      return 'bg-destructive';
    case 'high':
      return 'bg-warning';
    case 'medium':
      return 'bg-warning/60';
    case 'low':
      return 'bg-success';
    default:
      return 'bg-muted-foreground';
  }
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // CLI-329：全站展示统一 Asia/Shanghai 时区，不随浏览器本地时区漂移（配置见 @/lib/intl）。
  return d.toLocaleString('zh-CN', DISPLAY_TIME_OPTS);
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

  const copyId = async (id: string) => {
    // CLI-308：主路径与回退路径统一写入 tl:${id}，消除行为分裂。
    const text = `tl:${id}`;
    // CLI-309：仅保留 Clipboard API，不可用/失败时提示手动复制，
    // 不再回退到已废弃的 document.execCommand('copy')。
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
      }
    } catch {
      // 落入下方失败提示
    }
    toast.error('复制失败，请手动复制');
  };

  if (events.length === 0) {
    return (
      <div className={cn('text-sm text-muted-foreground py-8 text-center', className)}>
        暂无时间线事件
      </div>
    );
  }

  return (
    <div className={cn('space-y-3', className)}>
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-foreground">
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

      <ol className="relative space-y-2 border-l border-border pl-4">
        {events.map((ev) => (
          <li key={ev.id} id={`tl-${ev.id}`} className="relative">
            <span
              /* R2-CC2-002：时间轴节点描边 ring-white→ring-background 令牌（dark 下白描边刺眼且与表面冲突）。 */
              className={cn(
                'absolute -left-[23px] top-1.5 w-2.5 h-2.5 rounded-full ring-2 ring-background',
                severityClass(ev.severity),
              )}
            />
            {/* R2-CC2-002：事件卡片表面 bg-card→bg-card 令牌（dark 主题可读）。 */}
            <div className="rounded-lg border border-border bg-card p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <a
                      href={`#tl-${ev.id}`}
                      aria-label={`锚定到事件 ${ev.id}`}
                      className="inline-flex items-center text-xs font-mono text-primary hover:underline"
                    >
                      <Link2 className="w-3 h-3 mr-1" />
                      {ev.id}
                    </a>
                    <Badge className={cn('text-[9px] px-1.5 py-0', SOURCE_STYLES[ev.source] ?? SOURCE_STYLES.system)}>
                      {SOURCE_LABELS[ev.source] ?? ev.source}
                    </Badge>
                    {ev.severity && (
                      <Badge variant="outline" className="text-[9px] px-1.5 py-0 text-muted-foreground">
                        {ev.severity}
                      </Badge>
                    )}
                    {ev.status && (
                      <Badge variant="outline" className="text-[9px] px-1.5 py-0 text-muted-foreground">
                        {ev.status}
                      </Badge>
                    )}
                  </div>
                  <div className="mt-1 text-sm font-medium text-foreground">
                    {ev.title ?? `${ev.objectType} · ${ev.action}`}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {formatTime(ev.timestamp)} · {ev.objectType} · {ev.objectId} · 执行者 {ev.actor}
                    {ev.riskLevel ? ` · 风险 ${ev.riskLevel}` : ''}
                  </div>
                  {ev.action && (
                    <div className="mt-1 text-xs text-muted-foreground">
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
                    <div className="mt-0.5 text-[10px] text-muted-foreground">
                      关联：{ev.correlationId}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => copyId(ev.id)}
                    aria-label={`复制事件 ID ${ev.id}`}
                    className="rounded p-1.5 text-muted-foreground hover:bg-muted"
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </button>
                  {ev.evidence.length > 0 && (
                    <button
                      type="button"
                      onClick={() => toggle(ev.id)}
                      aria-expanded={isExpanded(ev.id)}
                      aria-label={`切换证据预览（${ev.evidence.length} 条）`}
                      className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[10px] font-medium text-primary hover:bg-muted"
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
                <div className="mt-2 rounded bg-muted p-2 text-xs">
                  {ev.evidence.map((e) => {
                    // CLI-301：evidence.url 来自后端/离线数据，仅白名单协议
                    // （http/https/mailto/tel，相对路径放行）才渲染为链接，
                    // 危险 scheme（javascript:/data: 等）降级为纯文本。
                    const safeUrl = sanitizeUrl(e.url);
                    return (
                    <div key={e.id} className="flex items-center gap-2 py-0.5">
                      <span className="font-mono text-muted-foreground">{e.id}</span>
                      {e.type && <span className="text-muted-foreground">[{e.type}]</span>}
                      {e.label && <span className="text-foreground">{e.label}</span>}
                      {safeUrl ? (
                        <a
                          href={safeUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="ml-auto text-primary hover:underline"
                        >
                          查看
                        </a>
                      ) : e.url ? (
                        <span
                          className="ml-auto max-w-40 truncate font-mono text-muted-foreground"
                          title={e.url}
                        >
                          {e.url}
                        </span>
                      ) : e.ref ? (
                        <span className="ml-auto font-mono text-muted-foreground">{e.ref}</span>
                      ) : null}
                    </div>
                    );
                  })}
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
