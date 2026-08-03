import type { CurrentWorldState, SpatialEntity } from '@shared/api.interface';
import { filterRelatedDevices, filterRelatedPersons } from './l3l4';

const entity = (
  entityId: string,
  entityType: string,
  parentId: string | null = null,
): SpatialEntity => ({
  id: entityId,
  entityId,
  entityType,
  parentId,
  name: entityId,
  x: 0,
  y: 0,
  yaw: 0,
  bboxW: 10,
  bboxH: 10,
  status: 'active',
  sourceType: 'simulated',
  confidence: 1,
  version: 1,
  extra: null,
  createdAt: '2026-08-03T00:00:00.000Z',
  updatedAt: '2026-08-03T00:00:00.000Z',
});

describe('L3/L4 related entity filtering', () => {
  const focus = entity('w-1', 'workstation', 'f-1');
  const entities = [
    entity('f-1', 'factory'),
    focus,
    entity('d-1', 'device', 'w-1'),
    entity('d-2', 'device', 'w-1'),
    entity('d-3', 'device', 'f-1'),
    entity('p-1', 'person', 'w-1'),
    entity('p-2', 'person', 'f-1'),
  ];

  const worldState: CurrentWorldState = {
    ts: '2026-08-03T00:01:00.000Z',
    persons: [
      { entityId: 'p-1', name: '张三', x: 1, y: 1, status: 'working', confidence: 1, deviceId: 'd-1' },
      { entityId: 'p-2', name: '李四', x: 2, y: 2, status: 'idle', confidence: 1, deviceId: 'd-3' },
      { entityId: 'p-9', name: '王五', x: 3, y: 3, status: 'idle', confidence: 1, deviceId: 'd-9' },
    ],
    devices: [
      { entityId: 'd-1', name: 'EXO-1', x: 1, y: 1, status: 'online', workerId: 'p-1' },
      { entityId: 'd-2', name: 'EXO-2', x: 2, y: 2, status: 'offline' },
      { entityId: 'd-3', name: 'EXO-3', x: 3, y: 3, status: 'online', workerId: 'p-2' },
      { entityId: 'd-9', name: 'EXO-9', x: 9, y: 9, status: 'online', workerId: 'p-9' },
    ],
    workstations: [],
    events: [],
  };

  it('filters persons by focus children and world-state references', () => {
    const related = filterRelatedPersons(focus, entities, worldState);
    expect(related.map((person) => person.entityId).sort()).toEqual(['p-1']);
    expect(related).toHaveLength(1);
  });

  it('filters devices by focus children and worker references', () => {
    const related = filterRelatedDevices(focus, entities, worldState);
    expect(related.map((device) => device.entityId).sort()).toEqual(['d-1', 'd-2']);
  });

  it('falls back to entity children when world state has no matching records', () => {
    const emptyWorld: CurrentWorldState = {
      ts: '2026-08-03T00:01:00.000Z',
      persons: [],
      devices: [],
      workstations: [],
      events: [],
    };
    expect(filterRelatedPersons(focus, entities, emptyWorld).map((p) => p.entityId)).toEqual([
      'p-1',
    ]);
    expect(filterRelatedDevices(focus, entities, emptyWorld).map((d) => d.entityId)).toEqual([
      'd-1',
      'd-2',
    ]);
  });

  it('does not return unrelated global records', () => {
    const personFocus = entity('p-2', 'person', 'f-1');
    const devices = filterRelatedDevices(personFocus, entities, worldState);
    expect(devices.map((device) => device.entityId)).toEqual(['d-3']);
  });

  it('returns empty lists without a focus', () => {
    expect(filterRelatedPersons(null, entities, worldState)).toEqual([]);
    expect(filterRelatedDevices(null, entities, worldState)).toEqual([]);
  });
});
