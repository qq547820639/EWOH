import type {
  DeviceInfo,
  EventInfo,
  OrganizationInfo,
  PersonnelInfo,
  SpatialEntity,
} from '@shared/api.interface';

export interface PersonDetailData {
  personnel: PersonnelInfo | null;
  organization: OrganizationInfo | null;
  alerts: EventInfo[];
  recentEvents: EventInfo[];
}

export interface DeviceDetailData {
  device: DeviceInfo | null;
  alerts: EventInfo[];
  recentEvents: EventInfo[];
}

export interface EntityDetailData {
  person: PersonDetailData | null;
  device: DeviceDetailData | null;
}

function byCreatedAtDesc(left: EventInfo, right: EventInfo): number {
  return (right.createdAt ?? '').localeCompare(left.createdAt ?? '');
}

function relatedEvents(
  events: EventInfo[],
  match: (event: EventInfo) => boolean,
): { alerts: EventInfo[]; recentEvents: EventInfo[] } {
  const sorted = [...events].sort(byCreatedAtDesc);
  const related = sorted.filter(match);
  return {
    alerts: related.filter((event) => event.status !== 'closed'),
    recentEvents: related.slice(0, 5),
  };
}

export function resolveEntityDetailData(
  entity: SpatialEntity | null,
  personnel: PersonnelInfo[],
  organizations: OrganizationInfo[],
  devices: DeviceInfo[],
  events: EventInfo[],
): EntityDetailData {
  if (!entity) {
    return { person: null, device: null };
  }

  if (entity.entityType === 'person') {
    const personnelRecord =
      personnel.find(
        (candidate) =>
          candidate.name === entity.name ||
          String(entity.extra?.personId ?? '') === candidate.id ||
          String(entity.extra?.employeeNo ?? '') === candidate.employeeNo,
      ) ?? null;
    const organization = personnelRecord?.orgId
      ? (organizations.find((org) => org.id === personnelRecord.orgId) ?? null)
      : null;
    const related = relatedEvents(
      events,
      (event) =>
        Boolean(personnelRecord) &&
        (String(event.evidenceJson?.personId ?? '') === personnelRecord?.id ||
          event.title.includes(entity.name)),
    );
    return {
      person: {
        personnel: personnelRecord,
        organization,
        alerts: related.alerts,
        recentEvents: related.recentEvents,
      },
      device: null,
    };
  }

  if (entity.entityType === 'device') {
    const deviceRecord =
      devices.find(
        (candidate) =>
          candidate.entityId === entity.entityId ||
          candidate.deviceId === entity.entityId ||
          candidate.deviceId === entity.name,
      ) ?? null;
    const deviceKey = deviceRecord?.deviceId ?? entity.name;
    const related = relatedEvents(
      events,
      (event) => event.deviceId === deviceKey || event.title.includes(deviceKey),
    );
    return {
      person: null,
      device: {
        device: deviceRecord,
        alerts: related.alerts,
        recentEvents: related.recentEvents,
      },
    };
  }

  return { person: null, device: null };
}
