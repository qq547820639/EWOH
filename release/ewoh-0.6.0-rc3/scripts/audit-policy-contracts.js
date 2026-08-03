#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const root = path.resolve(__dirname, '..');
const requireFromApp = createRequire(path.join(root, 'ewoh-spark-app', 'package.json'));
const yaml = requireFromApp('js-yaml');
const Ajv = requireFromApp('ajv');

const schemaPath = path.join(root, 'contracts/policy/policy-schema.json');
const examplePath = path.join(root, 'contracts/policy/examples/operator-safety.yaml');
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

check(schema.$id === 'ewoh:///policy/v1', 'schema $id');
check(schema.title === 'EWOH Policy Definition', 'schema title');
check(Array.isArray(schema.required) && schema.required.length === 4, 'schema required fields');
check(valid, `example validates against policy schema (${ajv.errors?.length ?? 0} errors)`);
check(/^\d+\.\d+\.\d+$/.test(example.version ?? ''), 'example version semver');
check(['allow', 'deny', 'warn'].includes(example.effect), 'example effect enum');
check(Array.isArray(example.rules) && example.rules.length > 0, 'example rules non-empty');

if (errors.length > 0) {
  console.error('POLICY CONTRACT AUDIT FAILED');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(
  `Policy contract audit: schema ${schema.$id} | example ${example.policyId} ${example.version} | ` +
    `${example.rules.length} rules | ${checked.length} checks passed`,
);
