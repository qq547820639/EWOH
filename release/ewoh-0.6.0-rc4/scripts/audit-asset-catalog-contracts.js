#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const root = path.resolve(__dirname, '..');
const requireFromApp = createRequire(path.join(root, 'ewoh-spark-app', 'package.json'));
const yaml = requireFromApp('js-yaml');
const Ajv = requireFromApp('ajv');

const catalogSchema = JSON.parse(
  fs.readFileSync(path.join(root, 'contracts/catalog/asset-catalog.schema.json'), 'utf8'),
);
const scenarioSchema = JSON.parse(
  fs.readFileSync(path.join(root, 'contracts/catalog/scenario-pack.schema.json'), 'utf8'),
);
const connectorSchema = JSON.parse(
  fs.readFileSync(path.join(root, 'contracts/catalog/connector-package.schema.json'), 'utf8'),
);
const mappingSchema = JSON.parse(
  fs.readFileSync(path.join(root, 'contracts/mapping/mapping-schema.json'), 'utf8'),
);

const ajv = new Ajv({ allErrors: true, strict: false });
const errors = [];
const checked = [];

const check = (condition, message) => {
  checked.push(message);
  if (!condition) {
    errors.push(message);
  }
};

check(ajv.validateSchema(catalogSchema), 'asset catalog schema is valid JSON Schema');
check(catalogSchema.$id === 'ewoh:///asset-catalog/v1', 'asset catalog schema $id');
check(ajv.validateSchema(scenarioSchema), 'scenario pack schema is valid JSON Schema');
check(scenarioSchema.$id === 'ewoh:///scenario-pack/v1', 'scenario pack schema $id');
check(ajv.validateSchema(connectorSchema), 'connector package schema is valid JSON Schema');
check(connectorSchema.$id === 'ewoh:///connector-package/v1', 'connector package schema $id');

const validateScenario = ajv.compile(scenarioSchema);
const validateConnector = ajv.compile(connectorSchema);
const validateMapping = ajv.compile(mappingSchema);

function walk(directory, suffix, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(full, suffix, files);
    } else if (entry.name.endsWith(suffix)) {
      files.push(full);
    }
  }
  return files;
}

const scenarioFiles = walk(path.join(root, 'catalog/scenarios'), '.yaml');
const connectorFiles = walk(path.join(root, 'catalog/connectors'), '.yaml');
const mappingFiles = walk(path.join(root, 'catalog/mappings'), '.yaml');

check(scenarioFiles.length >= 4, `scenario manifests >= 4 (${scenarioFiles.length})`);
check(connectorFiles.length >= 2, `connector manifests >= 2 (${connectorFiles.length})`);
check(mappingFiles.length >= 2, `mapping manifests >= 2 (${mappingFiles.length})`);

for (const file of scenarioFiles) {
  const doc = yaml.load(fs.readFileSync(file, 'utf8'));
  const valid = validateScenario(doc);
  check(valid, `${path.relative(root, file)} scenario manifest valid`);
  if (!valid) {
    for (const error of validateScenario.errors ?? []) {
      errors.push(`  ${path.relative(root, file)} ${error.instancePath}: ${error.message}`);
    }
  }
  check(
    Array.isArray(doc?.spec?.workflows) && doc.spec.workflows.length > 0,
    `${path.relative(root, file)} workflows non-empty`,
  );
  check(
    typeof doc?.spec?.acceptance === 'string' && doc.spec.acceptance.length > 0,
    `${path.relative(root, file)} acceptance non-empty`,
  );
}

for (const file of connectorFiles) {
  const doc = yaml.load(fs.readFileSync(file, 'utf8'));
  const valid = validateConnector(doc);
  check(valid, `${path.relative(root, file)} connector manifest valid`);
  if (!valid) {
    for (const error of validateConnector.errors ?? []) {
      errors.push(`  ${path.relative(root, file)} ${error.instancePath}: ${error.message}`);
    }
  }
  check(
    Array.isArray(doc?.spec?.outputEvents) && doc.spec.outputEvents.length > 0,
    `${path.relative(root, file)} outputEvents non-empty`,
  );
  check(
    doc?.spec?.compatibility?.core,
    `${path.relative(root, file)} compatibility.core present`,
  );
}

for (const file of mappingFiles) {
  const doc = yaml.load(fs.readFileSync(file, 'utf8'));
  const valid = validateMapping(doc);
  check(valid, `${path.relative(root, file)} mapping manifest valid`);
  if (!valid) {
    for (const error of validateMapping.errors ?? []) {
      errors.push(`  ${path.relative(root, file)} ${error.instancePath}: ${error.message}`);
    }
  }
  check(Array.isArray(doc?.rules) && doc.rules.length > 0, `${path.relative(root, file)} rules non-empty`);
}

const catalog = {
  schemaVersion: catalogSchema.$id,
  catalogId: 'ewoh-final6-catalog',
  generatedAt: new Date().toISOString(),
  assets: [
    ...scenarioFiles.map((file) => {
      const doc = yaml.load(fs.readFileSync(file, 'utf8'));
      return {
        packageId: `scenario-${doc?.metadata?.name}`,
        packageType: 'scenario',
        name: doc?.metadata?.name,
        version: doc?.metadata?.version,
        status: 'catalog',
        sourcePath: path.relative(root, file),
      };
    }),
    ...connectorFiles.map((file) => {
      const doc = yaml.load(fs.readFileSync(file, 'utf8'));
      return {
        packageId: `connector-${doc?.metadata?.name}`,
        packageType: 'connector',
        name: doc?.metadata?.name,
        version: doc?.metadata?.version,
        status: 'catalog',
        sourcePath: path.relative(root, file),
      };
    }),
  ],
};

const catalogValid = ajv.validate(catalogSchema, catalog);
check(catalogValid, `generated catalog validates (${ajv.errors?.length ?? 0} errors)`);

if (errors.length > 0) {
  console.error('ASSET CATALOG CONTRACT AUDIT FAILED');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(
  `Asset catalog contract audit: ${scenarioFiles.length} scenarios | ${connectorFiles.length} connectors | ` +
    `${mappingFiles.length} mappings | ${checked.length} checks passed`,
);
