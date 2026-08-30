import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Brain,
  Gauge,
  BatteryCharging,
  ShieldAlert,
  TrendingUp,
  AlertOctagon,
  Check,
  CheckCheck,
  Sparkles,
  Loader2,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  getBrainSuggestions,
  applyBrainSuggestion,
} from '@client/src/api/gamification';
import { getCurrentOperator } from '@client/src/lib/auth';
import type { BrainSuggestion } from '@shared/api.interface';
import { cn } from '@client/src/lib/utils';
import { Button } from '@client/src/components/ui/button';
import { Badge } from '@client/src/components/ui/badge';
import { ScrollArea } from '@client/src/components/ui/scroll-area';
import { errorDescription } from '@client/src/lib/errorContract';

type SuggestionType = BrainSuggestion['type'];

const TYPE_META: Record<
  SuggestionType,
  { label: string; icon: LucideIcon; color: string; ring: string }
> = {
  takt_improve: {
    label: '节拍优化',
    icon: Gauge,
    color: 'text-cyan-400',
    ring: 'border-cyan-500/40',
  },
  load_balance: {
    label: '负荷均衡',
    icon: TrendingUp,
    color: 'text-violet-400',
    ring: 'border-violet-500/40',
  },
  battery_swap: {
    label: '电池更换',
    icon: BatteryCharging,
    color: 'text-yellow-400',
    ring: 'border-yellow-500/40',
  },
  safety_intervene: {
    label: '安全干预',
    icon: ShieldAlert,
    color: 'text-red-400',
    ring: 'border-red-500/40',
  },
  bottleneck_resolve: {
    label: '瓶颈消解',
    icon: AlertOctagon,
    color: 'text-orange-400',
    ring: 'border-orange-500/40',
  },
};

function confidenceColor(c: number): string {
  if (c >= 0.8) return 'bg-green-500';
  if (c >= 0.5) return 'bg-yellow-500';
  return 'bg-red-500';
}

function SuggestionCard({
  suggestion,
  onAccept,
  accepting,
}: {
  suggestion: BrainSuggestion;
  onAccept: (s: BrainSuggestion) => void;
  accepting?: boolean;
}): React.ReactElement {
  const meta = TYPE_META[suggestion.type] ?? TYPE_META.takt_improve;
  const Icon = meta.icon;
  // CLI-039：confidence 判空/NaN 防护（缺失时显示 '—'，条宽 0）。
  const confidencePct =
    suggestion.confidence != null && Number.isFinite(suggestion.confidence)
      ? Math.round(suggestion.confidence * 100)
      : null;

  return (
    <div
      className={cn(
        'bg-card/5 rounded-lg p-3 border border-white/10',
        meta.ring,
      )}
    >
      <div className="flex items-start gap-2">
        <div
          className={cn(
            'w-7 h-7 shrink-0 rounded-md flex items-center justify-center bg-card/5',
          )}
        >
          <Icon className={cn('w-3.5 h-3.5', meta.color)} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium text-white/90 truncate">
              {suggestion.title}
            </span>
            <Badge
              variant="outline"
              className={cn('text-[9px] px-1 py-0', meta.color, 'border-white/20')}
            >
              {meta.label}
            </Badge>
          </div>
          <p className="mt-1 text-[10px] text-white/60 leading-relaxed line-clamp-3">
            {suggestion.description}
          </p>
        </div>
      </div>

      <div className="mt-2 flex items-center gap-2 text-[10px] text-white/70">
        <Sparkles className="w-3 h-3 text-cyan-400" />
        <span>预期收益:</span>
        <span className="text-white/80 truncate">{suggestion.expectedBenefit}</span>
      </div>

      <div className="mt-2">
        <div className="flex items-center justify-between text-[10px] text-white/60">
          <span>置信度</span>
          <span className="tabular-nums text-white/70">
            {confidencePct != null ? `${confidencePct}%` : '—'}
          </span>
        </div>
        <div className="mt-0.5 h-1.5 rounded-full bg-card/10 overflow-hidden">
          <div
            className={cn('h-full rounded-full', confidenceColor(suggestion.confidence))}
            style={{ width: `${confidencePct ?? 0}%` }}
          />
        </div>
      </div>

      {suggestion.affectedEntities.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {suggestion.affectedEntities.map((id) => (
            <span
              key={id}
              className="text-[9px] px-1.5 py-0.5 rounded bg-card/10 text-white/60"
            >
              {id}
            </span>
          ))}
        </div>
      )}

      <div className="mt-2 flex items-center justify-between">
        <span className="text-[9px] text-white/60">
          {suggestion.planId ? `方案: ${suggestion.planId}` : '无关联方案'}
        </span>
        <Button
          size="sm"
          variant="outline"
          className="h-5 text-[10px] px-2"
          onClick={() => onAccept(suggestion)}
          disabled={accepting}
          title={
            suggestion.planId
              ? '已有关联方案，点击定位到调度方案面板'
              : '采纳为一条待审批调度方案（由调度内核生成，可在调度方案面板审批）'
          }
        >
          {accepting ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <Check className="w-3 h-3" />
          )}
          {accepting ? '转化中...' : '采纳'}
        </Button>
      </div>
    </div>
  );
}

interface BrainPanelProps {
  onSelectPlan?: (planId: string) => void;
}

const BrainPanel = ({ onSelectPlan }: BrainPanelProps): React.ReactElement => {
  const queryClient = useQueryClient();
  const { data: suggestions, isLoading, isError } = useQuery<BrainSuggestion[]>({
    queryKey: ['brain-suggestions'],
    queryFn: getBrainSuggestions,
    refetchInterval: 10000,
  });

  const applyMutation = useMutation({
    mutationFn: (s: BrainSuggestion) =>
      applyBrainSuggestion({
        type: s.type,
        title: s.title,
        description: s.description,
        affectedEntities: s.affectedEntities,
        expectedBenefit: s.expectedBenefit,
        confidence: s.confidence,
        operator: getCurrentOperator(),
      }),
    onSuccess: (res, s) => {
      toast.success(`已采纳「${s.title}」，已生成方案 ${res.planId}`);
      queryClient.invalidateQueries({ queryKey: ['schedule-plans'] });
      onSelectPlan?.(res.planId);
    },
    onError: (err) =>
      toast.error('采纳失败', {
        description: errorDescription(err),
      }),
  });

  const handleAccept = (s: BrainSuggestion) => {
    if (s.planId && onSelectPlan) {
      onSelectPlan(s.planId);
      toast.success(`已采纳「${s.title}」，已定位到方案 ${s.planId}`);
      return;
    }
    if (s.planId) {
      toast.success(`已采纳「${s.title}」，关联方案 ${s.planId}`);
      return;
    }
    // 无关联方案：转化为一条待审批方案
    applyMutation.mutate(s);
  };

  // 任一建议携带 enhancing=true 时，展示「大模型增强中」提示
  const enhancing = (suggestions ?? []).some((s) => s.enhancing);

  // 分类筛选：'all' 或某一建议类型
  const [filter, setFilter] = useState<SuggestionType | 'all'>('all');
  const filtered = useMemo(
    () =>
      filter === 'all'
        ? (suggestions ?? [])
        : (suggestions ?? []).filter((s) => s.type === filter),
    [suggestions, filter],
  );

  // 一键全部采纳：对当前筛选下「无关联方案」的建议逐条提交（受后端去抖合并保护）；
  // 已有关联方案的仅提示定位。批量提交避免阻塞 UI。
  const handleAcceptAll = () => {
    const list = filtered;
    if (list.length === 0) return;
    const withoutPlan = list.filter((s) => !s.planId);
    const withPlan = list.filter((s) => s.planId);
    withoutPlan.forEach((s) => applyMutation.mutate(s));
    withPlan.forEach((s) => {
      if (onSelectPlan) {
        onSelectPlan(s.planId!);
        toast.success(`已采纳「${s.title}」，已定位到方案 ${s.planId}`);
      }
    });
    if (withoutPlan.length > 0) {
      toast.success(`已提交 ${withoutPlan.length} 条建议的采纳请求，请到调度方案面板审批`);
    }
  };

  const grouped = filtered.reduce<
    Record<SuggestionType, BrainSuggestion[]>
  >(
    (acc, s) => {
      (acc[s.type] ??= []).push(s);
      return acc;
    },
    {} as Record<SuggestionType, BrainSuggestion[]>,
  );

  const order: SuggestionType[] = [
    'safety_intervene',
    'bottleneck_resolve',
    'load_balance',
    'battery_swap',
    'takt_improve',
  ];

  return (
    <div className="h-full flex flex-col bg-[hsl(220_14%_14%)] text-white">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/10 shrink-0">
        <Brain className="w-3.5 h-3.5 text-violet-400" />
        <span className="text-xs font-medium text-white/80">大脑建议</span>
        <span className="ml-auto text-[10px] text-white/60 tabular-nums">
          {suggestions?.length ?? 0} 条
        </span>
      </div>

      {/* 使用说明：解释大脑建议的来源与「采纳」的作用，降低认知门槛 */}
      <div className="px-3 py-2 border-b border-white/10 bg-violet-500/5 text-[10px] text-white/60 leading-relaxed shrink-0">
        由实时遥测、安全事件与设备电量聚合生成，每 10 秒自动刷新。点击「采纳」可将其转化为一条
        <span className="text-violet-300"> 待审批调度方案</span>
        （若已有关联方案则直接定位），进入「调度方案」面板审批执行。
      </div>

      {/* 分类筛选 + 一键全部采纳 */}
      {suggestions && suggestions.length > 0 && (
        <div className="px-3 py-2 border-b border-white/10 shrink-0 space-y-2">
          <div className="flex items-center gap-1 flex-wrap">
            <button
              type="button"
              onClick={() => setFilter('all')}
              className={cn(
                'px-2 py-0.5 rounded-full text-[10px] transition-colors',
                filter === 'all'
                  ? 'bg-violet-500/30 text-violet-100 border border-violet-400/40'
                  : 'bg-card/5 text-white/60 border border-white/10 hover:text-white/80',
              )}
            >
              全部 ({suggestions.length})
            </button>
            {order.map((type) => {
              const count = (suggestions ?? []).filter((s) => s.type === type).length;
              if (count === 0) return null;
              const meta = TYPE_META[type];
              const Icon = meta.icon;
              return (
                <button
                  key={type}
                  type="button"
                  onClick={() => setFilter(type)}
                  className={cn(
                    'flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] transition-colors',
                    filter === type
                      ? 'bg-violet-500/30 text-violet-100 border border-violet-400/40'
                      : 'bg-card/5 text-white/60 border border-white/10 hover:text-white/80',
                  )}
                >
                  <Icon className={cn('w-2.5 h-2.5', meta.color)} />
                  {meta.label} ({count})
                </button>
              );
            })}
          </div>
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="outline"
              className="h-5 text-[10px] px-2"
              onClick={handleAcceptAll}
              disabled={applyMutation.isPending || filtered.length === 0}
              title="对当前筛选下的建议批量采纳（无关联方案的生成待审批方案）"
            >
              {applyMutation.isPending ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <CheckCheck className="w-3 h-3" />
              )}
              一键全部采纳
            </Button>
          </div>
        </div>
      )}

      {enhancing && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-cyan-500/20 bg-cyan-500/10 text-[10px] text-cyan-300 shrink-0">
          <Loader2 className="w-3 h-3 animate-spin" />
          正在调用大模型增强建议…
        </div>
      )}

      <ScrollArea className="flex-1">
        <div className="p-3">
          {isLoading ? (
            <div className="text-xs text-white/70 text-center py-4">加载中...</div>
          ) : isError ? (
            <div className="text-xs text-red-400 text-center py-4">加载失败</div>
          ) : !suggestions || suggestions.length === 0 ? (
            <div className="text-xs text-white/70 text-center py-4 space-y-1">
              <div>暂无 AI 建议</div>
              <div className="text-white/40 text-[10px]">
                当检测到高负荷、低电量或安全事件时会自动生成建议
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {order.map((type) => {
                const list = grouped[type] ?? [];
                if (list.length === 0) return null;
                const meta = TYPE_META[type];
                const Icon = meta.icon;
                return (
                  <div key={type}>
                    <div className="flex items-center gap-1.5 mb-1.5 px-1">
                      <Icon className={cn('w-3 h-3', meta.color)} />
                      <span className="text-[10px] text-white/60">{meta.label}</span>
                      <span className="text-[9px] text-white/60">({list.length})</span>
                    </div>
                    <div className="grid grid-cols-1 gap-2">
                      {list.map((s, i) => (
                        <SuggestionCard
                          key={s.suggestionId ?? `${s.title}-${i}`}
                          suggestion={s}
                          onAccept={handleAccept}
                          accepting={applyMutation.isPending}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
};

export default BrainPanel;
