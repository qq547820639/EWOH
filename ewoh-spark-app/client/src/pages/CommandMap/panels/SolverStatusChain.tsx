// panels/SolverStatusChain.tsx — 求解器状态链展示（Task 5 / P1）
//
// 只展示服务端 SchedulingPlanV2.solverStatus / solverVersion / fallbackReason /
// solveDurationMs 已知信息；状态缺失时不伪造链，仅显示已知版本。
// 链映射见 vm/solverStatusChainVM.ts（纯函数，node 可测）。

import { memo } from 'react';
import type { SolverStatus } from '@shared/api.interface';
import { cn } from '@client/src/lib/utils';
import { Badge } from '@client/src/components/ui/badge';
import { solverStatusChain, type SolverChainStep } from '../vm/solverStatusChainVM';

export interface SolverStatusChainProps {
  status?: SolverStatus | null;
  solverVersion?: string | null;
  fallbackReason?: string | null;
  solveDurationMs?: number | null;
  className?: string;
}

const STEP_CLASSES: Record<SolverChainStep['kind'], string> = {
  primary: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  failed: 'bg-red-500/20 text-red-400 border-red-500/30',
  fallback: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  result: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
};

/** 求解器状态链（CP-SAT 请求 → 状态 → 启发式回退；仅展示服务端已知信息）。 */
export function SolverStatusChain({
  status,
  solverVersion,
  fallbackReason,
  solveDurationMs,
  className = '',
}: SolverStatusChainProps): React.ReactElement | null {
  const chain = solverStatusChain(status);
  if (!chain) {
    // 无状态/未知状态：不伪造链，只显示已知的求解器版本（若有）。
    if (!solverVersion) return null;
    return (
      <span
        className={cn('inline-flex items-center gap-1 text-[9px] text-white/55', className)}
        title="求解器状态缺失（服务端未返回），仅显示已知版本"
      >
        <Badge variant="outline" className="border-white/10 px-1 py-0 text-[9px] text-white/60">
          求解器 {solverVersion}
        </Badge>
      </span>
    );
  }
  return (
    <span
      className={cn('inline-flex items-center gap-1 text-[9px]', className)}
      title={`求解器版本 ${solverVersion ?? '—'}${fallbackReason ? `；回退原因 ${fallbackReason}` : ''}${solveDurationMs != null ? `；求解耗时 ${solveDurationMs}ms` : ''}`}
    >
      <span className="text-white/40">Solver:</span>
      {chain.map((step, i) => (
        <span key={step.key} className="inline-flex items-center gap-1">
          {i > 0 && <span className="text-white/35">→</span>}
          <Badge variant="outline" className={cn('px-1 py-0 text-[9px]', STEP_CLASSES[step.kind])}>
            {step.label}
          </Badge>
        </span>
      ))}
      {solveDurationMs != null && (
        <span className="tabular-nums text-white/45">{solveDurationMs}ms</span>
      )}
    </span>
  );
}

export default memo(SolverStatusChain);
