/**
 * 统一对象时间线 —— 纯函数助手门面。
 *
 * 实现位于 timelineModel.ts（模型 + 归一化 / 过滤 / 因果链 / 权限可见性），
 * 本文件作为统一入口导出，供页面与组件复用。
 */
export {
  normalizeTimelineEvent,
  filterTimelineEvents,
  buildCorrelationChain,
  selectVisibleEvents,
} from './timelineModel';

export type {
  TimelineEvent,
  TimelineEventModel,
  TimelineFilter,
  TimelineCredibility,
  TimelineSource,
  PermissionVisibility,
  TimelineEvidenceRef,
  RawTimelineEvent,
} from './timelineModel';