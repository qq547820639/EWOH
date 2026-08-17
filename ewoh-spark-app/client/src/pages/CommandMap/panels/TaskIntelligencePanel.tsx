/* M05：Task Intelligence 面板（08 §10）。
 *
 * 消费 GET /api/scheduler/tasks/:taskId/candidates（TaskCandidatesResponse）与
 * assignment.decisionTrace。**只渲染服务端数据，禁止重算 hard constraints**——
 * 本文件不 import 任何资格/成本判定逻辑；所有 eligible/reject/score 均由后端透传。
 */
import React from 'react';
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

const ELIGIBLE_LABEL: Record<string, string> = {
  missing_skill: '缺少技能',
  missing_certification: '缺少证书',
  route_infeasible: '路径不可行',
  coords_unknown: '坐标未知',
  safety_blocked: '安全封锁',
  forbidden_zone: '禁入区',
  device_offline: '设备离线',
  low_battery: '电量不足',
  reservation_conflict: '预占冲突',
  unavailable: '人员不可用',
};

function reasonLabel(reason: string): string {
  return ELIGIBLE_LABEL[reason] ?? reason;
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
