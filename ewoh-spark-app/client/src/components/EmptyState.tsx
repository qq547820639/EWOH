/**
 * 统一空态组件：为「无权限 / 无设备 / 无数据 / 连接中断 / 同步中 / 初始化失败」等
 * 场景提供统一的「当前状态 + 缺什么 + 下一步动作」三段式说明，保证全站空态口径一致。
 *
 * 每个 reason 都映射到一段结构化内容（EMPTY_STATE_CONTENT），并可选提供一个
 * 可执行按钮（onAction / actionLabel）。若需要跳转，可传入 onAction 回调。
 */

import {
  Inbox,
  Loader2,
  Power,
  ShieldX,
  TriangleAlert,
  WifiOff,
  type LucideIcon,
} from 'lucide-react';
import { Button } from './ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from './ui/empty';

export type EmptyStateReason =
  | 'noPermission'
  | 'noDevices'
  | 'noData'
  | 'connectionInterrupted'
  | 'syncing'
  | 'initializationFailed';

export interface EmptyStateContent {
  icon: LucideIcon;
  title: string;
  /** 当前状态说明。 */
  state: string;
  /** 目前缺什么。 */
  missing: string;
  /** 下一步可执行动作。 */
  nextAction: string;
  defaultActionLabel?: string;
}

export const EMPTY_STATE_CONTENT: Record<EmptyStateReason, EmptyStateContent> = {
  noPermission: {
    icon: ShieldX,
    title: '暂无权限',
    state: '你没有查看此内容的权限。',
    missing: '缺少对应的角色/权限。',
    nextAction: '请联系管理员开通所需权限后重试。',
    defaultActionLabel: '返回安全状态',
  },
  noDevices: {
    icon: Power,
    title: '暂无设备',
    state: '当前还没有接入任何设备或数据源。',
    missing: '缺少至少一个在线设备/数据源。',
    nextAction: '前往「设备接入」添加并连接首个数据源。',
    defaultActionLabel: '去接入设备',
  },
  noData: {
    icon: Inbox,
    title: '暂无数据',
    state: '当前范围下没有任何数据。',
    missing: '缺少可展示的数据记录。',
    nextAction: '尝试切换筛选范围，或先创建一条数据。',
    defaultActionLabel: '刷新看看',
  },
  connectionInterrupted: {
    icon: WifiOff,
    title: '连接中断',
    state: '与服务端的连接已中断。',
    missing: '缺少可用的网络连接。',
    nextAction: '请检查网络后重试；离线数据会自动在恢复连接后同步。',
    defaultActionLabel: '重新连接',
  },
  syncing: {
    icon: Loader2,
    title: '正在同步',
    state: '数据正在与远端同步。',
    missing: '同步尚未完成。',
    nextAction: '请稍候，同步完成后即可查看完整数据。',
  },
  initializationFailed: {
    icon: TriangleAlert,
    title: '初始化失败',
    state: '系统初始化没有成功。',
    missing: '初始化流程未完成。',
    nextAction: '请重试初始化；若持续失败请联系管理员。',
    defaultActionLabel: '重试初始化',
  },
};

export interface EmptyStateProps {
  reason: EmptyStateReason;
  /** 覆盖默认动作文案。 */
  actionLabel?: string;
  /** 动作回调；不传则仅展示说明（如同步中）。 */
  onAction?: () => void;
  className?: string;
}

export const EmptyState = ({
  reason,
  actionLabel,
  onAction,
  className,
}: EmptyStateProps): React.ReactElement => {
  const content = EMPTY_STATE_CONTENT[reason];
  const Icon = content.icon;
  const label = actionLabel ?? content.defaultActionLabel;
  const showAction = onAction && label;

  return (
    <Empty className={className} data-reason={reason}>
      <EmptyHeader>
        <EmptyMedia>
          <Icon className="size-6" aria-hidden />
        </EmptyMedia>
        <EmptyTitle>{content.title}</EmptyTitle>
        <EmptyDescription>
          {content.state}
          <br />
          <span className="font-medium">缺什么：</span>
          {content.missing}
          <br />
          <span className="font-medium">下一步：</span>
          {content.nextAction}
        </EmptyDescription>
      </EmptyHeader>
      {showAction && (
        <EmptyContent>
          <Button type="button" variant="outline" size="sm" onClick={onAction}>
            {label}
          </Button>
        </EmptyContent>
      )}
    </Empty>
  );
};

export default EmptyState;