#!/usr/bin/env node
/**
 * Canonical Identity 契约门禁（ADR-006 / Phase 2 NO-02）。
 *
 * 职责（全部 fail-closed，任一违反 → 非零退出）：
 *  1. contracts/identity/identity.schema.json 形状合法（schemaVersion/$id/注册表/语法/规则）；
 *  2. contracts/identity/identity-mapping.schema.json 形状合法（$id/必填字段/枚举）；
 *  3. contracts/identity/test-vectors.json 与契约语法一致（valid 必须语法合法、
 *     invalid 必须语法非法、mapping 场景的声明结果必须与契约解析规则一致——
 *     门禁在 JS 内独立重实现解析规则，作为第三方仲裁，防止实现与向量互相腐化）；
 *  4. Python 锁定注册表（src/edge_platform/contracts/identity.py KINDS）与 schema 逐项一致；
 *  5. TypeScript 锁定注册表（ewoh-spark-app/shared/identity.ts IDENTITY_KINDS）与 schema 逐项一致。
 *
 * 已接入：make truth-check + .github/workflows/test.yml（Identity 契约一致性门禁）。
 * 用法：node scripts/audit-identity-contracts.js [--strict]
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCHEMA_PATH = path.join(REPO_ROOT, 'contracts', 'identity', 'identity.schema.json');
const MAPPING_SCHEMA_PATH = path.join(REPO_ROOT, 'contracts', 'identity', 'identity-mapping.schema.json');
const VECTORS_PATH = path.join(REPO_ROOT, 'contracts', 'identity', 'test-vectors.json');
const PY_IDENTITY_PATH = path.join(REPO_ROOT, 'src', 'edge_platform', 'contracts', 'identity.py');
const TS_IDENTITY_PATH = path.join(REPO_ROOT, 'ewoh-spark-app', 'shared', 'identity.ts');

const failures = [];
const checks = [];
function check(name, ok, detail = '') {
  checks.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

function loadJson(file) {
  const raw = fs.readFileSync(file, 'utf-8');
  return JSON.parse(raw);
}

// ── 1. identity.schema.json ────────────────────────────────────────────────
const schema = loadJson(SCHEMA_PATH);
check('identity_schema_parses', typeof schema === 'object' && schema !== null);
check('identity_schema_id', schema.$id === 'ewoh:///identity/identity/v1', schema.$id);
check('identity_schema_version', schema.schemaVersion === '1.0.0', schema.schemaVersion);
const registry = Array.isArray(schema.kindRegistry) ? schema.kindRegistry : [];
check(
  'identity_schema_registry_closed_unique',
  registry.length > 0 && new Set(registry).size === registry.length,
  `count=${registry.length}`,
);
check(
  'identity_schema_kind_pattern',
  schema.kindPattern === '^[a-z][a-z0-9_]{0,31}$',
  schema.kindPattern,
);
check(
  'identity_schema_value_pattern',
  schema.valuePattern === '^[A-Za-z0-9][A-Za-z0-9._~@-]{0,127}$',
  schema.valuePattern,
);
check('identity_schema_max_value_length', schema.maxValueLength === 128, String(schema.maxValueLength));
const rules = (schema.rules || {});
check(
  'identity_schema_rules_present',
  ['canonicalForm', 'equality', 'closedRegistry', 'internalValueOwnership', 'thirdPartyIdSeparation', 'mappingResolution'].every((k) => typeof rules[k] === 'string'),
);
const kindRe = new RegExp(`^${schema.kindPattern}$`);
for (const kind of registry) {
  if (!kindRe.test(kind)) {
    check(`registry_kind_grammar:${kind}`, false);
    break;
  }
}

// ── 2. identity-mapping.schema.json ────────────────────────────────────────
const mappingSchema = loadJson(MAPPING_SCHEMA_PATH);
check('mapping_schema_id', mappingSchema.$id === 'ewoh:///identity/identity-mapping/v1', mappingSchema.$id);
const requiredFields = (mappingSchema.required || []);
check(
  'mapping_schema_required_fields',
  ['mappingId', 'version', 'source', 'target', 'authority', 'status', 'recordedAt'].every((f) => requiredFields.includes(f)),
);
check(
  'mapping_schema_status_enum',
  JSON.stringify(mappingSchema.properties.status.enum) === JSON.stringify(['active', 'superseded', 'revoked']),
);
check(
  'mapping_schema_authority_enum',
  JSON.stringify(mappingSchema.properties.authority.enum) === JSON.stringify(['registration', 'adapter', 'manual']),
);

// ── 3. test-vectors.json（独立仲裁：用契约语法重算每个向量的期望） ─────────
const vectors = loadJson(VECTORS_PATH);
check('vectors_schema_version', vectors.schemaVersion === '1.0.0', vectors.schemaVersion);

const kinds = registry.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
const valueBody = schema.valuePattern.replace(/^\^/, '').replace(/\$$/, '');
const canonicalRe = new RegExp(`^(${kinds}):(${valueBody})$`);

let vectorsOk = true;
for (const value of vectors.valid) {
  if (!canonicalRe.test(value)) {
    check(`vector_valid_grammar:${value}`, false);
    vectorsOk = false;
  }
}
for (const entry of vectors.invalid) {
  if (canonicalRe.test(entry.value)) {
    check(`vector_invalid_grammar:${entry.value}`, false, entry.reason);
    vectorsOk = false;
  }
}
check('vectors_valid_invalid_grammar_consistent', vectorsOk);

function parseIso(value) {
  if (value == null || String(value).trim() === '') return null;
  let text = String(value).trim();
  if (text.endsWith('Z')) text = `${text.slice(0, -1)}+00:00`;
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d;
}

// 独立重实现解析规则（第三方仲裁，只依赖契约文本，不依赖任何运行时实现）
function arbiterResolve(system, sourceId, mappings, now) {
  const nowMs = parseIso(now)?.getTime() ?? null;
  const hits = [];
  for (const record of mappings) {
    if (record == null || typeof record !== 'object') continue;
    if (record.status !== 'active') continue;
    const src = record.source;
    if (src == null || src.system !== system || src.id !== sourceId) continue;
    if (nowMs != null) {
      const from = parseIso(record.validFrom)?.getTime() ?? null;
      const to = parseIso(record.validTo)?.getTime() ?? null;
      if (from != null && nowMs < from) continue;
      if (to != null && nowMs >= to) continue;
    }
    if (record.target && typeof record.target.entityId === 'string') hits.push(record.target.entityId);
  }
  const unique = [...new Set(hits)];
  if (unique.length > 1) return { error: 'ambiguous_identity', count: unique.length };
  return { result: unique.length === 1 ? unique[0] : null };
}

for (const scenario of vectors.mappingScenarios) {
  const { error, result } = arbiterResolve(scenario.system, scenario.sourceId, scenario.mappings, scenario.now);
  if (scenario.expectError != null) {
    check(`vector_scenario:${scenario.name}`, error === scenario.expectError, `expected error ${scenario.expectError}, got ${error ?? 'none'}`);
  } else {
    check(`vector_scenario:${scenario.name}`, error == null && result === scenario.expect, `expected ${scenario.expect}, got ${error != null ? `error:${error}` : result}`);
  }
}

// ── 4. Python 锁定注册表 ───────────────────────────────────────────────────
try {
  const pyOut = execFileSync(
    'python3',
    [
      '-c',
      "import sys; sys.path.insert(0, 'src'); from edge_platform.contracts.identity import KINDS; print(','.join(sorted(KINDS)))",
    ],
    { cwd: REPO_ROOT, encoding: 'utf-8', env: { ...process.env, PYTHONPATH: path.join(REPO_ROOT, 'src') } },
  ).trim();
  const pyKinds = pyOut.split(',').filter(Boolean);
  check(
    'python_registry_matches_schema',
    JSON.stringify(pyKinds.sort()) === JSON.stringify([...registry].sort()),
    `python=${pyKinds.length} schema=${registry.length}`,
  );
} catch (err) {
  check('python_registry_exec', false, String(err.message || err));
}

// ── 5. TypeScript 锁定注册表 ───────────────────────────────────────────────
const tsSource = fs.readFileSync(TS_IDENTITY_PATH, 'utf-8');
const tsMatch = tsSource.match(/export const IDENTITY_KINDS = \[([\s\S]*?)\]/);
const tsKinds = tsMatch ? [...tsMatch[1].matchAll(/'([a-z][a-z0-9_]*)'/g)].map((m) => m[1]) : [];
check(
  'typescript_registry_matches_schema',
  tsMatch != null && JSON.stringify(tsKinds.sort()) === JSON.stringify([...registry].sort()),
  `ts=${tsKinds.length} schema=${registry.length}`,
);

// ── 输出 ───────────────────────────────────────────────────────────────────
for (const line of checks) console.log(line);
const summary = `${checks.length - failures.length}/${checks.length} passed, ${failures.length} failed`;
console.log(`summary: ${summary}`);
if (failures.length > 0) {
  console.error(`IDENTITY CONTRACT AUDIT FAIL: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('IDENTITY CONTRACT AUDIT PASS');
