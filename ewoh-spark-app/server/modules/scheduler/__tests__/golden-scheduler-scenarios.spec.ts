/* Golden Scheduler TCK（Phase 7 / NO-07，TS 执行器）。
 *
 * 与 tests/test_golden_scheduler_scenarios.py 消费同一份共享场景定义
 * （tests/golden-fixtures/scheduler-golden-scenarios.json）：
 * - 本文件：TS heuristic 求解器对每个场景求解，提取规范化结果
 *   （assignments[taskId,personId,deviceId,stationId] 按 taskId 排序 +
 *    unassigned + violationReasons），与提交的
 *   scheduler-golden-results.json 逐字节比对（漂移门禁，确定性重放）；
 * - Python 侧：对同一结果文件做独立硬约束仲裁（标准库 plan-checker，
 *   不依赖 ortools）——跨语言一致性。
 *
 * 更新结果：UPDATE_GOLDEN_RESULTS=1 npx jest golden-scheduler-scenarios
 * （必须人工确认新结果符合契约语义后提交，绝不静默覆盖）。
 */
/// <reference types="jest" />
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  makeSolver,
  buildSnapshot,
  defaultPolicy,
  baseSolveOpts,
} from './scheduler-test-helpers';
import type { WorldStateSnapshot } from '@shared/api.interface';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const SCENARIOS_PATH = path.join(
  REPO_ROOT,
  'tests',
  'golden-fixtures',
  'scheduler-golden-scenarios.json',
);
const RESULTS_PATH = path.join(
  REPO_ROOT,
  'tests',
  'golden-fixtures',
  'scheduler-golden-results.json',
);

interface ScenarioExpect {
  assignments: Array<{ taskId: string; personId: string; deviceId: string | null; stationId: string | null }>;
  unassigned: string[];
  blockedReasons: Array<{ taskId: string; reason: string }>;
}

interface Scenario {
  id: string;
  name: string;
  snapshot: WorldStateSnapshot;
  expect: ScenarioExpect;
}

interface ScenarioResult {
  scenarioId: string;
  assignments: Array<{ taskId: string; personId: string; deviceId: string | null; stationId: string | null }>;
  unassigned: string[];
  violationReasons: string[];
}

const data = JSON.parse(fs.readFileSync(SCENARIOS_PATH, 'utf-8')) as {
  schemaVersion: string;
  scenarios: Scenario[];
};

/** 规范化结果：assignment 按 taskId 排序；violationReasons 按 taskId:reason 去重排序。 */
function canonicalize(
  scenario: Scenario,
  assignments: Array<{ taskId: string; personId: string; deviceId: string | null; stationId: string | null }>,
  violationReasonsByTask: Map<string, Set<string>>,
): ScenarioResult {
  const taskIds = new Set(scenario.snapshot.tasks.map((t) => t.id));
  const unassigned = [...taskIds]
    .filter((id) => !assignments.some((a) => a.taskId === id))
    .sort();
  const violationReasons: string[] = [];
  for (const taskId of [...taskIds].sort()) {
    for (const reason of [...(violationReasonsByTask.get(taskId) ?? new Set<string>())].sort()) {
      violationReasons.push(`${taskId}:${reason}`);
    }
  }
  return {
    scenarioId: scenario.id,
    assignments: [...assignments].sort((a, b) => a.taskId.localeCompare(b.taskId)),
    unassigned,
    violationReasons,
  };
}

async function solveScenario(scenario: Scenario): Promise<ScenarioResult> {
  const { solver } = makeSolver();
  const plan = await solver.solve(
    buildSnapshot(scenario.snapshot),
    [],
    { ...baseSolveOpts, policy: defaultPolicy() },
  );
  const assignments = plan.assignments.map((a) => ({
    taskId: a.taskId,
    personId: a.personId ?? null,
    deviceId: a.deviceId ?? null,
    stationId: a.stationId ?? null,
  }));
  const violationReasonsByTask = new Map<string, Set<string>>();
  for (const v of plan.violations) {
    const taskId = String((v as Record<string, unknown>).taskId ?? '');
    const set = violationReasonsByTask.get(taskId) ?? new Set<string>();
    for (const alt of (v as { alternatives?: Array<{ reasons?: string[] }> }).alternatives ?? []) {
      for (const r of alt.reasons ?? []) set.add(r);
    }
    violationReasonsByTask.set(taskId, set);
  }
  return canonicalize(scenario, assignments, violationReasonsByTask);
}

describe('golden scheduler scenarios（Phase 7 / NO-07 共享场景，跨语言一致）', () => {
  it('场景定义 schemaVersion=1.0.0 且四场景齐全', () => {
    expect(data.schemaVersion).toBe('1.0.0');
    expect(data.scenarios.map((s) => s.id).sort()).toEqual([
      'maintenance_blocked_device_fail_closed',
      'maintenance_blocked_person_fail_closed',
      'quality_blocked_station_fail_closed',
      'skill_match_baseline',
    ]);
  });

  it('求解结果与提交的 golden 结果文件零漂移（确定性重放门禁）', async () => {
    const results: ScenarioResult[] = [];
    for (const scenario of data.scenarios) {
      results.push(await solveScenario(scenario));
    }
    const committed = fs.existsSync(RESULTS_PATH)
      ? (JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf-8')) as ScenarioResult[])
      : null;
    if (process.env.UPDATE_GOLDEN_RESULTS === '1') {
      fs.writeFileSync(RESULTS_PATH, `${JSON.stringify(results, null, 2)}\n`);
      return;
    }
    expect(committed).not.toBeNull();
    expect(results).toEqual(committed);
  });

  for (const scenario of data.scenarios) {
    it(`scenario: ${scenario.id}（${scenario.name}）`, async () => {
      const result = await solveScenario(scenario);
      expect(result.assignments).toEqual(scenario.expect.assignments);
      expect(result.unassigned).toEqual(scenario.expect.unassigned);
      for (const blocked of scenario.expect.blockedReasons) {
        expect(result.violationReasons).toContain(
          `${blocked.taskId}:${blocked.reason}`,
        );
      }
    });
  }
});
