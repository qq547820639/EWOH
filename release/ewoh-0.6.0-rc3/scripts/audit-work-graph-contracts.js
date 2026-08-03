#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const root = path.resolve(__dirname, '..');
const requireFromApp = createRequire(path.join(root, 'ewoh-spark-app', 'package.json'));
const Ajv = requireFromApp('ajv');

const schemaPath = path.join(root, 'contracts/work/work-graph.schema.json');
const registrySchemaPath = path.join(root, 'contracts/work/artifact-paths.schema.json');
const registryPath = path.join(root, 'contracts/work/artifact-paths.json');
const fixturePath = path.join(root, 'contracts/work/examples/sample-work-graph.json');
const generatedPath = path.join(root, 'output/work-graph.json');
const gitSyncSchemaPath = path.join(root, 'contracts/work/git-sync-plan.schema.json');
const gitSyncGeneratedPath = path.join(root, 'output/git-sync.json');

const ajv = new Ajv({ allErrors: true, strict: false });
const errors = [];
const checked = [];

const check = (condition, message) => {
  checked.push(message);
  if (!condition) {
    errors.push(message);
  }
};

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const schema = readJson(schemaPath);
const registrySchema = readJson(registrySchemaPath);
const registry = readJson(registryPath);
const fixture = readJson(fixturePath);
const gitSyncSchema = readJson(gitSyncSchemaPath);

check(ajv.validateSchema(schema), 'work graph schema is a valid JSON Schema');
check(schema.$id === 'ewoh:///work-graph/v1', 'work graph schema $id');
check(ajv.validateSchema(registrySchema), 'artifact path registry schema valid');
check(registrySchema.$id === 'ewoh:///artifact-paths/v1', 'artifact path registry $id');
const validateRegistry = ajv.compile(registrySchema);
check(validateRegistry(registry), `artifact path registry instance validates (${validateRegistry.errors?.length ?? 0} errors)`);
check(
  Array.isArray(registry.paths) && registry.paths.length >= 10,
  'artifact path registry has at least 10 entries',
);
check(ajv.validateSchema(gitSyncSchema), 'git sync plan schema is valid JSON Schema');
check(gitSyncSchema.$id === 'ewoh:///git-sync/v1', 'git sync plan schema $id');

const validateWorkGraph = ajv.compile(schema);
const fixtureValid = validateWorkGraph(fixture);
check(fixtureValid, `sample work graph validates (${validateWorkGraph.errors?.length ?? 0} errors)`);

const missingRequired = [];
for (const entry of registry.paths) {
  const candidate = path.resolve(root, entry.path);
  const exists = fs.existsSync(candidate);
  if (entry.required && !exists) {
    missingRequired.push(entry.path);
  }
  if (!entry.required && exists) {
    check(true, `optional artifact present: ${entry.path}`);
  }
}
check(missingRequired.length === 0, `required artifacts present (missing: ${missingRequired.join(', ') || 'none'})`);

if (fs.existsSync(generatedPath)) {
  const generated = readJson(generatedPath);
  const generatedValid = validateWorkGraph(generated);
  check(generatedValid, `generated work graph validates (${validateWorkGraph.errors?.length ?? 0} errors)`);
  check(
    generated.items?.length > 0 && generated.edges?.length >= 0,
    'generated work graph contains items',
  );
}

if (fs.existsSync(gitSyncGeneratedPath)) {
  const gitSync = readJson(gitSyncGeneratedPath);
  const gitSyncValid = ajv.validate(gitSyncSchema, gitSync);
  check(gitSyncValid, `generated git sync plan validates (${ajv.errors?.length ?? 0} errors)`);
}

const orchestrationSpec = path.join(root, 'openapi/work-orchestration.yaml');
check(fs.existsSync(orchestrationSpec), 'openapi/work-orchestration.yaml exists');
if (fs.existsSync(orchestrationSpec)) {
  const text = fs.readFileSync(orchestrationSpec, 'utf8');
  for (const operation of [
    'get:',
    '/api/work/graph:',
    '/api/work/gates:',
    '/api/work/evidence:',
  ]) {
    check(text.includes(operation), `work orchestration OpenAPI includes ${operation}`);
  }
}

if (errors.length > 0) {
  console.error('WORK GRAPH CONTRACT AUDIT FAILED');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(
  `Work graph contract audit: schema ${schema.$id} | registry ${registry.paths.length} paths | ` +
    `fixture valid | ${checked.length} checks passed`,
);
