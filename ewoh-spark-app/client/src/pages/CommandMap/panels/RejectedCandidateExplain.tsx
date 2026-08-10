/* M05：Rejected Candidate Explainability（08 §10）。
 *
 * 只消费服务端 DecisionTrace.rejectedHard/hardConstraints/softCosts/weightsSnapshot；
 * 前端只渲染不重算 hard constraints（本文件无任何 hard 判定逻辑 import）。
 */
import React from 'react';
import type { DecisionExplainVM } from '../vm/decisionExplainVM';

interface RejectedCandidateExplainProps {
  decision: DecisionExplainVM | null;
  /** 最多展示条数。 */
  limit?: number;
}

/** 拒绝候选可解释列表：person/device/station + 结构化拒绝原因（服务端透传）。 */
export function RejectedCandidateExplain({
  decision,
  limit = 10,
}: RejectedCandidateExplainProps): React.ReactElement | null {
  if (!decision) return null;
  const rejected = decision.rejectedHard.slice(0, limit);
  if (rejected.length === 0) return null;
  return (
    <div className="space-y-2 p-2" data-testid="rejected-candidate-explain">
      <div className="text-xs font-semibold text-slate-300">被拒候选与原因</div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-slate-400">
            <th className="px-1 py-0.5">人员</th>
            <th className="px-1 py-0.5">设备</th>
            <th className="px-1 py-0.5">工位</th>
            <th className="px-1 py-0.5">原因</th>
          </tr>
        </thead>
        <tbody>
          {rejected.map((r, i) => (
            <tr key={i} className="border-t border-slate-800">
              <td className="px-1 py-0.5 text-slate-300">{r.personId ?? '—'}</td>
              <td className="px-1 py-0.5 text-slate-300">{r.deviceId ?? '—'}</td>
              <td className="px-1 py-0.5 text-slate-300">{r.stationId ?? '—'}</td>
              <td className="px-1 py-0.5 text-slate-400">{r.reasonLabels.join(', ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {decision.softCosts && Object.keys(decision.softCosts).length > 0 && (
        <div className="text-xs text-slate-500">
          软成本：{Object.entries(decision.softCosts).map(([k, v]) => `${k}=${v}`).join(' · ')}
        </div>
      )}
    </div>
  );
}
