// panels/TaskMoveExplain.tsx — 'Why did this task move?' 视图（Task 5 / P1）
//
// 输入 = 服务端 PlanAssignmentDiff / ReplanImpact / DecisionTrace（经 taskMoveExplainVM
// 纯函数装配），输出 = old→new 分配 + 服务端顺序原因链 + 未变化任务数。
// 前端不推导因果：原因链严格按服务端给出的顺序渲染（无 diff 数据时显示空态）。

import { memo } from 'react';
import type { TaskMoveExplainVM } from '../vm/taskMoveExplainVM';

export interface TaskMoveExplainProps {
  vm: TaskMoveExplainVM | null;
  /** 人员 id → 姓名（可空；缺省显示原始 id）。 */
  personNameOf?: (id: string | null) => string | null;
  className?: string;
}

function fmtResource(
  view: TaskMoveExplainVM['old'],
  personNameOf?: (id: string | null) => string | null,
): string {
  const parts: string[] = [];
  if (view.personId) parts.push(personNameOf?.(view.personId) ?? view.personId);
  if (view.deviceId) parts.push(view.deviceId);
  if (view.stationId) parts.push(view.stationId);
  return parts.length > 0 ? parts.join(' / ') : '未分配';
}

function resourceChanged(vm: TaskMoveExplainVM): string {
  const parts: string[] = [];
  if (vm.changed.person) parts.push('人员');
  if (vm.changed.device) parts.push('设备');
  if (vm.changed.station) parts.push('工位');
  return parts.length > 0 ? `${parts.join('/')}变更` : '未变（仅时间/其他）';
}

const ORIGIN_LABELS: Record<TaskMoveExplainVM['causeChain'][number]['origin'], string> = {
  trigger: '触发',
  diff: '方案',
  trace: '求解',
};

/** 任务移动解释块：old→new + 服务端顺序原因链 + 未变化任务数。 */
export function TaskMoveExplain({
  vm,
  personNameOf,
  className = '',
}: TaskMoveExplainProps): React.ReactElement {
  if (!vm) {
    return (
      <div className={`rounded-md border border-white/10 bg-card/5 px-2 py-2 text-[10px] text-white/50 ${className}`}>
        无任务移动 diff 数据（选择已被重排/对比过的任务后可查看原因链）。
      </div>
    );
  }
  return (
    <div className={`space-y-1.5 rounded-md border border-white/10 bg-card/5 px-2 py-2 ${className}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px]">
        <span className="font-semibold text-white/90">{vm.taskId ?? '任务'}</span>
        <span className="text-white/40">Old:</span>
        <span className="text-white/70">{fmtResource(vm.old, personNameOf)}</span>
        <span className="text-white/40">→</span>
        <span className="text-white/40">New:</span>
        <span className="font-medium text-risk-offline-foreground">{fmtResource(vm.current, personNameOf)}</span>
        <span className="ml-auto rounded border border-white/10 px-1 py-0 text-[9px] text-white/55">
          {resourceChanged(vm)}
        </span>
      </div>
      {vm.triggerType && (
        <div className="text-[9px] text-white/50">
          触发类型：<span className="text-white/70">{vm.triggerType}</span>
        </div>
      )}
      {vm.causeChain.length > 0 ? (
        <div className="text-[9px] text-white/60">
          <span className="text-white/40">原因链：</span>
          {vm.causeChain.map((step, i) => (
            <span key={`${step.origin}-${i}`} className="inline-flex items-center gap-1">
              {i > 0 && <span className="text-white/30">→</span>}
              <span title={`${step.code}（${ORIGIN_LABELS[step.origin]}）`}>
                {step.label}
                <span className="ml-0.5 text-white/30">[{ORIGIN_LABELS[step.origin]}]</span>
              </span>
            </span>
          ))}
        </div>
      ) : (
        <div className="text-[9px] text-white/40">原因链：服务端未返回原因</div>
      )}
      <div className="flex flex-wrap items-center gap-2 text-[9px] text-white/55">
        <span>
          未变化任务：
          {vm.unchangedTaskCount != null ? (
            <span className="font-semibold text-risk-normal-foreground">{vm.unchangedTaskCount}</span>
          ) : (
            '—'
          )}
        </span>
        {vm.unchangedTaskIds.length > 0 && (
          <span className="text-white/40">
            {vm.unchangedTaskIds.slice(0, 8).join('、')}
            {vm.unchangedTaskIds.length > 8 ? ` 等 ${vm.unchangedTaskIds.length} 个` : ''}
          </span>
        )}
        <span className="text-white/40">·</span>
        <span>
          变更任务：
          {vm.changedTaskCount != null ? (
            <span className="font-semibold text-white/80">{vm.changedTaskCount}</span>
          ) : (
            '—'
          )}
        </span>
      </div>
    </div>
  );
}

export default memo(TaskMoveExplain);
