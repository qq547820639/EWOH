import { useQuery } from '@tanstack/react-query';
import {
  Brain,
  Gauge,
  BatteryCharging,
  ShieldAlert,
  TrendingUp,
  AlertOctagon,
  Check,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { getBrainSuggestions } from '@client/src/api/gamification';
import type { BrainSuggestion } from '@shared/api.interface';
import { cn } from '@client/src/lib/utils';
import { Button } from '@client/src/components/ui/button';
import { Badge } from '@client/src/components/ui/badge';
import { ScrollArea } from '@client/src/components/ui/scroll-area';

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
}: {
  suggestion: BrainSuggestion;
  onAccept: (s: BrainSuggestion) => void;
}): React.ReactElement {
  const meta = TYPE_META[suggestion.type] ?? TYPE_META.takt_improve;
  const Icon = meta.icon;
  const confidencePct = Math.round(suggestion.confidence * 100);

  return (
    <div
      className={cn(
        'bg-white/5 rounded-lg p-3 border border-white/10',
        meta.ring,
      )}
    >
      <div className="flex items-start gap-2">
        <div
          className={cn(
            'w-7 h-7 shrink-0 rounded-md flex items-center justify-center bg-white/5',
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
          <span className="tabular-nums text-white/70">{confidencePct}%</span>
        </div>
        <div className="mt-0.5 h-1.5 rounded-full bg-white/10 overflow-hidden">
          <div
            className={cn('h-full rounded-full', confidenceColor(suggestion.confidence))}
            style={{ width: `${confidencePct}%` }}
          />
        </div>
      </div>

      {suggestion.affectedEntities.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {suggestion.affectedEntities.map((id) => (
            <span
              key={id}
              className="text-[9px] px-1.5 py-0.5 rounded bg-white/10 text-white/60"
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
        >
          <Check className="w-3 h-3" />
          采纳
        </Button>
      </div>
    </div>
  );
}

const BrainPanel = (): React.ReactElement => {
  const { data: suggestions, isLoading, isError } = useQuery<BrainSuggestion[]>({
    queryKey: ['brain-suggestions'],
    queryFn: getBrainSuggestions,
    refetchInterval: 10000,
  });

  const handleAccept = (s: BrainSuggestion) => {
    if (s.planId) {
      toast.success(`已采纳「${s.title}」，跳转方案 ${s.planId}`);
    } else {
      toast.info(`已采纳「${s.title}」`);
    }
  };

  const grouped = (suggestions ?? []).reduce<
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

      <ScrollArea className="flex-1">
        <div className="p-3">
          {isLoading ? (
            <div className="text-xs text-white/70 text-center py-4">加载中...</div>
          ) : isError ? (
            <div className="text-xs text-red-400 text-center py-4">加载失败</div>
          ) : !suggestions || suggestions.length === 0 ? (
            <div className="text-xs text-white/70 text-center py-4">
              暂无 AI 建议
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
                          key={`${s.title}-${i}`}
                          suggestion={s}
                          onAccept={handleAccept}
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
