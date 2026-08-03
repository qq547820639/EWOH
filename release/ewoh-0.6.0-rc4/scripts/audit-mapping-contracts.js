#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const root = path.resolve(__dirname, '..');
const requireFromApp = createRequire(path.join(root, 'ewoh-spark-app', 'package.json'));
const yaml = requireFromApp('js-yaml');
const Ajv = requireFromApp('ajv');

const schemaPath = path.join(root, 'contracts/mapping/mapping-schema.json');
const examplePath = path.join(root, 'contracts/mapping/examples/exoskeleton-telemetry.yaml');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const example = yaml.load(fs.readFileSync(examplePath, 'utf8'));

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);
const valid = validate(example);
const errors = [];
const checked = [];

const check = (condition, message) => {
  checked.push(message);
  if (!condition) {
    errors.push(message);
  }
};

check(schema.$id === 'ewoh:///mapping/v1', 'schema $id');
check(schema.title === 'EWOH Mapping Definition', 'schema title');
check(Array.isArray(schema.required) && schema.required.length === 6, 'schema required fields');
check(valid, `example validates against mapping schema (${validate.errors?.length ?? 0} errors)`);
if (!valid) {
  for (const error of validate.errors ?? []) {
    errors.push(`  ${error.instancePath}: ${error.message}`);
  }
}

check(/^\d+\.\d+\.\d+$/.test(example.version ?? ''), 'example version semver');
check(example.source?.system && example.target?.system, 'example source/target systems');
check(Array.isArray(example.rules) && example.rules.length > 0, 'example rules non-empty');
const fromKeys = example.rules?.map((rule) => rule.from) ?? [];
const toKeys = example.rules?.map((rule) => rule.to) ?? [];
check(new Set(fromKeys).size === fromKeys.length, 'rule from keys unique');
check(new Set(toKeys).size === toKeys.length, 'rule to keys unique');
check(example.rules?.some((rule) => rule.required === true), 'at least one required rule');

if (errors.length > 0) {
  console.error('MAPPING CONTRACT AUDIT FAILED');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(
  `Mapping contract audit: schema ${schema.$id} | example ${example.mappingId} ${example.version} | ` +
    `${example.rules.length} rules | ${checked.length} checks passed`,
);
