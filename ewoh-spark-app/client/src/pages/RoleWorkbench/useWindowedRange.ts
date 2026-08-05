import { useEffect, useState } from 'react';
import { OVERSCAN } from './roleWorkbenchState';

/**
 * 行虚拟化：仅渲染视口内的行（基于滚动位置），用首尾 spacer 保持滚动高度。
 * 大表（10k+ 行）只会渲染可见的 ~O(overscan) 行 DOM。
 */
export function useWindowedRange(
  total: number,
  rowHeight: number,
  containerRef: React.RefObject<HTMLDivElement | null>,
  overscan = OVERSCAN,
): { start: number; end: number; topPad: number; bottomPad: number } {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      setScrollTop(el.scrollTop);
      setViewport(el.clientHeight);
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    const ro =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      ro?.disconnect();
    };
  }, [containerRef]);

  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(total, Math.ceil((scrollTop + viewport) / rowHeight) + overscan);
  return {
    start,
    end,
    topPad: Math.max(0, start * rowHeight),
    bottomPad: Math.max(0, (total - end) * rowHeight),
  };
}