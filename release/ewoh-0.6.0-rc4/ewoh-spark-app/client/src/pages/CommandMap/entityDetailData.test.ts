import type {
  DeviceInfo,
  EventInfo,
  OrganizationInfo,
  PersonnelInfo,
  SpatialEntity,
} from '@shared/api.interface';
import { resolveEntityDetailData } from './entityDetailData';

function entity(entityId: string, entityType: string, extra: Record<string, unknown> | null = null): SpatialEntity {
  return {
    id: entityId,
    entityId,
    entityType,
    parentId: null,
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
    extra,
    createdAt: '2026-08-04T00:00:00.000Z',
    updatedAt: '2026-08-04T00:00:00.000Z',
  };
}

const personnel: PersonnelInfo[] = [
  {
    id: 'P-1',
    name: '张三',
    employeeNo: 'E-001',
    orgId: 'ORG-1',
    teamName: '装配一班',
    position: '装配工',
    skills: ['装配', '质检'],
    status: 'active',
    riskLevel: 'medium',
    createdAt: '2026-08-04T00:00:00.000Z',
    updatedAt: '2026-08-04T00:00:00.000Z',
  },
];

const organizations: OrganizationInfo[] = [
  {
    id: 'ORG-1',
    name: '一厂装配车间',
    orgType: 'workshop',
    parentId: null,
    status: 'active',
    description: null,
    createdAt: '2026-08-04T00:00:00.000Z',
    updatedAt: '2026-08-04T00:00:00.000Z',
  },
];

const devices: DeviceInfo[] = [
  {
    id: 'D-1',
    deviceId: 'EXO-001',
    workerName: '张三',
    deviceModel: 'NY-EXO-A1',
    batteryPct: 80,
    online: true,
    lastTelemetryAt: '2026-08-04T01:00:00.000Z',
    entityId: 'd-1',
    sourceType: 'real',
    firmwareVersion: '1.2.0',
    protocolVersion: 'v2',
    faultCode: null,
  },
];

const events: EventInfo[] = [
  {
    id: 'EVT-1',
    eventId: 'EVT-1',
    deviceId: 'EXO-001',
    eventCode: 'HIGH_LOAD',
    eventType: 'safety',
    severity: 'L2',
    title: '张三负荷过高',
    status: 'open',
    createdAt: '2026-08-04T00:30:00.000Z',
    handlerAction: null,
    evidenceJson: { personId: 'P-1' },
  },
  {
    id: 'EVT-2',
    eventId: 'EVT-2',
    deviceId: 'OTHER',
    eventCode: 'UNRELATED',
    eventType: 'maintenance',
    severity: 'L1',
    title: '其他设备保养',
    status: 'open',
    createdAt: '2026-08-04T00:20:00.000Z',
    handlerAction: null,
  },
];

describe('resolveEntityDetailData', () => {
  it('matches a person to personnel, organization, and related events', () => {
    const result = resolveEntityDetailData(
      entity('p-1', 'person', { personId: 'P-1' }),
      personnel,
      organizations,
      devices,
      events,
    );

    expect(result.person?.personnel?.name).toBe('张三');
    expect(result.person?.organization?.name).toBe('一厂装配车间');
    expect(result.person?.alerts.map((event) => event.eventId)).toEqual(['EVT-1']);
    expect(result.person?.recentEvents.map((event) => event.eventId)).toEqual(['EVT-1']);
  });

  it('matches a device to its record, alerts, and recent events', () => {
    const result = resolveEntityDetailData(
      entity('d-1', 'device'),
      personnel,
      organizations,
      devices,
      events,
    );

    expect(result.device?.device?.deviceId).toBe('EXO-001');
    expect(result.device?.alerts.map((event) => event.eventId)).toEqual(['EVT-1']);
  });

  it('returns null detail data for non-person/device entities and missing records', () => {
    const workstation = resolveEntityDetailData(
      entity('w-1', 'workstation'),
      personnel,
      organizations,
      devices,
      events,
    );
    expect(workstation.person).toBeNull();
    expect(workstation.device).toBeNull();

    const unknownPerson = resolveEntityDetailData(
      entity('p-99', 'person'),
      personnel,
      organizations,
      devices,
      events,
    );
    expect(unknownPerson.person?.personnel).toBeNull();
    expect(unknownPerson.person?.alerts).toEqual([]);
  });
});
