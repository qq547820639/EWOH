#!/usr/bin/env node
/**
 * Canonical Event Envelope 契约门禁（ADR-009 / NO-04）。
 *
 * 职责（fail-closed，任一违反 → 非零退出）：
 *  1. contracts/events/envelope.schema.json 形状合法（$id/schemaVersion/必填字段/规则/容忍常量）；
 *  2. contracts/events/envelope-test-vectors.json 与契约一致（门禁在 JS 内独立重实现
 *     envelope 校验与时间语义作第三方仲裁：时间三态/漂移标记/迟到标记/规范引用）；
 *  3. eventType 交叉校验：向量中每个 eventType 必须命中
 *     contracts/events/event-catalog.yaml 的 x-event-types（目录 = 类型唯一事实源）；
 *  4. Python（src/edge_platform/contracts/envelope.py）与 TypeScript
 *     （ewoh-spark-app/shared/event-envelope.ts）的容忍常量与契约一致（源码扫描）。
 *
 * 已接入：make truth-check + .github/workflows/test.yml（Event Envelope 契约门禁）。
 * 用法：node scripts/audit-event-envelope.js [--strict]
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const REPO_ROOT = path.resolve(__dirname, '..');
const requireFromApp = createRequire(path.join(REPO_ROOT, 'ewoh-spark-app', 'package.json'));

const failures = [];
const checks = [];
function check(name, ok, detail = '') {
  checks.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures.push(name);
}
function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

const SCHEMA_PATH = path.join(REPO_ROOT, 'contracts', 'events', 'envelope.schema.json');
const VECTORS_PATH = path.join(REPO_ROOT, 'contracts', 'events', 'envelope-test-vectors.json');
const CATALOG_PATH = path.join(REPO_ROOT, 'contracts', 'events', 'event-catalog.yaml');

// ── 1. schema 形状 ──────────────────────────────────────────────────────────
const schema = loadJson(SCHEMA_PATH);
check('envelope_schema_parses', typeof schema === 'object' && schema !== null);
check('envelope_schema_id', schema.$id === 'ewoh:///events/envelope/v1', schema.$id);
check('envelope_schema_version', schema.schemaVersion === '1.0.0', schema.schemaVersion);
check(
  'envelope_schema_required_fields',
  JSON.stringify(schema.requiredFields) === JSON.stringify(['eventId', 'eventType', 'schemaVersion', 'occurredAt', 'source']),
);
check('envelope_schema_drift_tolerance', schema.clockDriftToleranceMs === 300000, String(schema.clockDriftToleranceMs));
check('envelope_schema_late_threshold', schema.lateThresholdMs === 600000, String(schema.lateThresholdMs));
check(
  'envelope_schema_rules_present',
  ['timeOrdering', 'lateEvent', 'idempotency', 'canonicalRefs', 'catalogReference'].every((k) => typeof schema.rules[k] === 'string'),
);

// ── 2. 事件目录交叉校验（类型唯一事实源） ──────────────────────────────────
let catalogTypes = null;
try {
  const yaml = requireFromApp('js-yaml');
  const catalog = yaml.load(fs.readFileSync(CATALOG_PATH, 'utf-8'));
  catalogTypes = new Set(catalog['x-event-types'] || []);
  check('catalog_x_event_types_loaded', catalogTypes.size > 0, `count=${catalogTypes.size}`);
} catch (err) {
  check('catalog_load', false, String(err.message || err));
}

// ── 3. vectors 独立仲裁 ─────────────────────────────────────────────────────
const vectors = loadJson(VECTORS_PATH);
check('vectors_schema_version', vectors.schemaVersion === '1.0.0', vectors.schemaVersion);

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

const DRIFT = schema.clockDriftToleranceMs;
const LATE = schema.lateThresholdMs;

function arbValidate(envelope) {
  if (envelope == null || typeof envelope !== 'object') return ['record_must_be_object'];
  if (typeof envelope.eventType !== 'string' || envelope.eventType === '') return ['missing_event_type'];
  for (const f of ['eventId', 'eventType', 'schemaVersion', 'occurredAt', 'source']) {
    if (!(f in envelope)) return [`missing_field:${f}`];
  }
  if (typeof envelope.eventId !== 'string' || envelope.eventId === '') return ['bad_event_id'];
  if (catalogTypes != null && !catalogTypes.has(envelope.eventType)) return ['unknown_event_type'];
  if (typeof envelope.schemaVersion !== 'string' || envelope.schemaVersion === '') return ['bad_schema_version'];
  if (arbParseTs(envelope.occurredAt) == null) return ['bad_occurred_at'];
  if (typeof envelope.source !== 'string' || envelope.source === '') return ['bad_source'];
  if (envelope.observedAt != null && arbParseTs(envelope.observedAt) == null) return ['bad_observed_at'];
  if (envelope.receivedAt != null && arbParseTs(envelope.receivedAt) == null) return ['bad_received_at'];
  for (const refKey of ['actor', 'subject']) {
    const ref = envelope[refKey];
    if (ref != null && (typeof ref !== 'string' || !canonRe.test(ref))) return [`bad_${refKey}`];
  }
  if (envelope.confidence != null) {
    const c = envelope.confidence;
    if (typeof c !== 'number' || c < 0 || c > 1) return ['bad_confidence'];
  }
  return [];
}

function arbSemantics(envelope) {
  const occurred = arbParseTs(envelope.occurredAt);
  const observed = envelope.observedAt != null ? arbParseTs(envelope.observedAt) : null;
  const received = envelope.receivedAt != null ? arbParseTs(envelope.receivedAt) : null;
  let clockDrift = false;
  if (observed != null && occurred - observed > DRIFT) clockDrift = true;
  if (received != null && occurred - received > DRIFT) clockDrift = true;
  if (observed != null && received != null && observed - received > DRIFT) clockDrift = true;
  const isLate = received != null && received - occurred > LATE;
  return { clockDrift, isLate };
}

for (const c of vectors.envelopes) {
  const errors = arbValidate(c.envelope);
  if (c.expectError != null) {
    check(`envelope:${c.name}`, errors[0] === c.expectError, `expected ${c.expectError}, got ${errors[0]}`);
  } else {
    check(`envelope:${c.name}`, errors.length === 0, errors.join(','));
    if (c.expect != null) {
      const sem = arbSemantics(c.envelope);
      check(
        `envelope_semantics:${c.name}`,
        sem.clockDrift === c.expect.clockDrift && sem.isLate === c.expect.isLate,
        `expected ${JSON.stringify(c.expect)}, got ${JSON.stringify(sem)}`,
      );
    }
  }
}

// ── 4. 双运行时容忍常量与契约一致（源码扫描） ─────────────────────────────
const pySource = fs.readFileSync(path.join(REPO_ROOT, 'src', 'edge_platform', 'contracts', 'envelope.py'), 'utf-8');
check(
  'python_drift_constant',
  /CLOCK_DRIFT_TOLERANCE_MS\s*=\s*300_?000/.test(pySource),
);
check('python_late_constant', /LATE_THRESHOLD_MS\s*=\s*600_?000/.test(pySource));

const tsSource = fs.readFileSync(path.join(REPO_ROOT, 'ewoh-spark-app', 'shared', 'event-envelope.ts'), 'utf-8');
check('ts_drift_constant', /ENVELOPE_CLOCK_DRIFT_TOLERANCE_MS = 300_?000/.test(tsSource));
check('ts_late_constant', /ENVELOPE_LATE_THRESHOLD_MS = 600_?000/.test(tsSource));

// ── 输出 ───────────────────────────────────────────────────────────────────
for (const line of checks) console.log(line);
const summary = `${checks.length - failures.length}/${checks.length} passed, ${failures.length} failed`;
console.log(`summary: ${summary}`);
if (failures.length > 0) {
  console.error(`EVENT ENVELOPE AUDIT FAIL: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('EVENT ENVELOPE AUDIT PASS');
