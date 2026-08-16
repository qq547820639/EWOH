/* Canonical Contract Golden Scenarios（TS 侧，总提示词 §26；ADR-006/ADR-007）。
 *
 * 与 tests/test_golden_contract_scenarios.py 消费同一份场景定义
 * （tests/golden-fixtures/contract-golden-scenarios.json），保证跨语言
 * 场景语义逐项一致。契约或接线变更必须重跑（make contract-golden + CI）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

import { IdentityConflictError, resolveIdentityMapping } from './identity';
import { DomainContractError, normalizeSeverity, riskTransitionAllowed } from './risk';
import { isValidSpatialKind, validateLocationRecord } from './location';
import { evaluateAvailability } from './resource';
import { validateWorldStateRecord, validateWorldIntervalSet, worldSnapshotSourceProfile } from './world-contract';
import { validateEventEnvelope, envelopeSemantics, envelopeDedupKey } from './event-envelope';
import { maintenanceTransitionAllowed, validateMaintenanceCondition, isMaintenanceOverdue } from './maintenance';
import { qualityTransitionAllowed, validateQualityFinding } from './quality';
import { validateWorkOrder, workOrderTransitionAllowed } from './workorder';
import { validateInferenceResult } from './inference-result';
import { validateReasoningResult } from './reasoning-result';
import { validateReasoningTrace, evaluateReasoningRules } from './reasoning-trace';
import { validateEntityDeclaration } from './entity-model';
import { validateAgentManifest } from './agent-manifest';
import { validateAgentTask } from './agent-task';
import { validateKnowledgeEntry } from './knowledge-entry';
import { validateLearningEvaluation } from './learning-evaluation';
import { validateMetricSample } from './metrics-registry';
import { validateDeadLetter } from './dead-letter';
import {
  validateSimulationRun,
  evaluateWhatIf,
  evaluateCapacity,
  evaluateLayout,
  evaluateMaterialFlow,
} from './simulation-run';
import {
  validateLearningProposal,
  proposalTransitionAllowed,
  evaluateRuleThresholdShadow,
} from './learning-proposal';
import { validateExoSession, exoSessionTransitionAllowed } from './exo-session';
import { validateOutcomeAnnotation } from './outcome-annotation';
import { validateCapability } from './capability';
import { validateDecision } from './decision';
import { validateExoConfig } from './exo-config';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCENARIOS_PATH = path.join(
  REPO_ROOT,
  'tests',
  'golden-fixtures',
  'contract-golden-scenarios.json',
);

interface ScenarioCase {
  name: string;
  [key: string]: unknown;
}

interface Scenario {
  id: string;
  domain: 'identity' | 'risk' | 'location' | 'resource' | 'world' | 'envelope' | 'maintenance_quality' | 'workorder' | 'intelligence' | 'reasoning' | 'reasoning_trace' | 'entity' | 'agent' | 'agent_task' | 'knowledge' | 'learning' | 'metrics' | 'dead_letter' | 'simulation' | 'learning_proposal' | 'exo_session' | 'outcome_annotation' | 'capability' | 'decision' | 'exo_config';
  name: string;
  cases: ScenarioCase[];
}

const data = JSON.parse(fs.readFileSync(SCENARIOS_PATH, 'utf-8')) as { scenarios: Scenario[] };

function runCase(domain: Scenario['domain'], c: ScenarioCase): void {
  switch (domain) {
    case 'identity': {
      if (c.expectError != null) {
        try {
          resolveIdentityMapping(
            c.system as string,
            c.sourceId as string,
            c.mappings as never[],
            c.now as string,
          );
          fail(`场景 ${c.name} 应抛 ${c.expectError}`);
        } catch (err) {
          expect(err).toBeInstanceOf(IdentityConflictError);
          expect((err as DomainContractError).code).toBe(c.expectError);
        }
      } else {
        expect(
          resolveIdentityMapping(
            c.system as string,
            c.sourceId as string,
            c.mappings as never[],
            c.now as string,
          ),
        ).toBe(c.expect);
      }
      break;
    }
    case 'risk': {
      if ('input' in c) {
        if (c.expectError != null) {
          try {
            normalizeSeverity(c.input as string);
            fail(`场景 ${c.name} 应抛 ${c.expectError}`);
          } catch (err) {
            expect((err as DomainContractError).code).toBe(c.expectError);
          }
        } else {
          expect(normalizeSeverity(c.input as string)).toBe(c.expect);
        }
      } else {
        expect(riskTransitionAllowed(c.from as string, c.to as string)).toBe(c.allowed);
      }
      break;
    }
    case 'location': {
      if ('kind' in c) {
        expect(isValidSpatialKind(c.kind as string)).toBe(c.valid);
      } else {
        const errors = validateLocationRecord(c.record);
        if (c.expectError == null) {
          expect(errors).toEqual([]);
        } else {
          expect(errors).toContain(c.expectError);
        }
      }
      break;
    }
    case 'resource': {
      if (c.expectError != null) {
        try {
          evaluateAvailability(c.status as string, c.dataQuality as string);
          fail(`场景 ${c.name} 应抛 ${c.expectError}`);
        } catch (err) {
          expect((err as DomainContractError).code).toBe(c.expectError);
        }
      } else {
        expect(evaluateAvailability(c.status as string, c.dataQuality as string)).toEqual(c.expect);
      }
      break;
    }
    case 'world': {
      if ('states' in c) {
        const records = (c.states as Array<Record<string, unknown>>).map((st) => ({
          entityId: 'person:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11',
          stateType: 'location',
          validFrom: st.validFrom,
          validTo: st.validTo,
          version: st.version,
        }));
        const errors = validateWorldIntervalSet(records);
        expect(errors).toContain(c.expectError);
      } else {
        const errors = validateWorldStateRecord(c.record);
        if (c.expectError == null) {
          expect(errors).toEqual([]);
          if ('expectProfile' in c) {
            expect(worldSnapshotSourceProfile([c.record])).toEqual(c.expectProfile);
          }
        } else {
          expect(errors[0]).toBe(c.expectError);
        }
      }
      break;
    }
    case 'envelope': {
      const known = (() => {
        const requireFromApp = createRequire(path.join(REPO_ROOT, 'ewoh-spark-app', 'package.json'));
        const yaml = requireFromApp('js-yaml');
        const catalog = yaml.load(
          fs.readFileSync(path.join(REPO_ROOT, 'contracts', 'events', 'event-catalog.yaml'), 'utf-8'),
        ) as { 'x-event-types': string[] };
        return new Set(catalog['x-event-types']);
      })();
      if ('dedupKey' in c) {
        expect(envelopeDedupKey(c.envelope as Record<string, unknown>)).toBe(
          (c.dedupKey as string[]).join('|'),
        );
        break;
      }
      const errors = validateEventEnvelope(c.envelope, known);
      if (c.expectError == null) {
        expect(errors).toEqual([]);
        if (c.expect != null) {
          expect(envelopeSemantics(c.envelope as Record<string, unknown>)).toEqual(c.expect);
        }
      } else {
        expect(errors[0]).toBe(c.expectError);
      }
      break;
    }
    case 'maintenance_quality': {
      if ('condition' in c) {
        const errors = validateMaintenanceCondition(c.condition);
        if (c.expectError == null) {
          expect(errors).toEqual([]);
        } else {
          expect(errors[0]).toBe(c.expectError);
        }
      } else if ('path' in c) {
        const path = c.path as string[];
        const ok = path.every((_, i) =>
          i + 1 < path.length ? maintenanceTransitionAllowed(path[i], path[i + 1]) : true,
        );
        expect(ok).toBe(c.expectValid);
      } else if ('dueAt' in c) {
        expect(isMaintenanceOverdue(c.dueAt as string | null, c.status as string, c.now as string)).toBe(
          c.expectOverdue,
        );
      } else if ('finding' in c) {
        const errors = validateQualityFinding(c.finding);
        if (c.expectError == null) {
          expect(errors).toEqual([]);
        } else {
          expect(errors[0]).toBe(c.expectError);
        }
      } else {
        throw new Error(`unhandled case: ${c.name}`);
      }
      break;
    }
    case 'workorder': {
      if ('path' in c) {
        const path = c.path as string[];
        const ok = path.every((_, i) =>
          i + 1 < path.length ? workOrderTransitionAllowed(path[i], path[i + 1]) : true,
        );
        expect(ok).toBe(c.expectValid);
      } else {
        const errors = validateWorkOrder(c.record);
        if (c.expectError == null) {
          expect(errors).toEqual([]);
        } else {
          expect(errors[0]).toBe(c.expectError);
        }
      }
      break;
    }
    case 'intelligence': {
      const errors = validateInferenceResult(c.record);
      if (c.expectError == null) {
        expect(errors).toEqual([]);
      } else {
        expect(errors[0]).toBe(c.expectError);
      }
      break;
    }
    case 'reasoning': {
      const errors = validateReasoningResult(c.record);
      if (c.expectError == null) {
        expect(errors).toEqual([]);
      } else {
        expect(errors[0]).toBe(c.expectError);
      }
      break;
    }
    case 'reasoning_trace': {
      if ('record' in c) {
        const errors = validateReasoningTrace(c.record);
        if (c.expectError == null) {
          expect(errors).toEqual([]);
        } else {
          expect(errors[0]).toBe(c.expectError);
        }
      } else {
        const input = c.input as { traceId: string; facts: never };
        expect(evaluateReasoningRules(input.traceId, input.facts)).toEqual(c.expect);
      }
      break;
    }
    case 'entity': {
      const errors = validateEntityDeclaration(c.record);
      if (c.expectError == null) {
        expect(errors).toEqual([]);
      } else {
        expect(errors[0]).toBe(c.expectError);
      }
      break;
    }
    case 'agent': {
      const errors = validateAgentManifest(c.record);
      if (c.expectError == null) {
        expect(errors).toEqual([]);
      } else {
        expect(errors[0]).toBe(c.expectError);
      }
      break;
    }
    case 'agent_task': {
      const errors = validateAgentTask(c.record);
      if (c.expectError == null) {
        expect(errors).toEqual([]);
      } else {
        expect(errors[0]).toBe(c.expectError);
      }
      break;
    }
    case 'knowledge': {
      const errors = validateKnowledgeEntry(c.record);
      if (c.expectError == null) {
        expect(errors).toEqual([]);
      } else {
        expect(errors[0]).toBe(c.expectError);
      }
      break;
    }
    case 'learning': {
      const errors = validateLearningEvaluation(c.record);
      if (c.expectError == null) {
        expect(errors).toEqual([]);
      } else {
        expect(errors[0]).toBe(c.expectError);
      }
      break;
    }
    case 'metrics': {
      const errors = validateMetricSample(c.record);
      if (c.expectError == null) {
        expect(errors).toEqual([]);
      } else {
        expect(errors[0]).toBe(c.expectError);
      }
      break;
    }
    case 'dead_letter': {
      const errors = validateDeadLetter(c.record);
      if (c.expectError == null) {
        expect(errors).toEqual([]);
      } else {
        expect(errors[0]).toBe(c.expectError);
      }
      break;
    }
    case 'simulation': {
      if ('record' in c) {
        const errors = validateSimulationRun(c.record);
        if (c.expectError == null) {
          expect(errors).toEqual([]);
        } else {
          expect(errors[0]).toBe(c.expectError);
        }
      } else {
        const input = c.input as Record<string, unknown>;
        const engine = String(input.engine);
        let result: unknown;
        switch (engine) {
          case 'capacity':
            result = evaluateCapacity(
              input.stations as never[],
              input.demandPerHour as number,
            );
            break;
          case 'layout':
            result = evaluateLayout(input.stations as never[], input.moves as never[]);
            break;
          case 'material_flow':
            result = evaluateMaterialFlow(input.stations as never[]);
            break;
          case 'what_if':
            result = evaluateWhatIf(
              input.traceId as string,
              input.baseFacts as never[],
              input.deltaFacts as never[],
            );
            break;
          default:
            throw new Error(`unknown simulation engine ${engine}`);
        }
        expect(result).toEqual(c.expect);
      }
      break;
    }
    case 'learning_proposal': {
      if ('record' in c) {
        const errors = validateLearningProposal(c.record);
        if (c.expectError == null) {
          expect(errors).toEqual([]);
        } else {
          expect(errors[0]).toBe(c.expectError);
        }
      } else {
        const input = c.input as Record<string, unknown>;
        const engine = String(input.engine);
        if (engine === 'shadow') {
          expect(
            evaluateRuleThresholdShadow(
              input.ruleId as string,
              input.baselineThreshold as number,
              input.candidateThreshold as number,
              input.facts as never[],
            ),
          ).toEqual(c.expect);
        } else if (engine === 'transition') {
          const pairs = input.pairs as Array<[string, string]>;
          expect(pairs.map(([from, to]) => proposalTransitionAllowed(from, to))).toEqual(c.expect);
        } else {
          throw new Error(`unknown learning_proposal engine ${engine}`);
        }
      }
      break;
    }
    case 'capability': {
      const errors = validateCapability(c.record);
      if (c.expectError == null) {
        expect(errors).toEqual([]);
      } else {
        expect(errors[0]).toBe(c.expectError);
      }
      break;
    }
    case 'decision': {
      const errors = validateDecision(c.record);
      if (c.expectError == null) {
        expect(errors).toEqual([]);
      } else {
        expect(errors[0]).toBe(c.expectError);
      }
      break;
    }
    case 'exo_config': {
      const errors = validateExoConfig(c.record);
      if (c.expectError == null) {
        expect(errors).toEqual([]);
      } else {
        expect(errors[0]).toBe(c.expectError);
      }
      break;
    }
    case 'outcome_annotation': {
      const errors = validateOutcomeAnnotation(c.record);
      if (c.expectError == null) {
        expect(errors).toEqual([]);
      } else {
        expect(errors[0]).toBe(c.expectError);
      }
      break;
    }
    case 'exo_session': {
      if ('record' in c) {
        const errors = validateExoSession(c.record);
        if (c.expectError == null) {
          expect(errors).toEqual([]);
        } else {
          expect(errors[0]).toBe(c.expectError);
        }
      } else {
        const pairs = (c.input as { pairs: Array<[string, string]> }).pairs;
        expect(pairs.map(([from, to]) => exoSessionTransitionAllowed(from, to))).toEqual(c.expect);
      }
      break;
    }
    default:
      throw new Error(`unknown domain ${String(domain)}`);
  }
}

describe('canonical contract golden scenarios（共享场景定义，跨语言一致）', () => {
  it('二十五个 Golden 场景全部声明', () => {
    expect(data.scenarios.map((s) => s.id).sort()).toEqual([
      'agent_manifest_contract',
      'agent_task_contract',
      'capability_contract',
      'dead_letter_contract',
      'decision_contract',
      'dirty_spatial_type_rejection',
      'entity_model_contract',
      'event_envelope_semantics',
      'exo_config_contract',
      'exo_session_contract',
      'identity_mapping_conflict',
      'inference_result_contract',
      'knowledge_entry_contract',
      'learning_evaluation_contract',
      'learning_proposal_contract',
      'legacy_severity_normalization',
      'maintenance_quality_loop',
      'metrics_registry_contract',
      'outcome_annotation_contract',
      'reasoning_result_contract',
      'reasoning_trace_contract',
      'resource_freshness_fail_closed',
      'simulation_run_contract',
      'workorder_loop',
      'world_state_projection_rules',
    ]);
  });

  for (const scenario of data.scenarios) {
    it(`scenario: ${scenario.id}（${scenario.name}）`, () => {
      for (const c of scenario.cases) {
        runCase(scenario.domain, c);
      }
    });
  }
});
