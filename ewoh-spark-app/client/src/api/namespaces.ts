/**
 * 前端 API 命名空间常量。
 *
 * 2026-09-11 清理：移除 `workstation`（/api/workstation）与 `eventRule`
 * （/api/event-rules）——服务端从未提供这两个 controller，属于会误导后续
 * 开发的死配置（原则 9：不为保留改动最小而保留明显不合理的旧设计）。
 */
export const API_NAMESPACES = {
  organization: '/api/organization',
  task: '/api/tasks',
  resource: '/api/resource',
  control: '/api/control',
  model: '/api/models',
  knowledge: '/api/knowledge',
  notification: '/api/notifications',
  system: '/api/system',
} as const;

export type ApiNamespace = keyof typeof API_NAMESPACES;

export const API_NAMESPACE_LIST = Object.keys(API_NAMESPACES) as ApiNamespace[];
