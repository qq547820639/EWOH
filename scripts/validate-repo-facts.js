#!/usr/bin/env node
'use strict';

/**
 * Validate a collected repository-facts snapshot against
 * contracts/repository-facts/repository-facts.schema.json.
 *
 * Usage:
 *   node scripts/validate-repo-facts.js --snapshot <path/to/repository-facts.json>
 */

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '..');
const requireFromApp = createRequire(path.join(root, 'ewoh-spark-app', 'package.json'));
const Ajv = requireFromApp('ajv');

const args = process.argv.slice(2);
const snapshotIndex = args.indexOf('--snapshot');
const snapshotPath = snapshotIndex >= 0 ? args[snapshotIndex + 1] : null;

if (!snapshotPath) {
  console.error('Usage: node scripts/validate-repo-facts.js --snapshot <path/to/repository-facts.json>');
  process.exitCode = 1;
  process.exit();
}

const schemaPath = path.join(root, 'contracts', 'repository-facts', 'repository-facts.schema.json');
const snapshotText = fs.readFileSync(path.resolve(root, snapshotPath), 'utf8');
const schemaText = fs.readFileSync(schemaPath, 'utf8');

let snapshot;
let schema;
try {
  snapshot = JSON.parse(snapshotText);
  schema = JSON.parse(schemaText);
} catch (error) {
  console.error(`JSON parse error: ${error.message}`);
  process.exitCode = 1;
  process.exit();
}

const ajv = new Ajv.default({ allErrors: true, formats: { 'date-time': true } });
const validate = ajv.compile(schema);
const valid = validate(snapshot);

if (!valid) {
  console.error('VALIDATION FAILED:');
  for (const err of validate.errors) {
    console.error(`  - ${err.instancePath} ${err.message}`);
  }
  process.exitCode = 1;
  process.exit();
}

console.log(`VALIDATION OK: repository-facts snapshot at ${snapshotPath}`);
console.log(`  version: ${snapshot.version}`);
console.log(`  head: ${snapshot.head}`);
console.log(`  generatedAt: ${snapshot.generatedAt}`);
console.log(`  testCounts: ${JSON.stringify(snapshot.testCounts)}`);
process.exitCode = 0;
