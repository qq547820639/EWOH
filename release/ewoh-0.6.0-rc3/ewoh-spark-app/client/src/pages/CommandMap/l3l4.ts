import type { CurrentWorldState, SpatialEntity } from '@shared/api.interface';

export interface RelatedPerson {
  entityId: string;
  name: string;
  status: string;
  deviceId?: string;
  task?: string;
  loadScore?: number;
}

export interface RelatedDevice {
  entityId: string;
  name: string;
  status: string;
  deviceId?: string;
  workerId?: string;
}

/** 与 focus 直接相关的实体 ID：focus 自身 + 直接子实体。 */
export function getRelatedEntityIds(
  focus: SpatialEntity | null,
  entities: SpatialEntity[],
): Set<string> {
  const ids = new Set<string>();
  if (!focus) return ids;
  ids.add(focus.entityId);
  for (const entity of entities) {
    if (entity.parentId === focus.entityId) ids.add(entity.entityId);
  }
  return ids;
}

/**
 * 关联人员只保留两类：
 * 1. 世界状态中引用 focus 或其直接子实体的记录（person.deviceId / entityId）。
 * 2. 空间实体中挂在 focus 下的 person 子节点。
 */
export function filterRelatedPersons(
  focus: SpatialEntity | null,
  entities: SpatialEntity[],
  worldState: CurrentWorldState | null,
): RelatedPerson[] {
  if (!focus) return [];
  const relatedIds = getRelatedEntityIds(focus, entities);
  const personChildIds = new Set(
    entities
      .filter((entity) => entity.entityType === 'person' && entity.parentId === focus.entityId)
      .map((entity) => entity.entityId),
  );
  const seen = new Set<string>();
  const result: RelatedPerson[] = [];

  for (const person of worldState?.persons ?? []) {
    if (
      relatedIds.has(person.entityId) ||
      relatedIds.has(person.deviceId ?? '') ||
      person.deviceId === focus.entityId ||
      person.entityId === focus.entityId
    ) {
      seen.add(person.entityId);
      result.push({
        entityId: person.entityId,
        name: person.name,
        status: person.status,
        deviceId: person.deviceId,
        task: person.task,
        loadScore: person.loadScore,
      });
    }
  }

  for (const entity of entities) {
    if (
      entity.entityType !== 'person' ||
      !personChildIds.has(entity.entityId) ||
      seen.has(entity.entityId)
    ) {
      continue;
    }
    seen.add(entity.entityId);
    result.push({
      entityId: entity.entityId,
      name: entity.name,
      status: entity.status,
    });
  }

  return result;
}

/**
 * 关联设备只保留两类：
 * 1. 世界状态中引用 focus 或其直接子实体的记录（workerId / deviceId / entityId）。
 * 2. 空间实体中挂在 focus 下的 device 子节点。
 */
export function filterRelatedDevices(
  focus: SpatialEntity | null,
  entities: SpatialEntity[],
  worldState: CurrentWorldState | null,
): RelatedDevice[] {
  if (!focus) return [];
  const relatedIds = getRelatedEntityIds(focus, entities);
  const deviceChildIds = new Set(
    entities
      .filter((entity) => entity.entityType === 'device' && entity.parentId === focus.entityId)
      .map((entity) => entity.entityId),
  );
  const seen = new Set<string>();
  const result: RelatedDevice[] = [];

  for (const device of worldState?.devices ?? []) {
    if (
      relatedIds.has(device.entityId) ||
      relatedIds.has(device.deviceId ?? '') ||
      relatedIds.has(device.workerId ?? '') ||
      device.workerId === focus.entityId ||
      device.entityId === focus.entityId
    ) {
      seen.add(device.entityId);
      result.push({
        entityId: device.entityId,
        name: device.name,
        status: device.status,
        deviceId: device.deviceId,
        workerId: device.workerId,
      });
    }
  }

  for (const entity of entities) {
    if (
      entity.entityType !== 'device' ||
      !deviceChildIds.has(entity.entityId) ||
      seen.has(entity.entityId)
    ) {
      continue;
    }
    seen.add(entity.entityId);
    result.push({
      entityId: entity.entityId,
      name: entity.name,
      status: entity.status,
    });
  }

  return result;
}
