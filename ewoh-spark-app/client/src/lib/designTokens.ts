/**
 * EWOH 语义化设计 Token —— TS 侧单一来源。
 *
 * 与 client/src/tokens.css 中的 CSS 变量一一对应，供 TS/TSX 组件在需要
 * 引用具体 token 值时使用（例如图表填充色、内联 style、非 Tailwind 场景）。
 * 运行时仅作常量导出，不产生副作用。
 */

/* ------------------------------------------------------------------ */
/* 语义状态色                                                          */
/* ------------------------------------------------------------------ */
export const semanticTokens = {
  success: 'hsl(130 54% 42%)',
  successForeground: 'hsl(115 77% 97%)',
  warning: 'hsl(26 90% 49%)',
  warningForeground: 'hsl(33 100% 96%)',
  danger: 'hsl(2 84% 62%)',
  dangerForeground: 'hsl(0 0% 100%)',
  info: 'hsl(221 83% 53%)',
  infoForeground: 'hsl(230 100% 98%)',
} as const;

/* ------------------------------------------------------------------ */
/* 风险状态 token                                                      */
/* ------------------------------------------------------------------ */
export const riskTokens = {
  normal: { color: 'hsl(130 54% 42%)', foreground: 'hsl(130 54% 24%)', soft: 'hsl(120 60% 96%)', border: 'hsl(130 54% 82%)' },
  degraded: { color: 'hsl(26 90% 49%)', foreground: 'hsl(26 90% 30%)', soft: 'hsl(33 100% 96%)', border: 'hsl(26 90% 82%)' },
  offline: { color: 'hsl(199 89% 48%)', foreground: 'hsl(199 89% 28%)', soft: 'hsl(199 89% 96%)', border: 'hsl(199 89% 82%)' },
  blocked: { color: 'hsl(2 84% 62%)', foreground: 'hsl(2 84% 32%)', soft: 'hsl(2 84% 97%)', border: 'hsl(2 84% 85%)' },
  conflict: { color: 'hsl(262 83% 58%)', foreground: 'hsl(262 83% 38%)', soft: 'hsl(262 83% 97%)', border: 'hsl(262 83% 85%)' },
  unknown: { color: 'hsl(220 9% 46%)', foreground: 'hsl(220 9% 26%)', soft: 'hsl(220 14% 96%)', border: 'hsl(220 9% 85%)' },
} as const;

export type RiskState = keyof typeof riskTokens;

/* ------------------------------------------------------------------ */
/* z-index 刻度                                                        */
/* ------------------------------------------------------------------ */
export const zScale = {
  base: '0',
  sticky: '10',
  nav: '50',
  overlay: '100',
  modal: '200',
  toast: '300',
} as const;

/** 可用的语义状态名（供 TS 类型校验）。 */
export const semanticStatuses = ['success', 'warning', 'danger', 'info'] as const;
export type SemanticStatus = (typeof semanticStatuses)[number];

/** 可用的风险状态名（供 TS 类型校验）。 */
export const riskStates = ['normal', 'degraded', 'offline', 'blocked', 'conflict', 'unknown'] as const;
export type RiskStateName = (typeof riskStates)[number];

/**
 * 获取某个风险状态的完整 token 对象。
 * 非法/未知状态回退到 unknown，保证渲染永不崩溃。
 */
export function riskToken(state: RiskStateName | undefined): (typeof riskTokens)[RiskStateName] {
  return riskTokens[(state ?? 'unknown') in riskTokens ? ((state ?? 'unknown') as RiskStateName) : 'unknown'];
}