import { AlertTriangle, CheckCircle2, ShieldCheck, XCircle } from 'lucide-react';
import { getAuthUser } from '../../lib/auth';
import type { GateBatchPreviewRow } from './gateBatchModel';
import { StatusBadge } from './shared';

const DECISION_LABEL: Record<string, string> = {
  approved: '批准',
  rejected: '驳回',
  conditional: '条件批准',
};

/**
 * 批量门禁预览对话框：列出将受影响的门禁、影响下游节点数、证据情况与可执行性，
 * 明确区分「可执行」与「不可执行」两组，避免盲目批量批准。
 */
export const BatchGatePreviewDialog = ({
  open,
  rows,
  decision,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  rows: GateBatchPreviewRow[];
  decision: string;
  onCancel: () => void;
  onConfirm: () => void;
}): React.ReactElement | null => {
  if (!open) return null;
  const actor = getAuthUser()?.username ?? 'anonymous';
  const timestamp = new Date().toLocaleString('zh-CN', { hour12: false });
  const executable = rows.filter((row) => row.executable);
  const nonExecutable = rows.filter((row) => !row.executable);
  const affectedTotal = executable.reduce((sum, row) => sum + row.downstreamCount, 0);
  const missingCount = rows.filter((row) => row.missingEvidence).length;
  const decisionLabel = DECISION_LABEL[decision] ?? decision;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="批量门禁预览"
    >
      <div className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-lg border border-[hsl(220_14%_89%)] bg-white p-5 shadow-lg">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-[hsl(220_14%_14%)]">
            批量记录门禁决定
          </h3>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-[hsl(220_14%_89%)] px-3 py-1 text-sm text-[hsl(220_14%_14%)] hover:bg-[hsl(220_14%_96%)]"
          >
            关闭
          </button>
        </div>
        <p className="mt-1 text-sm text-[hsl(218_10%_42%)]">
          将对筛选出的门禁执行「{decisionLabel}」。仅可执行门禁会被记录，不可执行门禁将被跳过。
        </p>

        {/* 影响范围摘要 */}
        <div className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          <div className="rounded-lg border border-[hsl(220_14%_89%)] bg-[hsl(220_14%_96%)] p-3">
            <p className="text-xs text-[hsl(218_10%_42%)]">门禁总数</p>
            <p className="mt-0.5 text-lg font-semibold text-[hsl(220_14%_14%)]">
              {rows.length}
            </p>
          </div>
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
            <p className="text-xs text-emerald-700">可执行</p>
            <p className="mt-0.5 text-lg font-semibold text-emerald-700">
              {executable.length}
            </p>
          </div>
          <div className="rounded-lg border border-red-200 bg-red-50 p-3">
            <p className="text-xs text-red-700">不可执行</p>
            <p className="mt-0.5 text-lg font-semibold text-red-700">
              {nonExecutable.length}
            </p>
          </div>
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
            <p className="text-xs text-amber-700">受影响下游节点</p>
            <p className="mt-0.5 text-lg font-semibold text-amber-700">
              {affectedTotal}
            </p>
          </div>
        </div>

        {/* 可执行组 */}
        <div className="mt-4">
          <h4 className="flex items-center gap-1.5 text-sm font-medium text-emerald-700">
            <CheckCircle2 className="h-4 w-4" />
            可执行（{executable.length}）
          </h4>
          <div className="max-h-[200px] overflow-y-auto rounded-lg border border-emerald-200">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-emerald-200 bg-emerald-50 text-[hsl(218_10%_42%)]">
                <tr>
                  <th className="px-3 py-2 font-medium">门禁</th>
                  <th className="px-3 py-2 font-medium">状态</th>
                  <th className="px-3 py-2 font-medium">影响下游</th>
                  <th className="px-3 py-2 font-medium">证据</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[hsl(220_14%_89%)]">
                {executable.map((row) => (
                  <tr key={row.gateId}>
                    <td className="px-3 py-2 text-[hsl(220_14%_14%)]">
                      <div className="font-medium">{row.gateId}</div>
                      <div className="text-[10px] text-[hsl(218_10%_42%)]">
                        {row.title}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge status={row.status} />
                    </td>
                    <td className="px-3 py-2 text-[hsl(218_10%_42%)]">
                      {row.downstreamCount > 0
                        ? `${row.downstreamCount} 个节点`
                        : '无下游'}
                    </td>
                    <td className="px-3 py-2 text-[hsl(218_10%_42%)]">
                      {row.evidenceCount} 条
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* 不可执行组 */}
        <div className="mt-4">
          <h4 className="flex items-center gap-1.5 text-sm font-medium text-red-700">
            <XCircle className="h-4 w-4" />
            不可执行（{nonExecutable.length}）
          </h4>
          <div className="max-h-[200px] overflow-y-auto rounded-lg border border-red-200">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-red-200 bg-red-50 text-[hsl(218_10%_42%)]">
                <tr>
                  <th className="px-3 py-2 font-medium">门禁</th>
                  <th className="px-3 py-2 font-medium">状态</th>
                  <th className="px-3 py-2 font-medium">缺失证据</th>
                  <th className="px-3 py-2 font-medium">原因</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[hsl(220_14%_89%)]">
                {nonExecutable.map((row) => (
                  <tr key={row.gateId}>
                    <td className="px-3 py-2 text-[hsl(220_14%_14%)]">
                      <div className="font-medium">{row.gateId}</div>
                      <div className="text-[10px] text-[hsl(218_10%_42%)]">
                        {row.title}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge status={row.status} />
                    </td>
                    <td className="px-3 py-2">
                      {row.missingEvidence ? (
                        <span className="inline-flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                          <AlertTriangle className="h-3 w-3" />
                          缺失
                        </span>
                      ) : (
                        <span className="text-[10px] text-[hsl(218_10%_42%)]">
                          {row.evidenceCount} 条
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-red-600">{row.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {missingCount > 0 && (
            <p className="mt-1 flex items-center gap-1 text-[11px] text-amber-700">
              <AlertTriangle className="h-3 w-3" />
              其中 {missingCount} 个门禁缺失证据，已排除在批量记录之外。
            </p>
          )}
        </div>

        {/* 元数据 */}
        <div className="mt-4 flex items-center gap-2 text-xs text-[hsl(218_10%_42%)]">
          <ShieldCheck className="h-4 w-4" />
          操作者
          <span className="font-mono">{actor}</span>
          <span className="mx-1">·</span>
          <span className="font-mono">{timestamp}</span>
          <span className="mx-1">·</span>
          仅对 {executable.length} 个可执行门禁生效
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-[hsl(220_14%_89%)] bg-white px-4 py-2 text-sm font-medium text-[hsl(220_14%_14%)] hover:bg-[hsl(220_14%_96%)]"
          >
            取消
          </button>
          <button
            type="button"
            disabled={executable.length === 0}
            onClick={onConfirm}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
          >
            批量确认（{executable.length} 个可执行）
          </button>
        </div>
      </div>
    </div>
  );
};