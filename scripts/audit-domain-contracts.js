#!/usr/bin/env node
/**
 * Canonical Risk/Location/Resource 契约门禁（ADR-007 / NO-02c）。
 *
 * 职责（fail-closed，任一违反 → 非零退出）：
 *  1. contracts/{risk,location,resource}/*.schema.json 形状合法（$id/schemaVersion/注册表/规则）；
 *  2. contracts/{risk,location,resource}/test-vectors.json 与契约一致（门禁在 JS 内
 *     独立重实现三域语义作第三方仲裁：severity 归一/转移、location 记录校验、
 *     resource 可用性判定）；
 *  3. Python 锁定注册表（src/edge_platform/contracts/{risk,location,resource}.py）
 *     与 schema 逐项一致；
 *  4. TypeScript 锁定注册表（ewoh-spark-app/shared/{risk,location,resource}.ts）
 *     与 schema 逐项一致。
 *
 * 已接入：make truth-check + .github/workflows/test.yml（Domain 契约一致性门禁）。
 * 用法：node scripts/audit-domain-contracts.js [--strict]
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const failures = [];
const checks = [];
function check(name, ok, detail = '') {
  checks.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures.push(name);
}
function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

const DOMAINS = ['risk', 'location', 'resource', 'world', 'maintenance', 'quality', 'workorder', 'intelligence', 'reasoning', 'entity', 'agent', 'agent_task', 'knowledge'];
const DOMAIN_SCHEMA_FILES = {
  risk: 'risk.schema.json',
  location: 'location.schema.json',
  resource: 'resource.schema.json',
  world: 'world-state.schema.json',
  maintenance: 'maintenance.schema.json',
  quality: 'quality.schema.json',
  workorder: 'work-order.schema.json',
  intelligence: 'inference-result.schema.json',
  reasoning: 'reasoning-result.schema.json',
  entity: 'entity-model.schema.json',
  agent: 'agent-manifest.schema.json',
  agent_task: 'agent-task.schema.json',
  knowledge: 'knowledge-entry.schema.json',
};

// ── 1. schema 形状 ──────────────────────────────────────────────────────────
for (const domain of DOMAINS) {
  const schema = loadJson(path.join(REPO_ROOT, 'contracts', domain, DOMAIN_SCHEMA_FILES[domain]));
  check(`${domain}_schema_parses`, typeof schema === 'object' && schema !== null);
  const expectedSchemaId =
    domain === 'world'
      ? 'ewoh:///world/world-state/v1'
      : domain === 'intelligence'
        ? 'ewoh:///intelligence/inference-result/v1'
        : domain === 'reasoning'
          ? 'ewoh:///reasoning/reasoning-result/v1'
          : domain === 'entity'
            ? 'ewoh:///entity/entity-model/v1'
            : domain === 'agent'
              ? 'ewoh:///agent/agent-manifest/v1'
              : domain === 'agent_task'
                ? 'ewoh:///agent-task/agent-task/v1'
                : domain === 'knowledge'
                  ? 'ewoh:///knowledge/knowledge-entry/v1'
                  : `ewoh:///${domain}/${domain}/v1`;
  check(`${domain}_schema_id`, schema.$id === expectedSchemaId, schema.$id);
  check(`${domain}_schema_version`, schema.schemaVersion === '1.0.0', schema.schemaVersion);
  check(`${domain}_rules_present`, typeof schema.rules === 'object' && schema.rules !== null);
}

// ── 2. vectors 独立仲裁（JS 第三方重实现契约语义） ──────────────────────────
const riskSchema = loadJson(path.join(REPO_ROOT, 'contracts/risk/risk.schema.json'));
const locSchema = loadJson(path.join(REPO_ROOT, 'contracts/location/location.schema.json'));
const resSchema = loadJson(path.join(REPO_ROOT, 'contracts/resource/resource.schema.json'));

// --- risk 仲裁 ---
const riskVectors = loadJson(path.join(REPO_ROOT, 'contracts/risk/test-vectors.json'));
const ladder = new Set(riskSchema.severityLadder);
const legacyMap = riskSchema.legacySeverityMap;
const lifecycle = new Set(riskSchema.lifecycle);
const categories = new Set(riskSchema.categoryRegistry);
const arbTransitions = new Set([
  'open->acknowledged', 'acknowledged->resolving', 'resolving->resolved',
  'resolved->closed', 'resolving->open', 'resolved->open',
]);
for (const c of riskVectors.severityNormalize) {
  const arb = ladder.has(c.input) ? c.input : legacyMap[c.input] != null ? legacyMap[c.input] : { error: 'unknown_severity' };
  if (c.expectError != null) {
    check(`risk_severity:${c.input}`, arb.error === c.expectError, `expected error ${c.expectError}, got ${arb.error ?? arb}`);
  } else {
    check(`risk_severity:${c.input}`, arb === c.expect, `expected ${c.expect}, got ${JSON.stringify(arb)}`);
  }
}
for (const c of riskVectors.severityOrder) {
  const rank = (v) => riskSchema.severityLadder.length - riskSchema.severityLadder.indexOf(v);
  check(`risk_order:${c.higher}>${c.lower}`, rank(c.higher) > rank(c.lower));
}
for (const c of riskVectors.transitions) {
  const allowed = lifecycle.has(c.from) && lifecycle.has(c.to) && arbTransitions.has(`${c.from}->${c.to}`);
  check(`risk_transition:${c.from}->${c.to}`, allowed === c.allowed, `expected ${c.allowed}, got ${allowed}`);
}
for (const c of riskVectors.categories) {
  check(`risk_category:${c.value}`, categories.has(c.value) === c.valid, `expected ${c.valid}`);
}

// --- location 仲裁 ---
const locVectors = loadJson(path.join(REPO_ROOT, 'contracts/location/test-vectors.json'));
const kinds = new Set(locSchema.spatialKindRegistry);
const coordinateTypes = new Set(locSchema.coordinateTypes);
const bounds = locSchema.wgs84Bounds;
function arbValidateLocation(record) {
  if (record == null || typeof record !== 'object') return ['record_must_be_object'];
  if (!coordinateTypes.has(record.coordinateType)) return ['bad_coordinate'];
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const hasCoord = [record.x, record.y, record.z, record.yawDeg].some((v) => v != null);
  if (record.coordinateType === 'UNKNOWN') return hasCoord ? ['bad_coordinate'] : [];
  const errors = [];
  if (record.coordinateType === 'WGS84') {
    if (!isNum(record.x) || record.x < bounds.latMin || record.x > bounds.latMax) errors.push('bad_coordinate');
    if (!isNum(record.y) || record.y < bounds.lngMin || record.y > bounds.lngMax) errors.push('bad_coordinate');
  } else {
    for (const k of ['x', 'y', 'z']) if (record[k] != null && !isNum(record[k])) errors.push('bad_coordinate');
  }
  if (record.yawDeg != null && (!isNum(record.yawDeg) || record.yawDeg < bounds.yawMin || record.yawDeg >= bounds.yawMax)) errors.push('bad_coordinate');
  if (record.confidence != null && (!isNum(record.confidence) || record.confidence < 0 || record.confidence > 1)) errors.push('bad_coordinate');
  return errors;
}
for (const c of locVectors.spatialKinds) {
  check(`location_kind:${c.value}`, kinds.has(c.value) === c.valid, `expected ${c.valid}`);
}
for (const c of locVectors.records) {
  const errors = arbValidateLocation(c.record);
  if (c.expectError == null) {
    check(`location_record:${c.name}`, errors.length === 0, errors.join(','));
  } else {
    check(`location_record:${c.name}`, errors.includes(c.expectError), `expected ${c.expectError}, got ${errors.join(',')}`);
  }
}

// --- resource 仲裁 ---
const resVectors = loadJson(path.join(REPO_ROOT, 'contracts/resource/test-vectors.json'));
const statuses = new Set(resSchema.statusRegistry);
const qualities = new Set(resSchema.dataQualityRegistry);
const resTypes = new Set(resSchema.resourceTypeRegistry);
const reasonMap = { RESERVED: 'reserved', BUSY: 'busy', DEGRADED: 'degraded', OFFLINE: 'offline', MAINTENANCE: 'maintenance', UNKNOWN: 'unknown_status' };
function arbAvailability(status, quality) {
  if (!statuses.has(status)) return { error: 'unknown_status' };
  if (!qualities.has(quality)) return { error: 'unknown_data_quality' };
  if (status === 'AVAILABLE') {
    return quality === 'FRESH' ? { available: true, reason: null } : { available: false, reason: 'stale_data' };
  }
  return { available: false, reason: reasonMap[status] ?? 'unknown_status' };
}
for (const c of resVectors.statuses) {
  check(`resource_status:${c.value}`, statuses.has(c.value) === c.valid, `expected ${c.valid}`);
}
for (const c of resVectors.availability) {
  const arb = arbAvailability(c.status, c.dataQuality);
  if (c.expectError != null) {
    check(`resource_availability:${c.name}`, arb.error === c.expectError, `expected error ${c.expectError}, got ${arb.error ?? JSON.stringify(arb)}`);
  } else {
    check(`resource_availability:${c.name}`, arb.error == null && arb.available === c.expect.available && arb.reason === c.expect.reason, `expected ${JSON.stringify(c.expect)}, got ${JSON.stringify(arb)}`);
  }
}
for (const c of resVectors.resourceTypes) {
  check(`resource_type:${c.value}`, resTypes.has(c.value) === c.valid, `expected ${c.valid}`);
}

// --- world 仲裁（ADR-008） ---
const worldSchema = loadJson(path.join(REPO_ROOT, 'contracts/world/world-state.schema.json'));
const worldVectors = loadJson(path.join(REPO_ROOT, 'contracts/world/test-vectors.json'));
const worldTypes = new Set(worldSchema.entityTypeRegistry);
const worldSources = new Set(worldSchema.sourceTypeRegistry);
const canonRe = (() => {
  const idSchema = loadJson(path.join(REPO_ROOT, 'contracts/identity/identity.schema.json'));
  const kinds = idSchema.kindRegistry.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const valueBody = idSchema.valuePattern.replace(/^\^/, '').replace(/\$$/, '');
  return new RegExp(`^(${kinds}):(${valueBody})$`);
})();
function arbParseTs(v) {
  if (typeof v !== 'string' || v.trim() === '') return null;
  let text = v.trim();
  if (text.endsWith('Z')) text = text.slice(0, -1) + '+00:00';
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}
function arbValidateStateRecord(r) {
  if (r == null || typeof r !== 'object') return ['record_must_be_object'];
  const required = ['stateId', 'entityId', 'entityType', 'stateJson', 'validFrom', 'sourceType', 'confidence', 'version'];
  for (const f of required) if (!(f in r)) return [`missing_field:${f}`];
  if (typeof r.stateId !== 'string' || r.stateId === '') return ['bad_state_id'];
  if (typeof r.entityId !== 'string' || !canonRe.test(r.entityId)) return ['bad_entity_id'];
  if (!worldTypes.has(r.entityType)) return ['unknown_entity_type'];
  if (typeof r.stateJson !== 'object' || r.stateJson == null || Array.isArray(r.stateJson)) return ['bad_state_json'];
  if (!worldSources.has(r.sourceType)) return ['unknown_source_type'];
  if (typeof r.confidence !== 'number' || r.confidence < 0 || r.confidence > 1) return ['bad_confidence'];
  if (typeof r.version !== 'number' || !Number.isInteger(r.version) || r.version < 1) return ['bad_version'];
  const vf = arbParseTs(r.validFrom);
  if (vf == null) return ['bad_valid_from'];
  if (r.validTo != null) {
    const vt = arbParseTs(r.validTo);
    if (vt == null || vt < vf) return ['bad_interval'];
  }
  return [];
}
for (const c of worldVectors.stateRecords) {
  const errors = arbValidateStateRecord(c.record);
  if (c.expectError == null) {
    check(`world_record:${c.name}`, errors.length === 0, errors.join(','));
  } else {
    check(`world_record:${c.name}`, errors[0] === c.expectError, `expected ${c.expectError}, got ${errors[0]}`);
  }
}
for (const c of worldVectors.transitions) {
  const ordered = [...c.states].sort((a, b) => arbParseTs(a.validFrom) - arbParseTs(b.validFrom));
  let prevEnd = null;
  let prevVersion = 0;
  let err = null;
  for (const st of ordered) {
    const vf = arbParseTs(st.validFrom);
    if (prevEnd != null && vf < prevEnd) { err = 'overlapping_interval'; break; }
    if (st.version !== prevVersion + 1) { err = 'version_not_monotonic'; break; }
    prevVersion = st.version;
    prevEnd = st.validTo != null ? arbParseTs(st.validTo) : null;
  }
  if (c.expect.valid) {
    check(`world_transition:${c.name}`, err == null && prevVersion === c.expect.currentVersion, `err=${err}`);
  } else {
    check(`world_transition:${c.name}`, err === c.expect.reason, `expected ${c.expect.reason}, got ${err}`);
  }
}
for (const c of worldVectors.snapshots) {
  const sn = c.snapshot;
  let err = null;
  if (sn == null || typeof sn !== 'object') err = 'record_must_be_object';
  else {
    const required = ['snapshotId', 'snapshotVersion', 'ts', 'worldVersion', 'entityVersions', 'states'];
    if (required.some((f) => !(f in sn))) err = 'missing_field';
    else if (typeof sn.worldVersion !== 'number' || sn.worldVersion < 0) err = 'bad_world_version';
    else if (typeof sn.entityVersions !== 'object' || sn.entityVersions == null) err = 'bad_entity_versions';
    else {
      for (const key of Object.keys(sn.entityVersions)) {
        if (!canonRe.test(key)) { err = 'bad_entity_version_key'; break; }
        const v = sn.entityVersions[key];
        if (typeof v !== 'number' || v < 0) { err = 'bad_entity_version_value'; break; }
      }
      if (!err) {
        for (const st of sn.states) {
          const e = arbValidateStateRecord(st);
          if (e.length > 0) { err = e[0]; break; }
        }
      }
    }
  }
  if (c.expectError != null) {
    check(`world_snapshot:${c.name}`, err === c.expectError, `expected ${c.expectError}, got ${err}`);
  } else {
    check(`world_snapshot:${c.name}`, err == null, `err=${err}`);
    if (c.expect != null) {
      const sources = new Set(sn.states.map((st) => st.sourceType));
      const simulatedOnly = sources.size > 0 && sources.size === 1 && sources.has('simulated');
      const hasReal = sources.has('real');
      check(`world_snapshot_profile:${c.name}`, simulatedOnly === c.expect.simulatedOnly && hasReal === c.expect.hasReal);
    }
  }
}

// --- maintenance 仲裁（ADR-010） ---
const maintSchema = loadJson(path.join(REPO_ROOT, 'contracts/maintenance/maintenance.schema.json'));
const maintVectors = loadJson(path.join(REPO_ROOT, 'contracts/maintenance/test-vectors.json'));
const maintTypes = new Set(maintSchema.conditionTypeRegistry);
const maintLifecycle = new Set(maintSchema.lifecycle);
const maintTransitions = new Set([
  'detected->acknowledged', 'acknowledged->work_order_created',
  'work_order_created->resolved', 'resolved->closed',
]);
const riskLadderSet = new Set(riskSchema.severityLadder);
const legacySev = riskSchema.legacySeverityMap;
function arbMaintValidate(r) {
  if (r == null || typeof r !== 'object') return ['record_must_be_object'];
  for (const f of ['conditionId', 'subjectEntityId', 'conditionType', 'severity', 'status']) {
    if (!(f in r)) return [`missing_field:${f}`];
  }
  if (typeof r.conditionId !== 'string' || r.conditionId === '') return ['bad_condition_id'];
  if (typeof r.subjectEntityId !== 'string' || !canonRe.test(r.subjectEntityId)) return ['bad_subject'];
  if (!maintTypes.has(r.conditionType)) return ['unknown_condition_type'];
  if (typeof r.severity !== 'string') return ['unknown_severity'];
  if (!riskLadderSet.has(r.severity) && legacySev[r.severity] == null) return ['unknown_severity'];
  if (!maintLifecycle.has(r.status)) return ['unknown_status'];
  return [];
}
for (const c of maintVectors.conditions) {
  const errors = arbMaintValidate(c.record);
  if (c.expectError == null) {
    check(`maintenance:${c.name}`, errors.length === 0, errors.join(','));
  } else {
    check(`maintenance:${c.name}`, errors[0] === c.expectError, `expected ${c.expectError}, got ${errors[0]}`);
  }
}
for (const c of maintVectors.transitions) {
  const allowed = maintLifecycle.has(c.from) && maintLifecycle.has(c.to) && maintTransitions.has(`${c.from}->${c.to}`);
  check(`maintenance_transition:${c.from}->${c.to}`, allowed === c.allowed, `expected ${c.allowed}`);
}
for (const c of maintVectors.overdue) {
  const due = c.dueAt != null ? arbParseTs(c.dueAt) : null;
  const nowMs = arbParseTs(c.now);
  const overdue = due != null && nowMs != null && !['resolved', 'closed'].includes(c.status) && due < nowMs;
  check(`maintenance_overdue:${c.name}`, overdue === c.expect, `expected ${c.expect}`);
}

// --- quality 仲裁（ADR-010） ---
const qualitySchema = loadJson(path.join(REPO_ROOT, 'contracts/quality/quality.schema.json'));
const qualityVectors = loadJson(path.join(REPO_ROOT, 'contracts/quality/test-vectors.json'));
const qualityTypes = new Set(qualitySchema.findingTypeRegistry);
const qualityLifecycle = new Set(qualitySchema.lifecycle);
const qualityDispositions = new Set(qualitySchema.dispositionRegistry);
const qualityTransitions = new Set(['open->under_review', 'under_review->dispositioned', 'dispositioned->closed']);
function arbQualityValidate(r) {
  if (r == null || typeof r !== 'object') return ['record_must_be_object'];
  for (const f of ['findingId', 'findingType', 'severity', 'status']) {
    if (!(f in r)) return [`missing_field:${f}`];
  }
  if (typeof r.findingId !== 'string' || r.findingId === '') return ['bad_finding_id'];
  if (!qualityTypes.has(r.findingType)) return ['unknown_finding_type'];
  if (typeof r.severity !== 'string') return ['unknown_severity'];
  if (!riskLadderSet.has(r.severity) && legacySev[r.severity] == null) return ['unknown_severity'];
  if (!qualityLifecycle.has(r.status)) return ['unknown_status'];
  const links = r.links ?? [];
  if (!Array.isArray(links)) return ['bad_links'];
  for (const link of links) {
    if (typeof link !== 'string' || !canonRe.test(link)) return ['bad_link'];
  }
  const disposition = r.disposition;
  if (r.status === 'dispositioned') {
    if (disposition == null) return ['disposition_required'];
    if (!qualityDispositions.has(disposition)) return ['unknown_disposition'];
  } else if (disposition != null && !qualityDispositions.has(disposition)) {
    return ['unknown_disposition'];
  }
  return [];
}
for (const c of qualityVectors.findings) {
  const errors = arbQualityValidate(c.record);
  if (c.expectError == null) {
    check(`quality:${c.name}`, errors.length === 0, errors.join(','));
  } else {
    check(`quality:${c.name}`, errors[0] === c.expectError, `expected ${c.expectError}, got ${errors[0]}`);
  }
}
for (const c of qualityVectors.transitions) {
  const allowed = qualityLifecycle.has(c.from) && qualityLifecycle.has(c.to) && qualityTransitions.has(`${c.from}->${c.to}`);
  check(`quality_transition:${c.from}->${c.to}`, allowed === c.allowed, `expected ${c.allowed}`);
}

// --- workorder 仲裁（ADR-012 / NO-05e-a） ---
const woSchema = loadJson(path.join(REPO_ROOT, 'contracts/workorder/work-order.schema.json'));
const woVectors = loadJson(path.join(REPO_ROOT, 'contracts/workorder/test-vectors.json'));
const woTypes = new Set(woSchema.workOrderTypeRegistry);
const woOriginKinds = new Set(woSchema.originKindRegistry);
const woLifecycle = new Set(woSchema.lifecycle);
const woTransitions = new Set([
  'created->scheduled', 'scheduled->in_progress', 'in_progress->completed',
  'completed->closed', 'created->cancelled', 'scheduled->cancelled',
]);
const woCompleted = new Set(['completed', 'closed']);
function arbParseableIso(v) {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}
function arbValidateWorkOrder(record) {
  if (record == null || typeof record !== 'object' || Array.isArray(record)) return ['record_must_be_object'];
  for (const field of ['workOrderId', 'workOrderType', 'origin', 'subjectEntityId', 'severity', 'status']) {
    if (!(field in record)) return [`missing_field:${field}`];
  }
  if (typeof record.workOrderId !== 'string' || record.workOrderId === '') return ['bad_work_order_id'];
  if (!woTypes.has(record.workOrderType)) return ['unknown_work_order_type'];
  const origin = record.origin;
  if (typeof origin !== 'object' || origin === null || Array.isArray(origin) || !('kind' in origin) || !('id' in origin)) {
    return ['missing_origin'];
  }
  if (!woOriginKinds.has(origin.kind)) return ['unknown_origin_kind'];
  if (typeof origin.id !== 'string' || origin.id === '') return ['bad_origin_id'];
  if (typeof record.subjectEntityId !== 'string' || !/^[a-z][a-z0-9_]*:[^\s]+$/.test(record.subjectEntityId)) return ['bad_subject'];
  if (typeof record.severity !== 'string') return ['unknown_severity'];
  const ladder = riskSchema.severityLadder;
  const legacy = riskSchema.legacySeverityMap;
  if (!ladder.includes(record.severity) && legacy[record.severity] == null) return ['unknown_severity'];
  if (!woLifecycle.has(record.status)) return ['unknown_status'];
  if (record.scheduledFor != null && !arbParseableIso(record.scheduledFor)) return ['bad_scheduled_for'];
  if (woCompleted.has(record.status) && record.completedAt == null) return ['completed_at_required'];
  if (record.completedAt != null && !arbParseableIso(record.completedAt)) return ['bad_completed_at'];
  if (record.status === 'cancelled' && (typeof record.cancelledReason !== 'string' || record.cancelledReason === '')) {
    return ['cancelled_reason_required'];
  }
  return [];
}
for (const c of woVectors.records) {
  const errors = arbValidateWorkOrder(c.record);
  if (c.expectError == null) {
    check(`workorder:${c.name}`, errors.length === 0, errors.join(','));
  } else {
    check(`workorder:${c.name}`, errors[0] === c.expectError, `expected ${c.expectError}, got ${errors[0]}`);
  }
}
for (const c of woVectors.transitions) {
  const allowed = woLifecycle.has(c.from) && woLifecycle.has(c.to) && woTransitions.has(`${c.from}->${c.to}`);
  check(`workorder_transition:${c.from}->${c.to}`, allowed === c.allowed, `expected ${c.allowed}`);
}

// --- intelligence 仲裁（ADR-013 / NO-08a） ---
const intelSchema = loadJson(path.join(REPO_ROOT, 'contracts/intelligence/inference-result.schema.json'));
const intelVectors = loadJson(path.join(REPO_ROOT, 'contracts/intelligence/test-vectors.json'));
const intelLevels = new Set(intelSchema.levelRegistry);
const intelOodReasons = new Set(intelSchema.oodReasonRegistry);
const intelQualities = new Set(intelSchema.dataQualityRegistry);
function arbValidateInference(record) {
  if (record == null || typeof record !== 'object' || Array.isArray(record)) return ['record_must_be_object'];
  for (const field of ['inferenceId', 'subjectId', 'level', 'modelId', 'modelVersion', 'inputVersion', 'label', 'confidence', 'oodIndicator', 'dataQuality', 'evidence']) {
    if (!(field in record)) return [`missing_field:${field}`];
  }
  if (typeof record.inferenceId !== 'string' || record.inferenceId === '') return ['bad_inference_id'];
  if (typeof record.subjectId !== 'string' || !/^[a-z][a-z0-9_]*:[^\s]+$/.test(record.subjectId)) return ['bad_subject'];
  if (!intelLevels.has(record.level)) return ['unknown_level'];
  for (const key of ['modelId', 'modelVersion', 'inputVersion']) {
    if (typeof record[key] !== 'string' || record[key] === '') return [`bad_${key}`];
  }
  if (typeof record.label !== 'string' || record.label === '') return ['bad_label'];
  if (typeof record.confidence !== 'number' || Number.isNaN(record.confidence) || record.confidence < 0 || record.confidence > 1) return ['bad_confidence'];
  const ood = record.oodIndicator;
  if (typeof ood !== 'object' || ood === null || Array.isArray(ood) || !('flag' in ood) || !('reasons' in ood)) return ['bad_ood_indicator'];
  const reasons = ood.reasons;
  if (!Array.isArray(reasons) || reasons.some((r) => typeof r !== 'string')) return ['bad_ood_indicator'];
  for (const r of reasons) {
    if (!intelOodReasons.has(r)) return ['unknown_ood_reason'];
  }
  if (ood.flag === true && reasons.length === 0) return ['ood_reason_required'];
  if (ood.flag !== true && reasons.length > 0) return ['ood_flag_required'];
  if (record.label === 'unknown' && !(ood.flag === true && reasons.length > 0)) return ['unknown_requires_ood'];
  if (!intelQualities.has(record.dataQuality)) return ['bad_data_quality'];
  const evidence = record.evidence;
  if (typeof evidence !== 'object' || evidence === null || Array.isArray(evidence)) return ['bad_evidence'];
  if (!('tsStart' in evidence) || !('tsEnd' in evidence) || !('isRule' in evidence)) return ['bad_evidence'];
  if (typeof evidence.isRule !== 'boolean') return ['bad_evidence'];
  if (typeof evidence.tsStart !== 'string' || typeof evidence.tsEnd !== 'string') return ['bad_evidence'];
  return [];
}
for (const c of intelVectors.records) {
  const errors = arbValidateInference(c.record);
  if (c.expectError == null) {
    check(`intelligence:${c.name}`, errors.length === 0, errors.join(','));
  } else {
    check(`intelligence:${c.name}`, errors[0] === c.expectError, `expected ${c.expectError}, got ${errors[0]}`);
  }
}

// --- reasoning 仲裁（ADR-014 / NO-08c） ---
const reasoningSchema = loadJson(path.join(REPO_ROOT, 'contracts/reasoning/reasoning-result.schema.json'));
const reasoningVectors = loadJson(path.join(REPO_ROOT, 'contracts/reasoning/test-vectors.json'));
const reasoningLevels = new Set(reasoningSchema.levelRegistry);
const reasoningKinds = new Set(reasoningSchema.kindRegistry);
function arbValidateReasoning(record) {
  if (record == null || typeof record !== 'object' || Array.isArray(record)) return ['record_must_be_object'];
  for (const field of ['reasoningId', 'level', 'kind', 'modelId', 'modelVersion', 'inputVersion', 'subjectId', 'content', 'ok', 'error', 'confidence', 'confidenceBasis', 'evidence']) {
    if (!(field in record)) return [`missing_field:${field}`];
  }
  if (typeof record.reasoningId !== 'string' || record.reasoningId === '') return ['bad_reasoning_id'];
  if (!reasoningLevels.has(record.level)) return ['unknown_level'];
  if (!reasoningKinds.has(record.kind)) return ['unknown_kind'];
  for (const key of ['modelId', 'modelVersion', 'inputVersion']) {
    if (typeof record[key] !== 'string' || record[key] === '') return [`bad_${key}`];
  }
  if (record.subjectId != null && (typeof record.subjectId !== 'string' || !/^[a-z][a-z0-9_]*:[^\s]+$/.test(record.subjectId))) return ['bad_subject'];
  if (typeof record.content !== 'string') return ['bad_content'];
  if (typeof record.ok !== 'boolean') return ['bad_ok'];
  if (record.ok === true) {
    if (record.content === '') return ['empty_content'];
    if (record.error != null) return ['error_forbidden'];
  } else {
    if (typeof record.error !== 'string' || record.error === '') return ['error_required'];
  }
  if (record.confidence != null) return ['confidence_forbidden'];
  if (record.confidenceBasis !== 'uncalibrated') return ['confidence_basis_required'];
  const evidence = record.evidence;
  if (typeof evidence !== 'object' || evidence === null || Array.isArray(evidence)) return ['bad_evidence'];
  if (!('generatedAt' in evidence) || typeof evidence.generatedAt !== 'string' || evidence.generatedAt === '') return ['bad_evidence'];
  return [];
}
for (const c of reasoningVectors.records) {
  const errors = arbValidateReasoning(c.record);
  if (c.expectError == null) {
    check(`reasoning:${c.name}`, errors.length === 0, errors.join(','));
  } else {
    check(`reasoning:${c.name}`, errors[0] === c.expectError, `expected ${c.expectError}, got ${errors[0]}`);
  }
}

// --- reasoning_trace 仲裁（ADR-020 / NO-08b，Level 4 独立工业推理层） ---
const traceSchema = loadJson(path.join(REPO_ROOT, 'contracts/reasoning/reasoning-trace.schema.json'));
const traceVectors = loadJson(path.join(REPO_ROOT, 'contracts/reasoning/reasoning-trace.test-vectors.json'));
const traceRules = new Set(traceSchema.ruleRegistry);
const traceSeverities = new Set(traceSchema.severityRegistry);
const traceBases = new Set(traceSchema.confidenceBasisRegistry);
function arbIsCanonicalId(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9_]*:[^\s]+$/.test(value);
}
function arbValidateTrace(record) {
  if (record == null || typeof record !== 'object' || Array.isArray(record)) return ['record_must_be_object'];
  for (const field of ['traceId', 'engineVersion', 'factsRef', 'conclusions', 'auditTrail']) {
    if (!(field in record)) return [`missing_field:${field}`];
  }
  if (typeof record.traceId !== 'string' || record.traceId === '') return ['bad_trace_id'];
  if (typeof record.engineVersion !== 'string' || record.engineVersion === '') return ['bad_engine_version'];
  const fr = record.factsRef;
  if (typeof fr !== 'object' || fr === null || Array.isArray(fr)) return ['bad_facts_ref'];
  if (!Number.isInteger(fr.snapshotVersion) || fr.snapshotVersion < 0) return ['bad_facts_ref'];
  if (!Array.isArray(fr.eventIds) || fr.eventIds.some((x) => !arbIsCanonicalId(x))) return ['bad_facts_ref'];
  if (!Array.isArray(record.conclusions)) return ['bad_conclusions'];
  // R2-SHR-001 配套：duplicate_conclusion_id 仲裁分支（与 TS/Python 引擎一致）。
  const seenConclusionIds = new Set();
  for (const c of record.conclusions) {
    if (typeof c !== 'object' || c === null || Array.isArray(c)) return ['bad_conclusions'];
    for (const field of ['conclusionId', 'ruleId', 'subjectId', 'severity', 'confidence', 'confidenceBasis', 'premises', 'evidenceIds', 'explanation']) {
      if (!(field in c)) return [`missing_field:${field}`];
    }
    if (!arbIsCanonicalId(c.conclusionId)) return ['bad_conclusion_id'];
    if (seenConclusionIds.has(c.conclusionId)) return ['duplicate_conclusion_id'];
    seenConclusionIds.add(c.conclusionId);
    if (!traceRules.has(c.ruleId)) return ['unknown_rule'];
    if (!arbIsCanonicalId(c.subjectId)) return ['bad_subject'];
    if (!traceSeverities.has(c.severity)) return ['unknown_severity'];
    if (typeof c.confidence !== 'number' || Number.isNaN(c.confidence) || c.confidence < 0 || c.confidence > 1) return ['bad_confidence'];
    if (!traceBases.has(c.confidenceBasis)) return ['bad_confidence_basis'];
    if (c.confidenceBasis === 'deterministic' && c.confidence !== 1) return ['bad_confidence'];
    if (!Array.isArray(c.premises) || c.premises.length === 0) return ['empty_premises'];
    if (c.premises.some((x) => !arbIsCanonicalId(x))) return ['bad_premise'];
    if (!Array.isArray(c.evidenceIds) || c.evidenceIds.length === 0) return ['empty_evidence'];
    if (c.evidenceIds.some((x) => !arbIsCanonicalId(x))) return ['bad_evidence_ref'];
    if (typeof c.explanation !== 'string' || c.explanation.trim() === '') return ['bad_explanation'];
  }
  if (record.auditTrail !== true) return ['audit_required'];
  return [];
}
for (const c of traceVectors.records) {
  const errors = arbValidateTrace(c.record);
  if (c.expectError == null) {
    check(`reasoning_trace:${c.name}`, errors.length === 0, errors.join(','));
  } else {
    check(`reasoning_trace:${c.name}`, errors[0] === c.expectError, `expected ${c.expectError}, got ${errors[0]}`);
  }
}

// --- learning 仲裁（ADR-021 / NO-09a，Phase 12 Continuous Learning） ---
const learningSchema = loadJson(path.join(REPO_ROOT, 'contracts/learning/learning-evaluation.schema.json'));
const learningVectors = loadJson(path.join(REPO_ROOT, 'contracts/learning/learning-evaluation.test-vectors.json'));
const learningMetrics = new Set(learningSchema.metricRegistry);
const learningTypes = new Set(learningSchema.evaluationTypeRegistry);
function arbParseIso(value) {
  if (typeof value !== 'string') return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}
function arbValidateLearning(record) {
  if (record == null || typeof record !== 'object' || Array.isArray(record)) return ['record_must_be_object'];
  for (const field of ['evalId', 'orgId', 'evaluationType', 'periodStart', 'periodEnd', 'engineVersion', 'metrics', 'basis', 'auditTrail']) {
    if (!(field in record)) return [`missing_field:${field}`];
  }
  if (typeof record.evalId !== 'string' || record.evalId === '') return ['bad_eval_id'];
  if (typeof record.orgId !== 'string' || record.orgId === '') return ['bad_org_id'];
  if (!learningTypes.has(record.evaluationType)) return ['unknown_evaluation_type'];
  const start = arbParseIso(record.periodStart);
  if (start == null) return ['bad_period'];
  const end = arbParseIso(record.periodEnd);
  if (end == null || end < start) return ['bad_period'];
  if (typeof record.engineVersion !== 'string' || record.engineVersion === '') return ['bad_engine_version'];
  const metrics = record.metrics;
  if (typeof metrics !== 'object' || metrics === null || Array.isArray(metrics)) return ['bad_metrics'];
  for (const key of learningMetrics) {
    if (!(key in metrics)) return ['metric_missing'];
  }
  for (const [key, value] of Object.entries(metrics)) {
    if (!learningMetrics.has(key)) return ['unknown_metric'];
    if (value != null && (typeof value !== 'number' || Number.isNaN(value))) return ['bad_metric_value'];
  }
  if (!Array.isArray(record.basis) || record.basis.length === 0) return ['basis_required'];
  if (record.basis.some((x) => typeof x !== 'string' || x === '')) return ['bad_basis'];
  if (record.auditTrail !== true) return ['audit_required'];
  return [];
}
for (const c of learningVectors.records) {
  const errors = arbValidateLearning(c.record);
  if (c.expectError == null) {
    check(`learning:${c.name}`, errors.length === 0, errors.join(','));
  } else {
    check(`learning:${c.name}`, errors[0] === c.expectError, `expected ${c.expectError}, got ${errors[0]}`);
  }
}

// --- observability metrics 仲裁（ADR-023 / NO-10b，§19 指标腿） ---
const metricsSchema = loadJson(path.join(REPO_ROOT, 'contracts/observability/metrics-registry.schema.json'));
const metricsVectors = loadJson(path.join(REPO_ROOT, 'contracts/observability/metrics-registry.test-vectors.json'));
const metricEntryOf = new Map(metricsSchema.metricRegistry.map((e) => [e.name, e]));
function arbValidateMetric(record) {
  if (record == null || typeof record !== 'object' || Array.isArray(record)) return ['record_must_be_object'];
  for (const field of ['metricName', 'metricType', 'value', 'labels']) {
    if (!(field in record)) return [`missing_field:${field}`];
  }
  const entry = metricEntryOf.get(record.metricName);
  if (!entry) return ['unknown_metric'];
  if (record.metricType !== entry.type) return ['metric_type_mismatch'];
  if (typeof record.value !== 'number' || !Number.isFinite(record.value)) return ['bad_value'];
  if (entry.type === 'counter' && record.value < 0) return ['bad_value'];
  if (typeof record.labels !== 'object' || record.labels === null || Array.isArray(record.labels)) return ['bad_labels'];
  for (const key of Object.keys(record.labels)) {
    if (!entry.labelKeys.includes(key)) return ['unknown_label'];
  }
  if (entry.type === 'histogram' && !('le' in record.labels)) return ['histogram_le_required'];
  return [];
}
for (const c of metricsVectors.records) {
  const errors = arbValidateMetric(c.record);
  if (c.expectError == null) {
    check(`metrics:${c.name}`, errors.length === 0, errors.join(','));
  } else {
    check(`metrics:${c.name}`, errors[0] === c.expectError, `expected ${c.expectError}, got ${errors[0]}`);
  }
}

// --- reliability dead-letter 仲裁（ADR-024 / NO-11a，§20 失败终态） ---
const deadLetterSchema = loadJson(path.join(REPO_ROOT, 'contracts/reliability/dead-letter.schema.json'));
const deadLetterVectors = loadJson(path.join(REPO_ROOT, 'contracts/reliability/dead-letter.test-vectors.json'));
const deadLetterReasons = new Set(deadLetterSchema.reasonRegistry);
const deadLetterStatuses = new Set(deadLetterSchema.statusRegistry);
function arbValidateDeadLetter(record) {
  if (record == null || typeof record !== 'object' || Array.isArray(record)) return ['record_must_be_object'];
  for (const field of ['letterId', 'sourceId', 'reason', 'attempts', 'status', 'envelope', 'correlationId', 'auditTrail']) {
    if (!(field in record)) return [`missing_field:${field}`];
  }
  if (typeof record.letterId !== 'string' || record.letterId === '') return ['bad_letter_id'];
  if (typeof record.sourceId !== 'string' || record.sourceId === '') return ['bad_source'];
  if (!deadLetterReasons.has(record.reason)) return ['unknown_reason'];
  if (typeof record.attempts !== 'number' || !Number.isInteger(record.attempts) || record.attempts < 1) return ['bad_attempts'];
  if (!deadLetterStatuses.has(record.status)) return ['unknown_status'];
  if (typeof record.envelope !== 'object' || record.envelope === null || Array.isArray(record.envelope) || Object.keys(record.envelope).length === 0) return ['envelope_required'];
  if (record.status === 'discarded') {
    if (typeof record.discardedReason !== 'string' || record.discardedReason.trim() === '') return ['discard_reason_required'];
  }
  if (record.correlationId != null && typeof record.correlationId !== 'string') return ['bad_correlation'];
  if (record.auditTrail !== true) return ['audit_required'];
  return [];
}
for (const c of deadLetterVectors.records) {
  const errors = arbValidateDeadLetter(c.record);
  if (c.expectError == null) {
    check(`dead_letter:${c.name}`, errors.length === 0, errors.join(','));
  } else {
    check(`dead_letter:${c.name}`, errors[0] === c.expectError, `expected ${c.expectError}, got ${errors[0]}`);
  }
}

// --- simulation run 仲裁（ADR-025 / NO-12a，§13 Digital Twin Simulation） ---
const simSchema = loadJson(path.join(REPO_ROOT, 'contracts/simulation/simulation-run.schema.json'));
const simVectors = loadJson(path.join(REPO_ROOT, 'contracts/simulation/simulation-run.test-vectors.json'));
const simKinds = new Set(simSchema.kindRegistry);
const simStatuses = new Set(simSchema.statusRegistry);
// 形状：isolation 规则必须是 schema properties 中的真规则实例值（§13 三层强制的契约面）。
check(
  'simulation_schema_shape',
  simSchema.schemaVersion === '1.0.0' && simSchema.kindRegistry.length === 4 && simSchema.statusRegistry.length === 4,
  'kind/status 注册表实例值缺失或长度错误',
);
check(
  'simulation_rules_instance',
  typeof simSchema.rules === 'object' && simSchema.rules !== null
    && simSchema.rules.isolationContract === simSchema.properties.rules.properties.isolationContract.const,
  'rules 实例值与 properties const 不一致',
);
function arbValidateSimulationRun(record) {
  if (record == null || typeof record !== 'object' || Array.isArray(record)) return ['record_must_be_object'];
  for (const field of ['runId', 'kind', 'status', 'isSimulation', 'baseRef', 'parameters', 'engineVersion', 'auditTrail']) {
    if (!(field in record)) return [`missing_field:${field}`];
  }
  if (typeof record.runId !== 'string' || record.runId.trim() === '') return ['bad_run_id'];
  if (!simKinds.has(record.kind)) return ['unknown_kind'];
  if (!simStatuses.has(record.status)) return ['unknown_status'];
  if (record.isSimulation !== true) return ['isolation_required'];
  const baseRef = record.baseRef;
  if (typeof baseRef !== 'object' || baseRef === null || Array.isArray(baseRef)) return ['bad_base_ref'];
  if (!Number.isInteger(baseRef.snapshotVersion) || baseRef.snapshotVersion < 0) return ['bad_base_ref'];
  if (baseRef.scenarioId != null && typeof baseRef.scenarioId !== 'string') return ['bad_base_ref'];
  if (typeof record.parameters !== 'object' || record.parameters === null || Array.isArray(record.parameters)) return ['bad_parameters'];
  if (record.status === 'completed') {
    if (typeof record.results !== 'object' || record.results === null || Array.isArray(record.results)) return ['results_required'];
  }
  if (record.status === 'failed') {
    if (typeof record.failureReason !== 'string' || record.failureReason.trim() === '') return ['failure_reason_required'];
  }
  if (typeof record.engineVersion !== 'string' || record.engineVersion.trim() === '') return ['bad_engine_version'];
  if (record.auditTrail !== true) return ['audit_required'];
  return [];
}
for (const c of simVectors.records) {
  const errors = arbValidateSimulationRun(c.record);
  if (c.expectError == null) {
    check(`simulation:${c.name}`, errors.length === 0, errors.join(','));
  } else {
    check(`simulation:${c.name}`, errors[0] === c.expectError, `expected ${c.expectError}, got ${errors[0]}`);
  }
}
// 评估器跨语言仲裁（§31 共享执行向量）：独立 JS 实现 vs Python 锁定实现。
{
  const round6 = (v) => Math.round(v * 1e6) / 1e6;
  const jsCapacity = (stations, demand) => {
    const caps = stations.map((s) => s.capacityPerHour);
    const line = Math.min(...caps);
    const bottleneck = stations.find((s) => s.capacityPerHour === line);
    const utilization = round6(demand / line);
    return {
      bottleneckStationId: bottleneck.stationId,
      lineThroughputPerHour: line,
      utilization,
      overloaded: utilization > 1.0,
    };
  };
  const jsLayout = (stations, moves) => {
    const coords = new Map(stations.map((s) => [s.stationId, [s.x, s.y]]));
    const routes = [];
    let total = 0;
    for (const m of moves) {
      const [x1, y1] = coords.get(m.fromStationId);
      const [x2, y2] = coords.get(m.toStationId);
      const distance = round6(Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2));
      const weighted = round6(distance * m.trips);
      total = round6(total + weighted);
      routes.push({ fromStationId: m.fromStationId, toStationId: m.toStationId, distance, trips: m.trips, totalDistance: weighted });
    }
    return { totalTravelDistance: total, routes };
  };
  const jsFlow = (stations) => {
    const normalized = stations.map((s) => {
      const loadRatio = round6(s.inflowPerHour / s.capacityPerHour);
      return { stationId: s.stationId, loadRatio, overloaded: loadRatio > 1.0 };
    });
    const bottleneck = normalized.reduce((acc, s) => (s.loadRatio > acc.loadRatio ? s : acc));
    return { bottleneckStationId: bottleneck.stationId, bottleneckLoadRatio: bottleneck.loadRatio, stations: normalized };
  };
  const capacityCase = {
    stations: [
      { stationId: 'station:s1', capacityPerHour: 10 },
      { stationId: 'station:s2', capacityPerHour: 25 },
      { stationId: 'station:s3', capacityPerHour: 18.5 },
    ],
    demandPerHour: 24,
  };
  const layoutCase = {
    stations: [
      { stationId: 'station:s1', x: 0, y: 0 },
      { stationId: 'station:s2', x: 3, y: 4 },
      { stationId: 'station:s3', x: 8, y: 0 },
    ],
    moves: [
      { fromStationId: 'station:s1', toStationId: 'station:s2', trips: 10 },
      { fromStationId: 'station:s2', toStationId: 'station:s3', trips: 4 },
      { fromStationId: 'station:s3', toStationId: 'station:s1', trips: 2 },
    ],
  };
  const flowCase = {
    stations: [
      { stationId: 'station:s1', capacityPerHour: 10, inflowPerHour: 8 },
      { stationId: 'station:s2', capacityPerHour: 20, inflowPerHour: 25.5 },
      { stationId: 'station:s3', capacityPerHour: 15, inflowPerHour: 15 },
    ],
  };
  const expected = {
    capacity: jsCapacity(capacityCase.stations, capacityCase.demandPerHour),
    layout: jsLayout(layoutCase.stations, layoutCase.moves),
    flow: jsFlow(flowCase.stations),
  };
  try {
    // SCR-041: 用例数据经 stdin 传入（json.load(sys.stdin)），不再拼入 python -c 字符串。
    const payload = JSON.stringify({
      capacityStations: capacityCase.stations,
      capacityDemand: capacityCase.demandPerHour,
      layoutStations: layoutCase.stations,
      layoutMoves: layoutCase.moves,
      flowStations: flowCase.stations,
    });
    const pyEval = execFileSync(
      'python3',
      ['-c',
        "import json,sys; sys.path.insert(0,'src'); from edge_platform.contracts import simulation_run as s; "
        + "d = json.load(sys.stdin); "
        + "print(json.dumps({'capacity': s.evaluate_capacity(d['capacityStations'], d['capacityDemand']), "
        + "'layout': s.evaluate_layout(d['layoutStations'], d['layoutMoves']), "
        + "'flow': s.evaluate_material_flow(d['flowStations'])}))"],
      { cwd: REPO_ROOT, encoding: 'utf-8', env: { ...process.env, PYTHONPATH: path.join(REPO_ROOT, 'src') }, input: payload },
    ).trim();
    const actual = JSON.parse(pyEval);
    check('simulation_evaluator_capacity', JSON.stringify(actual.capacity) === JSON.stringify(expected.capacity), 'js vs python mismatch');
    check('simulation_evaluator_layout', JSON.stringify(actual.layout) === JSON.stringify(expected.layout), 'js vs python mismatch');
    check('simulation_evaluator_material_flow', JSON.stringify(actual.flow) === JSON.stringify(expected.flow), 'js vs python mismatch');
  } catch (err) {
    check('simulation_evaluator_python_exec', false, `${String(err.message || err)} | STDERR: ${String(err.stderr || '')}`);
  }
}

// --- learning proposal 仲裁（ADR-026 / NO-12b，§10 Level 7 + §12 反馈腿） ---
const proposalSchema = loadJson(path.join(REPO_ROOT, 'contracts/learning/learning-proposal.schema.json'));
const proposalVectors = loadJson(path.join(REPO_ROOT, 'contracts/learning/learning-proposal.test-vectors.json'));
const proposalKinds = new Set(proposalSchema.kindRegistry);
const proposalStatuses = new Set(proposalSchema.statusRegistry);
const thresholdPairs = new Set(proposalSchema.thresholdRules.map((t) => `${t.ruleId}\u0000${t.parameter}`));
check(
  'learning_proposal_schema_shape',
  proposalSchema.schemaVersion === '1.0.0' && proposalSchema.kindRegistry.length === 1
    && proposalSchema.statusRegistry.length === 5 && proposalSchema.thresholdRules.length === 1,
  'kind/status/thresholdRules 注册表实例值缺失或长度错误',
);
check(
  'learning_proposal_rules_instance',
  typeof proposalSchema.rules === 'object' && proposalSchema.rules !== null
    && proposalSchema.rules.shadowGateContract === proposalSchema.properties.rules.properties.shadowGateContract.const,
  'rules 实例值与 properties const 不一致',
);
// 交叉校验（§3 单一事实源）：thresholdRules 的 ruleId ⊆ reasoning-trace ruleRegistry。
{
  const outside = [...thresholdPairs].map((p) => p.split('\u0000')[0]).filter((r) => !traceRules.has(r));
  check('learning_proposal_threshold_rules_subset', outside.length === 0, `threshold ruleIds outside reasoning registry: ${outside.join(',')}`);
}
function arbValidateProposal(record) {
  if (record == null || typeof record !== 'object' || Array.isArray(record)) return ['record_must_be_object'];
  for (const field of ['proposalId', 'kind', 'status', 'change', 'auditTrail']) {
    if (!(field in record)) return [`missing_field:${field}`];
  }
  if (typeof record.proposalId !== 'string' || record.proposalId.trim() === '') return ['bad_proposal_id'];
  if (!proposalKinds.has(record.kind)) return ['unknown_kind'];
  if (!proposalStatuses.has(record.status)) return ['unknown_status'];
  const change = record.change;
  if (typeof change !== 'object' || change === null || Array.isArray(change)) return ['bad_change'];
  for (const field of ['ruleId', 'parameter', 'baselineValue', 'candidateValue']) {
    if (!(field in change)) return [`missing_field:${field}`];
  }
  if (!thresholdPairs.has(`${change.ruleId}\u0000${change.parameter}`)) return ['unsupported_threshold'];
  if (typeof change.baselineValue !== 'number' || typeof change.candidateValue !== 'number') return ['bad_change'];
  if (change.baselineValue < 0 || change.baselineValue > 1 || change.candidateValue < 0 || change.candidateValue > 1) return ['bad_change'];
  if (change.baselineValue === change.candidateValue) return ['no_op_change'];
  const arbValidShadow = (s) => {
    if (typeof s !== 'object' || s === null || Array.isArray(s)) return false;
    for (const field of ['baselineThreshold', 'candidateThreshold', 'factsCount', 'baselineFires', 'candidateFires', 'addedSubjects', 'removedSubjects', 'riskLevel']) {
      if (!(field in s)) return false;
    }
    if (typeof s.baselineThreshold !== 'number' || typeof s.candidateThreshold !== 'number') return false;
    for (const field of ['factsCount', 'baselineFires', 'candidateFires']) {
      if (!Number.isInteger(s[field]) || s[field] < 0) return false;
    }
    if (!Array.isArray(s.addedSubjects) || s.addedSubjects.some((x) => typeof x !== 'string' || x === '')) return false;
    if (!Array.isArray(s.removedSubjects) || s.removedSubjects.some((x) => typeof x !== 'string' || x === '')) return false;
    if (!['low', 'medium', 'high'].includes(s.riskLevel)) return false;
    return true;
  };
  const status = record.status;
  if (['shadow_evaluated', 'approved', 'rolled_back'].includes(status)) {
    if (!arbValidShadow(record.shadowEval)) return ['shadow_eval_required'];
  }
  if (status === 'approved') {
    if (typeof record.approvedBy !== 'string' || record.approvedBy.trim() === '') return ['approver_required'];
    if (typeof record.approvedAt !== 'string' || Number.isNaN(Date.parse(record.approvedAt))) return ['approval_time_required'];
  }
  if (status === 'rejected') {
    if (typeof record.rejectedBy !== 'string' || record.rejectedBy.trim() === '') return ['rejecter_required'];
    if (typeof record.rejectedReason !== 'string' || record.rejectedReason.trim() === '') return ['reject_reason_required'];
  }
  if (status === 'rolled_back') {
    if (typeof record.rolledBackBy !== 'string' || record.rolledBackBy.trim() === '') return ['rollback_by_required'];
    if (typeof record.rolledBackReason !== 'string' || record.rolledBackReason.trim() === '') return ['rollback_reason_required'];
  }
  const evalRef = record.evaluationRef;
  if (evalRef != null && (typeof evalRef !== 'object' || Array.isArray(evalRef) || typeof evalRef.evalId !== 'string')) return ['bad_evaluation_ref'];
  if (record.auditTrail !== true) return ['audit_required'];
  return [];
}
for (const c of proposalVectors.records) {
  const errors = arbValidateProposal(c.record);
  if (c.expectError == null) {
    check(`learning_proposal:${c.name}`, errors.length === 0, errors.join(','));
  } else {
    check(`learning_proposal:${c.name}`, errors[0] === c.expectError, `expected ${c.expectError}, got ${errors[0]}`);
  }
}
// 影子评估器跨语言仲裁（§31 共享执行向量）：独立 JS 实现 vs Python 锁定实现。
{
  const FATIGUE = 0.7;
  const ERGO = 0.7;
  const jsShadow = (ruleId, baseline, candidate, facts) => {
    if (ruleId !== 'rule:worker-overload') throw new Error(`unsupported_threshold:${ruleId}`);
    const fires = (t) => facts
      .filter((f) => f.values.workload >= t && (f.values.fatigue >= FATIGUE || f.values.ergonomicRisk >= ERGO))
      .map((f) => f.subjectId);
    const b = new Set(fires(baseline));
    const c = new Set(fires(candidate));
    const added = [...c].filter((s) => !b.has(s)).sort();
    const removed = [...b].filter((s) => !c.has(s)).sort();
    let riskLevel;
    if (removed.length > 0 && candidate - baseline >= 0.15) riskLevel = 'high';
    else if (removed.length > 0) riskLevel = 'medium';
    else riskLevel = 'low';
    return {
      baselineThreshold: baseline,
      candidateThreshold: candidate,
      factsCount: facts.length,
      baselineFires: b.size,
      candidateFires: c.size,
      addedSubjects: added,
      removedSubjects: removed,
      riskLevel,
    };
  };
  const shadowFacts = [
    { subjectId: 'person:p1', kind: 'person', values: { workload: 0.82, fatigue: 0.8, ergonomicRisk: 0.2 } },
    { subjectId: 'person:p2', kind: 'person', values: { workload: 0.78, fatigue: 0.75, ergonomicRisk: 0.1 } },
    { subjectId: 'person:p3', kind: 'person', values: { workload: 0.9, fatigue: 0.9, ergonomicRisk: 0.9 } },
  ];
  const shadowCases = [
    ['tighten', 0.8, 0.75, shadowFacts],
    ['loosen_medium', 0.8, 0.85, shadowFacts],
    ['loosen_high', 0.7, 0.95, shadowFacts],
  ];
  try {
    // SCR-041: 用例数据经 stdin 传入（json.load(sys.stdin)），不再拼入 python -c 字符串。
    const payload = JSON.stringify(shadowCases.map(([, b, c, facts]) => [b, c, facts]));
    const pyShadow = execFileSync(
      'python3',
      ['-c',
        "import json,sys; sys.path.insert(0,'src'); from edge_platform.contracts import learning_proposal as lp; "
        + "cases = json.load(sys.stdin); "
        + "print(json.dumps([lp.evaluate_rule_threshold_shadow('rule:worker-overload', b, c, f) for (b, c, f) in cases]))"],
      { cwd: REPO_ROOT, encoding: 'utf-8', env: { ...process.env, PYTHONPATH: path.join(REPO_ROOT, 'src') }, input: payload },
    ).trim();
    const actual = JSON.parse(pyShadow);
    for (let i = 0; i < shadowCases.length; i += 1) {
      const [name, b, c, facts] = shadowCases[i];
      const expected = jsShadow('rule:worker-overload', b, c, facts);
      check(
        `learning_proposal_evaluator_${name}`,
        JSON.stringify(actual[i]) === JSON.stringify(expected),
        'js vs python mismatch',
      );
    }
  } catch (err) {
    check('learning_proposal_evaluator_python_exec', false, `${String(err.message || err)} | STDERR: ${String(err.stderr || '')}`);
  }
}

// --- alert/andon 状态机门禁（ADR-031 / §6：alert.yaml 单一事实源） ---
{
  const yamlText = fs.readFileSync(path.join(REPO_ROOT, 'contracts', 'state-machines', 'alert.yaml'), 'utf-8');
  const yamlTransitions = [...yamlText.matchAll(/\{ from: (\w+), to: (\w+), role: (\w+), condition: (\w+) \}/g)]
    .map((m) => ({ from: m[1], to: m[2], role: m[3] }));
  const tsSrc = fs.readFileSync(path.join(REPO_ROOT, 'ewoh-spark-app', 'shared', 'alert-state-machine.ts'), 'utf-8');
  const tsTransitions = [];
  let currentFrom = null;
  for (const line of tsSrc.split('\n')) {
    const section = line.match(/^  (\w+): \[$/);
    if (section) { currentFrom = section[1]; continue; }
    if (currentFrom == null) continue;
    const entry = line.match(/\{ to: '(\w+)', roles: \[([^\]]*)\] \}/);
    if (entry) {
      for (const role of entry[2].matchAll(/'([a-z_]+)'/g)) {
        tsTransitions.push({ from: currentFrom, to: entry[1], role: role[1] });
      }
    }
  }
  check(
    'alert_state_machine_ts_vs_yaml',
    yamlTransitions.length > 0
      && JSON.stringify(yamlTransitions) === JSON.stringify(tsTransitions),
    `yaml=${JSON.stringify(yamlTransitions)} ts=${JSON.stringify(tsTransitions)}`,
  );
}

// --- R2-CNT-002：terminal 结构不变量——终态不得作为任何 transition.from ---
// 覆盖 contracts/state-machines/ 全部 YAML（alert/fleet/...）：
// terminal 集合与转移表自洽（终态有出边即自相矛盾，NEST-626 同型防线）。
{
  const smDir = path.join(REPO_ROOT, 'contracts', 'state-machines');
  const yamlFiles = fs.readdirSync(smDir).filter((f) => f.endsWith('.yaml'));
  let allOk = true;
  const problems = [];
  for (const file of yamlFiles) {
    const text = fs.readFileSync(path.join(smDir, file), 'utf-8');
    const transitions = [...text.matchAll(/\{ from: (\w+), to: (\w+)[,}]/g)].map((m) => m[1]);
    const terminalMatch = text.match(/^terminal:\s*\[([^\]]*)\]\s*$/m);
    if (!terminalMatch) {
      // 无 terminal 声明的机器跳过（结构检查仅针对显式声明者）。
      continue;
    }
    const terminalStates = new Set(
      terminalMatch[1].split(',').map((s) => s.trim()).filter((s) => s !== ''),
    );
    for (const from of transitions) {
      if (terminalStates.has(from)) {
        allOk = false;
        problems.push(`${file}: terminal 状态 ${from} 存在出边`);
      }
    }
  }
  check('state_machine_terminal_no_outgoing_edge', allOk, problems.join('; ') || `checked ${yamlFiles.length} files`);
}

// --- R2-CNT-001：registry 型契约 schema const vs rules 实例自洽 ---
// world-state.schema.json 的 properties.*.const 必须与 rules.* 逐字一致
// （此前 versionMonotonicity 双口径：const 严格 +1 vs 实例放宽文本）。
{
  const worldSchema = loadJson(path.join(REPO_ROOT, 'contracts/world/world-state.schema.json'));
  const ruleProps = worldSchema?.properties?.rules?.properties ?? {};
  const ruleInstances = worldSchema?.rules ?? {};
  const mismatches = [];
  for (const [ruleName, ruleDef] of Object.entries(ruleProps)) {
    const constText = ruleDef && typeof ruleDef === 'object' ? ruleDef.const : undefined;
    const instanceText = ruleInstances[ruleName];
    if (typeof constText === 'string' && constText !== instanceText) {
      mismatches.push(`${ruleName}: const="${constText}" != rules.${ruleName}="${instanceText}"`);
    }
  }
  check('world_state_const_vs_rules_self_consistent', mismatches.length === 0, mismatches.join(' | ') || 'consistent');
}

// --- outcome annotation 仲裁（ADR-034 / §10 Level 7 + §12：真值标注面） ---
const outcomeSchema = loadJson(path.join(REPO_ROOT, 'contracts/learning/outcome-annotation.schema.json'));
const outcomeVectors = loadJson(path.join(REPO_ROOT, 'contracts/learning/outcome-annotation.test-vectors.json'));
const outcomeTargets = new Set(outcomeSchema.targetTypeRegistry);
const outcomeKinds = new Set(outcomeSchema.outcomeKindRegistry);
check(
  'outcome_annotation_schema_shape',
  outcomeSchema.schemaVersion === '1.0.0' && outcomeSchema.targetTypeRegistry.length === 4 && outcomeSchema.outcomeKindRegistry.length === 4,
  'targetType/outcomeKind 注册表实例值缺失或长度错误',
);
check(
  'outcome_annotation_rules_instance',
  typeof outcomeSchema.rules === 'object' && outcomeSchema.rules !== null
    && outcomeSchema.rules.judgerContract === outcomeSchema.properties.rules.properties.judgerContract.const,
  'rules 实例值与 properties const 不一致',
);
function arbValidateOutcome(record) {
  if (record == null || typeof record !== 'object' || Array.isArray(record)) return ['record_must_be_object'];
  for (const field of ['annotationId', 'targetType', 'targetId', 'outcomeKind', 'judgedBy', 'judgedAt', 'auditTrail']) {
    if (!(field in record)) return [`missing_field:${field}`];
  }
  if (typeof record.annotationId !== 'string' || record.annotationId.trim() === '') return ['bad_annotation_id'];
  if (!outcomeTargets.has(record.targetType)) return ['unknown_target_type'];
  if (typeof record.targetId !== 'string' || record.targetId.trim() === '') return ['bad_target_id'];
  if (!outcomeKinds.has(record.outcomeKind)) return ['unknown_outcome_kind'];
  if (typeof record.judgedBy !== 'string' || record.judgedBy.trim() === '') return ['judger_required'];
  if (typeof record.judgedAt !== 'string' || Number.isNaN(Date.parse(record.judgedAt))) return ['bad_judged_at'];
  if (record.measured !== undefined) {
    if (typeof record.measured !== 'object' || record.measured === null || Array.isArray(record.measured)) return ['bad_measured'];
    for (const v of Object.values(record.measured)) {
      if (typeof v !== 'number' || Number.isNaN(v) || !Number.isFinite(v)) return ['bad_measured'];
    }
  }
  if (record.comment !== undefined && typeof record.comment !== 'string') return ['bad_comment'];
  if (record.auditTrail !== true) return ['audit_required'];
  return [];
}
for (const c of outcomeVectors.records) {
  const errors = arbValidateOutcome(c.record);
  if (c.expectError == null) {
    check(`outcome_annotation:${c.name}`, errors.length === 0, errors.join(','));
  } else {
    check(`outcome_annotation:${c.name}`, errors[0] === c.expectError, `expected ${c.expectError}, got ${errors[0]}`);
  }
}

// --- capability 仲裁（ADR-043 / NO-12t，§3/§4 Canonical Capability Model） ---
const capSchema = loadJson(path.join(REPO_ROOT, 'contracts/capability/capability.schema.json'));
const capVectors = loadJson(path.join(REPO_ROOT, 'contracts/capability/capability.test-vectors.json'));
const capKinds = new Set(capSchema.capabilityKinds);
const capProviders = new Set(capSchema.providerTypes);
check(
  'capability_schema_shape',
  capSchema.schemaVersion === '1.0.0' && capSchema.capabilityKinds.length === 5 && capSchema.providerTypes.length === 7,
  'kind/providerType 注册表实例值缺失或长度错误',
);
check(
  'capability_rules_instance',
  typeof capSchema.rules === 'object' && capSchema.rules !== null
    && capSchema.rules.auditRequired === true
    && capSchema.rules.certificationRequiresIssuer === true
    && capSchema.rules.certificationRequiresExpiry === true
    && capSchema.rules.timeOrderRequired === true,
  'rules 实例值缺失或语义错误',
);
function arbValidateCapability(record) {
  if (record == null || typeof record !== 'object' || Array.isArray(record)) return ['record_must_be_object'];
  for (const field of ['capabilityId', 'kind', 'name', 'providerType', 'subject', 'auditTrail']) {
    if (!(field in record)) return [`missing_field:${field}`];
  }
  if (typeof record.capabilityId !== 'string' || record.capabilityId.trim() === '') return ['bad_capability_id'];
  if (!capKinds.has(record.kind)) return ['unknown_kind'];
  if (typeof record.name !== 'string' || record.name.trim() === '' || record.name.length > 100) return ['bad_name'];
  if (!capProviders.has(record.providerType)) return ['unknown_provider_type'];
  if (typeof record.subject !== 'string' || !record.subject.includes(':') || record.subject.startsWith(':') || record.subject.endsWith(':')) return ['bad_subject'];
  if (record.grantedAt !== undefined && (typeof record.grantedAt !== 'string' || Number.isNaN(Date.parse(record.grantedAt)))) return ['bad_granted_at'];
  if (record.expiresAt !== undefined && (typeof record.expiresAt !== 'string' || Number.isNaN(Date.parse(record.expiresAt)))) return ['bad_expires_at'];
  if (record.kind === 'certification') {
    if (typeof record.issuer !== 'string' || record.issuer.trim() === '') return ['certification_missing_issuer'];
    if (record.expiresAt === undefined || typeof record.expiresAt !== 'string') return ['certification_missing_expiry'];
  } else if (record.issuer !== undefined && (typeof record.issuer !== 'string' || record.issuer.trim() === '')) {
    return ['bad_issuer'];
  }
  if (record.grantedAt !== undefined && record.expiresAt !== undefined
      && Date.parse(record.expiresAt) < Date.parse(record.grantedAt)) {
    return ['time_order_violation'];
  }
  const evidence = record.evidence ?? [];
  if (!Array.isArray(evidence)) return ['bad_evidence'];
  for (const item of evidence) {
    if (typeof item !== 'string' || item.trim() === '') return ['bad_evidence'];
  }
  if (record.auditTrail !== true) return ['audit_required'];
  return [];
}
for (const c of capVectors.records) {
  const errors = arbValidateCapability(c.record);
  if (c.expectError == null) {
    check(`capability:${c.name}`, errors.length === 0, errors.join(','));
  } else {
    check(`capability:${c.name}`, errors[0] === c.expectError, `expected ${c.expectError}, got ${errors[0]}`);
  }
}

// --- decision 仲裁（ADR-047 / NO-12x，§2/§3/§18 Canonical Decision Model） ---
const decSchema = loadJson(path.join(REPO_ROOT, 'contracts/decision/decision.schema.json'));
const decVectors = loadJson(path.join(REPO_ROOT, 'contracts/decision/decision.test-vectors.json'));
const decKinds = new Set(decSchema.decisionKinds);
const decStatuses = new Set(decSchema.decisionStatuses);
const decAuthorities = new Set(decSchema.decisionAuthorities);
const decRisks = new Set(decSchema.riskLevels);
const DEC_ACTOR = /^[a-z][a-z0-9_]*:[^\s]+$/;
const DEC_ID = /^decision:[^\s]+$/;
check(
  'decision_schema_shape',
  decSchema.schemaVersion === '1.0.0'
    && decSchema.decisionKinds.length === 8
    && decSchema.decisionStatuses.length === 5
    && decSchema.decisionAuthorities.length === 5
    && decSchema.riskLevels.length === 4,
  'kind/status/authority/riskLevel 注册表实例值缺失或长度错误',
);
check(
  'decision_rules_instance',
  typeof decSchema.rules === 'object' && decSchema.rules !== null
    && decSchema.rules.registriesClosed === true
    && decSchema.rules.selectedReasonRequired === true
    && decSchema.rules.selectedMustBeAmongOptions === true
    && decSchema.rules.approverRequiredWhenHumanDecided === true
    && decSchema.rules.approverRequiredWhenDecided === true
    && decSchema.rules.approverTimeNotBeforeDecision === true
    && decSchema.rules.auditTrailRequired === true
    && decSchema.rules.outcomeLinkOptional === true
    && decSchema.rules.subjectCanonicalIdentity === true
    && decSchema.rules.riskLadderSharedWithRiskContract === true
    && decSchema.rules.decisionIdCanonicalPrefix === 'decision:',
  'rules 实例值缺失或语义错误',
);
check(
  'decision_risk_ladder_shared_with_risk_contract',
  JSON.stringify(decSchema.riskLevels) === JSON.stringify(riskSchema.severityLadder),
  'decision.riskLevels 与 risk.severityLadder 不一致（§31 单一事实源破坏）',
);
function decIsoMs(value) {
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
function decIsFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}
function decNonEmptyStrings(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim() !== '');
}
function arbValidateDecision(record) {
  if (record == null || typeof record !== 'object' || Array.isArray(record)) return ['record_must_be_object'];
  for (const field of ['decisionId', 'kind', 'status', 'decisionAuthority', 'subject', 'tenantId', 'riskLevel', 'requiresApproval', 'decidedAt', 'selected', 'auditTrail']) {
    if (!(field in record)) return [`missing_field:${field}`];
  }
  if (typeof record.decisionId !== 'string' || !DEC_ID.test(record.decisionId)) return ['bad_decision_id'];
  if (!decKinds.has(record.kind)) return ['unknown_kind'];
  if (!decStatuses.has(record.status)) return ['unknown_status'];
  if (!decAuthorities.has(record.decisionAuthority)) return ['unknown_authority'];
  if (typeof record.subject !== 'string' || !DEC_ACTOR.test(record.subject)) return ['bad_subject'];
  if (typeof record.tenantId !== 'string' || record.tenantId.trim() === '') return ['bad_tenant'];
  if (!decRisks.has(record.riskLevel)) return ['unknown_risk_level'];
  if (typeof record.requiresApproval !== 'boolean') return ['bad_approval_flag'];
  const decidedMs = decIsoMs(record.decidedAt);
  if (decidedMs === null) return ['bad_decided_at'];
  for (const [field, code] of [['policyVersion', 'bad_policy_version'], ['solverVersion', 'bad_solver_version'], ['snapshotRef', 'bad_snapshot_ref'], ['outcomeRef', 'bad_outcome_ref']]) {
    const value = record[field];
    if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) return [code];
  }
  const options = record.options;
  const optionIds = [];
  if (options !== undefined) {
    if (!Array.isArray(options)) return ['bad_options'];
    for (const option of options) {
      if (option == null || typeof option !== 'object' || Array.isArray(option)) return ['bad_options'];
      if (typeof option.optionId !== 'string' || option.optionId.trim() === '') return ['bad_option_id'];
      if (optionIds.includes(option.optionId)) return ['duplicate_option'];
      optionIds.push(option.optionId);
      if (option.score !== undefined && option.score !== null && !decIsFiniteNumber(option.score)) return ['bad_options'];
      if (!decNonEmptyStrings(option.reasons ?? [])) return ['bad_options'];
    }
  }
  if (record.selected == null || typeof record.selected !== 'object' || Array.isArray(record.selected)) return ['bad_selected'];
  if (typeof record.selected.optionId !== 'string' || record.selected.optionId.trim() === '') return ['bad_option_id'];
  if (!Array.isArray(record.selected.reason) || record.selected.reason.length === 0
      || record.selected.reason.some((x) => typeof x !== 'string' || x.trim() === '')) {
    return ['selected_reason_required'];
  }
  if (options !== undefined && !optionIds.includes(record.selected.optionId)) return ['unknown_selected_option'];
  if (record.rejectedAlternatives !== undefined) {
    if (!Array.isArray(record.rejectedAlternatives)) return ['bad_rejected'];
    for (const entry of record.rejectedAlternatives) {
      if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) return ['bad_rejected'];
      if (typeof entry.optionId !== 'string' || entry.optionId.trim() === '') return ['bad_option_id'];
      if (!Array.isArray(entry.rejectReasons) || entry.rejectReasons.length === 0
          || entry.rejectReasons.some((x) => typeof x !== 'string' || x.trim() === '')) {
        return ['reject_reason_required'];
      }
    }
  }
  if (record.hardConstraints !== undefined && !decNonEmptyStrings(record.hardConstraints)) return ['bad_hard_constraints'];
  if (record.weightsSnapshot !== undefined) {
    if (record.weightsSnapshot == null || typeof record.weightsSnapshot !== 'object' || Array.isArray(record.weightsSnapshot)) return ['bad_weights'];
    for (const value of Object.values(record.weightsSnapshot)) {
      if (!decIsFiniteNumber(value)) return ['bad_weights'];
    }
  }
  if (record.evidence !== undefined && !decNonEmptyStrings(record.evidence)) return ['bad_evidence'];
  const needsApprover = record.decisionAuthority === 'human' || record.status === 'approved' || record.status === 'rejected';
  if (needsApprover) {
    if (record.approver == null || typeof record.approver !== 'object' || Array.isArray(record.approver)) return ['approver_required'];
  }
  if (record.approver !== undefined) {
    if (record.approver == null || typeof record.approver !== 'object' || Array.isArray(record.approver)) return ['bad_approver'];
    if (typeof record.approver.actor !== 'string' || !DEC_ACTOR.test(record.approver.actor)) return ['bad_approver'];
    const approverMs = decIsoMs(record.approver.at);
    if (approverMs === null) return ['bad_approver'];
    if (approverMs < decidedMs) return ['time_order_violation'];
  }
  if (!Array.isArray(record.auditTrail) || record.auditTrail.length === 0) return ['audit_required'];
  for (const entry of record.auditTrail) {
    if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) return ['bad_audit_entry'];
    if (typeof entry.actor !== 'string' || !DEC_ACTOR.test(entry.actor)) return ['bad_audit_entry'];
    if (typeof entry.action !== 'string' || entry.action.trim() === '') return ['bad_audit_entry'];
    if (decIsoMs(entry.at) === null) return ['bad_audit_entry'];
  }
  return [];
}
for (const c of decVectors.records) {
  const errors = arbValidateDecision(c.record);
  if (c.expectError == null) {
    check(`decision:${c.name}`, errors.length === 0, errors.join(','));
  } else {
    check(`decision:${c.name}`, errors[0] === c.expectError, `expected ${c.expectError}, got ${errors[0]}`);
  }
}

// --- exo config 仲裁（ADR-051 / NO-13b，§7 Support Mode/Assist Profile/Fit/Calibration） ---
const excSchema = loadJson(path.join(REPO_ROOT, 'contracts/exo/exo-config.schema.json'));
const excVectors = loadJson(path.join(REPO_ROOT, 'contracts/exo/exo-config.test-vectors.json'));
const excKinds = new Set(excSchema.exoConfigKinds);
const excModes = new Set(excSchema.supportModes);
const excCalKinds = new Set(excSchema.calibrationKinds);
const excStatusByKind = {
  assist_profile: new Set(excSchema.profileStatuses),
  fit: new Set(excSchema.fitStatuses),
  calibration: new Set(excSchema.calibrationStatuses),
};
const EXC_ACTOR = /^[a-z][a-z0-9_]*:[^\s]+$/;
const EXC_CONFIG_ID = /^exo-config:[^\s]+$/;
const EXC_EXO_ID = /^device:[^\s]+$/;
const EXC_PERSON_ID = /^person:[^\s]+$/;
check(
  'exo_config_schema_shape',
  excSchema.schemaVersion === '1.0.0'
    && excSchema.exoConfigKinds.length === 3
    && excSchema.supportModes.length === 8
    && excSchema.calibrationKinds.length === 3
    && excSchema.profileStatuses.length === 3
    && excSchema.fitStatuses.length === 4
    && excSchema.calibrationStatuses.length === 3,
  'kind/supportMode/calibrationKind/status 注册表实例值缺失或长度错误',
);
check(
  'exo_config_rules_instance',
  typeof excSchema.rules === 'object' && excSchema.rules !== null
    && excSchema.rules.configIdCanonicalPrefix === 'exo-config:'
    && excSchema.rules.exoIdCanonicalDevicePrefix === 'device:'
    && excSchema.rules.auditTrailRequired === true
    && excSchema.rules.assistProfileRequiresSupportMode === true
    && excSchema.rules.assistProfileParametersBounded === true
    && excSchema.rules.fitRequiresPerson === true
    && excSchema.rules.calibrationRequiresResult === true
    && excSchema.rules.vendorSpecificModeRequiresName === true
    && excSchema.rules.timeOrderRequired === true
    && excSchema.rules.subjectCanonicalIdentity === true,
  'rules 实例值缺失或语义错误',
);
function excIsoMs(value) {
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
function excIsFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}
function excIsFiniteMap(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every(excIsFiniteNumber);
}
function arbValidateExoConfig(record) {
  if (record == null || typeof record !== 'object' || Array.isArray(record)) return ['record_must_be_object'];
  for (const field of ['configId', 'kind', 'exoId', 'tenantId', 'status', 'auditTrail']) {
    if (!(field in record)) return [`missing_field:${field}`];
  }
  if (typeof record.configId !== 'string' || !EXC_CONFIG_ID.test(record.configId)) return ['bad_config_id'];
  if (!excKinds.has(record.kind)) return ['unknown_kind'];
  if (typeof record.exoId !== 'string' || !EXC_EXO_ID.test(record.exoId)) return ['bad_exo_id'];
  if (typeof record.tenantId !== 'string' || record.tenantId.trim() === '') return ['bad_tenant'];
  if (!excStatusByKind[record.kind].has(record.status)) return ['unknown_status'];
  if (record.kind === 'assist_profile') {
    if (!excModes.has(record.supportMode)) return ['unknown_support_mode'];
    if (record.supportMode === 'vendor_specific') {
      if (typeof record.vendorModeName !== 'string' || record.vendorModeName.trim() === '') return ['vendor_mode_name_required'];
    } else if (record.vendorModeName !== undefined
        && (typeof record.vendorModeName !== 'string' || record.vendorModeName.trim() === '')) {
      return ['bad_vendor_mode_name'];
    }
    const parameters = record.parameters;
    if (parameters !== undefined) {
      if (parameters == null || typeof parameters !== 'object' || Array.isArray(parameters)) return ['bad_parameters'];
      if (parameters.assistLevel !== undefined
          && (!excIsFiniteNumber(parameters.assistLevel) || parameters.assistLevel < 0 || parameters.assistLevel > 1)) {
        return ['bad_assist_level'];
      }
      if (parameters.torqueLimitNm !== undefined
          && (!excIsFiniteNumber(parameters.torqueLimitNm) || parameters.torqueLimitNm < 0)) {
        return ['bad_torque_limit'];
      }
    }
    const fromMs = excIsoMs(record.effectiveFrom);
    if (fromMs === null) {
      return record.effectiveFrom === undefined ? ['missing_field:effectiveFrom'] : ['bad_effective_from'];
    }
    if (record.effectiveTo !== undefined) {
      const toMs = excIsoMs(record.effectiveTo);
      if (toMs === null) return ['bad_effective_to'];
      if (toMs < fromMs) return ['time_order_violation'];
    }
    if (record.status === 'superseded') {
      if (typeof record.supersededBy !== 'string' || record.supersededBy.trim() === '') return ['superseded_by_required'];
    }
    if (record.setBy !== undefined && (typeof record.setBy !== 'string' || record.setBy.trim() === '')) return ['bad_set_by'];
  } else if (record.kind === 'fit') {
    if (record.personId === undefined) return ['fit_person_required'];
    if (typeof record.personId !== 'string' || !EXC_PERSON_ID.test(record.personId)) return ['bad_person_id'];
    if (record.fittedAt === undefined) return ['missing_field:fittedAt'];
    if (excIsoMs(record.fittedAt) === null) return ['bad_fitted_at'];
    if (record.fitter === undefined) return ['fitter_required'];
    if (typeof record.fitter !== 'string' || !EXC_ACTOR.test(record.fitter)) return ['bad_fitter'];
    if (record.measuredValues !== undefined && !excIsFiniteMap(record.measuredValues)) return ['bad_measured_values'];
  } else if (record.kind === 'calibration') {
    if (record.calibrationKind === undefined) return ['missing_field:calibrationKind'];
    if (!excCalKinds.has(record.calibrationKind)) return ['unknown_calibration_kind'];
    if (record.result === undefined) return ['calibration_result_required'];
    if (!excStatusByKind.calibration.has(record.result)) return ['unknown_calibration_result'];
    const atMs = excIsoMs(record.calibratedAt);
    if (atMs === null) {
      return record.calibratedAt === undefined ? ['missing_field:calibratedAt'] : ['bad_calibrated_at'];
    }
    if (record.calibratedBy === undefined) return ['calibrated_by_required'];
    if (typeof record.calibratedBy !== 'string' || !EXC_ACTOR.test(record.calibratedBy)) return ['bad_calibrated_by'];
    if (record.nextDueAt !== undefined) {
      const dueMs = excIsoMs(record.nextDueAt);
      if (dueMs === null) return ['bad_next_due_at'];
      if (dueMs < atMs) return ['time_order_violation'];
    }
  }
  if (!Array.isArray(record.auditTrail) || record.auditTrail.length === 0) return ['audit_required'];
  for (const entry of record.auditTrail) {
    if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) return ['bad_audit_entry'];
    if (typeof entry.actor !== 'string' || !EXC_ACTOR.test(entry.actor)) return ['bad_audit_entry'];
    if (typeof entry.action !== 'string' || entry.action.trim() === '') return ['bad_audit_entry'];
    if (excIsoMs(entry.at) === null) return ['bad_audit_entry'];
  }
  return [];
}
for (const c of excVectors.records) {
  const errors = arbValidateExoConfig(c.record);
  if (c.expectError == null) {
    check(`exo_config:${c.name}`, errors.length === 0, errors.join(','));
  } else {
    check(`exo_config:${c.name}`, errors[0] === c.expectError, `expected ${c.expectError}, got ${errors[0]}`);
  }
}

// --- exo session 仲裁（ADR-032 / §7：外骨骼↔人员绑定 Session） ---
const exoSessionSchema = loadJson(path.join(REPO_ROOT, 'contracts/exo/exo-session.schema.json'));
const exoSessionVectors = loadJson(path.join(REPO_ROOT, 'contracts/exo/exo-session.test-vectors.json'));
const exoSessionStatuses = new Set(exoSessionSchema.statusRegistry);
check(
  'exo_session_schema_shape',
  exoSessionSchema.schemaVersion === '1.0.0' && exoSessionSchema.statusRegistry.length === 3,
  'status 注册表实例值缺失或长度错误',
);
check(
  'exo_session_rules_instance',
  typeof exoSessionSchema.rules === 'object' && exoSessionSchema.rules !== null
    && exoSessionSchema.rules.uniquenessContract === exoSessionSchema.properties.rules.properties.uniquenessContract.const,
  'rules 实例值与 properties const 不一致',
);
function arbValidateExoSession(record) {
  if (record == null || typeof record !== 'object' || Array.isArray(record)) return ['record_must_be_object'];
  for (const field of ['sessionId', 'exoId', 'personId', 'status', 'startedAt', 'auditTrail']) {
    if (!(field in record)) return [`missing_field:${field}`];
  }
  if (typeof record.sessionId !== 'string' || !record.sessionId.startsWith('exo-session:')) return ['bad_session_id'];
  if (typeof record.exoId !== 'string' || !record.exoId.startsWith('device:') || !/^[a-z][a-z0-9_]*:[^\s]+$/.test(record.exoId)) return ['bad_exo_identity'];
  if (typeof record.personId !== 'string' || !record.personId.startsWith('person:') || !/^[a-z][a-z0-9_]*:[^\s]+$/.test(record.personId)) return ['bad_person_identity'];
  if (!exoSessionStatuses.has(record.status)) return ['unknown_status'];
  if (typeof record.startedAt !== 'string' || Number.isNaN(Date.parse(record.startedAt))) return ['bad_start_time'];
  const actualEnd = record.actualEndAt;
  if (record.status === 'ended' || record.status === 'aborted') {
    if (typeof actualEnd !== 'string' || Number.isNaN(Date.parse(actualEnd))) return ['actual_end_required'];
    if (Date.parse(actualEnd) < Date.parse(record.startedAt)) return ['bad_time_order'];
    if (typeof record.endedBy !== 'string' || record.endedBy.trim() === '') return ['ended_by_required'];
  } else if (actualEnd !== undefined) {
    return ['actual_end_not_allowed'];
  }
  if (record.expectedEndAt !== undefined && (typeof record.expectedEndAt !== 'string' || Number.isNaN(Date.parse(record.expectedEndAt)))) return ['bad_expected_end'];
  if (record.operatorId !== undefined && (typeof record.operatorId !== 'string' || record.operatorId === '')) return ['bad_operator'];
  if (record.auditTrail !== true) return ['audit_required'];
  return [];
}
for (const c of exoSessionVectors.records) {
  const errors = arbValidateExoSession(c.record);
  if (c.expectError == null) {
    check(`exo_session:${c.name}`, errors.length === 0, errors.join(','));
  } else {
    check(`exo_session:${c.name}`, errors[0] === c.expectError, `expected ${c.expectError}, got ${errors[0]}`);
  }
}

// --- entity 仲裁（ADR-015 / NO-03a） ---
const entitySchema = loadJson(path.join(REPO_ROOT, 'contracts/entity/entity-model.schema.json'));
const entityVectors = loadJson(path.join(REPO_ROOT, 'contracts/entity/test-vectors.json'));
const entityKinds = new Set(entitySchema.entityKindRegistry);
const entitySources = new Set(entitySchema.sourceRegistry);
// 交叉校验（契约规则 snapshotSubset）：world-state 22 类快照实体 ⊆ entityKindRegistry。
const snapshotKinds = new Set(worldSchema.entityTypeRegistry);
const snapshotOutsideEntity = [...snapshotKinds].filter((k) => !entityKinds.has(k));
check(
  'entity_snapshot_subset',
  snapshotOutsideEntity.length === 0,
  `snapshot kinds outside entity registry: ${snapshotOutsideEntity.join(',')}`,
);
function arbParseableIsoV(v) {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}
function arbValidateEntity(record) {
  if (record == null || typeof record !== 'object' || Array.isArray(record)) return ['record_must_be_object'];
  for (const field of ['entityId', 'kind', 'tenantId', 'factoryId', 'timeSemantics', 'status', 'source', 'version']) {
    if (!(field in record)) return [`missing_field:${field}`];
  }
  if (typeof record.entityId !== 'string' || !/^[a-z][a-z0-9_]*:[^\s]+$/.test(record.entityId)) return ['bad_entity_id'];
  if (!entityKinds.has(record.kind)) return ['unknown_kind'];
  // kind 前缀一致性（ADR-015 投影分工）：kind:value 的 kind 部分即实体类别。
  const prefix = String(record.entityId).split(':')[0];
  if (!entityKinds.has(prefix)) return ['kind_prefix_unknown'];
  if (prefix !== record.kind) return ['kind_prefix_mismatch'];
  if (typeof record.tenantId !== 'string' || record.tenantId === '') return ['bad_tenant'];
  if (typeof record.factoryId !== 'string' || record.factoryId === '') return ['bad_factory'];
  const timeSem = record.timeSemantics;
  if (typeof timeSem !== 'object' || timeSem === null || Array.isArray(timeSem) || !('validFrom' in timeSem)) return ['bad_time'];
  if (!arbParseableIsoV(timeSem.validFrom)) return ['bad_time'];
  if (timeSem.validTo != null) {
    if (!arbParseableIsoV(timeSem.validTo)) return ['bad_time'];
    if (Date.parse(timeSem.validTo) < Date.parse(timeSem.validFrom)) return ['bad_time'];
  }
  if (typeof record.status !== 'string' || record.status === '') return ['bad_status'];
  if (!entitySources.has(record.source)) return ['unknown_source'];
  if (!Number.isInteger(record.version) || record.version < 1) return ['bad_version'];
  const confidence = record.confidence;
  if (confidence != null && (typeof confidence !== 'number' || Number.isNaN(confidence) || confidence < 0 || confidence > 1)) return ['bad_confidence'];
  for (const key of ['refs', 'eventRefs']) {
    const refs = record[key];
    if (refs == null) continue;
    if (!Array.isArray(refs) || refs.some((x) => typeof x !== 'string' || !/^[a-z][a-z0-9_]*:[^\s]+$/.test(x))) return ['bad_ref'];
  }
  return [];
}
for (const c of entityVectors.records) {
  const errors = arbValidateEntity(c.record);
  if (c.expectError == null) {
    check(`entity:${c.name}`, errors.length === 0, errors.join(','));
  } else {
    check(`entity:${c.name}`, errors[0] === c.expectError, `expected ${c.expectError}, got ${errors[0]}`);
  }
}

// 投影分工交叉校验（ADR-015 修正案，NO-03b）：
//  - projectionDivision.stateProjectableKinds 必须恰等于 world-state 22 类注册表；
//  - identityOnlyKinds / entityOnlyKinds 必须恰等于 identity 42 类与 entity 45 类的差集
//    （device/session 仅发证；worker_capability/fatigue/workload/ergonomic_risk/
//    production_order 仅模型事实——单一事实源，门禁强制）；
//  - projectionBuckets（云侧粗粒度投影桶映射）必须以 schema 实例值存在。
const identitySchema = loadJson(path.join(REPO_ROOT, 'contracts/identity/identity.schema.json'));
const identityKinds = new Set(identitySchema.kindRegistry);
const identityOnly = [...identityKinds].filter((k) => !entityKinds.has(k));
const entityOnly = [...entityKinds].filter((k) => !identityKinds.has(k));
const projDiv = entitySchema.projectionDivision;
check(
  'entity_projection_division_present',
  projDiv != null && Array.isArray(projDiv.stateProjectableKinds) && Array.isArray(projDiv.identityOnlyKinds) && Array.isArray(projDiv.entityOnlyKinds),
  'projectionDivision instance value missing',
);
if (projDiv != null) {
  check(
    'entity_division_state_projectable',
    JSON.stringify([...snapshotKinds].sort()) === JSON.stringify([...projDiv.stateProjectableKinds].sort()),
    `projection mismatch: schema=${projDiv.stateProjectableKinds.length} world=${snapshotKinds.size}`,
  );
  check(
    'entity_division_identity_only',
    JSON.stringify(identityOnly.sort()) === JSON.stringify([...projDiv.identityOnlyKinds].sort()),
    `identity-only mismatch: derived=${identityOnly.join(',')} schema=${projDiv.identityOnlyKinds.join(',')}`,
  );
  check(
    'entity_division_entity_only',
    JSON.stringify(entityOnly.sort()) === JSON.stringify([...projDiv.entityOnlyKinds].sort()),
    `entity-only mismatch: derived=${entityOnly.join(',')} schema=${projDiv.entityOnlyKinds.join(',')}`,
  );
  const buckets = entitySchema.projectionBuckets;
  check(
    'entity_projection_buckets_present',
    buckets != null && Array.isArray(buckets.personBucket) && Array.isArray(buckets.deviceBucket) && Array.isArray(buckets.stationBucket) && Array.isArray(buckets.taskBucket),
    'projectionBuckets instance value missing',
  );
  if (buckets != null) {
    const bucketKindUnion = new Set([...entityKinds, ...identityOnly]);
    for (const key of ['personBucket', 'deviceBucket', 'stationBucket', 'taskBucket']) {
      const outside = buckets[key].filter((k) => !bucketKindUnion.has(k));
      check(`entity_bucket_${key}_kinds_valid`, outside.length === 0, `bucket kinds outside registries: ${outside.join(',')}`);
    }
  }
}

// --- agent 仲裁（ADR-016 / NO-06） ---
const agentSchema = loadJson(path.join(REPO_ROOT, 'contracts/agent/agent-manifest.schema.json'));
const agentVectors = loadJson(path.join(REPO_ROOT, 'contracts/agent/test-vectors.json'));
const agentRoles = new Set(agentSchema.agentRoleRegistry);
const agentScopes = new Set(agentSchema.scopeTokenRegistry);
const agentCommands = new Set(agentSchema.commandRegistry);
const agentRiskLevels = new Set(agentSchema.riskLevels);
const agentAutonomous = new Set(agentSchema.autonomousLevels);
const agentFallbacks = new Set(agentSchema.fallbackStrategies);
function arbValidateAgent(record) {
  if (record == null || typeof record !== 'object' || Array.isArray(record)) return ['record_must_be_object'];
  const required = ['agentId', 'name', 'version', 'role', 'purpose', 'allowedTools', 'readScope', 'writeScope', 'approvalRequirement', 'riskLevel', 'inputContract', 'outputContract', 'auditTrail', 'budget', 'timeoutSec', 'fallback'];
  for (const field of required) if (!(field in record)) return [`missing_field:${field}`];
  if (typeof record.agentId !== 'string' || !/^[a-z][a-z0-9_]*:[^\s]+$/.test(record.agentId)) return ['bad_agent_id'];
  if (!agentRoles.has(record.role)) return ['unknown_role'];
  if (typeof record.name !== 'string' || record.name === '') return ['bad_name'];
  if (!Number.isInteger(record.version) || record.version < 1) return ['bad_version'];
  if (typeof record.purpose !== 'string' || record.purpose.trim() === '') return ['empty_purpose'];
  if (!Array.isArray(record.allowedTools) || record.allowedTools.some((t) => typeof t !== 'string' || !/^[a-z][a-z0-9_]*:[^\s]+$/.test(t))) return ['bad_tool'];
  if (!Array.isArray(record.readScope) || record.readScope.some((x) => typeof x !== 'string')) return ['bad_scope'];
  for (const token of record.readScope) if (!agentScopes.has(token)) return ['unknown_scope_token'];
  const ws = record.writeScope;
  if (ws == null || typeof ws !== 'object' || Array.isArray(ws)) return ['bad_write_scope'];
  const writeTokens = ws.tokens ?? [];
  if (!Array.isArray(writeTokens) || writeTokens.some((x) => typeof x !== 'string')) return ['bad_scope'];
  for (const token of writeTokens) if (!agentScopes.has(token)) return ['unknown_scope_token'];
  const writeCommands = ws.commands ?? [];
  if (!Array.isArray(writeCommands) || writeCommands.some((c) => typeof c !== 'string')) return ['bad_command'];
  for (const command of writeCommands) if (!agentCommands.has(command)) return ['unknown_command'];
  const approval = record.approvalRequirement;
  if (approval == null || typeof approval !== 'object' || Array.isArray(approval)) return ['bad_approval'];
  const level = approval.autonomousLevel;
  if (typeof level !== 'string' || !agentAutonomous.has(level)) return ['unknown_autonomous_level'];
  const requiredCmds = approval.approvalRequiredFor ?? [];
  if (!Array.isArray(requiredCmds) || requiredCmds.some((c) => typeof c !== 'string')) return ['bad_approval'];
  for (const command of requiredCmds) if (!agentCommands.has(command)) return ['unknown_command'];
  if ((level === 'L2' || level === 'L3') && requiredCmds.length === 0) return ['approval_required'];
  if (!agentRiskLevels.has(record.riskLevel)) return ['unknown_risk_level'];
  if (record.riskLevel === 'critical' && (level === 'L2' || level === 'L3')) return ['level_risk_conflict'];
  if (record.role === 'Safety') {
    if (level === 'L2' || level === 'L3') return ['safety_autonomy_forbidden'];
    if (writeTokens.length > 0 || writeCommands.length > 0) return ['safety_role_write_forbidden'];
  }
  const l3SafeCommands = new Set(['propose_plan', 'record_evidence', 'request_approval', 'run_simulation']);
  if (level === 'L3') {
    if (record.riskLevel !== 'low') return ['l3_risk_forbidden'];
    if (writeCommands.some((command) => !l3SafeCommands.has(command))) return ['l3_command_forbidden'];
    if (writeTokens.some((token) => token !== 'simulationData')) return ['l3_scope_forbidden'];
  }
  for (const key of ['inputContract', 'outputContract']) {
    const contract = record[key];
    if (contract == null || typeof contract !== 'object' || Array.isArray(contract) || typeof contract.schemaRef !== 'string' || contract.schemaRef === '') return ['bad_contract'];
  }
  if (record.auditTrail !== true) return ['audit_required'];
  const budget = record.budget;
  if (budget == null || typeof budget !== 'object' || Array.isArray(budget)) return ['bad_budget'];
  for (const key of ['maxSteps', 'maxTokens', 'maxDurationSec']) {
    if (!Number.isInteger(budget[key]) || budget[key] < 1) return ['bad_budget'];
  }
  if (!Number.isInteger(record.timeoutSec) || record.timeoutSec < 1) return ['bad_timeout'];
  const fallback = record.fallback;
  if (fallback == null || typeof fallback !== 'object' || Array.isArray(fallback) || !agentFallbacks.has(fallback.onFailure)) return ['unknown_fallback'];
  if (fallback.fallbackAgentId != null && (typeof fallback.fallbackAgentId !== 'string' || !/^[a-z][a-z0-9_]*:[^\s]+$/.test(fallback.fallbackAgentId))) return ['bad_fallback_agent'];
  return [];
}
for (const c of agentVectors.records) {
  const errors = arbValidateAgent(c.record);
  if (c.expectError == null) {
    check(`agent:${c.name}`, errors.length === 0, errors.join(','));
  } else {
    check(`agent:${c.name}`, errors[0] === c.expectError, `expected ${c.expectError}, got ${errors[0]}`);
  }
}

// --- agent_task 仲裁（ADR-017 / NO-06e） ---
const agentTaskSchema = loadJson(path.join(REPO_ROOT, 'contracts/agent_task/agent-task.schema.json'));
const agentTaskVectors = loadJson(path.join(REPO_ROOT, 'contracts/agent_task/test-vectors.json'));
const agentTaskRoles = new Set(agentTaskSchema.agentRoleRegistry);
const agentTaskKinds = new Set(agentTaskSchema.taskKindRegistry);
const agentTaskPriorities = new Set(agentTaskSchema.priorityRegistry);
const agentTaskStatuses = new Set(agentTaskSchema.statusRegistry);
// 交叉核对：agent-task 的角色注册表与 agent-manifest 同源（单一事实源）
check(
  'agent_task_role_registry_aligned',
  JSON.stringify([...agentTaskRoles].sort()) === JSON.stringify([...new Set(agentSchema.agentRoleRegistry)].sort()),
  'agent-task agentRoleRegistry must equal agent-manifest agentRoleRegistry',
);
function arbValidateAgentTask(record) {
  if (record == null || typeof record !== 'object' || Array.isArray(record)) return ['record_must_be_object'];
  const required = ['taskId', 'name', 'version', 'kind', 'assignedRole', 'dependencies', 'inputContract', 'outputContract', 'priority', 'createdAt', 'budget', 'status', 'auditTrail'];
  for (const field of required) if (!(field in record)) return [`missing_field:${field}`];
  if (typeof record.taskId !== 'string' || !/^[a-z][a-z0-9_]*:[^\s]+$/.test(record.taskId)) return ['bad_task_id'];
  if (typeof record.name !== 'string' || record.name === '') return ['bad_name'];
  if (!Number.isInteger(record.version) || record.version < 1) return ['bad_version'];
  if (!agentTaskKinds.has(record.kind)) return ['unknown_kind'];
  if (!agentTaskRoles.has(record.assignedRole)) return ['unknown_role'];
  if (record.assigneeAgentId != null && (typeof record.assigneeAgentId !== 'string' || !/^[a-z][a-z0-9_]*:[^\s]+$/.test(record.assigneeAgentId))) return ['bad_assignee'];
  if (!Array.isArray(record.dependencies) || record.dependencies.some((d) => typeof d !== 'string' || !/^[a-z][a-z0-9_]*:[^\s]+$/.test(d))) return ['bad_dependency'];
  if (record.dependencies.includes(record.taskId)) return ['self_dependency'];
  for (const key of ['inputContract', 'outputContract']) {
    const contract = record[key];
    if (contract == null || typeof contract !== 'object' || Array.isArray(contract) || typeof contract.schemaRef !== 'string' || contract.schemaRef === '') return ['bad_contract'];
  }
  if (!agentTaskPriorities.has(record.priority)) return ['bad_priority'];
  const createdMs = arbParseableIsoV(record.createdAt) ? Date.parse(record.createdAt) : null;
  if (createdMs == null) return ['bad_time'];
  if (record.dueTime != null) {
    if (!arbParseableIsoV(record.dueTime)) return ['bad_time'];
    if (Date.parse(record.dueTime) < createdMs) return ['bad_time'];
  }
  const budget = record.budget;
  if (budget == null || typeof budget !== 'object' || Array.isArray(budget)) return ['bad_budget'];
  for (const key of ['maxSteps', 'maxTokens', 'maxDurationSec']) {
    if (!Number.isInteger(budget[key]) || budget[key] < 1) return ['bad_budget'];
  }
  if (!agentTaskStatuses.has(record.status)) return ['bad_status'];
  if (record.auditTrail !== true) return ['audit_required'];
  return [];
}
for (const c of agentTaskVectors.records) {
  const errors = arbValidateAgentTask(c.record);
  if (c.expectError == null) {
    check(`agent_task:${c.name}`, errors.length === 0, errors.join(','));
  } else {
    check(`agent_task:${c.name}`, errors[0] === c.expectError, `expected ${c.expectError}, got ${errors[0]}`);
  }
}

// --- knowledge 仲裁（ADR-018 / NO-07） ---
const knowledgeSchema = loadJson(path.join(REPO_ROOT, 'contracts/knowledge/knowledge-entry.schema.json'));
const knowledgeVectors = loadJson(path.join(REPO_ROOT, 'contracts/knowledge/test-vectors.json'));
const knowledgeKinds = new Set(knowledgeSchema.knowledgeKindRegistry);
const knowledgeScopes = new Set(knowledgeSchema.knowledgeScopeRegistry);
const knowledgeStatuses = new Set(knowledgeSchema.knowledgeStatusRegistry);
const kTenantRequired = new Set(['customer', 'factory', 'private_operational']);
const kShared = new Set(['global', 'industry']);
const kProvenanceFields = ['trainingDataSources', 'anonymizationPolicy', 'dataAuthorization', 'modelVersion'];
function arbValidateKnowledge(record) {
  if (record == null || typeof record !== 'object' || Array.isArray(record)) return ['record_must_be_object'];
  const required = ['knowledgeId', 'kind', 'scope', 'title', 'summary', 'body', 'sourceEvidenceIds', 'relatedEntityIds', 'tags', 'version', 'status', 'timeSemantics', 'auditTrail'];
  for (const field of required) if (!(field in record)) return [`missing_field:${field}`];
  if (typeof record.knowledgeId !== 'string' || !/^[a-z][a-z0-9_]*:[^\s]+$/.test(record.knowledgeId)) return ['bad_knowledge_id'];
  if (!knowledgeKinds.has(record.kind)) return ['unknown_kind'];
  if (!knowledgeScopes.has(record.scope)) return ['unknown_scope'];
  if (typeof record.title !== 'string' || record.title.trim() === '') return ['bad_title'];
  if (typeof record.summary !== 'string' || record.summary.trim() === '') return ['bad_summary'];
  if (typeof record.body !== 'string' || record.body.trim() === '') return ['bad_body'];
  if (!Array.isArray(record.sourceEvidenceIds) || record.sourceEvidenceIds.some((e) => typeof e !== 'string' || !/^[a-z][a-z0-9_]*:[^\s]+$/.test(e))) return ['bad_evidence_ref'];
  if (record.sourceEvidenceIds.length === 0) return ['empty_evidence'];
  if (!Array.isArray(record.relatedEntityIds) || record.relatedEntityIds.some((x) => typeof x !== 'string' || !/^[a-z][a-z0-9_]*:[^\s]+$/.test(x))) return ['bad_entity_ref'];
  if (!Array.isArray(record.tags) || record.tags.some((t) => typeof t !== 'string' || t.length < 1 || t.length > 64)) return ['bad_tag'];
  if (!Number.isInteger(record.version) || record.version < 1) return ['bad_version'];
  if (!knowledgeStatuses.has(record.status)) return ['bad_status'];
  if (record.verifiedBy != null && (typeof record.verifiedBy !== 'string' || !/^[a-z][a-z0-9_]*:[^\s]+$/.test(record.verifiedBy))) return ['bad_verifier'];
  const scope = record.scope;
  if (kTenantRequired.has(scope)) {
    if (typeof record.tenantId !== 'string' || record.tenantId === '') return ['tenant_required'];
  } else if (kShared.has(scope)) {
    if (record.tenantId != null) return ['tenant_forbidden'];
  }
  const provenance = record.provenance;
  if (kShared.has(scope)) {
    if (provenance == null || typeof provenance !== 'object' || Array.isArray(provenance)) return ['provenance_required'];
    const kSources = provenance.trainingDataSources;
    if (!Array.isArray(kSources) || kSources.length === 0 || kSources.some((item) => typeof item !== 'string' || item.trim() === '')) return ['provenance_required'];
    for (const field of kProvenanceFields.slice(1)) {
      if (typeof provenance[field] !== 'string' || provenance[field].trim() === '') return ['provenance_required'];
    }
  } else if (scope === 'private_operational') {
    if (provenance != null) return ['provenance_forbidden'];
  } else if (provenance != null && (typeof provenance !== 'object' || Array.isArray(provenance))) {
    return ['bad_provenance'];
  }
  const timeSem = record.timeSemantics;
  if (timeSem == null || typeof timeSem !== 'object' || Array.isArray(timeSem) || !('validFrom' in timeSem)) return ['bad_time'];
  if (!arbParseableIsoV(timeSem.validFrom)) return ['bad_time'];
  if (timeSem.validTo != null) {
    if (!arbParseableIsoV(timeSem.validTo)) return ['bad_time'];
    if (Date.parse(timeSem.validTo) < Date.parse(timeSem.validFrom)) return ['bad_time'];
  }
  if (record.auditTrail !== true) return ['audit_required'];
  return [];
}
for (const c of knowledgeVectors.records) {
  const errors = arbValidateKnowledge(c.record);
  if (c.expectError == null) {
    check(`knowledge:${c.name}`, errors.length === 0, errors.join(','));
  } else {
    check(`knowledge:${c.name}`, errors[0] === c.expectError, `expected ${c.expectError}, got ${errors[0]}`);
  }
}

// ── 3/4. Python / TypeScript 注册表与 schema 一致 ───────────────────────────
// ordered=true 的注册表语义有序（severity 阶梯/生命周期/枚举序），必须逐位一致；
// 其余为无序集合，排序后比较。
const pyChecks = [
  ['risk.SEVERITY_LADDER', riskSchema.severityLadder, true],
  ['risk.LIFECYCLE', riskSchema.lifecycle, true],
  ['risk.CATEGORIES', riskSchema.categoryRegistry, false],
  ['location.SPATIAL_KINDS', locSchema.spatialKindRegistry, false],
  ['location.COORDINATE_TYPES', locSchema.coordinateTypes, false],
  ['resource.STATUSES', resSchema.statusRegistry, false],
  ['resource.DATA_QUALITIES', resSchema.dataQualityRegistry, false],
  ['resource.SOURCES', resSchema.sourceRegistry, false],
  ['resource.RESOURCE_TYPES', resSchema.resourceTypeRegistry, false],
  ['world.ENTITY_TYPES', worldSchema.entityTypeRegistry, false],
  ['world.SOURCE_TYPES', worldSchema.sourceTypeRegistry, false],
  ['maintenance.CONDITION_TYPES', maintSchema.conditionTypeRegistry, false],
  ['maintenance.LIFECYCLE', maintSchema.lifecycle, true],
  ['quality.FINDING_TYPES', qualitySchema.findingTypeRegistry, false],
  ['quality.LIFECYCLE', qualitySchema.lifecycle, true],
  ['quality.DISPOSITIONS', qualitySchema.dispositionRegistry, false],
  ['workorder.WORK_ORDER_TYPES', woSchema.workOrderTypeRegistry, false],
  ['workorder.ORIGIN_KINDS', woSchema.originKindRegistry, false],
  ['workorder.LIFECYCLE', woSchema.lifecycle, true],
  ['intelligence.LEVELS', intelSchema.levelRegistry, true],
  ['intelligence.OOD_REASONS', intelSchema.oodReasonRegistry, false],
  ['intelligence.DATA_QUALITIES', intelSchema.dataQualityRegistry, false],
  ['reasoning.LEVELS', reasoningSchema.levelRegistry, true],
  ['reasoning.KINDS', reasoningSchema.kindRegistry, false],
  ['reasoning_trace.RULE_IDS', traceSchema.ruleRegistry, true],
  ['reasoning_trace.SEVERITIES', traceSchema.severityRegistry, true],
  ['reasoning_trace.CONFIDENCE_BASES', traceSchema.confidenceBasisRegistry, true],
  ['reasoning_trace.FACT_KINDS', traceSchema.factKindRegistry, true],
  ['learning.METRIC_KEYS', learningSchema.metricRegistry, true],
  ['learning.EVALUATION_TYPES', learningSchema.evaluationTypeRegistry, true],
  ['metrics.METRIC_NAMES', metricsSchema.metricRegistry.map((e) => e.name), true],
  ['metrics.METRIC_TYPES', metricsSchema.metricTypeRegistry, true],
  ['metrics.METRIC_LABEL_KEYS', metricsSchema.labelKeyRegistry, true],
  ['dead_letter.REASONS', deadLetterSchema.reasonRegistry, true],
  ['dead_letter.STATUSES', deadLetterSchema.statusRegistry, true],
  ['simulation.KINDS', simSchema.kindRegistry, true],
  ['simulation.STATUSES', simSchema.statusRegistry, true],
  ['learning_proposal.KINDS', proposalSchema.kindRegistry, true],
  ['learning_proposal.STATUSES', proposalSchema.statusRegistry, true],
  ['exo_session.STATUSES', exoSessionSchema.statusRegistry, true],
  ['outcome_annotation.TARGET_TYPES', outcomeSchema.targetTypeRegistry, true],
  ['outcome_annotation.OUTCOME_KINDS', outcomeSchema.outcomeKindRegistry, true],
  ['entity.ENTITY_KINDS', entitySchema.entityKindRegistry, true],
  ['entity.SOURCES', entitySchema.sourceRegistry, false],
  ['entity.WORLD_STATE_PROJECTABLE_KINDS', entitySchema.projectionDivision.stateProjectableKinds, false],
  ['entity.PERSON_BUCKET_KINDS', entitySchema.projectionBuckets.personBucket, true],
  ['entity.DEVICE_BUCKET_KINDS', entitySchema.projectionBuckets.deviceBucket, true],
  ['entity.STATION_BUCKET_KINDS', entitySchema.projectionBuckets.stationBucket, true],
  ['entity.TASK_BUCKET_KINDS', entitySchema.projectionBuckets.taskBucket, true],
  ['agent.AGENT_ROLES', agentSchema.agentRoleRegistry, true],
  ['agent.SCOPE_TOKENS', agentSchema.scopeTokenRegistry, false],
  ['agent.COMMANDS', agentSchema.commandRegistry, false],
  ['agent.RISK_LEVELS', agentSchema.riskLevels, true],
  ['agent.AUTONOMOUS_LEVELS', agentSchema.autonomousLevels, true],
  ['agent.FALLBACK_STRATEGIES', agentSchema.fallbackStrategies, false],
  ['agent_task.TASK_KINDS', agentTaskSchema.taskKindRegistry, true],
  ['agent_task.PRIORITIES', agentTaskSchema.priorityRegistry, true],
  ['agent_task.STATUSES', agentTaskSchema.statusRegistry, true],
  ['knowledge.KNOWLEDGE_KINDS', knowledgeSchema.knowledgeKindRegistry, true],
  ['knowledge.KNOWLEDGE_SCOPES', knowledgeSchema.knowledgeScopeRegistry, true],
  ['knowledge.KNOWLEDGE_STATUSES', knowledgeSchema.knowledgeStatusRegistry, true],
  ['capability.KINDS', capSchema.capabilityKinds, true],
  ['capability.PROVIDER_TYPES', capSchema.providerTypes, true],
  ['capability.KNOWN_VALUES', capSchema.knownValues, false],
  ['decision.KINDS', decSchema.decisionKinds, true],
  ['decision.STATUSES', decSchema.decisionStatuses, true],
  ['decision.AUTHORITIES', decSchema.decisionAuthorities, true],
  ['decision.RISK_LEVELS', riskSchema.severityLadder, true],
  ['exo_config.KINDS', excSchema.exoConfigKinds, true],
  ['exo_config.SUPPORT_MODES', excSchema.supportModes, true],
  ['exo_config.CALIBRATION_KINDS', excSchema.calibrationKinds, true],
  ['exo_config.PROFILE_STATUSES', excSchema.profileStatuses, true],
  ['exo_config.FIT_STATUSES', excSchema.fitStatuses, true],
  ['exo_config.CALIBRATION_STATUSES', excSchema.calibrationStatuses, true],
];
try {
  const pyOut = execFileSync(
    'python3',
    [
      '-c',
      "import json,sys; sys.path.insert(0,'src'); from edge_platform.contracts import risk, location, resource, world, maintenance, quality, workorder, inference_result, reasoning_result, reasoning_trace, learning_evaluation, metrics_registry, dead_letter, simulation_run, learning_proposal, exo_session, outcome_annotation, entity_model, agent, agent_task, knowledge, capability, decision, exo_config; "
        + "print(json.dumps({'risk.SEVERITY_LADDER': list(risk.SEVERITY_LADDER), "
        + "'risk.LIFECYCLE': list(risk.LIFECYCLE), 'risk.CATEGORIES': sorted(risk.CATEGORIES), "
        + "'location.SPATIAL_KINDS': sorted(location.SPATIAL_KINDS), "
        + "'location.COORDINATE_TYPES': sorted(location.COORDINATE_TYPES), "
        + "'resource.STATUSES': sorted(resource.STATUSES), "
        + "'resource.DATA_QUALITIES': sorted(resource.DATA_QUALITIES), "
        + "'resource.SOURCES': sorted(resource.SOURCES), "
        + "'resource.RESOURCE_TYPES': sorted(resource.RESOURCE_TYPES), "
        + "'world.ENTITY_TYPES': sorted(world.ENTITY_TYPES), "
        + "'world.SOURCE_TYPES': sorted(world.SOURCE_TYPES), "
        + "'maintenance.CONDITION_TYPES': sorted(maintenance.CONDITION_TYPES), "
        + "'maintenance.LIFECYCLE': list(maintenance.LIFECYCLE), "
        + "'quality.FINDING_TYPES': sorted(quality.FINDING_TYPES), "
        + "'quality.LIFECYCLE': list(quality.LIFECYCLE), "
        + "'quality.DISPOSITIONS': sorted(quality.DISPOSITIONS), "
        + "'workorder.WORK_ORDER_TYPES': sorted(workorder.WORK_ORDER_TYPES), "
        + "'workorder.ORIGIN_KINDS': sorted(workorder.ORIGIN_KINDS), "
        + "'workorder.LIFECYCLE': list(workorder.LIFECYCLE), "
        + "'intelligence.LEVELS': list(inference_result.LEVELS), "
        + "'intelligence.OOD_REASONS': sorted(inference_result.OOD_REASONS), "
        + "'intelligence.DATA_QUALITIES': sorted(inference_result.DATA_QUALITIES), "
        + "'reasoning.LEVELS': list(reasoning_result.LEVELS), "
        + "'reasoning.KINDS': sorted(reasoning_result.KINDS), "
        + "'reasoning_trace.RULE_IDS': list(reasoning_trace.RULE_IDS), "
        + "'reasoning_trace.SEVERITIES': list(reasoning_trace.SEVERITIES), "
        + "'reasoning_trace.CONFIDENCE_BASES': sorted(reasoning_trace.CONFIDENCE_BASES), "
        + "'reasoning_trace.FACT_KINDS': list(reasoning_trace.FACT_KINDS), "
        + "'learning.METRIC_KEYS': list(learning_evaluation.METRIC_KEYS), "
        + "'learning.EVALUATION_TYPES': list(learning_evaluation.EVALUATION_TYPES), "
        + "'metrics.METRIC_NAMES': list(metrics_registry.METRIC_NAMES), "
        + "'metrics.METRIC_TYPES': list(metrics_registry.METRIC_TYPES), "
        + "'metrics.METRIC_LABEL_KEYS': list(metrics_registry.METRIC_LABEL_KEYS), "
        + "'dead_letter.REASONS': list(dead_letter.REASONS), "
        + "'dead_letter.STATUSES': list(dead_letter.STATUSES), "
        + "'simulation.KINDS': list(simulation_run.KINDS), "
        + "'simulation.STATUSES': list(simulation_run.STATUSES), "
        + "'learning_proposal.KINDS': list(learning_proposal.KINDS), "
        + "'learning_proposal.STATUSES': list(learning_proposal.STATUSES), "
        + "'exo_session.STATUSES': list(exo_session.STATUSES), "
        + "'outcome_annotation.TARGET_TYPES': list(outcome_annotation.TARGET_TYPES), "
        + "'outcome_annotation.OUTCOME_KINDS': list(outcome_annotation.OUTCOME_KINDS), "
        + "'learning_proposal.THRESHOLD_RULES': [[r, p] for r, p in learning_proposal.THRESHOLD_RULES], "
        + "'metrics.REGISTRY_DEEP': json.dumps(sorted([{'name': n, 'type': t, 'labelKeys': list(l)} for n, t, l in metrics_registry.METRIC_REGISTRY], key=lambda e: e['name'])), "
        + "'entity.ENTITY_KINDS': list(entity_model.ENTITY_KINDS), "
        + "'entity.SOURCES': sorted(entity_model.SOURCES), "
        + "'entity.WORLD_STATE_PROJECTABLE_KINDS': sorted(entity_model.WORLD_STATE_PROJECTABLE_KINDS), "
        + "'entity.PERSON_BUCKET_KINDS': list(entity_model.PERSON_BUCKET_KINDS), "
        + "'entity.DEVICE_BUCKET_KINDS': list(entity_model.DEVICE_BUCKET_KINDS), "
        + "'entity.STATION_BUCKET_KINDS': list(entity_model.STATION_BUCKET_KINDS), "
        + "'entity.TASK_BUCKET_KINDS': list(entity_model.TASK_BUCKET_KINDS), "
        + "'agent.AGENT_ROLES': list(agent.AGENT_ROLES), "
        + "'agent.SCOPE_TOKENS': sorted(agent.SCOPE_TOKENS), "
        + "'agent.COMMANDS': sorted(agent.COMMANDS), "
        + "'agent.RISK_LEVELS': list(agent.RISK_LEVELS), "
        + "'agent.AUTONOMOUS_LEVELS': list(agent.AUTONOMOUS_LEVELS), "
        + "'agent.FALLBACK_STRATEGIES': sorted(agent.FALLBACK_STRATEGIES), "
        + "'agent_task.TASK_KINDS': list(agent_task.TASK_KINDS), "
        + "'agent_task.PRIORITIES': list(agent_task.PRIORITIES), "
        + "'agent_task.STATUSES': list(agent_task.STATUSES), "
        + "'knowledge.KNOWLEDGE_KINDS': list(knowledge.KNOWLEDGE_KINDS), "
        + "'knowledge.KNOWLEDGE_SCOPES': list(knowledge.KNOWLEDGE_SCOPES), "
        + "'knowledge.KNOWLEDGE_STATUSES': list(knowledge.KNOWLEDGE_STATUSES), "
        + "'capability.KINDS': list(capability.CAPABILITY_KINDS), "
        + "'capability.PROVIDER_TYPES': list(capability.PROVIDER_TYPES), "
        + "'capability.KNOWN_VALUES': list(capability.KNOWN_VALUES), "
        + "'decision.KINDS': list(decision.DECISION_KINDS), "
        + "'decision.STATUSES': list(decision.DECISION_STATUSES), "
        + "'decision.AUTHORITIES': list(decision.DECISION_AUTHORITIES), "
        + "'decision.RISK_LEVELS': list(decision.RISK_LEVELS), "
        + "'exo_config.KINDS': list(exo_config.EXO_CONFIG_KINDS), "
        + "'exo_config.SUPPORT_MODES': list(exo_config.SUPPORT_MODES), "
        + "'exo_config.CALIBRATION_KINDS': list(exo_config.CALIBRATION_KINDS), "
        + "'exo_config.PROFILE_STATUSES': list(exo_config.PROFILE_STATUSES), "
        + "'exo_config.FIT_STATUSES': list(exo_config.FIT_STATUSES), "
        + "'exo_config.CALIBRATION_STATUSES': list(exo_config.CALIBRATION_STATUSES)}))",
    ],
    { cwd: REPO_ROOT, encoding: 'utf-8', env: { ...process.env, PYTHONPATH: path.join(REPO_ROOT, 'src') } },
  ).trim();
  const parsed = JSON.parse(pyOut);
  for (const [expr, expected, ordered] of pyChecks) {
    const actual = parsed[expr];
    const expectedSorted = [...expected].sort();
    const actualSorted = Array.isArray(actual) ? [...actual].sort() : actual;
    const ok =
      Array.isArray(actual) &&
      (ordered
        ? JSON.stringify(actual) === JSON.stringify(expected)
        : JSON.stringify(actualSorted) === JSON.stringify(expectedSorted));
    check(`python_${expr}`, ok, `python=${Array.isArray(actual) ? actual.length : 'missing'} schema=${expected.length}`);
  }
  // metrics registry 深比较（schema vs Python）
  {
    const schemaSorted = [...metricsSchema.metricRegistry].sort((a, b) => (a.name < b.name ? -1 : 1));
    let registryOk = false;
    try {
      registryOk = JSON.stringify(schemaSorted) === JSON.stringify(JSON.parse(parsed['metrics.REGISTRY_DEEP']));
    } catch {
      registryOk = false;
    }
    check('metrics.REGISTRY_DEEP', registryOk, 'schema vs python registry mismatch');
  }
  // learning proposal THRESHOLD_RULES 深比较（schema vs Python）
  {
    let rulesOk = false;
    try {
      const schemaPairs = proposalSchema.thresholdRules.map((t) => [t.ruleId, t.parameter]);
      rulesOk = JSON.stringify(schemaPairs) === JSON.stringify(parsed['learning_proposal.THRESHOLD_RULES']);
    } catch {
      rulesOk = false;
    }
    check('learning_proposal.THRESHOLD_RULES', rulesOk, 'schema vs python threshold rules mismatch');
  }
} catch (err) {
  check('python_domain_registries_exec', false, `${String(err.message || err)} | STDERR: ${String(err.stderr || '')}`);
}

function extractTsArray(tsPath, exportName) {
  const source = fs.readFileSync(tsPath, 'utf-8');
  const m = source.match(new RegExp(`export const ${exportName} = \\[([\\s\\S]*?)\\](?: as const)?;`));
  if (!m) return null;
  // 值字符集含 : 与 -（如 rule:worker-overload）；既有注册表无此类字符，行为不变。
  return [...m[1].matchAll(/'([A-Za-z0-9:_-]+)'/g)].map((x) => x[1]);
}
const tsChecks = [
  ['risk.ts', 'RISK_SEVERITY_LADDER', riskSchema.severityLadder, true],
  ['risk.ts', 'RISK_LIFECYCLE', riskSchema.lifecycle, true],
  ['risk.ts', 'RISK_CATEGORIES', riskSchema.categoryRegistry, false],
  ['location.ts', 'SPATIAL_KINDS', locSchema.spatialKindRegistry, false],
  ['location.ts', 'COORDINATE_TYPES', locSchema.coordinateTypes, false],
  ['resource.ts', 'RESOURCE_STATUSES', resSchema.statusRegistry, false],
  ['resource.ts', 'RESOURCE_DATA_QUALITIES', resSchema.dataQualityRegistry, false],
  ['resource.ts', 'RESOURCE_SOURCES', resSchema.sourceRegistry, false],
  ['resource.ts', 'RESOURCE_TYPES', resSchema.resourceTypeRegistry, false],
  ['world-contract.ts', 'WORLD_ENTITY_TYPES', worldSchema.entityTypeRegistry, false],
  ['world-contract.ts', 'WORLD_SOURCE_TYPES', worldSchema.sourceTypeRegistry, false],
  ['maintenance.ts', 'MAINTENANCE_CONDITION_TYPES', maintSchema.conditionTypeRegistry, false],
  ['maintenance.ts', 'MAINTENANCE_LIFECYCLE', maintSchema.lifecycle, true],
  ['quality.ts', 'QUALITY_FINDING_TYPES', qualitySchema.findingTypeRegistry, false],
  ['quality.ts', 'QUALITY_LIFECYCLE', qualitySchema.lifecycle, true],
  ['quality.ts', 'QUALITY_DISPOSITIONS', qualitySchema.dispositionRegistry, false],
  ['workorder.ts', 'WORK_ORDER_TYPES', woSchema.workOrderTypeRegistry, false],
  ['workorder.ts', 'WORK_ORDER_ORIGIN_KINDS', woSchema.originKindRegistry, false],
  ['workorder.ts', 'WORK_ORDER_LIFECYCLE', woSchema.lifecycle, true],
  ['inference-result.ts', 'INFERENCE_LEVELS', intelSchema.levelRegistry, true],
  ['inference-result.ts', 'OOD_REASONS', intelSchema.oodReasonRegistry, false],
  ['inference-result.ts', 'INFERENCE_DATA_QUALITIES', intelSchema.dataQualityRegistry, false],
  ['reasoning-result.ts', 'REASONING_LEVELS', reasoningSchema.levelRegistry, true],
  ['reasoning-result.ts', 'REASONING_KINDS', reasoningSchema.kindRegistry, false],
  ['reasoning-trace.ts', 'REASONING_RULE_IDS', traceSchema.ruleRegistry, true],
  ['reasoning-trace.ts', 'TRACE_SEVERITIES', traceSchema.severityRegistry, true],
  ['reasoning-trace.ts', 'TRACE_CONFIDENCE_BASES', traceSchema.confidenceBasisRegistry, true],
  ['reasoning-trace.ts', 'TRACE_FACT_KINDS', traceSchema.factKindRegistry, true],
  ['learning-evaluation.ts', 'LEARNING_METRIC_KEYS', learningSchema.metricRegistry, true],
  ['learning-evaluation.ts', 'LEARNING_EVALUATION_TYPES', learningSchema.evaluationTypeRegistry, true],
  ['metrics-registry.ts', 'METRIC_TYPES', metricsSchema.metricTypeRegistry, true],
  ['metrics-registry.ts', 'METRIC_LABEL_KEYS', metricsSchema.labelKeyRegistry, true],
  ['dead-letter.ts', 'DEAD_LETTER_REASONS', deadLetterSchema.reasonRegistry, true],
  ['dead-letter.ts', 'DEAD_LETTER_STATUSES', deadLetterSchema.statusRegistry, true],
  ['simulation-run.ts', 'SIMULATION_KINDS', simSchema.kindRegistry, true],
  ['simulation-run.ts', 'SIMULATION_STATUSES', simSchema.statusRegistry, true],
  ['learning-proposal.ts', 'LEARNING_PROPOSAL_KINDS', proposalSchema.kindRegistry, true],
  ['learning-proposal.ts', 'LEARNING_PROPOSAL_STATUSES', proposalSchema.statusRegistry, true],
  ['exo-session.ts', 'EXO_SESSION_STATUSES', exoSessionSchema.statusRegistry, true],
  ['outcome-annotation.ts', 'OUTCOME_TARGET_TYPES', outcomeSchema.targetTypeRegistry, true],
  ['outcome-annotation.ts', 'OUTCOME_KINDS', outcomeSchema.outcomeKindRegistry, true],
  ['entity-model.ts', 'ENTITY_KINDS', entitySchema.entityKindRegistry, true],
  ['entity-model.ts', 'ENTITY_SOURCES', entitySchema.sourceRegistry, false],
  ['entity-model.ts', 'WORLD_STATE_PROJECTABLE_KINDS', entitySchema.projectionDivision.stateProjectableKinds, false],
  ['entity-model.ts', 'PERSON_BUCKET_KINDS', entitySchema.projectionBuckets.personBucket, true],
  ['entity-model.ts', 'DEVICE_BUCKET_KINDS', entitySchema.projectionBuckets.deviceBucket, true],
  ['entity-model.ts', 'STATION_BUCKET_KINDS', entitySchema.projectionBuckets.stationBucket, true],
  ['entity-model.ts', 'TASK_BUCKET_KINDS', entitySchema.projectionBuckets.taskBucket, true],
  ['agent-manifest.ts', 'AGENT_ROLES', agentSchema.agentRoleRegistry, true],
  ['agent-manifest.ts', 'SCOPE_TOKENS', agentSchema.scopeTokenRegistry, false],
  ['agent-manifest.ts', 'AGENT_COMMANDS', agentSchema.commandRegistry, false],
  ['agent-manifest.ts', 'AGENT_RISK_LEVELS', agentSchema.riskLevels, true],
  ['agent-manifest.ts', 'AUTONOMOUS_LEVELS', agentSchema.autonomousLevels, true],
  ['agent-manifest.ts', 'FALLBACK_STRATEGIES', agentSchema.fallbackStrategies, false],
  ['agent-task.ts', 'TASK_KINDS', agentTaskSchema.taskKindRegistry, true],
  ['agent-task.ts', 'TASK_PRIORITIES', agentTaskSchema.priorityRegistry, true],
  ['agent-task.ts', 'TASK_STATUSES', agentTaskSchema.statusRegistry, true],
  ['knowledge-entry.ts', 'KNOWLEDGE_KINDS', knowledgeSchema.knowledgeKindRegistry, true],
  ['knowledge-entry.ts', 'KNOWLEDGE_SCOPES', knowledgeSchema.knowledgeScopeRegistry, true],
  ['knowledge-entry.ts', 'KNOWLEDGE_STATUSES', knowledgeSchema.knowledgeStatusRegistry, true],
  ['decision.ts', 'DECISION_KINDS', decSchema.decisionKinds, true],
  ['decision.ts', 'DECISION_STATUSES', decSchema.decisionStatuses, true],
  ['decision.ts', 'DECISION_AUTHORITIES', decSchema.decisionAuthorities, true],
  ['exo-config.ts', 'EXO_CONFIG_KINDS', excSchema.exoConfigKinds, true],
  ['exo-config.ts', 'SUPPORT_MODES', excSchema.supportModes, true],
  ['exo-config.ts', 'CALIBRATION_KINDS', excSchema.calibrationKinds, true],
  ['exo-config.ts', 'PROFILE_STATUSES', excSchema.profileStatuses, true],
  ['exo-config.ts', 'FIT_STATUSES', excSchema.fitStatuses, true],
  ['exo-config.ts', 'CALIBRATION_STATUSES', excSchema.calibrationStatuses, true],
];
// metrics-registry.ts METRIC_NAMES 为 METRIC_REGISTRY.map 派生（非字面量数组）——
// 用正则从注册表字面量提取 name 序列核对（注册表深语义由向量三向仲裁覆盖）。
{
  const tsSrc = fs.readFileSync(path.join(REPO_ROOT, 'ewoh-spark-app', 'shared', 'metrics-registry.ts'), 'utf-8');
  const block = tsSrc.match(/export const METRIC_REGISTRY[\s\S]*?\] as const;/)?.[0] ?? '';
  const tsNames = [...block.matchAll(/name: '([a-z0-9_]+)'/g)].map((m) => m[1]);
  const expectedNames = metricsSchema.metricRegistry.map((e) => e.name);
  check(
    'ts_metrics-registry.ts:METRIC_NAMES',
    JSON.stringify(tsNames) === JSON.stringify(expectedNames),
    `ts=${tsNames.length} schema=${expectedNames.length}`,
  );
}

// learning-proposal.ts THRESHOLD_RULES 为元组字面量（非字符串数组）——
// 正则提取扁平字符串序列与 schema 对扁平化核对。
{
  const tsSrc = fs.readFileSync(path.join(REPO_ROOT, 'ewoh-spark-app', 'shared', 'learning-proposal.ts'), 'utf-8');
  const block = tsSrc.match(/export const THRESHOLD_RULES[\s\S]*?= \[([\s\S]*?)\];/)?.[1] ?? '';
  const flat = [...block.matchAll(/'([A-Za-z0-9:_-]+)'/g)].map((m) => m[1]);
  const expectedFlat = proposalSchema.thresholdRules.flatMap((t) => [t.ruleId, t.parameter]);
  check(
    'ts_learning-proposal.ts:THRESHOLD_RULES',
    JSON.stringify(flat) === JSON.stringify(expectedFlat),
    `ts=${flat.length} schema=${expectedFlat.length}`,
  );
}

// decision.ts DECISION_RISK_LEVELS 必须 import 自 risk 契约（§31 单一事实源，
// 禁止在决策契约重复字面量定义）——源码形状门禁。
{
  const decSrc = fs.readFileSync(path.join(REPO_ROOT, 'ewoh-spark-app', 'shared', 'decision.ts'), 'utf-8');
  const importsRiskLadder = /import\s*\{[^}]*RISK_SEVERITY_LADDER[^}]*\}\s*from\s*'\.\/risk';/.test(decSrc);
  const assignsFromRisk = /DECISION_RISK_LEVELS[^=]*=\s*RISK_SEVERITY_LADDER\s*;/.test(decSrc);
  const noLiteralLadder = !/DECISION_RISK_LEVELS[^=]*=\s*\[/.test(decSrc);
  check(
    'ts_decision.ts:DECISION_RISK_LEVELS_SINGLE_SOURCE',
    importsRiskLadder && assignsFromRisk && noLiteralLadder,
    'DECISION_RISK_LEVELS 未从 risk 契约 import（§31 重复事实源）',
  );
}

for (const [file, exportName, expected, ordered] of tsChecks) {
  const actual = extractTsArray(path.join(REPO_ROOT, 'ewoh-spark-app', 'shared', file), exportName);
  const ok =
    actual != null &&
    (ordered
      ? JSON.stringify(actual) === JSON.stringify(expected)
      : JSON.stringify(actual.sort()) === JSON.stringify([...expected].sort()));
  check(`ts_${file}:${exportName}`, ok, `ts=${actual ? actual.length : 'missing'} schema=${expected.length}`);
}

// ── 输出 ───────────────────────────────────────────────────────────────────
for (const line of checks) console.log(line);
const summary = `${checks.length - failures.length}/${checks.length} passed, ${failures.length} failed`;
console.log(`summary: ${summary}`);
if (failures.length > 0) {
  console.error(`DOMAIN CONTRACT AUDIT FAIL: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('DOMAIN CONTRACT AUDIT PASS');
