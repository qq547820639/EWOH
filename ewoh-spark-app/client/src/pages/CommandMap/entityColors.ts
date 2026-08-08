// entityColors.ts — 地图实体着色纯函数（v0.7 Batch10.4）
//
// 从 FactoryMap 提取的颜色映射纯逻辑：
// - isExoDevice / getEntityColor / getDeviceColor / priorityLevelColor / resourceStatusColor
// 消除"人员层内联着色与 getDeviceColor 重复"（走读 M 项），纯函数可单测。
// 只读展示映射，不持有任何渲染状态。

import type { SpatialEntity, CurrentWorldState } from '@shared/api.interface';

export function isExoDevice(entity: SpatialEntity): boolean {
  return /EXO|外骨骼/i.test(`${entity.name} ${entity.entityId}`);
}

/** 按 mode 计算实体填充颜色 */
export function getEntityColor(
  entity: SpatialEntity,
  mode: string,
  worldState: CurrentWorldState | null,
): string {
  switch (mode) {
    case 'production':
      if (entity.entityType === 'workstation') {
        // 优先用实时工位占用率着色（与 L2 WIP/节拍逻辑一致），无实时数据时回退静态状态
        const occ = worldState?.workstations?.find(
          (w) => w.entityId === entity.entityId,
        )?.occupancy;
        if (occ == null) {
          if (entity.status === 'producing') return '#10b981';
          if (entity.status === 'warning') return '#f59e0b';
          return '#6b7280';
        }
        if (occ < 0.4) return '#10b981';
        if (occ < 0.7) return '#f59e0b';
        return '#ef4444';
      }
      return '#3b82f6';
    case 'person':
      return entity.entityType === 'person' ? '#06b6d4' : '#4b5563';
    case 'exoskeleton':
      // 仅外骨骼装备按其在线态着色，其余设备统一灰色
      if (entity.entityType === 'device' && isExoDevice(entity)) {
        const dev = worldState?.devices.find((d) => d.entityId === entity.entityId);
        return dev && dev.status !== 'offline' ? '#10b981' : '#6b7280';
      }
      return '#4b5563';
    case 'body_load':
      if (entity.entityType === 'person') {
        const p = worldState?.persons.find((pp) => pp.entityId === entity.entityId);
        const score = p?.loadScore;
        if (score == null) return '#6b7280';
        if (score < 0.3) return '#10b981';
        if (score < 0.6) return '#f59e0b';
        if (score < 0.8) return '#f97316';
        return '#ef4444';
      }
      return '#4b5563';
    case 'safety_risk':
      return entity.entityType === 'restricted_zone' ? '#ef4444' : '#4b5563';
    case 'device':
      if (entity.entityType === 'device') {
        const dev = worldState?.devices.find((d) => d.entityId === entity.entityId);
        return dev && dev.status !== 'offline' ? '#10b981' : '#6b7280';
      }
      return '#4b5563';
    case 'environment':
      // 无真实环境数据时用中性色，避免误导
      if (entity.entityType === 'zone') {
        return 'rgba(34,211,238,0.25)';
      }
      return '#4b5563';
    case 'scheduling':
      return entity.entityType === 'person' ? '#a855f7' : '#4b5563';
    case 'data_quality':
      if (entity.confidence > 0.95) return '#10b981';
      if (entity.confidence >= 0.8) return '#f59e0b';
      return '#ef4444';
    default:
      return '#3b82f6';
  }
}

/** 设备层着色：依赖 mode 决定是否区分外骨骼 */
export function getDeviceColor(
  entity: SpatialEntity,
  mode: string,
  worldState: CurrentWorldState | null,
): string {
  if (mode === 'exoskeleton') {
    // 外骨骼装备按在线态着色，其余设备统一灰色
    if (!isExoDevice(entity)) return '#4b5563';
    const dev = worldState?.devices.find((d) => d.entityId === entity.entityId);
    return dev && dev.status !== 'offline' ? '#10b981' : '#6b7280';
  }
  if (mode === 'device' || mode === 'production') {
    const dev = worldState?.devices.find((d) => d.entityId === entity.entityId);
    return dev && dev.status !== 'offline' ? '#10b981' : '#6b7280';
  }
  return '#4b5563';
}

/** 后端 priority.level 的触点颜色（智能调度驾驶舱徽标用，展示层映射）。 */
export function priorityLevelColor(level?: string): string {
  switch (level) {
    case 'urgent':
    case 'critical':
      return '#ef4444';
    case 'high':
      return '#f97316';
    case 'medium':
    case 'normal':
      return '#f59e0b';
    case 'low':
      return '#3b82f6';
    default:
      return '#a855f7';
  }
}

/** 资源可用性层：将后端 status 值映射为展示色（available/busy/unavailable/offline/fault/stale 等）。 */
export function resourceStatusColor(status?: string): string {
  switch (status) {
    case 'offline':
    case 'unavailable':
    case 'fault':
    case 'faulted':
      return '#ef4444';
    case 'busy':
    case 'occupied':
    case 'executing':
      return '#f97316';
    case 'reserved':
      return '#f59e0b';
    case 'stale':
      return '#6b7280';
    case 'idle':
    case 'available':
    case 'online':
    case 'ready':
    default:
      return '#34d399';
  }
}
