/**
 * UX-001 跨实体跳转辅助 —— 由实体类型 + id 生成可跳转路由。
 *
 * 覆盖 alert→device→person→workorder→process→quality→replay event 等跨实体跳转，
 * 供角色工作台/告警等视图复用，避免各处硬编码路由拼接。
 * 纯函数模块，不依赖 React Router。
 */

export type EntityType =
  | 'alert'
  | 'device'
  | 'person'
  | 'workorder'
  | 'process'
  | 'quality'
  | 'replay'
  | 'event';

/** 各实体类型的默认路由（与 client/src/lib/navigation.ts 中的路由保持一致）。 */
const ENTITY_ROUTES: Record<EntityType, string> = {
  alert: '/alerts',
  device: '/devices',
  person: '/personnel',
  workorder: '/scheduling',
  process: '/operations',
  quality: '/alerts',
  replay: '/digital-world',
  event: '/events',
};

/** 返回实体类型对应的基础路由。 */
export function entityRoute(type: EntityType): string {
  return ENTITY_ROUTES[type];
}

/**
 * 生成跨实体跳转路由：`{base}` 或 `{base}/{encodedId}`。
 * id 为空时仅返回基础路由（列表页）。
 */
export function jumpTo(type: EntityType, id?: string): string {
  const base = ENTITY_ROUTES[type];
  if (!id) return base;
  return `${base}/${encodeURIComponent(id)}`;
}