/* Task 12 / 12.2：可复用键盘表格替代视图（KeyboardTableView）。
 *
 * 为 Command Map 各面板（资源池 / 任务编排 / 冲突中心 / 调度方案分配 / 事件中心）
 * 提供语义化 `<table>` 替代视图，可完全用键盘操作：
 * - `<table>` + `<thead>` 列头（scope="col"）+ `<caption>`（屏幕阅读器可读）；
 * - 行可聚焦（tabIndex=0），Enter / Space 触发 onActivate（与卡片视图核心动作一致），
 *   aria-selected 标记选中行；
 * - 长列表内置虚拟化（useVirtualList：sticky 表头 + 上下占位行），大列表只渲染可视窗口；
 * - 支持每行附加操作列（renderActions），覆盖卡片视图的二级动作（如编辑/分配）。
 *
 * 卡片视图保持默认；本表格视图经面板内「表格视图/列表视图」切换按钮打开。
 */
import React from 'react';
import { useVirtualList } from '@client/src/lib/virtualList';
import { cn } from '@client/src/lib/utils';

export interface KeyboardTableColumn<T> {
  key: string;
  header: string;
  /** 单元格内容（文本优先，保证屏幕阅读器可读）。 */
  render: (row: T) => React.ReactNode;
  className?: string;
}

export interface KeyboardTableViewProps<T> {
  /** 表格可访问名称（如「资源列表」）。 */
  ariaLabel: string;
  columns: KeyboardTableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** 行主操作（Enter/Space/点击触发；对应卡片视图的 select/open/expand 等核心动作）。 */
  onActivate: (row: T) => void;
  /** 当前选中行 key（aria-selected）。 */
  selectedKey?: string | null;
  /** 每行附加操作（可选，覆盖卡片视图二级动作）。 */
  renderActions?: (row: T) => React.ReactNode;
  emptyText?: string;
  /** 行高（px，虚拟化估算；默认 40）。 */
  itemHeight?: number;
  className?: string;
}

/**
 * 语义化键盘表格（虚拟化 + sticky 表头 + 可聚焦行）。
 * 表格内部滚动；`useVirtualList` 绑定外层滚动容器，上下占位行保持滚动位置。
 */
export function KeyboardTableView<T>({
  ariaLabel,
  columns,
  rows,
  rowKey,
  onActivate,
  selectedKey,
  renderActions,
  emptyText = '暂无数据',
  itemHeight = 40,
  className,
}: KeyboardTableViewProps<T>): React.ReactElement {
  const list = useVirtualList<HTMLDivElement>({ total: rows.length, itemHeight, overscan: 6 });

  if (rows.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-white/60" role="status">
        {emptyText}
      </div>
    );
  }

  const visible = rows.slice(list.slice.start, list.slice.end);
  const spacerTop = list.range.offsetY;
  const spacerBottom = Math.max(0, list.range.totalHeight - spacerTop - visible.length * itemHeight);

  return (
    <div
      ref={list.ref}
      role="region"
      aria-label={ariaLabel}
      className={cn('min-h-0 overflow-auto', className)}
    >
      <table className="w-full border-collapse text-left text-[10px] text-white/80" aria-label={ariaLabel}>
        <caption className="sr-only">{ariaLabel}</caption>
        <thead>
          <tr className="sticky top-0 z-10 bg-[hsl(220_14%_16%)] text-white/60">
            {columns.map((col) => (
              <th key={col.key} scope="col" className="border-b border-white/10 px-2 py-1.5 font-medium whitespace-nowrap">
                {col.header}
              </th>
            ))}
            {renderActions && <th scope="col" className="border-b border-white/10 px-2 py-1.5 whitespace-nowrap">操作</th>}
          </tr>
        </thead>
        <tbody>
          {spacerTop > 0 && (
            <tr aria-hidden="true" style={{ height: spacerTop }} />
          )}
          {visible.map((row) => {
            const key = rowKey(row);
            const selected = selectedKey === key;
            return (
              <tr
                key={key}
                tabIndex={0}
                aria-selected={selected}
                onClick={() => onActivate(row)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onActivate(row);
                  }
                }}
                className={cn(
                  'cursor-pointer border-b border-white/5 hover:bg-card/5 focus:bg-card/10 focus:outline-none',
                  selected && 'bg-card/10',
                )}
              >
                {columns.map((col) => (
                  <td key={col.key} className={cn('px-2 py-1 align-top whitespace-nowrap', col.className)}>
                    {col.render(row)}
                  </td>
                ))}
                {renderActions && (
                  <td className="px-2 py-1 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                    {renderActions(row)}
                  </td>
                )}
              </tr>
            );
          })}
          {spacerBottom > 0 && (
            <tr aria-hidden="true" style={{ height: spacerBottom }} />
          )}
        </tbody>
      </table>
    </div>
  );
}
