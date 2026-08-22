import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

/**
 * LazyPlanList —— 带视口限制的懒加载滚动列表（排产调度方案卡专用）。
 *
 * 行为契约（2026-08-21）：
 * 1. 初始仅渲染 initialCount（默认 3）个方案；窗口最多同时渲染 maxCount（默认 9）个。
 * 2. 用户向下滚动（底部哨兵进入视口 ±rootMargin）→ 窗口推进 1 个：
 *    - 最顶部方案执行"缩小 + 淡出"动画（lazy-plan-exit），动画结束后移出 DOM；
 *    - 底部新方案从视口外进入，执行"从小到大 + 淡入"动画（lazy-plan-enter）。
 * 3. 并发退出动画上限 MAX_CONCURRENT_EXITS=2，防止快速滚动时动画堆积。
 * 4. 内容不足一屏时，自动连续推进直到填满视口或达到 maxCount。
 *
 * 性能策略：
 * - IntersectionObserver（浏览器原生）代替 scroll 监听，滚动线程零 JS 开销；
 * - 动画全部用 transform/opacity（GPU 合成）+ will-change + translateZ(0)，
 *   滚动期间不触发布局（layout）/绘制（paint）；
 * - 单帧推进互斥（advancingRef），避免同一帧多次 setState 造成抖动。
 *
 * 可读性保障：
 * - 进入动画起点 scale(0.92)，退出终点 scale(0.86)——缩放区间内文字保持清晰；
 * - 动画时长 300-380ms 短促，内容"可读性受损窗口"最小化；
 * - 退出项动画期间 pointer-events: none，防止误触（卡片内含审批/驳回按钮）。
 */

interface LazyPlanListProps<T> {
  items: T[];
  itemKey: (item: T) => string;
  renderItem: (item: T, phase: 'stable' | 'entering') => React.ReactNode;
  /** 初始渲染数量，默认 3。 */
  initialCount?: number;
  /** 窗口最大同时渲染数量，默认 9。 */
  maxCount?: number;
  /** 网格/布局容器 className（如 "grid gap-3 lg:grid-cols-2 xl:grid-cols-3"）。 */
  className?: string;
  /** 每个方案卡外层 wrapper className（如 "min-w-0"）。 */
  itemClassName?: string;
}

interface WindowState<T> {
  /** 窗口起点索引（已稳定渲染的第一项）。 */
  head: number;
  /** 窗口大小（3 → 9 递增，达到 maxCount 后固定并滑动）。 */
  count: number;
  /** 正在执行退出动画的项（保持渲染占位直到动画结束）。 */
  exiting: Map<string, T>;
  /** 正在执行进入动画的项 key。 */
  entering: Set<string>;
}

const INITIAL_COUNT_DEFAULT = 3;
const MAX_COUNT_DEFAULT = 9;
/** 并发退出动画上限：超过则暂停推进，等已有动画完成（保证动画自然）。 */
const MAX_CONCURRENT_EXITS = 2;
/** 底部哨兵的提前触发距离（px）：接近视口底部即预加载，滚动不产生停顿感。 */
const SENTINEL_ROOT_MARGIN_PX = 280;

export function LazyPlanList<T>({
  items,
  itemKey,
  renderItem,
  initialCount = INITIAL_COUNT_DEFAULT,
  maxCount = MAX_COUNT_DEFAULT,
  className,
  itemClassName,
}: LazyPlanListProps<T>): React.ReactElement {
  const [state, setState] = useState<WindowState<T>>(() => ({
    head: 0,
    count: Math.max(0, Math.min(initialCount, items.length)),
    exiting: new Map(),
    entering: new Set(),
  }));

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  /** 单帧推进互斥：避免同一帧多次 setState 造成滚动抖动。 */
  const advancingRef = useRef(false);
  /** 防 stale closure：advance 内部读取最新窗口状态。 */
  const stateRef = useRef(state);
  stateRef.current = state;

  // items 变化（状态过滤 / 刷新 / SSE 追加）时重置窗口回到初始状态。
  useEffect(() => {
    setState({
      head: 0,
      count: Math.max(0, Math.min(initialCount, items.length)),
      exiting: new Map(),
      entering: new Set(),
    });
  }, [items, initialCount]);

  const advance = useCallback(() => {
    if (advancingRef.current) return;
    const prev = stateRef.current;
    if (prev.exiting.size >= MAX_CONCURRENT_EXITS) return;
    if (prev.head + prev.count >= items.length) return;
    // 窗口已满（count===maxCount）且仍有退出动画进行中：等动画完成再滑窗，
    // 避免"同时退出多个顶部项"破坏顶部递进的自然节奏。
    if (prev.count >= maxCount && prev.exiting.size > 0) return;

    advancingRef.current = true;
    setState((cur) => {
      if (cur.head + cur.count >= items.length) return cur;
      if (cur.exiting.size >= MAX_CONCURRENT_EXITS) return cur;

      const top = items[cur.head];
      const next = items[cur.head + cur.count];
      const exiting = new Map(cur.exiting);
      if (top) exiting.set(itemKey(top), top);
      const entering = new Set(cur.entering);
      if (next) entering.add(itemKey(next));

      return {
        head: cur.head + 1,
        count: Math.min(cur.count + 1, maxCount),
        exiting,
        entering,
      };
    });
    // 下一帧释放互斥，允许后续滚动继续推进。
    requestAnimationFrame(() => {
      advancingRef.current = false;
    });
  }, [items, itemKey, maxCount]);

  // 底部哨兵 IntersectionObserver：进入视口（提前 280px）→ 推进窗口。
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) advance();
      },
      { rootMargin: `${SENTINEL_ROOT_MARGIN_PX}px 0px`, threshold: 0 },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [advance, items.length]);

  // 状态变化后自检：若内容不足一屏（哨兵仍在视口附近），继续推进填满/滑窗。
  // 覆盖"3 个卡片高度 < 视口高度"时 observer 不再触发的场景。
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const sentinel = sentinelRef.current;
      if (!sentinel) return;
      const rect = sentinel.getBoundingClientRect();
      if (rect.top < window.innerHeight + SENTINEL_ROOT_MARGIN_PX) advance();
    });
    return () => cancelAnimationFrame(id);
  }, [state.head, state.count, state.exiting.size, state.entering.size, advance]);

  const handleExitEnd = (key: string) => {
    setState((cur) => {
      if (!cur.exiting.has(key)) return cur;
      const exiting = new Map(cur.exiting);
      exiting.delete(key);
      return { ...cur, exiting };
    });
  };

  const handleEnterEnd = (key: string) => {
    setState((cur) => {
      if (!cur.entering.has(key)) return cur;
      const entering = new Set(cur.entering);
      entering.delete(key);
      return { ...cur, entering };
    });
  };

  // 渲染：顶部退出项（保持占位，缩小淡出）+ 窗口项 [head, head+count)。
  // 退出项置于 DOM 最前 → 网格首格（视口顶部），视觉上符合"顶部方案移除"。
  const exitingItems = useMemo(
    () => Array.from(state.exiting.entries()),
    [state.exiting],
  );
  const windowItems = items.slice(state.head, state.head + state.count);

  return (
    <div className={className}>
      {exitingItems.map(([key, item]) => (
        <div
          key={`lazy-exit-${key}`}
          className={`${itemClassName ?? ''} lazy-plan-exit`}
          onAnimationEnd={() => handleExitEnd(key)}
        >
          {renderItem(item, 'stable')}
        </div>
      ))}
      {windowItems.map((item) => {
        const key = itemKey(item);
        const isEntering = state.entering.has(key);
        return (
          <div
            key={key}
            className={`${itemClassName ?? ''} ${isEntering ? 'lazy-plan-enter' : ''}`}
            onAnimationEnd={isEntering ? () => handleEnterEnd(key) : undefined}
          >
            {renderItem(item, isEntering ? 'entering' : 'stable')}
          </div>
        );
      })}
      {/* 底部哨兵：进入视口触发加载下一批 */}
      <div ref={sentinelRef} className="h-px w-full" aria-hidden="true" />
    </div>
  );
}
