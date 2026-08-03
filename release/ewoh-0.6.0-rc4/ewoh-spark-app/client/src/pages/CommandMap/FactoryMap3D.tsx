import { useMemo, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Grid, Html, OrbitControls } from '@react-three/drei';
import { ErrorBoundary } from 'react-error-boundary';
import * as THREE from 'three';
import type { EnvironmentReading, SpatialEntity, CurrentWorldState } from '@shared/api.interface';
import FactoryMap from './FactoryMap';
import { isWebGLAvailable } from '../../lib/webgl';
import { truncateLabel } from './labels';

interface FactoryMap3DProps {
  entities: SpatialEntity[];
  worldState: CurrentWorldState | null;
  environmentReadings?: EnvironmentReading[];
  mode: string;
  selectedEntityId: string | null;
  onSelectEntity: (id: string | null) => void;
  replayMode?: boolean;
  replayTime?: string | null;
}

/** 与 2D FactoryMap 保持一致的 mode 着色语义 */
function entityColor(
  entity: SpatialEntity,
  mode: string,
  worldState: CurrentWorldState | null,
): string {
  switch (mode) {
    case 'production':
      if (entity.entityType === 'workstation') {
        if (entity.status === 'producing') return '#10b981';
        if (entity.status === 'warning') return '#f59e0b';
        return '#6b7280';
      }
      return '#3b82f6';
    case 'person':
      return entity.entityType === 'person' ? '#06b6d4' : '#4b5563';
    case 'exoskeleton':
    case 'device':
      if (entity.entityType === 'device') {
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
    case 'environment':
      if (entity.entityType === 'zone') {
        return '#1e3a5f';
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

function personColor(
  person: { entityId: string; loadScore?: number },
  mode: string,
  entities: SpatialEntity[],
): string {
  if (mode === 'body_load') {
    const score = person.loadScore;
    if (score == null) return '#6b7280';
    if (score < 0.3) return '#10b981';
    if (score < 0.6) return '#f59e0b';
    if (score < 0.8) return '#f97316';
    return '#ef4444';
  }
  if (mode === 'scheduling') return '#a855f7';
  if (mode === 'person') return '#06b6d4';
  if (mode === 'data_quality') {
    const entity = entities.find((e) => e.entityId === person.entityId);
    const confidence = entity?.confidence ?? 0;
    if (confidence > 0.95) return '#10b981';
    if (confidence >= 0.8) return '#f59e0b';
    return '#ef4444';
  }
  if (mode === 'exoskeleton' || mode === 'device' || mode === 'production' || mode === 'safety_risk') {
    return '#4b5563';
  }
  return '#06b6d4';
}

/** 工位/区域盒子 */
function EntityBox({
  entity,
  color,
  selected,
  onClick,
}: {
  entity: SpatialEntity;
  color: string;
  selected: boolean;
  onClick: () => void;
}) {
  const w = Math.max(entity.bboxW / 100, 0.5);
  const h = Math.max(entity.bboxH / 100, 0.5);
  const x = entity.x / 100;
  const z = entity.y / 100;
  return (
    <group position={[x, h / 2, z]} onClick={(e) => { e.stopPropagation(); onClick(); }}>
      <mesh>
        <boxGeometry args={[w, h, w]} />
        <meshStandardMaterial
          color={color}
          transparent
          opacity={selected ? 0.85 : 0.5}
          emissive={selected ? '#fbbf24' : '#000'}
          emissiveIntensity={selected ? 0.5 : 0}
        />
      </mesh>
      {selected && (
        <lineSegments>
          <edgesGeometry args={[new THREE.BoxGeometry(w * 1.05, h * 1.05, w * 1.05)]} />
          <lineBasicMaterial color="#fbbf24" />
        </lineSegments>
      )}
      <Html position={[0, h + 0.3, 0]} center distanceFactor={8}>
        <div className="px-1.5 py-0.5 rounded bg-black/70 text-white text-[10px] whitespace-nowrap pointer-events-none">
          {truncateLabel(entity.name, 12)}
        </div>
      </Html>
    </group>
  );
}

/** 人员胶囊体（动态移动） */
function PersonCapsule({
  entityId,
  name,
  x,
  y,
  color,
  selected,
  onClick,
}: {
  entityId: string;
  name: string;
  x: number;
  y: number;
  color: string;
  selected: boolean;
  onClick: () => void;
}) {
  const ref = useRef<THREE.Group>(null);
  const targetX = x / 100;
  const targetZ = y / 100;

  useFrame(() => {
    if (!ref.current) return;
    ref.current.position.x += (targetX - ref.current.position.x) * 0.1;
    ref.current.position.z += (targetZ - ref.current.position.z) * 0.1;
  });

  return (
    <group ref={ref} position={[targetX, 0.8, targetZ]} onClick={(e) => { e.stopPropagation(); onClick(); }}>
      <mesh>
        <capsuleGeometry args={[0.25, 0.6, 4, 8]} />
        <meshStandardMaterial
          color={color}
          emissive={selected ? '#fbbf24' : color}
          emissiveIntensity={selected ? 0.6 : 0.2}
        />
      </mesh>
      <Html position={[0, 1.2, 0]} center distanceFactor={8}>
        <div className="px-1 py-0.5 rounded bg-black/70 text-white text-[10px] whitespace-nowrap pointer-events-none">
          {truncateLabel(name, 12)}
        </div>
      </Html>
    </group>
  );
}

/** 摄像头视锥 */
function CameraCone({ entity, selected, onClick }: { entity: SpatialEntity; selected: boolean; onClick: () => void }) {
  const x = entity.x / 100;
  const z = entity.y / 100;
  const yaw = (entity.yaw * Math.PI) / 180;
  const extra = entity.extra as { range?: number } | null;
  const range = (extra?.range ?? 200) / 100;
  return (
    <group position={[x, 1.5, z]} rotation={[0, -yaw, 0]} onClick={(e) => { e.stopPropagation(); onClick(); }}>
      <mesh position={[range / 2, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
        <coneGeometry args={[range / 2, range, 8, 1, true]} />
        <meshStandardMaterial color="#3b82f6" transparent opacity={selected ? 0.3 : 0.12} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

/** UWB 覆盖半球 */
function UwbSphere({ entity, onClick }: { entity: SpatialEntity; onClick: () => void }) {
  const x = entity.x / 100;
  const z = entity.y / 100;
  const extra = entity.extra as { coverage_r?: number } | null;
  const r = (extra?.coverage_r ?? 150) / 100;
  return (
    <group position={[x, 0, z]} onClick={(e) => { e.stopPropagation(); onClick(); }}>
      <mesh>
        <sphereGeometry args={[r, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshStandardMaterial color="#22d3ee" transparent opacity={0.08} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

function FactoryMapFallback({
  entities,
  worldState,
  environmentReadings,
  mode,
  selectedEntityId,
  onSelectEntity,
  replayMode,
  replayTime,
}: FactoryMap3DProps) {
  return (
    <div className="relative flex-1 min-w-0 bg-[hsl(220_14%_8%)] overflow-hidden">
      <FactoryMap
        entities={entities}
        worldState={worldState}
        environmentReadings={environmentReadings}
        mode={mode}
        level="L1"
        selectedEntityId={selectedEntityId}
        onSelectEntity={onSelectEntity}
        replayMode={replayMode}
        replayTime={replayTime}
      />
      <div className="absolute top-3 left-3 z-20 px-2.5 py-1 rounded-full bg-[hsl(32_80%_50%)] text-white text-xs font-medium shadow-lg">
        3D 不可用，已切换 2D
      </div>
    </div>
  );
}

const FactoryMap3D = ({
  entities,
  worldState,
  environmentReadings = [],
  mode,
  selectedEntityId,
  onSelectEntity,
  replayMode = false,
  replayTime = null,
}: FactoryMap3DProps): React.ReactElement => {
  const webglAvailable = useMemo(() => isWebGLAvailable(), []);
  const [canvasFailed, setCanvasFailed] = useState(false);

  const staticEntities = useMemo(
    () => entities.filter((e) => ['workshop', 'production_line', 'zone', 'route', 'restricted_zone', 'workstation'].includes(e.entityType)),
    [entities],
  );
  const cameras = useMemo(() => entities.filter((e) => e.entityType === 'camera'), [entities]);
  const uwbStations = useMemo(() => entities.filter((e) => e.entityType === 'uwb_station'), [entities]);
  const devices = useMemo(() => entities.filter((e) => e.entityType === 'device'), [entities]);

  // 合并人员动态位置
  const persons = useMemo(() => {
    const map = new Map<string, { entityId: string; name: string; x: number; y: number; loadScore?: number }>();
    if (worldState) {
      for (const p of worldState.persons) {
        map.set(p.entityId, { entityId: p.entityId, name: p.name, x: p.x, y: p.y, loadScore: p.loadScore });
      }
    }
    for (const e of entities) {
      if (e.entityType !== 'person' || map.has(e.entityId)) continue;
      map.set(e.entityId, { entityId: e.entityId, name: e.name, x: e.x, y: e.y });
    }
    return Array.from(map.values());
  }, [entities, worldState]);

  const fallbackProps: FactoryMap3DProps = {
    entities,
    worldState,
    environmentReadings,
    mode,
    selectedEntityId,
    onSelectEntity,
    replayMode,
    replayTime,
  };

  if (!webglAvailable || canvasFailed) {
    return <FactoryMapFallback {...fallbackProps} />;
  }

  return (
    <div className="relative flex-1 min-w-0 bg-[hsl(220_14%_8%)] overflow-hidden">
      <ErrorBoundary
        onError={() => setCanvasFailed(true)}
        fallbackRender={() => <FactoryMapFallback {...fallbackProps} />}
      >
        <Canvas camera={{ position: [10, 8, 10], fov: 50 }} onPointerMissed={() => onSelectEntity(null)}>
          <ambientLight intensity={0.5} />
          <directionalLight position={[10, 15, 5]} intensity={0.8} castShadow />
          <pointLight position={[-10, 5, -10]} intensity={0.3} />

          {/* 地面网格 */}
          <Grid
            args={[20, 20]}
            cellSize={1}
            cellThickness={0.5}
            cellColor="#1e3a5f"
            sectionSize={5}
            sectionThickness={1}
            sectionColor="#3b82f6"
            fadeDistance={30}
            fadeStrength={1}
            infiniteGrid
          />

          {/* 静态实体盒子 */}
          {staticEntities.map((e) => (
            <EntityBox
              key={e.entityId}
              entity={e}
              color={entityColor(e, mode, worldState)}
              selected={selectedEntityId === e.entityId}
              onClick={() => onSelectEntity(e.entityId)}
            />
          ))}

          {/* 设备 */}
          {devices.map((d) => (
            <EntityBox
              key={d.entityId}
              entity={d}
              color={entityColor(d, mode, worldState)}
              selected={selectedEntityId === d.entityId}
              onClick={() => onSelectEntity(d.entityId)}
            />
          ))}

          {/* 摄像头视锥 */}
          {cameras.map((c) => (
            <CameraCone
              key={c.entityId}
              entity={c}
              selected={selectedEntityId === c.entityId}
              onClick={() => onSelectEntity(c.entityId)}
            />
          ))}

          {/* UWB 覆盖 */}
          {uwbStations.map((u) => (
            <UwbSphere key={u.entityId} entity={u} onClick={() => onSelectEntity(u.entityId)} />
          ))}

          {/* 人员胶囊体 */}
          {persons.map((p) => (
            <PersonCapsule
              key={p.entityId}
              entityId={p.entityId}
              name={p.name}
              x={p.x}
              y={p.y}
              color={personColor(p, mode, entities)}
              selected={selectedEntityId === p.entityId}
              onClick={() => onSelectEntity(p.entityId)}
            />
          ))}

          <OrbitControls
            enablePan
            enableZoom
            enableRotate
            minDistance={3}
            maxDistance={30}
            maxPolarAngle={Math.PI / 2.1}
          />
        </Canvas>
      </ErrorBoundary>

      {/* L2 标识 */}
      <div className="absolute top-3 left-3 px-2.5 py-1 rounded-full bg-[hsl(221_83%_53%)] text-white text-xs font-medium shadow-lg">
        L2 三维孪生 · {mode}
      </div>

      {/* 操作提示 */}
      <div className="absolute bottom-2 left-3 text-[10px] text-white/60 pointer-events-none">
        左键旋转 · 右键平移 · 滚轮缩放 · 点击实体选中
      </div>

      {/* 空数据占位 */}
      {entities.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-white/60 text-sm pointer-events-none">
          暂无空间实体数据
        </div>
      )}

      {/* 环境模式：无真实环境数据时明确空态 */}
      {mode === 'environment' && environmentReadings.length === 0 && (
        <div className="pointer-events-none absolute inset-x-0 top-12 z-20 flex justify-center px-4">
          <div className="rounded-lg border border-white/10 bg-[hsl(220_14%_14%)]/90 px-4 py-2 text-xs text-white/70 shadow-xl backdrop-blur">
            环境模式暂无实时环境数据，等待传感器接入后展示温湿度态势。
          </div>
        </div>
      )}
    </div>
  );
};

export default FactoryMap3D;
