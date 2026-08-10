/* Task 9 / 9.1：URL 背书的操作上下文（useUrlOperatorContext）。
 *
 * CommandMap 状态所有权不变（store/selection/replay/mode·level + Shell 本地 UI state），
 * 本 Hook 只做「URL ⇄ 上下文」的双向镜像：
 * - 读（restore）：挂载时读一次 + popstate（前进/后退）时恢复；
 * - 写（mirror）：上下文变化时经 history.replaceState 写回 URL。
 *
 * 写入规则（replaceState vs pushState）：
 * - 所有镜像写入一律 replaceState——mode/level/selection/tab/冲突/事件/回放时间戳/
 *   compare 都属于「连续变化」，不应污染历史栈，否则后退会逐级回退到每个选中态；
 * - 因此 history 中的「步骤」只来自真实导航（深链/外部跳转），popstate 恢复与
 *   历史直觉一致（后退 = 回到上一个 URL 上下文）。
 *
 * 失效 id 降级：URL 提供的 plan/task/entity/conflict/event id 在已加载权威数据中
 * 不存在 → 从恢复上下文剔除并回默认，同时通过 notices（内联 banner）+ onInvalidId
 * （toast）双重提示，绝不保留悬空 id。
 *
 * 瞬态 UI（对话框开关/动画/对比抽屉可见性）不写 URL——只镜像操作上下文。
 *
 * 纯函数（parse/sanitize/build）独立导出，node 环境可单测；
 * Hook 组合它们并在 mount/popstate/state-change 三处触发。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { isValidLevel, isValidMode } from '../map-mode-machine';

/** URL 中可镜像的 id 种类（用于失效校验与降级提示）。 */
export type UrlIdKind = 'plan' | 'task' | 'entity' | 'conflict' | 'event';

/** 失效 id 的用户可见提示（内联 banner + toast 共用）。 */
export interface UrlInvalidIdNotice {
  kind: UrlIdKind;
  id: string;
  /** 人读提示，如「所选方案 PLAN-1 已失效，已恢复默认视图」。 */
  message: string;
}

/** URL 查询参数 → 操作上下文（字段可空：缺失参数即不携带）。 */
export interface UrlOperatorContext {
  mode?: string | null;
  level?: string | null;
  entityId?: string | null;
  taskId?: string | null;
  planId?: string | null;
  tab?: string | null;
  conflictId?: string | null;
  eventId?: string | null;
  /** 回放时间戳（仅回放激活时镜像）。 */
  replayTs?: string | null;
  compareBaseline?: string | null;
  compareCandidate?: string | null;
}

export type UrlIdValidator = (kind: UrlIdKind, id: string) => boolean;

/** id 种类 → 提示用中文名。 */
export const URL_ID_KIND_LABELS: Record<UrlIdKind, string> = {
  plan: '方案',
  task: '任务',
  entity: '实体',
  conflict: '冲突',
  event: '事件',
};

/** 构造失效提示消息（「所选方案 X 已失效，已恢复默认视图」）。 */
export function urlInvalidIdMessage(kind: UrlIdKind, id: string): string {
  return `所选${URL_ID_KIND_LABELS[kind]} ${id} 已失效，已恢复默认视图`;
}

/** URL 参数名 → 上下文字段（参数名即对外契约，勿改）。 */
const PARAM_FIELD: Array<[string, keyof UrlOperatorContext]> = [
  ['mode', 'mode'],
  ['level', 'level'],
  ['entity_id', 'entityId'],
  ['task_id', 'taskId'],
  ['plan_id', 'planId'],
  ['tab', 'tab'],
  ['conflict_id', 'conflictId'],
  ['event_id', 'eventId'],
  ['replay_ts', 'replayTs'],
  ['compare_baseline', 'compareBaseline'],
  ['compare_candidate', 'compareCandidate'],
];

/** 纯函数：URL search 字符串 → 操作上下文（只取已知参数，忽略无关参数）。 */
export function parseUrlOperatorContext(search: string): UrlOperatorContext {
  const params = new URLSearchParams(search);
  const ctx: UrlOperatorContext = {};
  for (const [param, field] of PARAM_FIELD) {
    const value = params.get(param);
    if (value != null && value !== '') ctx[field] = value;
  }
  return ctx;
}

/**
 * 纯函数：校验/清洗 URL 上下文。
 * - 非法 mode/level/tab：静默剔除（非 id，不提示）；
 * - 不存在的 id（plan/task/entity/conflict/event）：剔除 + 生成降级提示；
 * - validateId 未提供或数据未就绪时跳过对应校验（不误报）。
 */
export function sanitizeUrlOperatorContext(
  ctx: UrlOperatorContext,
  options: {
    validateId?: UrlIdValidator;
    isValidTab?: (tab: string) => boolean;
  } = {},
): { ctx: UrlOperatorContext; invalid: UrlInvalidIdNotice[] } {
  const { validateId, isValidTab } = options;
  const cleaned: UrlOperatorContext = {};
  const invalid: UrlInvalidIdNotice[] = [];

  if (ctx.mode != null && isValidMode(ctx.mode)) cleaned.mode = ctx.mode;
  if (ctx.level != null && isValidLevel(ctx.level)) cleaned.level = ctx.level;
  if (ctx.tab != null && (!isValidTab || isValidTab(ctx.tab))) cleaned.tab = ctx.tab;

  const idFields: Array<[keyof UrlOperatorContext, UrlIdKind]> = [
    ['entityId', 'entity'],
    ['taskId', 'task'],
    ['planId', 'plan'],
    ['conflictId', 'conflict'],
    ['eventId', 'event'],
  ];
  for (const [field, kind] of idFields) {
    const id = ctx[field];
    if (id == null) continue;
    if (validateId && !validateId(kind, id)) {
      invalid.push({ kind, id, message: urlInvalidIdMessage(kind, id) });
      continue;
    }
    (cleaned as Record<string, unknown>)[field] = id;
  }

  // compare 双侧均需为有效方案 id（任一失效 → 双侧剔除，避免只留一半的无效对比）。
  const compareIds: Array<[keyof UrlOperatorContext, string | null | undefined]> = [
    ['compareBaseline', ctx.compareBaseline],
    ['compareCandidate', ctx.compareCandidate],
  ];
  const bothPlanIds =
    ctx.compareBaseline != null &&
    ctx.compareCandidate != null &&
    (!validateId ||
      (validateId('plan', ctx.compareBaseline) && validateId('plan', ctx.compareCandidate)));
  if (bothPlanIds) {
    for (const [field, id] of compareIds) {
      if (id != null) (cleaned as Record<string, unknown>)[field] = id;
    }
  } else {
    for (const [field, id] of compareIds) {
      if (id != null && validateId && !validateId('plan', id)) {
        invalid.push({ kind: 'plan', id, message: urlInvalidIdMessage('plan', id) });
      }
    }
  }

  if (ctx.replayTs != null) cleaned.replayTs = ctx.replayTs;
  return { ctx: cleaned, invalid };
}

/** 纯函数：操作上下文 → 完整 URL（保留 pathname/hash，只重写 query）。 */
export function buildOperatorSearchString(ctx: UrlOperatorContext, baseUrl: string): string {
  const url = new URL(baseUrl);
  const params = new URLSearchParams();
  const entries: Array<[string, string | null | undefined]> = [
    ['mode', ctx.mode],
    ['level', ctx.level],
    ['entity_id', ctx.entityId],
    ['task_id', ctx.taskId],
    ['plan_id', ctx.planId],
    ['tab', ctx.tab],
    ['conflict_id', ctx.conflictId],
    ['event_id', ctx.eventId],
    ['replay_ts', ctx.replayTs],
    ['compare_baseline', ctx.compareBaseline],
    ['compare_candidate', ctx.compareCandidate],
  ];
  for (const [param, value] of entries) {
    if (value != null && value !== '') params.set(param, value);
  }
  url.search = params.toString();
  return url.toString();
}

/**
 * 镜像写入：操作上下文变化 → history.replaceState 写回 URL。
 * 与现值相同（含瞬态参数仅来自外部时被归一化）则不写，避免无谓的历史替换。
 */
export function mirrorOperatorContextToUrl(state: UrlOperatorContext): void {
  const base = window.location.href;
  const next = buildOperatorSearchString(state, base);
  if (next === base) return;
  window.history.replaceState(null, '', next);
}

export interface UseUrlOperatorContextOptions {
  /** 当前操作上下文（父组件派生：store slices + 本地 UI state）。 */
  state: UrlOperatorContext;
  /** 权威数据加载完成前不执行初始恢复（避免把「未加载」误判为「失效」）。 */
  ready?: boolean;
  /** 应用恢复出的上下文（写 store / 本地 state）。 */
  onRestore: (ctx: UrlOperatorContext) => void;
  /** id 有效性校验（对照已加载权威数据）；缺省跳过校验。 */
  validateId?: UrlIdValidator;
  /** tab 有效性校验；缺省接受任意 tab。 */
  isValidTab?: (tab: string) => boolean;
  /** 失效 id 通知（toast 等瞬态提示）；内联 banner 经返回的 notices 渲染。 */
  onInvalidId?: (notices: UrlInvalidIdNotice[]) => void;
  /** 恢复完成后回调（深链聚焦等副作用）。 */
  onUrlRestored?: (ctx: UrlOperatorContext) => void;
}

/**
 * URL 背书的操作上下文 Hook。
 * 返回：notices（失效 id 内联 banner 数据）+ dismissNotice + restoreFromUrl
 * （供测试/手动触发；popstate 与挂载恢复共用同一实现）。
 */
export function useUrlOperatorContext(
  options: UseUrlOperatorContextOptions,
): {
  notices: UrlInvalidIdNotice[];
  dismissNotice: (index: number) => void;
  restoreFromUrl: () => void;
} {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [notices, setNotices] = useState<UrlInvalidIdNotice[]>([]);
  const restoredRef = useRef(false);
  // 初始恢复前不镜像（避免用未恢复的初始 state 覆盖 URL 深链参数）。
  const skipWriteRef = useRef(true);

  const restoreFromUrl = useCallback(() => {
    const { onRestore, validateId, isValidTab, onInvalidId, onUrlRestored } = optionsRef.current;
    const raw = parseUrlOperatorContext(window.location.search);
    const { ctx: cleaned, invalid } = sanitizeUrlOperatorContext(raw, { validateId, isValidTab });
    setNotices(invalid);
    if (invalid.length > 0) onInvalidId?.(invalid);
    onRestore(cleaned);
    restoredRef.current = true;
    skipWriteRef.current = false;
    onUrlRestored?.(cleaned);
  }, []);

  // 挂载初始恢复：数据就绪后执行一次（含 ready 延后到达的情况）。
  const ready = options.ready;
  useEffect(() => {
    if (!ready || restoredRef.current) return;
    restoreFromUrl();
  }, [ready, restoreFromUrl]);

  // popstate（前进/后退）恢复：与初始恢复同一实现。
  useEffect(() => {
    const onPopstate = () => {
      if (!optionsRef.current.ready || !restoredRef.current) return;
      restoreFromUrl();
    };
    window.addEventListener('popstate', onPopstate);
    return () => window.removeEventListener('popstate', onPopstate);
  }, [restoreFromUrl]);

  // 镜像：状态变化 → replaceState 写回 URL（已恢复后生效；与现值相同则不写）。
  const state = options.state;
  useEffect(() => {
    if (skipWriteRef.current) return;
    mirrorOperatorContextToUrl(state);
  }, [state]);

  const dismissNotice = useCallback((index: number) => {
    setNotices((prev) => prev.filter((_, i) => i !== index));
  }, []);

  return { notices, dismissNotice, restoreFromUrl };
}
