import { useLayoutEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CheckCircle2, ShieldCheck, UserRound } from 'lucide-react';
import { getAuthUser } from '../../lib/auth';
import type { WorkEvidence } from '../../api/work';
import { statusTone } from './graphLayout';

/** 共享染色类，供各面板与 EvidenceRow/StatusBadge 复用。 */
export const toneClasses: Record<string, string> = {
  emerald: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  red: 'border-red-200 bg-red-50 text-red-800',
  blue: 'border-blue-200 bg-blue-50 text-blue-800',
  amber: 'border-amber-200 bg-amber-50 text-amber-800',
  slate: 'border-slate-200 bg-slate-50 text-slate-700',
};

export const formatTime = (value?: string | null): string =>
  value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';

export const formatLockRemaining = (value?: string | null): string => {
  if (!value) return '';
  const ms = Date.parse(value) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return '已过期';
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}分${seconds}秒`;
};

export function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * 将单个筛选状态映射到 URL 查询参数（replace，避免历史栈膨胀）。
 * 刷新/分享链接后状态即可恢复。
 */
export function useUrlParam(key: string): [string, (value: string) => void] {
  const [params, setParams] = useSearchParams();
  const value = params.get(key) ?? '';
  const setValue: (next: string) => void = (next) => {
    setParams(
      (prev) => {
        const nextParams = new URLSearchParams(prev);
        if (next) nextParams.set(key, next);
        else nextParams.delete(key);
        return nextParams;
      },
      { replace: true },
    );
  };
  return [value, setValue];
}

/** 测量元素尺寸（用于大图窗口化渲染）。 */
export function useElementSize<T extends HTMLElement>(): {
  ref: React.RefObject<T | null>;
  size: { width: number; height: number };
} {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, size };
}

export const SummaryTile = ({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string;
  value: number;
  icon: typeof CheckCircle2;
  tone: 'blue' | 'emerald' | 'violet' | 'sky' | 'amber' | 'red';
}): React.ReactElement => {
  const iconTones: Record<string, string> = {
    blue: 'bg-blue-50 text-blue-600',
    emerald: 'bg-emerald-50 text-emerald-600',
    violet: 'bg-violet-50 text-violet-600',
    sky: 'bg-sky-50 text-sky-600',
    amber: 'bg-amber-50 text-amber-600',
    red: 'bg-red-50 text-red-600',
  };
  return (
    <div className="flex items-center gap-3 rounded-lg border border-[hsl(220_14%_89%)] bg-white p-4">
      <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${iconTones[tone]}`}>
        <Icon className="h-4 w-4" />
      </div>
      <div>
        <p className="text-xs text-[hsl(218_10%_42%)]">{label}</p>
        <p className="mt-0.5 text-2xl font-semibold text-[hsl(220_14%_14%)]">{value}</p>
      </div>
    </div>
  );
};

export const StatusBadge = ({ status }: { status: string }): React.ReactElement => (
  <span
    className={`inline-flex rounded-md border px-2 py-1 text-xs font-medium ${toneClasses[statusTone(status)]}`}
  >
    {status || '—'}
  </span>
);

export const EvidenceRow = ({
  entry,
  onPreview,
  onSelect,
}: {
  entry: WorkEvidence;
  onPreview?: (entry: WorkEvidence) => void;
  onSelect?: (entry: WorkEvidence) => void;
}): React.ReactElement => {
  const expired = Boolean(entry.expiresAt && Date.parse(entry.expiresAt) <= Date.now());
  return (
    <div
      role={onSelect ? 'button' : undefined}
      tabIndex={onSelect ? 0 : undefined}
      onClick={onSelect ? () => onSelect(entry) : undefined}
      onKeyDown={
        onSelect
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelect(entry);
              }
            }
          : undefined
      }
      className={`rounded-lg border px-4 py-3 ${
        onSelect ? 'cursor-pointer transition-colors hover:border-blue-400 hover:bg-white' : ''
      } ${
        expired
          ? 'border-red-300 bg-red-50'
          : 'border-[hsl(220_14%_89%)] bg-[hsl(220_14%_96%)]'
      }`}
    >
      <div className="flex items-center gap-2">
        <CheckCircle2
          className={`h-4 w-4 ${expired ? 'text-red-500' : 'text-emerald-600'}`}
        />
        <span className="font-medium text-[hsl(220_14%_14%)]">
          {entry.title || entry.evidenceId}
        </span>
        <span className="ml-auto text-xs text-[hsl(218_10%_42%)]">{entry.kind}</span>
        {onPreview && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onPreview(entry);
            }}
            className="rounded-md border border-[hsl(220_14%_89%)] bg-white px-2 py-1 text-xs font-medium text-[hsl(220_14%_14%)] hover:bg-[hsl(220_14%_96%)]"
          >
            预览
          </button>
        )}
        {onSelect && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onSelect(entry);
            }}
            aria-label={`查看证据 ${entry.title || entry.evidenceId} 元数据`}
            className="rounded-md border border-[hsl(220_14%_89%)] bg-white px-2 py-1 text-xs font-medium text-[hsl(220_14%_14%)] hover:bg-[hsl(220_14%_96%)]"
          >
            详情
          </button>
        )}
      </div>
      <p className="mt-1 font-mono text-xs text-[hsl(218_10%_42%)]">{entry.path}</p>
      <p className="mt-1 text-xs text-[hsl(218_10%_42%)]">
        校验 {entry.checksum.slice(0, 12)} · 结果 {entry.result ?? 'unknown'}
      </p>
      {(entry.status || entry.commitSha || entry.expiresAt || entry.verifier) && (
        <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-[hsl(218_10%_42%)]">
          <StatusBadge status={entry.status ?? 'unbound'} />
          {entry.commitSha && <span>提交 {entry.commitSha.slice(0, 8)}</span>}
          {entry.expiresAt && (
            <span className={expired ? 'font-medium text-red-600' : ''}>
              到期 {formatTime(entry.expiresAt)}
              {expired ? '（已过期）' : ''}
            </span>
          )}
          {entry.verifier && <span>验证人 {entry.verifier}</span>}
        </p>
      )}
    </div>
  );
};

/**
 * 写操作确认弹窗：展示 actor / reason / source / timestamp / rollback point。
 * 符合 UX-002「所有写操作展示操作元数据并要求确认」。
 */
export const WriteConfirmDialog = ({
  open,
  title,
  description,
  actionLabel,
  tone = 'primary',
  rollbackPoint,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description?: string;
  actionLabel: string;
  tone?: 'primary' | 'danger' | 'success';
  rollbackPoint: string;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}): React.ReactElement | null => {
  const [reason, setReason] = useState('');
  if (!open) return null;
  const actor = getAuthUser()?.username ?? 'anonymous';
  const timestamp = new Date().toLocaleString('zh-CN', { hour12: false });
  const confirmClass =
    tone === 'danger'
      ? 'bg-red-600 hover:bg-red-700'
      : tone === 'success'
        ? 'bg-emerald-600 hover:bg-emerald-700'
        : 'bg-blue-600 hover:bg-blue-700';
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="w-full max-w-md rounded-lg border border-[hsl(220_14%_89%)] bg-white p-5 shadow-lg">
        <h3 className="text-lg font-semibold text-[hsl(220_14%_14%)]">{title}</h3>
        {description && <p className="mt-1 text-sm text-[hsl(218_10%_42%)]">{description}</p>}
        <div className="mt-3 space-y-2 text-sm text-[hsl(220_14%_14%)]">
          <div className="flex items-center gap-2">
            <UserRound className="h-4 w-4 text-[hsl(218_10%_42%)]" />
            操作者
            <span className="font-mono text-xs">{actor}</span>
          </div>
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-[hsl(218_10%_42%)]" />
            来源
            <span className="font-mono text-xs">UI</span>
          </div>
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-[hsl(218_10%_42%)]" />
            时间
            <span className="font-mono text-xs">{timestamp}</span>
          </div>
          <label className="block">
            <span className="text-xs text-[hsl(218_10%_42%)]">原因（可选）</span>
            <input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="填写该操作的原因"
              className="mt-1 h-9 w-full rounded-lg border border-[hsl(220_14%_89%)] px-3 text-sm outline-none focus:border-blue-500"
            />
          </label>
          <div className="rounded-md bg-blue-50 px-3 py-2 text-xs text-[hsl(218_10%_42%)]">
            回滚点：{rollbackPoint}
          </div>
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
            onClick={() => onConfirm(reason)}
            className={`rounded-lg px-4 py-2 text-sm font-medium text-white ${confirmClass}`}
          >
            {actionLabel}
          </button>
        </div>
      </div>
    </div>
  );
};