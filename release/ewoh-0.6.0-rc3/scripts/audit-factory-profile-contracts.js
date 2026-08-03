#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const root = path.resolve(__dirname, '..');
const requireFromApp = createRequire(path.join(root, 'ewoh-spark-app', 'package.json'));
const yaml = requireFromApp('js-yaml');
const Ajv = requireFromApp('ajv');

const schema = JSON.parse(
  fs.readFileSync(path.join(root, 'contracts/factory/factory-profile.schema.json'), 'utf8'),
);
const example = yaml.load(
  fs.readFileSync(path.join(root, 'contracts/factory/examples/factory-profile.yaml'), 'utf8'),
);
const golden = yaml.load(
  fs.readFileSync(path.join(root, 'contracts/factory/golden-factory.yaml'), 'utf8'),
);
const replicationSchema = JSON.parse(
  fs.readFileSync(path.join(root, 'contracts/factory/replication-report.schema.json'), 'utf8'),
);
const siteReadinessSchema = JSON.parse(
  fs.readFileSync(path.join(root, 'contracts/factory/site-readiness.schema.json'), 'utf8'),
);
const passingReport = JSON.parse(
  fs.readFileSync(path.join(root, 'tools/factory-replication/fixtures/passing.json'), 'utf8'),
);
const failingReport = JSON.parse(
  fs.readFileSync(path.join(root, 'tools/factory-replication/fixtures/failing.json'), 'utf8'),
);
const { evaluateReport } = require(path.join(root, 'tools/factory-replication/index.js'));
const { evaluateSiteReadiness } = require(
  path.join(root, 'tools/factory-replication/site-readiness.js'),
);
const siteReady = JSON.parse(
  fs.readFileSync(path.join(root, 'tools/factory-replication/fixtures/site-ready.json'), 'utf8'),
);
const siteNotReady = JSON.parse(
  fs.readFileSync(path.join(root, 'tools/factory-replication/fixtures/site-not-ready.json'), 'utf8'),
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

check(ajv.validateSchema(schema), 'factory profile schema is valid JSON Schema');
check(schema.$id === 'ewoh:///factory-profile/v1', 'factory profile schema $id');
check(ajv.validateSchema(replicationSchema), 'replication report schema is valid JSON Schema');
check(
  replicationSchema.$id === 'ewoh:///factory-replication/v1',
  'replication report schema $id',
);
check(ajv.validateSchema(siteReadinessSchema), 'site readiness schema is valid JSON Schema');
check(siteReadinessSchema.$id === 'ewoh:///site-readiness/v1', 'site readiness schema $id');

const validate = ajv.compile(schema);
const valid = validate(example);
check(valid, `factory profile example validates (${validate.errors?.length ?? 0} errors)`);
if (!valid) {
  for (const error of validate.errors ?? []) {
    errors.push(`  ${error.instancePath}: ${error.message}`);
  }
}

check(example?.metadata?.profileId, 'example profileId');
check(example?.spec?.status, 'example status');
check(example?.spec?.upgradeRing, 'example upgrade ring');
check(example?.spec?.compatibleCore, 'example compatible core');
check(golden?.kind === 'FactoryTemplate', 'golden factory template remains valid');

const validateReplication = ajv.compile(replicationSchema);
check(
  validateReplication(passingReport),
  `passing replication fixture validates (${validateReplication.errors?.length ?? 0} errors)`,
);
check(
  validateReplication(failingReport),
  `failing replication fixture validates (${validateReplication.errors?.length ?? 0} errors)`,
);
check(evaluateReport(passingReport).passed, 'passing replication fixture passes TCK');
check(!evaluateReport(failingReport).passed, 'failing replication fixture fails TCK');

const validateSite = ajv.compile(siteReadinessSchema);
check(
  validateSite(siteReady),
  `site-ready fixture validates (${validateSite.errors?.length ?? 0} errors)`,
);
check(
  validateSite(siteNotReady),
  `site-not-ready fixture validates (${validateSite.errors?.length ?? 0} errors)`,
);
check(evaluateSiteReadiness(siteReady).ready, 'site-ready fixture is ready');
check(!evaluateSiteReadiness(siteNotReady).ready, 'site-not-ready fixture is not ready');

const catalogSiteDir = path.join(root, 'catalog', 'factory-sites');
const catalogSiteFiles = fs.existsSync(catalogSiteDir)
  ? fs.readdirSync(catalogSiteDir).filter((file) => file.endsWith('.json'))
  : [];
check(catalogSiteFiles.length >= 2, `catalog site reports >= 2 (${catalogSiteFiles.length})`);
for (const file of catalogSiteFiles) {
  const report = JSON.parse(
    fs.readFileSync(path.join(catalogSiteDir, file), 'utf8'),
  );
  const valid = validateSite(report);
  check(valid, `catalog site report ${file} validates`);
  const evaluated = evaluateSiteReadiness(report);
  if (file.includes('second-factory')) {
    check(evaluated.ready, `catalog site report ${file} is ready`);
  } else if (file.includes('third-factory')) {
    check(!evaluated.ready, `catalog site report ${file} is not ready`);
  }
}

if (errors.length > 0) {
  console.error('FACTORY PROFILE CONTRACT AUDIT FAILED');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(
  `Factory profile contract audit: schema ${schema.$id} | example ${example.metadata.profileId} | ` +
    `replication ${replicationSchema.$id} | passing/failing fixtures verified | ` +
    `site readiness ${siteReadinessSchema.$id} | ${checked.length} checks passed`,
);
