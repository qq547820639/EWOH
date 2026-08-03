#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const root = path.resolve(__dirname, '..');
const requireFromApp = createRequire(path.join(root, 'ewoh-spark-app', 'package.json'));
const yaml = requireFromApp('js-yaml');
const Ajv = requireFromApp('ajv');

const schemaPath = path.join(root, 'contracts/workflow/workflow-schema.json');
const examplePath = path.join(root, 'contracts/workflow/examples/mes-execution.yaml');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const example = yaml.load(fs.readFileSync(examplePath, 'utf8'));
const errors = [];
const checked = [];

const check = (condition, message) => {
  checked.push(message);
  if (!condition) {
    errors.push(message);
  }
};

const ajv = new Ajv({ allErrors: true, strict: false });
const valid = ajv.validate(schema, example);

check(schema.$id === 'ewoh:///workflow/v1', 'schema $id');
check(schema.title === 'EWOH Workflow Definition', 'schema title');
check(Array.isArray(schema.required) && schema.required.length === 4, 'schema required fields');
check(valid, `example validates against workflow schema (${ajv.errors?.length ?? 0} errors)`);
check(/^\d+\.\d+\.\d+$/.test(example.version ?? ''), 'example version semver');
check(typeof example.start === 'string' && example.start.length > 0, 'example start step');
check(Array.isArray(example.steps) && example.steps.length > 0, 'example steps non-empty');

const stepNames = example.steps?.map((step) => step.name) ?? [];
check(new Set(stepNames).size === stepNames.length, 'step names unique');
check(stepNames.includes(example.start), 'start step exists');
for (const step of example.steps ?? []) {
  for (const next of step.next ?? []) {
    check(stepNames.includes(next), `step ${step.name} next ${next} exists`);
  }
}

if (errors.length > 0) {
  console.error('WORKFLOW CONTRACT AUDIT FAILED');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(
  `Workflow contract audit: schema ${schema.$id} | example ${example.workflowId} ${example.version} | ` +
    `${example.steps.length} steps | ${checked.length} checks passed`,
);
