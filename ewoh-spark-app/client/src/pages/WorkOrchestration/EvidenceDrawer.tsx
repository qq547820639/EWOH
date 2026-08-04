import { useEffect, useRef } from 'react';
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from '../../components/ui/drawer';
import type { WorkEvidence } from '../../api/work';
import { formatTime, StatusBadge } from './shared';

/** 单条元数据行：标签 + 值（支持复制与空值占位）。 */
const MetaRow = ({
  label,
  value,
  mono = false,
  notice,
}: {
  label: string;
  value?: string | null;
  mono?: boolean;
  notice?: string;
}): React.ReactElement => {
  const hasValue = Boolean(value);
  return (
    <div className="flex items-start justify-between gap-3 rounded-md border border-[hsl(220_14%_89%)] bg-white px-3 py-2">
      <span className="shrink-0 text-xs text-[hsl(218_10%_42%)]">{label}</span>
      <span
        className={`text-right text-xs ${mono ? 'font-mono' : ''} ${
          hasValue ? 'text-[hsl(220_14%_14%)]' : 'text-[hsl(218_10%_42%)]'
        }`}
      >
        {hasValue ? value : '—'}
        {notice && <span className="ml-1 font-medium text-red-600">{notice}</span>}
      </span>
    </div>
  );
};

/**
 * 证据抽屉：右侧滑出 Drawer，展示完整证据元数据。
 * 纯展示组件，数据从传入的 WorkEvidence 直接读取。
 * - 过期证据用醒目红色标识；
 * - 缺少 commitSha 的证据标记为「未绑定提交」；
 * - 符合无障碍：role=dialog / aria-modal / Escape 关闭 / 焦点回掷。
 */
const EvidenceDrawer = ({
  open,
  entry,
  onClose,
}: {
  open: boolean;
  entry: WorkEvidence | null;
  onClose: () => void;
}): React.ReactElement | null => {
  const closeRef = useRef<HTMLButtonElement>(null);

  // 打开时聚焦关闭按钮；关闭时（Escape/遮罩）由 vaul 回掷焦点。
  useEffect(() => {
    if (open) {
      const id = window.setTimeout(() => closeRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
  }, [open]);

  if (!entry) return null;

  const expired = Boolean(entry.expiresAt && Date.parse(entry.expiresAt) <= Date.now());
  const unbound = !entry.commitSha && !entry.buildVersion;
  const prRef = entry.buildVersion || entry.branch || entry.commitSha;

  return (
    <Drawer open={open} onOpenChange={(next) => !next && onClose()} direction="right">
      <DrawerContent className="w-full sm:max-w-[520px]">
        <DrawerHeader className="gap-2 border-b border-[hsl(220_14%_89%)] pb-3">
          <div className="flex items-center gap-2">
            <DrawerTitle className="text-base text-[hsl(220_14%_14%)]">
              {entry.title || entry.evidenceId}
            </DrawerTitle>
            {expired && (
              <span className="rounded-md bg-red-600 px-2 py-0.5 text-xs font-semibold text-white">
                已过期
              </span>
            )}
            {unbound && (
              <span className="rounded-md border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                未绑定提交
              </span>
            )}
          </div>
          <DrawerDescription className="text-xs text-[hsl(218_10%_42%)]">
            证据 ID：{entry.evidenceId}
          </DrawerDescription>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="关闭证据抽屉"
            className="ml-auto -mt-1 rounded-md border border-[hsl(220_14%_89%)] bg-white px-3 py-1.5 text-xs font-medium text-[hsl(220_14%_14%)] outline-none hover:bg-[hsl(220_14%_96%)] focus:border-blue-500"
          >
            关闭
          </button>
        </DrawerHeader>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {/* 状态与结果横幅 */}
          <div
            className={`flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
              expired
                ? 'border-red-300 bg-red-50 text-red-800'
                : 'border-[hsl(220_14%_89%)] bg-[hsl(220_14%_96%)] text-[hsl(220_14%_14%)]'
            }`}
          >
            <span className="text-xs text-[hsl(218_10%_42%)]">状态</span>
            <StatusBadge status={entry.status ?? 'unbound'} />
            <span className="ml-auto text-xs text-[hsl(218_10%_42%)]">
              结果{' '}
              <span className={expired ? 'font-semibold text-red-600' : 'font-semibold'}>
                {entry.result ?? 'unknown'}
              </span>
            </span>
          </div>

          {/* 版本与提交 */}
          <div className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[hsl(218_10%_42%)]">
              版本与提交
            </h3>
            <MetaRow
              label="提交 commitSha"
              value={entry.commitSha}
              mono
              notice={unbound ? '（未绑定提交）' : undefined}
            />
            <MetaRow label="PR / buildVersion" value={prRef} mono />
            <MetaRow label="分支 branch" value={entry.branch} mono />
          </div>

          {/* 产物与校验 */}
          <div className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[hsl(218_10%_42%)]">
              产物与校验
            </h3>
            <MetaRow label="类型 kind" value={entry.kind} />
            <MetaRow label="路径 path" value={entry.path} mono />
            <MetaRow label="校验和 checksum" value={entry.checksum} mono />
            <MetaRow label="依赖版本 dependencyVersion" value={entry.dependencyVersion} mono />
          </div>

          {/* 验证与门禁 */}
          <div className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[hsl(218_10%_42%)]">
              验证与门禁
            </h3>
            <MetaRow label="验证人 verifier" value={entry.verifier} />
            <MetaRow label="测试时间 testTime" value={entry.testTime && formatTime(entry.testTime)} />
            <MetaRow
              label="有效期 expiresAt"
              value={entry.expiresAt && formatTime(entry.expiresAt)}
              notice={expired ? '（已过期）' : undefined}
            />
            <MetaRow label="失效原因 staleReason" value={entry.staleReason} />
          </div>

          {/* 上下文 */}
          <div className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[hsl(218_10%_42%)]">
              上下文
            </h3>
            <MetaRow label="工作项 workItemId" value={entry.workItemId} mono />
            <MetaRow label="环境 envFingerprint" value={entry.envFingerprint} mono />
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
};

export default EvidenceDrawer;