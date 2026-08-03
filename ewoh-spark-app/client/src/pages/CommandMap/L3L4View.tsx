import { useMemo } from 'react';
import type { SpatialEntity, CurrentWorldState } from '@shared/api.interface';
import { filterRelatedDevices, filterRelatedPersons } from './l3l4';

interface L3L4ViewProps {
  entities: SpatialEntity[];
  worldState: CurrentWorldState | null;
  level: 'L3' | 'L4';
  selectedEntityId: string | null;
  onSelectEntity: (id: string | null) => void;
}

const L3L4View = ({
  entities,
  worldState,
  level,
  selectedEntityId,
  onSelectEntity,
}: L3L4ViewProps): React.ReactElement => {
  const focusType = level === 'L3' ? 'workstation' : 'person';
  const focus =
    (selectedEntityId ? entities.find((entity) => entity.entityId === selectedEntityId) : null) ??
    entities.find((entity) => entity.entityType === focusType) ??
    null;

  const relatedPersons = useMemo(
    () => filterRelatedPersons(focus, entities, worldState),
    [focus, entities, worldState],
  );
  const relatedDevices = useMemo(
    () => filterRelatedDevices(focus, entities, worldState),
    [focus, entities, worldState],
  );

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-3 bg-[hsl(220_14%_96%)] p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="rounded-md bg-[hsl(221_83%_53%)] px-2 py-1 text-xs font-semibold text-white">
          {level === 'L3' ? 'L3 工位/设备近景' : 'L4 人员/外骨骼跟随'}
        </span>
        {focus && (
          <button
            type="button"
            onClick={() => onSelectEntity(focus.entityId)}
            className="min-w-0 rounded-md border border-[hsl(220_14%_89%)] bg-white px-2 py-1 text-xs font-medium hover:bg-[hsl(220_14%_96%)]"
            title={focus.name}
          >
            <span className="block max-w-56 truncate">{focus.name}</span>
          </button>
        )}
        <span className="text-xs text-[hsl(218_10%_42%)]">
          关联人员 {relatedPersons.length} · 关联设备 {relatedDevices.length}
        </span>
      </div>

      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-3">
        <section className="min-h-0 overflow-y-auto rounded-lg border border-[hsl(220_14%_89%)] bg-white p-4">
          <h2 className="text-sm font-semibold">当前实体</h2>
          {focus ? (
            <dl className="mt-3 space-y-2 text-sm">
              <div className="flex justify-between gap-2">
                <dt className="text-[hsl(218_10%_42%)]">类型</dt>
                <dd className="text-right">{focus.entityType}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-[hsl(218_10%_42%)]">状态</dt>
                <dd className="text-right">{focus.status}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-[hsl(218_10%_42%)]">坐标</dt>
                <dd className="font-mono text-right">{focus.x}, {focus.y}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-[hsl(218_10%_42%)]">置信度</dt>
                <dd className="text-right">{(focus.confidence * 100).toFixed(1)}%</dd>
              </div>
            </dl>
          ) : (
            <p className="mt-3 text-sm text-[hsl(218_10%_42%)]">暂无 {focusType} 实体。</p>
          )}
        </section>

        <section className="min-h-0 overflow-y-auto rounded-lg border border-[hsl(220_14%_89%)] bg-white p-4">
          <h2 className="text-sm font-semibold">关联人员</h2>
          {relatedPersons.length === 0 ? (
            <div className="mt-3 rounded-md border border-dashed border-[hsl(220_14%_89%)] p-4 text-sm text-[hsl(218_10%_42%)]">
              暂无与当前实体关联的人员数据。
            </div>
          ) : (
            <ul className="mt-3 space-y-2 text-sm">
              {relatedPersons.map((person) => (
                <li
                  key={person.entityId}
                  className="flex items-center justify-between gap-2 border-b border-[hsl(220_14%_96%)] pb-2 last:border-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">{person.name}</p>
                    <p className="truncate font-mono text-[10px] text-[hsl(218_10%_42%)]">
                      {person.entityId}
                    </p>
                  </div>
                  <span className="shrink-0 text-xs text-[hsl(218_10%_42%)]">{person.status}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="min-h-0 overflow-y-auto rounded-lg border border-[hsl(220_14%_89%)] bg-white p-4">
          <h2 className="text-sm font-semibold">关联设备 / 子实体</h2>
          {relatedDevices.length === 0 ? (
            <div className="mt-3 rounded-md border border-dashed border-[hsl(220_14%_89%)] p-4 text-sm text-[hsl(218_10%_42%)]">
              暂无与当前实体关联的设备或子实体。
            </div>
          ) : (
            <ul className="mt-3 space-y-2 text-sm">
              {relatedDevices.map((device) => (
                <li
                  key={device.entityId}
                  className="flex items-center justify-between gap-2 border-b border-[hsl(220_14%_96%)] pb-2 last:border-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">{device.name}</p>
                    <p className="truncate font-mono text-[10px] text-[hsl(218_10%_42%)]">
                      {device.entityId}
                    </p>
                  </div>
                  <span className="shrink-0 text-xs text-[hsl(218_10%_42%)]">{device.status}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
};

export default L3L4View;
