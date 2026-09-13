/* M05：Task Intelligence 面板（08 §10）。
 *
 * 消费 GET /api/scheduler/tasks/:taskId/candidates（TaskCandidatesResponse）与
 * assignment.decisionTrace。**只渲染服务端数据，禁止重算 hard constraints**——
 * 本文件不 import 任何资格/成本判定逻辑；所有 eligible/reject/score 均由后端透传。
 */
import React from 'react';
import { rejectReasonLabel } from '@shared/reject-reason';
import type {
  CandidateExplainVM,
  CandidateExplainItem,
} from '../vm/candidateExplainVM';
import type { DecisionExplainVM } from '../vm/decisionExplainVM';

interface TaskIntelligencePanelProps {
  taskId: string | null;
  candidates: CandidateExplainVM | null;
  decision: DecisionExplainVM | null;
  loading?: boolean;
}

/**
 * 候选拒绝原因文案：唯一来源 `shared/reject-reason.ts`。
 * （此前本面板自建一张 3 条的映射表，与 candidateExplainVM/conflict-panel 漂移。）
 */
function reasonLabel(reason: string): string {
  return rejectReasonLabel(reason);
}

/** 候选行（展示模型，后端字段透传）。 */
function CandidateRow({ c }: { c: CandidateExplainItem }) {
  return (
    <tr className="border-t border-slate-800 text-xs">
      <td className="px-2 py-1">{c.rank ?? '—'}</td>
      <td className="px-2 py-1">{c.personName}</td>
      <td className="px-2 py-1">{c.deviceId ?? '—'}</td>
      <td className="px-2 py-1">{c.stationId ?? '—'}</td>
      <td className="px-2 py-1">
        {Number.isFinite(c.score) ? c.score.toFixed(1) : '∞'}
      </td>
      {/* CLI-032：eta/distance 判空兜底（后端缺失时显示 '—' 而非 'NaNs/NaNm'）。 */}
      <td className="px-2 py-1">{c.etaSeconds != null ? `${c.etaSeconds}s` : '—'}</td>
      <td className="px-2 py-1">{c.distanceMeters != null ? `${c.distanceMeters}m` : '—'}</td>
      <td className="px-2 py-1">
        {c.batteryPct != null ? `${c.batteryPct}%` : '—'}
      </td>
      <td className="px-2 py-1">
        {c.rejectReasons.length > 0
          ? c.rejectReasons.map(reasonLabel).join(', ')
          : '—'}
        {c.capabilityNotes.length > 0 && (
          <div className="mt-0.5 text-[10px] text-muted-foreground">
            {c.capabilityNotes.join('；')}
          </div>
        )}
        {/* NO-38b：人机同体配对的正向说明（为什么只有这位人员能承接该设备） */}
        {c.sessionNotes.length > 0 && (
          <div className="mt-0.5 text-[10px] text-muted-foreground" data-testid={`candidate-session-note-${c.personId}`}>
            {c.sessionNotes.join('；')}
          </div>
        )}
      </td>
    </tr>
  );
}

/** Task Intelligence 面板：只读展示后端 TaskCandidatesResponse + DecisionTrace。 */
export function TaskIntelligencePanel({
  taskId,
  candidates,
  decision,
  loading = false,
}: TaskIntelligencePanelProps): React.ReactElement | null {
  if (!taskId) return null;
  if (loading) {
    return (
      <div className="p-3 text-xs text-slate-400" data-testid="task-intelligence-loading">
        加载任务智能…
      </div>
    );
  }
  if (!candidates && !decision) return null;

  return (
    <div className="space-y-3 p-3" data-testid="task-intelligence-panel">
      <div className="text-sm font-medium text-slate-200">
        任务智能：{taskId}
        {candidates?.taskTitle ? ` · ${candidates.taskTitle}` : ''}
      </div>

      {/* Priority Rank / Breakdown（服务端 DecisionTrace 透传） */}
      {decision && (
        <section className="rounded border border-slate-800 bg-slate-900/50 p-2">
          <div className="text-xs font-semibold text-slate-300">优先级（服务端）</div>
          <div className="mt-1 text-xs text-slate-300">
            级别：{decision.priorityLevel} · 分：{decision.priorityScore ?? '—'}
          </div>
          {decision.priorityFactors.length > 0 && (
            <table className="mt-1 w-full text-xs">
              <tbody>
                {decision.priorityFactors.map((f) => (
                  <tr key={f.key} className="border-t border-slate-800">
                    <td className="px-1 py-0.5 text-slate-400">{f.label}</td>
                    <td className="px-1 py-0.5 text-right text-slate-300">{f.value.toFixed(3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="mt-1 text-xs text-slate-400">
            当前分配：{decision.selected.personId ?? '—'} /{' '}
            {decision.selected.deviceId ?? '—'} / {decision.selected.stationId ?? '—'}
          </div>
        </section>
      )}

      {/* Top-N Candidates（服务端候选池透传） */}
      {candidates && (
        <section className="rounded border border-slate-800 bg-slate-900/50 p-2">
          <div className="text-xs font-semibold text-slate-300">
            候选（{candidates.eligibleCount} 可行 / {candidates.rejectedCount} 拒绝）
          </div>
          {candidates.eligible.length > 0 ? (
            <table className="mt-1 w-full text-xs">
              <thead>
                <tr className="text-left text-slate-400">
                  <th className="px-2 py-1">#</th>
                  <th className="px-2 py-1">人员</th>
                  <th className="px-2 py-1">设备</th>
                  <th className="px-2 py-1">工位</th>
                  <th className="px-2 py-1">评分</th>
                  <th className="px-2 py-1">ETA</th>
                  <th className="px-2 py-1">距离</th>
                  <th className="px-2 py-1">电量</th>
                  <th className="px-2 py-1">说明</th>
                </tr>
              </thead>
              <tbody>
                {candidates.eligible.slice(0, 5).map((c) => (
                  <CandidateRow key={`${c.personId}-${c.deviceId}-${c.stationId}`} c={c} />
                ))}
              </tbody>
            </table>
          ) : (
            <div className="mt-1 text-xs text-slate-500">无可行候选</div>
          )}
        </section>
      )}

      {/* Rejected Alternatives / Constraint Explanation（服务端透传） */}
      {decision && decision.rejectedHard.length > 0 && (
        <section className="rounded border border-slate-800 bg-slate-900/50 p-2">
          <div className="text-xs font-semibold text-slate-300">拒绝候选与约束解释</div>
          <ul className="mt-1 space-y-1 text-xs">
            {decision.rejectedHard.slice(0, 5).map((r, i) => (
              <li key={i} className="text-slate-400">
                {r.personId ?? '—'} / {r.deviceId ?? '—'} / {r.stationId ?? '—'}：
                {r.reasonLabels.join(', ')}
              </li>
            ))}
          </ul>
          {decision.hardConstraints.length > 0 && (
            <div className="mt-1 text-xs text-slate-500">
              硬约束：{decision.hardConstraints.join(', ')}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
