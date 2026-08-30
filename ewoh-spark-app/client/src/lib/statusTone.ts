// 状态色调统一常量（UX-IA / R-07 风险登记册收敛项）。
//
// 背景：状态 → 「bg-risk-* / 20 + text-risk-*-foreground + border-risk-* / 30」
// 徽章组合曾在 9 个文件各自维护，导致 2026-08-29 的对比度修复被迫全库
// 替换 75 处。自此所有 risk 系徽章色调一律引用本文件常量。
//
// 使用规则：
//  - 键（语义）属于各业务域，值（样式）必须来自此处——新增状态不改色板；
//  - 形状不匹配的场景（soft 底、15% 变体、primary/info/warning 体系）
//    保持原样，不强行收敛；
//  - 调整色板只需改本文件（对比度审计的唯一样本点）。
export const toneBadge = {
  /** 正常 / 通过 / 在线 */
  normal: 'bg-risk-normal/20 text-risk-normal-foreground border-risk-normal/30',
  /** 降级 / 警示 */
  degraded: 'bg-risk-degraded/20 text-risk-degraded-foreground border-risk-degraded/30',
  /** 离线 / 执行中（青色系语义借用） */
  offline: 'bg-risk-offline/20 text-risk-offline-foreground border-risk-offline/30',
  /** 阻断 / 拒绝 / 高危 */
  blocked: 'bg-risk-blocked/20 text-risk-blocked-foreground border-risk-blocked/30',
  /** 冲突 / 回放 */
  conflict: 'bg-risk-conflict/20 text-risk-conflict-foreground border-risk-conflict/30',
  /** 未知 / 无决定 */
  unknown: 'bg-risk-unknown/20 text-risk-unknown-foreground border-risk-unknown/30',
} as const;

export type ToneKey = keyof typeof toneBadge;
