import {
  Factory,
  Users,
  Cpu,
  Activity,
  AlertTriangle,
  Smartphone,
  Thermometer,
  GitBranch,
  ShieldCheck,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@client/src/lib/utils';

interface ModePanelProps {
  mode: string;
  onModeChange: (m: string) => void;
  level: 'L0' | 'L1' | 'L2' | 'L3' | 'L4';
  onLevelChange: (l: 'L0' | 'L1' | 'L2' | 'L3' | 'L4') => void;
}

interface ModeItem {
  key: string;
  name: string;
  desc: string;
  icon: LucideIcon;
  color: string;
}

export const MODES: ModeItem[] = [
  { key: 'production', name: '生产', desc: '工位产出状态', icon: Factory, color: '#3b82f6' },
  { key: 'person', name: '人员', desc: '人员位置分布', icon: Users, color: '#06b6d4' },
  { key: 'exoskeleton', name: '外骨骼', desc: '外骨骼装备与佩戴', icon: Cpu, color: '#8b5cf6' },
  { key: 'body_load', name: '人体负荷', desc: '负荷健康度', icon: Activity, color: '#f59e0b' },
  { key: 'safety_risk', name: '安全风险', desc: '事件风险区', icon: AlertTriangle, color: '#ef4444' },
  { key: 'device', name: '设备', desc: '设备运行态', icon: Smartphone, color: '#10b981' },
  { key: 'environment', name: '环境', desc: '温湿度态势', icon: Thermometer, color: '#22d3ee' },
  { key: 'scheduling', name: '调度', desc: '调度方案影响', icon: GitBranch, color: '#a855f7' },
  { key: 'data_quality', name: '数据质量', desc: '置信度评估', icon: ShieldCheck, color: '#eab308' },
];

const ModePanel = ({
  mode,
  onModeChange,
  level,
  onLevelChange,
}: ModePanelProps): React.ReactElement => {
  return (
    <div className="hidden w-[180px] shrink-0 flex-col overflow-y-auto border-r border-white/10 bg-[hsl(220_14%_14%)] md:flex">
      <div className="px-3 py-3 border-b border-white/10">
        <h2 className="text-xs font-semibold text-white/80 uppercase tracking-wide">地图模式</h2>
      </div>

      <div className="flex-1 p-2 space-y-1">
        {MODES.map((m) => {
          const active = mode === m.key;
          const Icon = m.icon;
          return (
            <button
              key={m.key}
              onClick={() => onModeChange(m.key)}
              aria-pressed={active}
              aria-label={`切换到${m.name}模式`}
              className={cn(
                'relative w-full flex items-start gap-2 px-2.5 py-2 rounded-md text-left transition-colors',
                active ? 'bg-white/10' : 'hover:bg-white/5',
              )}
            >
              {active && (
                <span
                  className="absolute left-0 top-1 bottom-1 w-0.5 rounded-full"
                  style={{ backgroundColor: m.color }}
                />
              )}
              <Icon
                className="w-4 h-4 mt-0.5 shrink-0"
                style={{ color: active ? m.color : 'rgba(255,255,255,0.5)' }}
              />
              <div className="flex flex-col leading-tight min-w-0">
                <span
                  className={cn(
                    'text-xs font-medium',
                    active ? 'text-white' : 'text-white/70',
                  )}
                >
                  {m.name}
                </span>
                <span className="text-[10px] text-white/60 truncate">{m.desc}</span>
              </div>
            </button>
          );
        })}
      </div>

      <div className="p-2 border-t border-white/10">
        <div className="text-[10px] text-white/60 px-1 mb-1.5 uppercase tracking-wide">
          建模层级
        </div>
        <div className="flex gap-1">
          {(['L0', 'L1', 'L2', 'L3', 'L4'] as const).map((l) => (
            <button
              key={l}
              onClick={() => onLevelChange(l)}
              aria-pressed={level === l}
              aria-label={`切换到${l}层级`}
              className={cn(
                'flex-1 py-1.5 rounded-md text-xs font-medium transition-colors',
                level === l
                  ? 'bg-[hsl(221_83%_53%)] text-white'
                  : 'bg-white/5 text-white/60 hover:bg-white/10',
              )}
            >
              {l}
            </button>
          ))}
        </div>
        <p className="text-[10px] text-white/60 mt-1.5 px-0.5 leading-snug">
          L0 基础结构 · L1 感知/动态 · L2 全量态势 · L3 工位近景 · L4 人员跟随
        </p>
      </div>
    </div>
  );
};

export default ModePanel;
