import type { CurrentWorldState, ReplaySnapshot } from '@shared/api.interface';

export function findNearestSnapshot(
  snapshots: ReplaySnapshot[],
  time: string,
): ReplaySnapshot | null {
  if (snapshots.length === 0) return null;
  const target = new Date(time).getTime();
  let closest = snapshots[0];
  let minDiff = Infinity;
  for (const snap of snapshots) {
    const diff = Math.abs(new Date(snap.ts).getTime() - target);
    if (diff < minDiff) {
      minDiff = diff;
      closest = snap;
    }
  }
  return closest;
}

export function advanceReplayTime(
  snapshots: ReplaySnapshot[],
  currentTime: string | null,
): string | null {
  if (snapshots.length === 0) return null;
  if (!currentTime) return snapshots[0].ts;
  const current = new Date(currentTime).getTime();
  const next = snapshots.find((snap) => new Date(snap.ts).getTime() > current + 250);
  return next ? next.ts : snapshots[0].ts;
}

export function snapshotToWorldState(
  snapshot: ReplaySnapshot,
  base: CurrentWorldState | null,
): CurrentWorldState {
  const personNames = new Map(
    (base?.persons ?? []).map((person) => [person.entityId, person.name]),
  );
  const deviceNames = new Map(
    (base?.devices ?? []).map((device) => [device.entityId, device.name]),
  );

  return {
    ts: snapshot.ts,
    persons: snapshot.persons.map((person) => ({
      entityId: person.entityId,
      name: personNames.get(person.entityId) ?? person.entityId,
      x: person.x,
      y: person.y,
      status: person.status,
      confidence: 1,
      loadScore: person.loadScore,
    })),
    devices: snapshot.devices.map((device) => ({
      entityId: device.entityId,
      name: deviceNames.get(device.entityId) ?? device.entityId,
      x: device.x,
      y: device.y,
      status: device.status,
    })),
    workstations: base?.workstations ?? [],
    events: snapshot.events.map((event) => ({
      eventId: event.eventId,
      title: event.title,
      severity: event.severity,
      status: 'open',
      createdAt: snapshot.ts,
    })),
  };
}
