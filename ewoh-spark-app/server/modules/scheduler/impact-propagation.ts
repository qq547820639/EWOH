/**
 * Impact Propagation（Incremental Replan V2 / M01，08 §3）——确定性闭包扩散纯函数。
 *
 * propagateImpact(snapshot, seed): ReplanImpact —— 从 seed（直接命中集合）出发，
 * 沿资源维度（device→tasks→deviceBinding person→person 的 assignee 任务→zone）、
 * route edge（routeEdgeTaskIndex）、station/zone 传播影响闭包，并对 predecessor
 * 下游做深度受限的 BFS，输出与现有 ImpactAnalyzer.affectedTaskIds 语义兼容的
 * 超集（含资源/冻结/可移动划分）。
 *
 * 纯函数约束：无 DB、无注入、无随机源。同 snapshot + seed 恒同输出（确定性）。
 */
import type { ReplanImpact, WorldStateSnapshot } from '@shared/api.interface';
import { TaskLifecycle } from './task-lifecycle';

/** 传播停止条件缺省值（08 §3；可经 PropagateOptions 覆盖）。 */
export const DEFAULT_MAX_PROPAGATION_DEPTH = 3;
export const DEFAULT_MAX_AFFECTED_TASKS = 200;

/** 冻结状态（与 impact-analyzer.ts FROZEN_STATUSES 同源）：executing/dispatched/in_progress。 */
const FROZEN_STATUSES = new Set(['executing', 'dispatched', 'in_progress']);

/** 传播选项（全可选；缺省=设计默认）。 */
export interface PropagateOptions {
  /** 仅 predecessor 闭包计入深度（资源维度为 1 跳），缺省 3。 */
  maxPropagationDepth?: number;
  /** 影响任务数截断，缺省 200。 */
  maxAffectedTasks?: number;
}

/** 逐项收集受影响任务的去重原因。 */
class TaskReasonCollector {
  private readonly reasonsByTask = new Map<string, Set<string>>();

  add(taskId: string, reason: string): boolean {
    let reasons = this.reasonsByTask.get(taskId);
    if (!reasons) {
      reasons = new Set<string>();
      this.reasonsByTask.set(taskId, reasons);
    }
    if (reasons.has(reason)) return false;
    reasons.add(reason);
    return true;
  }

  has(taskId: string): boolean {
    return this.reasonsByTask.has(taskId);
  }

  reasonsFor(taskId: string): string[] {
    return Array.from(this.reasonsByTask.get(taskId) ?? []);
  }

  taskIds(): string[] {
    return Array.from(this.reasonsByTask.keys());
  }
}

/**
 * 确定性影响传播：
 *  - 资源维度（device/person/station/zone/route edge）逐跳扩散，每资源一跳；
 *  - predecessor 下游闭包按 BFS 计深（maxPropagationDepth 截断）；
 *  - 受影响任务总数受 maxAffectedTasks 截断；
 *  - 去重 (taskId, reason)；frozen 任务不入 movable 扩散；
 *  - 所有集合输出前做字典序排序，保证同 snapshot+seed 恒同。
 */
export function propagateImpact(
  snapshot: WorldStateSnapshot,
  seed: ReplanImpact,
  options: PropagateOptions = {},
): ReplanImpact {
  const maxDepth = options.maxPropagationDepth ?? DEFAULT_MAX_PROPAGATION_DEPTH;
  const maxAffectedTasks = options.maxAffectedTasks ?? DEFAULT_MAX_AFFECTED_TASKS;

  // ---- 快照索引（纯函数，一次构建） ----
  const taskById = new Map<string, WorldStateSnapshot['tasks'][number]>();
  const tasksByDevice = new Map<string, string[]>();
  const tasksByPerson = new Map<string, string[]>();
  const tasksByStation = new Map<string, string[]>();
  const tasksByZone = new Map<string, string[]>();
  for (const t of snapshot.tasks) {
    taskById.set(t.id, t);
    appendIndex(tasksByDevice, t.deviceId, t.id);
    appendIndex(tasksByPerson, t.assigneeId, t.id);
    appendIndex(tasksByStation, t.stationId, t.id);
    appendIndex(tasksByZone, t.zoneId, t.id);
  }

  // deviceBinding：设备 → 绑定人员（world-state.service.ts 476-481 语义：
  // 快照不携带 deviceBindings，这里从任务 deviceId+assigneeId 推导，确定性取字典序最小任务）。
  const deviceBindingPerson = new Map<string, string>();
  for (const t of [...snapshot.tasks].sort((a, b) => a.id.localeCompare(b.id))) {
    if (t.deviceId && t.assigneeId && !deviceBindingPerson.has(t.deviceId)) {
      deviceBindingPerson.set(t.deviceId, t.assigneeId);
    }
  }

  // 空间 parent 解析：设备 → 所在 zone（通过任务 deviceId+zoneId 推导，确定性取字典序最小）。
  const zoneByDevice = new Map<string, string>();
  for (const t of [...snapshot.tasks].sort((a, b) => a.id.localeCompare(b.id))) {
    if (t.deviceId && t.zoneId && !zoneByDevice.has(t.deviceId)) {
      zoneByDevice.set(t.deviceId, t.zoneId);
    }
  }
  const zoneByStation = new Map<string, string>();
  for (const t of [...snapshot.tasks].sort((a, b) => a.id.localeCompare(b.id))) {
    if (t.stationId && t.zoneId && !zoneByStation.has(t.stationId)) {
      zoneByStation.set(t.stationId, t.zoneId);
    }
  }

  // ---- 冻结集合 ----
  const lockedTaskIds = new Set(snapshot.lockedAssignments.map((a) => a.taskId));
  const safetyBlockedPersonIds = new Set(snapshot.safetyBlockedPersonIds ?? []);
  const safetyBlockedDeviceIds = new Set(snapshot.safetyBlockedDeviceIds ?? []);
  const forbiddenZoneIds = new Set(snapshot.forbiddenZones.map((z) => z.zoneId));

  const frozenTaskIds = snapshot.tasks
    .filter(
      (t) =>
        FROZEN_STATUSES.has(t.status) ||
        lockedTaskIds.has(t.id) ||
        safetyBlockedPersonIds.has(t.assigneeId ?? '') ||
        safetyBlockedDeviceIds.has(t.deviceId ?? '') ||
        (t.zoneId != null && forbiddenZoneIds.has(t.zoneId)),
    )
    .map((t) => t.id);
  const frozenSet = new Set(frozenTaskIds);

  // ---- 受影响集合（去重原因） ----
  const affectedTasks = new TaskReasonCollector();
  const affectedPersons = new Set<string>();
  const affectedDevices = new Set<string>();
  const affectedStations = new Set<string>();
  const affectedZones = new Set<string>();

  const addAffectedTask = (taskId: string, reason: string): boolean => {
    if (affectedTasks.has(taskId)) {
      affectedTasks.add(taskId, reason);
      return true;
    }
    if (affectedTasks.taskIds().length >= maxAffectedTasks) {
      // NEST-022（2026-08-17）：截断不再静默——留痕（纯函数模块，console.warn；
      // 影响面即重排范围，静默丢失会导致"以为已重排实则未含"的静默偏差）。
      // eslint-disable-next-line no-console
      console.warn(
        `[impact-propagation] maxAffectedTasks=${maxAffectedTasks} reached; task ${taskId} (${reason}) excluded from affected set`,
      );
      return false;
    }
    affectedTasks.add(taskId, reason);
    return true;
  };

  // 1) seed 直接命中：受影响任务 + 受影响资源。
  const seedTriggerIds = new Set(seed.triggerIds ?? []);
  for (const taskId of seed.affectedTaskIds ?? []) {
    addAffectedTask(taskId, reasonFor(seed.triggerType, taskId, 'DIRECT'));
  }
  for (const id of seed.affectedPersonIds ?? []) affectedPersons.add(id);
  for (const id of seed.affectedDeviceIds ?? []) affectedDevices.add(id);
  for (const id of seed.affectedStationIds ?? []) affectedStations.add(id);
  for (const id of seed.affectedZoneIds ?? []) affectedZones.add(id);

  // 2) 资源维度逐跳扩散（每资源一跳，不消耗深度）。
  //    device → tasks.deviceId → deviceBinding person → person 的 assignee 任务 → zone。
  for (const deviceId of sortedSet(affectedDevices)) {
    const tasks = tasksByDevice.get(deviceId) ?? [];
    for (const taskId of [...tasks].sort()) {
      addAffectedTask(taskId, reasonFor(seed.triggerType, deviceId, 'DEVICE'));
    }
    const boundPersonId = deviceBindingPerson.get(deviceId);
    if (boundPersonId) {
      affectedPersons.add(boundPersonId);
    }
    const zoneId = zoneByDevice.get(deviceId);
    if (zoneId) {
      affectedZones.add(zoneId);
    }
  }
  //    person → assignee 任务。
  for (const personId of sortedSet(affectedPersons)) {
    const tasks = tasksByPerson.get(personId) ?? [];
    for (const taskId of [...tasks].sort()) {
      addAffectedTask(taskId, reasonFor(seed.triggerType, personId, 'PERSON'));
    }
  }
  //    station → tasks.stationId → 空间 parent 解析 zone。
  for (const stationId of sortedSet(affectedStations)) {
    const tasks = tasksByStation.get(stationId) ?? [];
    for (const taskId of [...tasks].sort()) {
      addAffectedTask(taskId, reasonFor(seed.triggerType, stationId, 'STATION'));
    }
    const zoneId = zoneByStation.get(stationId);
    if (zoneId) {
      affectedZones.add(zoneId);
    }
  }
  //    zone → 该 zone 上未锁定任务。
  for (const zoneId of sortedSet(affectedZones)) {
    const tasks = tasksByZone.get(zoneId) ?? [];
    for (const taskId of [...tasks].sort()) {
      addAffectedTask(taskId, reasonFor(seed.triggerType, zoneId, 'ZONE'));
    }
  }
  //    route edge → routeEdgeTaskIndex[edgeId]。
  for (const edgeId of [...seedTriggerIds].sort()) {
    const edgeTasks = snapshot.routeEdgeTaskIndex?.[edgeId] ?? [];
    for (const taskId of [...edgeTasks].sort()) {
      addAffectedTask(taskId, reasonFor(seed.triggerType, edgeId, 'ROUTE_EDGE'));
    }
  }
  //    safety blocked → fail-closed：纳入 affected 说明（求解器消费 hard 过滤，传播层仅说明）。
  //    NEST-021 修复（2026-08-17）：仅当触发类型与安全相关（SAFETY_*）时才把
  //    全部安全阻断资源扩散进 affected——无关触发（如 ROUTE_BLOCKED）不再
  //    无差别纳入全部安全阻断任务（影响集虚增、局部重排退化为大面积重排）。
  //    安全阻断的 frozen 语义不受影响（上方 frozenSet 判定始终生效）。
  const safetyRelatedTrigger = /SAFETY/i.test(seed.triggerType ?? '');
  if (safetyRelatedTrigger) {
    for (const personId of sortedSet(safetyBlockedPersonIds)) {
      affectedPersons.add(personId);
      for (const taskId of [...(tasksByPerson.get(personId) ?? [])].sort()) {
        addAffectedTask(taskId, `SAFETY_BLOCK:${personId}`);
      }
    }
    for (const deviceId of sortedSet(safetyBlockedDeviceIds)) {
      affectedDevices.add(deviceId);
      for (const taskId of [...(tasksByDevice.get(deviceId) ?? [])].sort()) {
        addAffectedTask(taskId, `SAFETY_BLOCK:${deviceId}`);
      }
    }
    for (const zoneId of sortedSet(forbiddenZoneIds)) {
      affectedZones.add(zoneId);
      for (const taskId of [...(tasksByZone.get(zoneId) ?? [])].sort()) {
        addAffectedTask(taskId, `SAFETY_BLOCK:${zoneId}`);
      }
    }
  }

  // 3) predecessor 下游闭包（BFS，按 taskId 字典序遍历；深度受限）。
  //    迭代直到无新增；frozen 任务可作 BFS 源（其待处理下游会受影响），
  //    但 frozen 自身不入 movable 扩散（设计 §3：frozen 任务不扩散其下游）。
  let queue: string[] = affectedTasks.taskIds().sort();
  let depth = 0;
  while (queue.length > 0 && depth < maxDepth) {
    depth += 1;
    const nextSet = new Set<string>();
    const sortedTasks = [...snapshot.tasks].sort((a, b) => a.id.localeCompare(b.id));
    for (const taskId of queue) {
      const task = taskById.get(taskId);
      if (!task) continue;
      for (const dependentId of sortedTasks) {
        if (frozenSet.has(dependentId.id)) continue;
        if (!dependentId.predecessorIds?.includes(taskId)) continue;
        if (addAffectedTask(dependentId.id, `PREDECESSOR:${taskId}`)) {
          nextSet.add(dependentId.id);
        }
      }
    }
    queue = Array.from(nextSet).sort();
  }

  // 4) 受影响资源集合补全：受影响任务的 assignee/device/station/zone 也计入资源维度。
  for (const taskId of affectedTasks.taskIds()) {
    const task = taskById.get(taskId);
    if (!task) continue;
    if (task.assigneeId) affectedPersons.add(task.assigneeId);
    if (task.deviceId) affectedDevices.add(task.deviceId);
    if (task.stationId) affectedStations.add(task.stationId);
    if (task.zoneId) affectedZones.add(task.zoneId);
  }

  // 5) 可移动任务 = affected ∩ schedulable ∩ !frozen。
  const movableAssignmentIds = affectedTasks
    .taskIds()
    .filter((taskId) => {
      const task = taskById.get(taskId);
      if (!task) return false;
      return !frozenSet.has(taskId) && TaskLifecycle.isSchedulable(task.status);
    })
    .sort();

  const affectedTaskIds = affectedTasks.taskIds().sort();
  const affectedResourceIds = Array.from(
    new Set([...affectedPersons, ...affectedDevices, ...affectedStations]),
  ).sort();

  // 6) reasons：去重、确定性排序（'CODE:id' 格式，与 triggerIds 对齐）。
  const reasons = new Set<string>(seed.reasons ?? []);
  for (const taskId of affectedTaskIds) {
    for (const r of affectedTasks.reasonsFor(taskId)) reasons.add(r);
  }
  for (const personId of sortedSet(affectedPersons)) {
    reasons.add(reasonFor(seed.triggerType, personId, 'PERSON'));
  }
  for (const deviceId of sortedSet(affectedDevices)) {
    reasons.add(reasonFor(seed.triggerType, deviceId, 'DEVICE'));
  }
  for (const stationId of sortedSet(affectedStations)) {
    reasons.add(reasonFor(seed.triggerType, stationId, 'STATION'));
  }
  for (const zoneId of sortedSet(affectedZones)) {
    reasons.add(reasonFor(seed.triggerType, zoneId, 'ZONE'));
  }

  return {
    triggerType: seed.triggerType,
    triggerIds: [...seedTriggerIds].sort(),
    affectedTaskIds,
    affectedResourceIds,
    affectedPersonIds: sortedSet(affectedPersons),
    affectedDeviceIds: sortedSet(affectedDevices),
    affectedStationIds: sortedSet(affectedStations),
    affectedZoneIds: sortedSet(affectedZones),
    frozenAssignmentIds: [...frozenSet].sort(),
    movableAssignmentIds,
    reasons: Array.from(reasons).sort(),
    snapshotVersion: snapshot.snapshotVersion,
    baselinePlanVersion: seed.baselinePlanVersion ?? null,
  };
}

/** 生成 'CODE:id' 形式的原因串（与 triggerIds 对齐；DIRECT 用于 seed 直接命中）。 */
function reasonFor(triggerType: string, id: string, kind: string): string {
  const code =
    kind === 'DIRECT'
      ? triggerType
      : kind === 'PERSON'
        ? 'PERSON_UNAVAILABLE'
        : kind === 'DEVICE'
          ? 'DEVICE_OFFLINE'
          : kind === 'STATION'
            ? 'STATION_BLOCKED'
            : kind === 'ZONE'
              ? 'ZONE_RESTRICTED'
              : kind === 'ROUTE_EDGE'
                ? 'ROUTE_BLOCKED'
                : triggerType;
  return `${code}:${id}`;
}

/** 向索引追加（Map<string, string[]>）。 */
function appendIndex(index: Map<string, string[]>, key: string | null | undefined, value: string): void {
  if (!key) return;
  const list = index.get(key);
  if (list) {
    list.push(value);
  } else {
    index.set(key, [value]);
  }
}

/** 集合转排序数组（确定性）。 */
function sortedSet(values: Iterable<string>): string[] {
  return Array.from(values).sort();
}
