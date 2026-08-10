/**
 * shared/scheduler.ts ↔ openapi/ewoh.yaml（→ client/src/types/openapi.d.ts）类型对等门禁。
 *
 * 这 7 个 P4 契约在 shared/scheduler.ts 与 ewoh.yaml 中手写重复声明，存在漂移风险。
 * TS 类型在运行时不存在，故：
 *  1) 用 TS compiler API 从 shared/scheduler.ts 提取各接口的展平字段路径（含嵌套对象）；
 *  2) 用 js-yaml 从 openapi/ewoh.yaml 提取 components.schemas 对应 schema 的展平字段路径；
 *  3) 断言两侧字段路径集合完全一致（任何一侧新增/删除字段都会使测试失败）；
 *  4) fixtures 表：每个契约一个代表对象，同时 satisfies 生成类型（client/src/types/openapi.d.ts）
 *     与 shared 类型（编译期强类型校验，多余/缺失/类型不匹配即编译失败），运行时再断言
 *     fixtures 顶层键集合与两侧声明一致。
 */
/// <reference types="jest" />
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { load } from 'js-yaml';
import type { components } from '../../../../client/src/types/openapi';
import type {
  ConflictPreviewRequest as SharedConflictPreviewRequest,
  ExecutionListResponse as SharedExecutionListResponse,
  ExecutionUpdateRequest as SharedExecutionUpdateRequest,
  PolicyReplayRequest as SharedPolicyReplayRequest,
  ReplanPreviewRequest as SharedReplanPreviewRequest,
  ReplanPreviewResult as SharedReplanPreviewResult,
  SchedulerKpiSnapshot as SharedSchedulerKpiSnapshot,
} from '@shared/scheduler';

const REPO_ROOT = path.resolve(__dirname, '../../../../../');
const SHARED_FILE = path.resolve(__dirname, '../../../../shared/scheduler.ts');
const SPEC_FILE = path.join(REPO_ROOT, 'openapi/ewoh.yaml');

// ---------------------------------------------------------------------------
// shared/scheduler.ts 侧：TS compiler API 提取接口展平字段路径
// ---------------------------------------------------------------------------

function collectMembers(members: ts.NodeArray<ts.TypeElement>, prefix: string, out: string[]) {
  for (const member of members) {
    if (!ts.isPropertySignature(member)) {
      continue;
    }
    const name = member.name.getText();
    const full = prefix ? `${prefix}.${name}` : name;
    if (member.type && ts.isTypeLiteralNode(member.type)) {
      collectMembers(member.type.members, full, out);
    } else {
      out.push(full);
    }
  }
}

function sharedFlatKeys(interfaceName: string): string[] {
  const source = ts.createSourceFile(
    SHARED_FILE,
    fs.readFileSync(SHARED_FILE, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === interfaceName) {
      collectMembers(node.members, '', out);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (out.length === 0) {
    throw new Error(`shared/scheduler.ts: interface ${interfaceName} not found`);
  }
  return out.sort();
}

/** 接口顶层成员名（fixtures 代表对象的顶层键应与之一致）。 */
function sharedTopLevelKeys(interfaceName: string): string[] {
  const source = ts.createSourceFile(
    SHARED_FILE,
    fs.readFileSync(SHARED_FILE, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === interfaceName) {
      for (const member of node.members) {
        if (ts.isPropertySignature(member)) {
          out.push(member.name.getText());
        }
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out.sort();
}

// ---------------------------------------------------------------------------
// openapi/ewoh.yaml 侧：js-yaml 提取 schema 展平字段路径
// ---------------------------------------------------------------------------

function specFlatKeys(schemaName: string): string[] {
  const document = load(fs.readFileSync(SPEC_FILE, 'utf8')) as {
    components?: { schemas?: Record<string, { properties?: Record<string, unknown> }> };
  };
  const schema = document.components?.schemas?.[schemaName];
  if (!schema || !schema.properties) {
    throw new Error(`openapi/ewoh.yaml: schema ${schemaName} not found`);
  }
  const out: string[] = [];
  const walk = (props: Record<string, { type?: string; properties?: Record<string, unknown> }>, prefix: string) => {
    for (const [name, prop] of Object.entries(props)) {
      const full = prefix ? `${prefix}.${name}` : name;
      if (prop && prop.type === 'object' && prop.properties) {
        walk(prop.properties, full);
      } else {
        out.push(full);
      }
    }
  };
  walk(schema.properties, '');
  return out.sort();
}

/** schema 顶层属性名（fixtures 代表对象的顶层键应与之一致）。 */
function specTopLevelKeys(schemaName: string): string[] {
  const document = load(fs.readFileSync(SPEC_FILE, 'utf8')) as {
    components?: { schemas?: Record<string, { properties?: Record<string, unknown> }> };
  };
  const schema = document.components?.schemas?.[schemaName];
  if (!schema || !schema.properties) {
    throw new Error(`openapi/ewoh.yaml: schema ${schemaName} not found`);
  }
  return Object.keys(schema.properties).sort();
}

// ---------------------------------------------------------------------------
// fixtures 表：同时 satisfies 生成类型与 shared 类型（编译期校验）
// ---------------------------------------------------------------------------

const executionUpdateRequestFixture = {
  status: 'STARTED',
  actualStartAt: '2026-08-10T08:00:00.000Z',
  actualEndAt: null,
  actualTravelMs: 1200,
  actualDistanceM: 85,
  actualWaitingMs: 300,
  deviationType: 'START_DELAY',
  deviationReason: 'handover delayed',
  triggerReplan: true,
} satisfies components['schemas']['ExecutionUpdateRequest'] & SharedExecutionUpdateRequest;

const executionListResponseFixture = {
  executions: [],
  total: 0,
} satisfies components['schemas']['ExecutionListResponse'] & SharedExecutionListResponse;

const schedulerKpiSnapshotFixture = {
  periodStart: '2026-08-10T00:00:00.000Z',
  periodEnd: '2026-08-10T08:00:00.000Z',
  delivery: {
    onTimeRate: 0.92,
    completionRate: 0.88,
    latenessP50Ms: 120,
    latenessP95Ms: 600,
    latenessMaxMs: 1800,
    averageWaitingMs: 240,
    averageTravelMs: 300,
    averageTravelDistanceM: 45,
  },
  resources: {
    personUtilization: 0.74,
    deviceUtilization: 0.61,
    stationUtilization: 0.68,
    resourceIdleMs: 3600,
    workloadVariance: 0.12,
  },
  stability: {
    replanCount: 3,
    replanSuccessRate: 1,
    assignmentChurnRate: 0.05,
    manualOverrideRate: 0.02,
    conflictRate: 0.01,
    averageConflictResolutionMs: 900,
    affectedAssignmentRatio: 0.08,
    unchangedAssignmentRate: 0.95,
    scheduleChurn: 12,
    replanDuration: 1500,
    replanTriggerCount: 4,
    replanSuppressedCount: 1,
  },
  solver: {
    solverLatencyP50Ms: 850,
    solverLatencyP95Ms: 1400,
    optimalRate: 0.8,
    feasibleRate: 0.95,
    heuristicFallbackRate: 0.05,
    timeoutRate: 0.02,
    infeasibleRate: 0,
  },
  dataQuality: {
    staleResourceRate: 0.03,
    unknownLocationRate: 0.01,
    degradedRouteRate: 0.04,
  },
} satisfies components['schemas']['SchedulerKpiSnapshot'] & SharedSchedulerKpiSnapshot;

const policyReplayRequestFixture = {
  candidatePolicyVersion: 7,
  snapshotVersion: 'WS-20260810-0007',
  seed: 42,
  limit: 10,
} satisfies components['schemas']['PolicyReplayRequest'] & SharedPolicyReplayRequest;

const conflictPreviewRequestFixture = {
  action: 'reallocate',
  resourceIds: ['p1', 'd2'],
} satisfies components['schemas']['ConflictPreviewRequest'] & SharedConflictPreviewRequest;

const replanPreviewRequestFixture = {
  triggerType: 'RESOURCE_BLOCKED',
  triggerIds: ['r1'],
} satisfies components['schemas']['ReplanPreviewRequest'] & SharedReplanPreviewRequest;

const replanPreviewResultFixture = {
  baselinePlanId: 'PLAN-BASE',
  candidatePlanId: 'PREVIEW-0001',
  readonly: true,
  affectedTaskCount: 2,
  unchangedAssignmentCount: 10,
  changedAssignmentCount: 2,
  addedAssignmentCount: 0,
  removedAssignmentCount: 0,
  latenessDelta: -300,
  travelDelta: 120,
  workloadDelta: -0.05,
  stationWaitDelta: 30,
  changeoverDelta: 0,
  energyRiskDelta: 0,
  riskDelta: 0,
  churnDelta: 0.01,
  changedAssignments: [],
} satisfies components['schemas']['ReplanPreviewResult'] & SharedReplanPreviewResult;

const CONTRACTS = [
  'ExecutionUpdateRequest',
  'ExecutionListResponse',
  'SchedulerKpiSnapshot',
  'PolicyReplayRequest',
  'ConflictPreviewRequest',
  'ReplanPreviewRequest',
  'ReplanPreviewResult',
] as const;

const FIXTURES: Record<(typeof CONTRACTS)[number], Record<string, unknown>> = {
  ExecutionUpdateRequest: executionUpdateRequestFixture,
  ExecutionListResponse: executionListResponseFixture,
  SchedulerKpiSnapshot: schedulerKpiSnapshotFixture,
  PolicyReplayRequest: policyReplayRequestFixture,
  ConflictPreviewRequest: conflictPreviewRequestFixture,
  ReplanPreviewRequest: replanPreviewRequestFixture,
  ReplanPreviewResult: replanPreviewResultFixture,
};

describe('shared/scheduler.ts ↔ openapi/ewoh.yaml 类型对等（P4 契约防漂移）', () => {
  const sharedCache = new Map<string, string[]>();
  const specCache = new Map<string, string[]>();

  for (const contract of CONTRACTS) {
    it(`${contract}: shared 与 spec 展平字段路径完全一致`, () => {
      const shared = sharedCache.get(contract) ?? sharedFlatKeys(contract);
      const spec = specCache.get(contract) ?? specFlatKeys(contract);
      sharedCache.set(contract, shared);
      specCache.set(contract, spec);
      expect(spec).toEqual(shared);
    });

    it(`${contract}: fixtures 顶层键覆盖两侧声明（代表对象完整）`, () => {
      const shared = sharedCache.get(contract) ?? sharedFlatKeys(contract);
      const spec = specCache.get(contract) ?? specFlatKeys(contract);
      sharedCache.set(contract, shared);
      specCache.set(contract, spec);
      expect(Object.keys(FIXTURES[contract]).sort()).toEqual(sharedTopLevelKeys(contract));
      expect(Object.keys(FIXTURES[contract]).sort()).toEqual(specTopLevelKeys(contract));
    });
  }
});
