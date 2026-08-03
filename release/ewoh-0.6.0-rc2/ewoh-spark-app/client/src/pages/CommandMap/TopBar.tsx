import { useState, useEffect, useRef } from 'react';
import { ArrowLeft, Cpu, Users, AlertTriangle, Zap, TrendingUp, Clock, Search } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { OverviewStats, CurrentWorldState, SpatialEntity } from '@shared/api.interface';
import { cn } from '@client/src/lib/utils';
import { UI_ARIA_LABELS } from '../../lib/a11y';

interface TopBarProps {
  overview: OverviewStats | null;
  worldState: CurrentWorldState | null;
  onBack: () => void;
  entities?: SpatialEntity[];
  onSelectEntity?: (id: string) => void;
  searchRef?: React.RefObject<HTMLInputElement | null>;
}

function KpiItem({
  icon: Icon,
  value,
  label,
  danger,
}: {
  icon: LucideIcon;
  value: string | number;
  label: string;
  danger?: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5 px-2.5 border-l border-white/10 first:border-l-0">
      <Icon className={cn('w-3.5 h-3.5 shrink-0', danger ? 'text-red-400' : 'text-white/70')} />
      <div className="flex flex-col leading-tight">
        <span
          className={cn(
            'text-sm font-semibold tabular-nums',
            danger ? 'text-red-400' : 'text-white',
          )}
        >
          {value}
        </span>
        <span className="text-[10px] text-white/70">{label}</span>
      </div>
    </div>
  );
}

const TopBar = ({ overview, onBack, entities, onSelectEntity, searchRef }: TopBarProps): React.ReactElement => {
  const [now, setNow] = useState<string>(() =>
    new Date().toLocaleTimeString('zh-CN', { hour12: false }),
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(new Date().toLocaleTimeString('zh-CN', { hour12: false }));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const eventOpen = overview?.eventOpen ?? 0;
  const eventCritical = overview?.eventCritical ?? 0;
  const avgLoadPct = ((overview?.avgLoad ?? 0) * 100).toFixed(0);

  const suggestions = searchQuery.trim()
    ? (entities ?? [])
        .filter(
          (e) =>
            e.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
            e.entityId.toLowerCase().includes(searchQuery.toLowerCase()),
        )
        .slice(0, 10)
    : [];

  const handleSelect = (id: string) => {
    onSelectEntity?.(id);
    setSearchQuery('');
    setShowSuggestions(false);
  };

  return (
    <div className="flex min-h-12 flex-wrap items-center gap-2 px-3 py-1.5 bg-[hsl(220_14%_10%)] border-b border-white/10 md:flex-nowrap md:gap-4 md:px-4">
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-white/80 hover:text-white hover:bg-white/10 transition-colors"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        返回
      </button>

      <div className="flex items-center gap-2">
        <div className="w-6 h-6 rounded bg-gradient-to-br from-[hsl(221_83%_53%)] to-[hsl(265_73%_55%)] flex items-center justify-center">
          <span className="text-[10px] font-bold text-white">E</span>
        </div>
        <span className="text-sm font-semibold text-white">EWOH 指挥地图</span>
      </div>

      {/* 搜索框 */}
      {entities && onSelectEntity && (
        <div ref={containerRef} className="relative w-full min-w-[120px] max-w-[280px] flex-1 md:w-56 md:flex-none">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/60" />
            <input
              ref={searchRef}
              type="text"
              value={searchQuery}
              aria-label={UI_ARIA_LABELS.searchEntities}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setShowSuggestions(true);
              }}
              onFocus={() => setShowSuggestions(true)}
              placeholder="搜索实体 (按 / 聚焦)"
              className="w-full pl-7 pr-2 py-1 text-xs bg-white/5 border border-white/10 rounded-md text-white placeholder:text-white/60 focus:outline-none focus:border-[hsl(221_83%_53%)]"
            />
          </div>
          {showSuggestions && suggestions.length > 0 && (
            <div className="absolute top-full left-0 right-0 mt-1 bg-[hsl(220_14%_14%)] border border-white/10 rounded-md shadow-xl z-50 max-h-60 overflow-y-auto">
              {suggestions.map((e) => (
                <button
                  key={e.entityId}
                  onClick={() => handleSelect(e.entityId)}
                  className="w-full text-left px-3 py-1.5 text-xs text-white/80 hover:bg-white/10 flex items-center gap-2"
                >
                  <span className="text-white/60 text-[10px] uppercase">{e.entityType.slice(0, 4)}</span>
                  <span className="flex-1 truncate">{e.name}</span>
                  <span className="text-white/60 text-[10px]">{e.entityId}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="hidden flex-1 md:block" />

      <div className="hidden items-center md:flex">
        <KpiItem
          icon={Cpu}
          value={`${overview?.deviceOnline ?? '-'}/${overview?.deviceTotal ?? '-'}`}
          label="在线设备"
        />
        <KpiItem icon={Users} value={overview?.workerCount ?? '-'} label="在岗人员" />
        <KpiItem
          icon={AlertTriangle}
          value={overview?.eventOpen ?? '-'}
          label="未结事件"
          danger={eventOpen > 0}
        />
        <KpiItem
          icon={Zap}
          value={overview?.eventCritical ?? '-'}
          label="严重事件"
          danger={eventCritical > 0}
        />
        <KpiItem icon={TrendingUp} value={`${avgLoadPct}%`} label="平均负荷" />
        <KpiItem icon={Clock} value={now} label="当前时间" />
      </div>
    </div>
  );
};

export default TopBar;
