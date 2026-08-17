import type {
  DeviceInfo,
  EventInfo,
  OrganizationInfo,
  PersonnelInfo,
  SpatialEntity,
  SpatialEntityType,
} from '@shared/api.interface';
import { resolveEntityDetailData } from './entityDetailData';

function entity(entityId: string, entityType: SpatialEntityType, extra: Record<string, unknown> | null = null): SpatialEntity {
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
    severity: 'high',
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
    severity: 'low',
    title: '其他设备保养',
    status: 'open',
    createdAt: '2026-08-04T00:20:00.000Z',
    handlerAction: null,
  },
  {
    // CLI-015：标题含人员姓名但 evidenceJson.personId 属于他人（无）——
    // 子串匹配曾误关联同名事件，精确匹配后不得命中。
    id: 'EVT-3',
    eventId: 'EVT-3',
    deviceId: 'EXO-999',
    eventCode: 'TITLE_MENTION',
    eventType: 'safety',
    severity: 'low',
    title: '张三设备 EXO-10 提及',
    status: 'open',
    createdAt: '2026-08-04T00:10:00.000Z',
    handlerAction: null,
  },
  {
    // CLI-015：deviceId 为 EXO-1 的前缀重叠设备（EXO-10）——
    // 子串匹配曾误命中，精确匹配后不得关联到 EXO-001 的设备。
    id: 'EVT-4',
    eventId: 'EVT-4',
    deviceId: 'EXO-10',
    eventCode: 'PREFIX_OVERLAP',
    eventType: 'maintenance',
    severity: 'low',
    title: 'EXO-10 保养',
    status: 'open',
    createdAt: '2026-08-04T00:05:00.000Z',
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

  it('CLI-015：精确匹配——标题含人员姓名但无 personId 证据的事件不误关联', () => {
    const result = resolveEntityDetailData(
      entity('p-1', 'person', { personId: 'P-1' }),
      personnel,
      organizations,
      devices,
      events,
    );
    // EVT-1（personId 精确命中）应关联；EVT-3（仅标题提及"张三"）不得关联。
    expect(result.person?.recentEvents.map((event) => event.eventId)).toEqual(['EVT-1']);
  });

  it('CLI-015：精确匹配——deviceId 前缀重叠（EXO-10 ≠ EXO-001）不误关联', () => {
    const result = resolveEntityDetailData(
      entity('d-1', 'device'),
      personnel,
      organizations,
      devices,
      events,
    );
    // 仅 EVT-1（deviceId === EXO-001）关联；EVT-4（EXO-10 前缀重叠）不得关联。
    expect(result.device?.alerts.map((event) => event.eventId)).toEqual(['EVT-1']);
  });
});
