/**
 * UX-008「性能工程」— 轻量虚拟列表工具。
 *
 * 提供：
 * - `computeVirtualRange`：纯函数，根据总数/视口高/行高/滚动位置计算当前应渲染的
 *   可见区间（含 overscan），供大表格/大列表只渲染可视区，避免一次性渲染数千行。
 * - `useVirtualList`：React hook，绑定容器滚动与尺寸，返回渲染区间与占位高度。
 *
 * 行高按固定值估算（工业 Web 场景下表格行高相对均匀），配合"占位行 + sticky 表头"
 * 模式即可获得可观收益，且不引入第三方虚拟滚动库。
 */

import { useLayoutEffect, useMemo, useRef, useState } from 'react';

export interface VirtualRange {
  /** 第一个可见项的索引（含）。 */
  start: number;
  /** 最后一个可见项索引（不含）。 */
  end: number;
  /** 顶部占位高度（px），用于把可见项推到正确位置。 */
  offsetY: number;
  /** 全部内容总高度（px）。 */
  totalHeight: number;
  /** 视口内可见项数（不含 overscan）。 */
  visibleCount: number;
}

/**
 * 计算虚拟滚动区间。纯函数，便于单测。
 */
export function computeVirtualRange(
  total: number,
  viewport: number,
  itemHeight: number,
  scrollTop: number,
  overscan = 4,
): VirtualRange {
  const safeTotal = Math.max(0, Math.floor(total));
  const safeItemHeight = Math.max(1, itemHeight);
  const safeScrollTop = Math.max(0, scrollTop);
  const totalHeight = safeTotal * safeItemHeight;

  if (viewport <= 0 || safeTotal === 0) {
    return { start: 0, end: 0, offsetY: 0, totalHeight, visibleCount: 0 };
  }

  const visibleCount = Math.ceil(viewport / safeItemHeight);
  const rawStart = Math.floor(safeScrollTop / safeItemHeight) - overscan;
  const start = Math.max(0, Math.min(safeTotal - 1, rawStart));
  const end = Math.min(safeTotal, start + visibleCount + overscan * 2);
  return {
    start,
    end,
    offsetY: start * safeItemHeight,
    totalHeight,
    visibleCount,
  };
}

export interface UseVirtualListOptions {
  total: number;
  itemHeight: number;
  overscan?: number;
}

export interface VirtualListWindow<T extends HTMLElement> {
  ref: React.RefObject<T | null>;
  /** 当前应渲染的区间。 */
  range: VirtualRange;
  /** 需要渲染的项（按索引切片）。 */
  slice: { start: number; end: number };
}

/**
 * 绑定一个可滚动容器（建议 overflow-auto + 固定 max-height），返回渲染区间。
 */
export function useVirtualList<T extends HTMLElement>({
  total,
  itemHeight,
  overscan = 4,
}: UseVirtualListOptions): VirtualListWindow<T> {
  const ref = useRef<T>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      setScrollTop(el.scrollTop);
      setViewport(el.clientHeight);
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      observer.disconnect();
    };
  }, []);

  const range = useMemo(() => {
    // 视口尚未测量（flex 布局未落地 / 首帧 / ResizeObserver 未回调）时，
    // computeVirtualRange 会返回 end:0 的空窗口，导致列表整片空白。
    // 此处防御：未测量则渲染全部行（待 ResizeObserver 回调后自动切回虚拟化），
    // 既不破坏 computeVirtualRange 的测试契约，也保证表格/列表视图永不空白。
    if (viewport <= 0) {
      const safeTotal = Math.max(0, Math.floor(total));
      const safeItemHeight = Math.max(1, itemHeight);
      return {
        start: 0,
        end: safeTotal,
        offsetY: 0,
        totalHeight: safeTotal * safeItemHeight,
        visibleCount: 0,
      };
    }
    return computeVirtualRange(total, viewport, itemHeight, scrollTop, overscan);
  }, [total, viewport, itemHeight, scrollTop, overscan]);

  return { ref, range, slice: { start: range.start, end: range.end } };
}