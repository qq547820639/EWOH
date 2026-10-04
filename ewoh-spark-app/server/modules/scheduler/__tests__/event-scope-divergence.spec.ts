/* EVTSC-01（V358 复核轮）：事件作用域两条腿的分叉，钉的是"生产 heuristic 走的是不分作用域那条"。
 *
 * 快照侧确实产 scope 数据（`world-state.service.ts:1180-1183` 从 `evidenceJson.affectedTaskIds` 建
 * `eventImpacts`、`:1468` 挂上快照，注释写「供 PriorityEngine 只消费相关事件」）；
 * 按 scope 的那条腿是 `computeEffectivePriorityResults`（`priority-engine.ts:274-292` 逐任务过滤，
 * 匹配器 `:331-341`），CP-SAT 用它（`cp-sat-scheduling-solver.ts:20,269`）。
 * 生产求解器 heuristic 在 `:649-668` 直接逐任务调 `compute`，把**全部开放事件**原样塞进去、
 * 连 eventId 都不带 ⇒ `:146-160` 的 `event_severity` 负项对每个任务同等生效。
 *
 * 既有常驻用例只钉了"按 scope 的腿"（`priority-engine.spec.ts:222-246`）⇒ 本文件补的是**分叉本身**，
 * 不重复那一条：任一腿被换成另一腿、或 heuristic 开始消费 eventImpacts，本文件的差分断言就会翻。
 */
/// <reference types="jest" />
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { PriorityEngine, computeEffectivePriorityResults } from '../priority-engine';
import {
  buildSnapshot,
  defaultConfig,
  defaultPolicy,
  task,
} from './scheduler-test-helpers';
import type { WorldStateSnapshot } from '@shared/api.interface';

const NOW = 1_700_000_000_000;
const HORIZON = NOW + 8 * 60 * 60 * 1000;
const EVENT = { eventId: 'evt-1', severity: 'high', status: 'open', eventType: 'DEVICE_OFFLINE' };
// 影响范围只圈 t1：t2 在 scope 语义下不该被这条事件抬紧急度。
const IMPACT = {
  eventId: 'evt-1',
  severity: 'high',
  status: 'open',
  affectedTaskIds: ['t1'],
  affectedPersonIds: [],
  affectedDeviceIds: [],
  affectedStationIds: [],
  affectedZoneIds: [],
};

function snapshotWith(severity: string): WorldStateSnapshot {
  return buildSnapshot({
    tasks: [task({ id: 't1' }), task({ id: 't2' })],
    events: [{ ...EVENT, severity }],
    eventImpacts: [{ ...IMPACT, severity }],
  });
}

const hasEventFactor = (factors: Array<{ name: string }>): boolean =>
  factors.some((f) => f.name === 'event_severity');

describe('EVTSC-01 事件作用域两腿分叉', () => {
  it('EVTSC-01 按 scope 的腿：只有被圈中的任务吃 event_severity，未圈中的不吃', () => {
    const scoped = computeEffectivePriorityResults(
      defaultPolicy(),
      defaultConfig(),
      snapshotWith('high'),
      [],
      NOW,
      HORIZON,
    );
    expect(hasEventFactor(scoped.get('t1')!.factors)).toBe(true);
    expect(hasEventFactor(scoped.get('t2')!.factors)).toBe(false);
  });

  it('EVTSC-01 现状腿（heuristic 的实调形状）：未圈中的 t2 照样吃 event_severity', () => {
    const engine = new PriorityEngine();
    const policy = defaultPolicy();
    const config = defaultConfig();
    // 与 heuristic-scheduling-solver.ts:666-668 逐键同形：全量开放事件、无 eventId、无 scope。
    const allOpen = [{ eventType: EVENT.eventType ?? null, severity: EVENT.severity }];
    const results = ['t1', 't2'].map((id) =>
      engine.compute(policy, {
        task: { id, priority: 'medium', planStart: null, planEnd: null, productionImpact: undefined },
        config,
        now: NOW,
        horizonEndMs: HORIZON,
        downstreamCount: new Map<string, number>(),
        manualBoostIds: new Set<string>(),
        events: allOpen,
      }),
    );
    expect(results.every((r) => hasEventFactor(r.factors))).toBe(true);
    // 差分本身：两条腿对同一个 t2 判得不一样（这是缺陷的机器形状，不是措辞）。
    const scoped = computeEffectivePriorityResults(
      policy,
      config,
      snapshotWith('high'),
      [],
      NOW,
      HORIZON,
    );
    expect(hasEventFactor(scoped.get('t2')!.factors)).toBe(false);
    expect(scoped.get('t2')!.score).not.toBe(results[1].score);
  });

  it('EVTSC-01 反向对照：事件降到非 risky 档时两腿都不加该因子（断言不是恒真）', () => {
    const engine = new PriorityEngine();
    const policy = defaultPolicy();
    const config = defaultConfig();
    const scoped = computeEffectivePriorityResults(
      policy,
      config,
      snapshotWith('low'),
      [],
      NOW,
      HORIZON,
    );
    expect(hasEventFactor(scoped.get('t1')!.factors)).toBe(false);
    const unscoped = engine.compute(policy, {
      task: { id: 't1', priority: 'medium', planStart: null, planEnd: null },
      config,
      now: NOW,
      horizonEndMs: HORIZON,
      downstreamCount: new Map<string, number>(),
      manualBoostIds: new Set<string>(),
      events: [{ eventType: EVENT.eventType ?? null, severity: 'low' }],
    });
    expect(hasEventFactor(unscoped.factors)).toBe(false);
  });

  it('EVTSC-01 接线面：生产 heuristic 调的是 compute，全文件不出现按 scope 的那条腿', () => {
    const src = readFileSync(
      resolve(__dirname, '..', 'heuristic-scheduling-solver.ts'),
      'utf8',
    );
    expect(src).toContain('this.priorityEngine.compute(');
    expect(src).not.toContain('computeEffectivePriorityResults');
  });
});
