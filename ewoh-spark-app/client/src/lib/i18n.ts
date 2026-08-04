/**
 * UX-007 7.7：极简 i18n 结构 —— 中文优先，预留翻译层。
 *
 * 提供可测试的纯函数（createTranslator / interpolate）与初始中文词典。
 * 不强制重构全部页面，仅作为后续文案抽取的接入点。
 */

export type Variables = Record<string, string | number>;

export interface Messages {
  [key: string]: string;
}

/** 中文（默认）文案词典。 */
export const zhCN: Messages = {
  'a11y.skipToContent': '跳到主内容',
  'a11y.graphTextView': '切换到文本视图',
  'a11y.graphGraphView': '切换到图形视图',
  'a11y.graphSummary': '交付因果图（文本替代）',
  'a11y.graphCriticalPath': '关键路径',
  'a11y.searchPersonnel': '搜索人员',
  'a11y.batteryChart': '设备电量分布图',
  'a11y.graph.nodeCount': '节点数：{count}',
  'a11y.graph.edgeCount': '依赖边数：{count}',
  'action.retry': '重试',
  'action.backToSafe': '返回安全状态',
  'action.saveDraft': '保存草稿',
  'action.copyDiagnostics': '复制诊断信息',
  'state.online': '在线',
  'state.offline': '离线',
};

/** 将 {key} 占位符替换为变量值。 */
export function interpolate(template: string, vars?: Variables): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    vars[key] !== undefined ? String(vars[key]) : match,
  );
}

/** 创建一个基于给定词典的翻译函数。 */
export function createTranslator(messages: Messages): (key: string, vars?: Variables) => string {
  return (key, vars) => interpolate(messages[key] ?? key, vars);
}

/** 默认中文翻译器。 */
export const t = createTranslator(zhCN);