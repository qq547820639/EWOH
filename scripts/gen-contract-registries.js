#!/usr/bin/env node
'use strict';

/**
 * gen-contract-registries — Entity Contract 注册表生成器（ADR-015 / NO-03b 收尾）。
 *
 * 单一事实源：contracts/entity/entity-model.schema.json（entityKindRegistry /
 * sourceRegistry / projectionDivision.stateProjectableKinds / projectionBuckets）。
 * 本脚本把锁定注册表生成进双运行时的代码块（生成区），消除"手写两份+门禁兜底"
 * 中的手写环节——Python/TS 常量由 schema 直接生成，audit-domain-contracts.js
 * 保留为独立仲裁双保险（生成器与仲裁器互相独立实现）。
 *
 * 目标文件与标记：
 *   src/edge_platform/contracts/entity_model.py
 *       # ---GEN-BEGIN:entity-registries--- ... # ---GEN-END:entity-registries---
 *   ewoh-spark-app/shared/entity-model.ts
 *       /* ---GEN-BEGIN:entity-registries--- * / ... /* ---GEN-END:entity-registries--- * /
 *
 * 用法：
 *   node scripts/gen-contract-registries.js --check   # 默认：漂移即退出非零（dry-run）
 *   node scripts/gen-contract-registries.js --write   # 显式重写生成区
 *
 * 已挂 make truth-check（--check），CI 随 truth-check 自动执行。
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCHEMA_PATH = path.join(REPO_ROOT, 'contracts', 'entity', 'entity-model.schema.json');
const PY_PATH = path.join(REPO_ROOT, 'src', 'edge_platform', 'contracts', 'entity_model.py');
const TS_PATH = path.join(REPO_ROOT, 'ewoh-spark-app', 'shared', 'entity-model.ts');

const PY_BEGIN = '# ---GEN-BEGIN:entity-registries---';
const PY_END = '# ---GEN-END:entity-registries---';
const TS_BEGIN = '/* ---GEN-BEGIN:entity-registries--- */';
const TS_END = '/* ---GEN-END:entity-registries--- */';

function fail(message) {
  console.error(`GEN-CONTRACT-REGISTRIES FAIL: ${message}`);
  process.exit(1);
}

function wrapPyTuple(name, values, indent = '    ') {
  const items = values.map((v) => JSON.stringify(v));
  const lines = [];
  let line = `${name}: tuple[str, ...] = (`;
  for (const item of items) {
    const probe = line === `${name}: tuple[str, ...] = (` ? `${line}${item},` : `${line} ${item},`;
    if (probe.length <= 76) {
      line = probe;
    } else {
      lines.push(line);
      line = `${indent}${item},`;
    }
  }
  lines.push(line);
  lines[lines.length - 1] += ')';
  return lines.join('\n');
}

function wrapTsArray(name, values, indent = '  ') {
  const items = values.map((v) => `'${v}'`);
  const lines = [];
  let line = `export const ${name} = [`;
  for (const item of items) {
    const probe = line === `export const ${name} = [` ? `${line}${item},` : `${line} ${item},`;
    if (probe.length <= 74) {
      line = probe;
    } else {
      lines.push(line);
      line = `${indent}${item},`;
    }
  }
  lines.push(line);
  lines[lines.length - 1] += '] as const;';
  return lines.join('\n');
}

function buildPyBlock(schema) {
  const kinds = schema.entityKindRegistry;
  const sources = schema.sourceRegistry;
  const projectable = schema.projectionDivision.stateProjectableKinds;
  const buckets = schema.projectionBuckets;
  const bucketTuple = (name, values) => {
    const inner = values.map((v) => JSON.stringify(v)).join(', ');
    // 尾逗号保证单元素也是 tuple（("person") 是字符串而非元组）
    return `${name}: tuple[str, ...] = (${inner},)`;
  };
  const header = [
    '# 自动生成（scripts/gen-contract-registries.js --write）；权威源 contracts/entity/entity-model.schema.json。',
    '# 请勿手改本生成区；漂移由 make truth-check 的 gen-contract-registries --check 拦截，',
    '# audit-domain-contracts.js 独立仲裁为双保险。',
  ].join('\n');
  const body = [
    header,
    wrapPyTuple('ENTITY_KINDS', kinds),
    `SOURCES: frozenset = frozenset({${sources.map((v) => JSON.stringify(v)).join(', ')}})`,
    wrapPyTuple('WORLD_STATE_PROJECTABLE_KINDS', projectable),
    bucketTuple('PERSON_BUCKET_KINDS', buckets.personBucket),
    bucketTuple('DEVICE_BUCKET_KINDS', buckets.deviceBucket),
    bucketTuple('STATION_BUCKET_KINDS', buckets.stationBucket),
    bucketTuple('TASK_BUCKET_KINDS', buckets.taskBucket),
  ].join('\n\n');
  return `${PY_BEGIN}\n${body}\n${PY_END}`;
}

function buildTsBlock(schema) {
  const kinds = schema.entityKindRegistry;
  const sources = schema.sourceRegistry;
  const projectable = schema.projectionDivision.stateProjectableKinds;
  const buckets = schema.projectionBuckets;
  const flat = (values) => values.map((v) => `'${v}'`).join(', ');
  const header = [
    '// 自动生成（scripts/gen-contract-registries.js --write）；权威源 contracts/entity/entity-model.schema.json。',
    '// 请勿手改本生成区；漂移由 make truth-check 的 gen-contract-registries --check 拦截。',
  ].join('\n');
  const body = [
    header,
    wrapTsArray('ENTITY_KINDS', kinds),
    `export type EntityKind = (typeof ENTITY_KINDS)[number];`,
    `export const ENTITY_SOURCES = [${flat(sources)}] as const;`,
    `export type EntitySource = (typeof ENTITY_SOURCES)[number];`,
    wrapTsArray('WORLD_STATE_PROJECTABLE_KINDS', projectable),
    `export const PERSON_BUCKET_KINDS = [${flat(buckets.personBucket)}] as const;`,
    `export const DEVICE_BUCKET_KINDS = [${flat(buckets.deviceBucket)}] as const;`,
    `export const STATION_BUCKET_KINDS = [${flat(buckets.stationBucket)}] as const;`,
    `export const TASK_BUCKET_KINDS = [${flat(buckets.taskBucket)}] as const;`,
  ].join('\n');
  return `${TS_BEGIN}\n${body}\n${TS_END}`;
}

function regionOf(source, begin, end, fileLabel) {
  const start = source.indexOf(begin);
  const stop = source.indexOf(end);
  if (start === -1 || stop === -1 || stop < start) {
    fail(`${fileLabel} 缺少生成区标记（${begin} ... ${end}）`);
  }
  return { start, end: stop + end.length };
}

function regenerate(filePath, begin, end, block, fileLabel) {
  const source = fs.readFileSync(filePath, 'utf-8');
  const region = regionOf(source, begin, end, fileLabel);
  const generated = source.slice(0, region.start) + block + source.slice(region.end);
  if (generated === source) return { target: filePath, drift: false, generated };
  return { target: filePath, drift: true, generated };
}

function main() {
  const mode = process.argv.includes('--write') ? 'write' : 'check';
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8'));
  if (!Array.isArray(schema.entityKindRegistry) || !Array.isArray(schema.sourceRegistry)) {
    fail('schema 实例值缺失（entityKindRegistry/sourceRegistry）');
  }
  if (!schema.projectionDivision || !schema.projectionBuckets) {
    fail('schema 实例值缺失（projectionDivision/projectionBuckets）');
  }

  const results = [
    regenerate(PY_PATH, PY_BEGIN, PY_END, buildPyBlock(schema), PY_PATH),
    regenerate(TS_PATH, TS_BEGIN, TS_END, buildTsBlock(schema), TS_PATH),
  ];
  const drifted = results.filter((r) => r.drift);
  if (drifted.length === 0) {
    console.log('GEN-CONTRACT-REGISTRIES OK: Python/TS 生成区与 schema 一致');
    return;
  }
  if (mode === 'check') {
    fail(`生成区与 schema 漂移（${drifted.map((d) => d.target).join(', ')}）；执行 node scripts/gen-contract-registries.js --write 修正`);
  }
  for (const d of drifted) {
    fs.writeFileSync(d.target, d.generated, 'utf-8');
    console.log(`GEN-CONTRACT-REGISTRIES WROTE: ${d.target}`);
  }
}

main();
