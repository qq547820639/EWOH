#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const root = path.resolve(__dirname, '..');
const requireFromApp = createRequire(path.join(root, 'ewoh-spark-app', 'package.json'));
const yaml = requireFromApp('js-yaml');

const file = path.join(root, 'contracts/factory/golden-factory.yaml');
const spec = yaml.load(fs.readFileSync(file, 'utf8'));
const errors = [];
const checked = [];

const check = (condition, message) => {
  checked.push(message);
  if (!condition) {
    errors.push(message);
  }
};

check(spec.apiVersion === 'ewoh.io/v1alpha1', 'apiVersion ewoh.io/v1alpha1');
check(spec.kind === 'FactoryTemplate', 'kind FactoryTemplate');
check(typeof spec.metadata?.name === 'string', 'metadata.name');
check(/^\d+\.\d+\.\d+$/.test(spec.metadata?.version ?? ''), 'metadata.version semver');
check(
  typeof spec.spec?.compatibleCore === 'string',
  'spec.compatibleCore string',
);

for (const module of ['organization', 'device', 'mes-p0', 'oee', 'andon', 'audit']) {
  check(
    Array.isArray(spec.spec?.modules) && spec.spec.modules.includes(module),
    `module ${module} included`,
  );
}

check(
  Array.isArray(spec.spec?.requiredConnectors) &&
    spec.spec.requiredConnectors.length >= 3,
  'required connectors >= 3',
);
for (const connector of spec.spec?.requiredConnectors ?? []) {
  check(typeof connector.id === 'string' && connector.id.length > 0, `connector ${connector.id} id`);
  check(/^\d+\.\d+\.\d+$/.test(connector.version ?? ''), `connector ${connector.id} version`);
  check(typeof connector.runtime === 'string', `connector ${connector.id} runtime`);
  check(typeof connector.protocol === 'string', `connector ${connector.id} protocol`);
}

check(
  Array.isArray(spec.spec?.scenarioPacks) &&
    spec.spec.scenarioPacks.length >= 4,
  'scenario packs >= 4',
);
for (const pack of spec.spec?.scenarioPacks ?? []) {
  check(typeof pack.id === 'string' && pack.id.length > 0, `scenario ${pack.id} id`);
  check(/^\d+\.\d+\.\d+$/.test(pack.version ?? ''), `scenario ${pack.id} version`);
  check(Array.isArray(pack.workflows), `scenario ${pack.id} workflows`);
  check(Array.isArray(pack.policies), `scenario ${pack.id} policies`);
  check(typeof pack.acceptance === 'string', `scenario ${pack.id} acceptance`);
}

const connectorIds = (spec.spec?.requiredConnectors ?? []).map(
  (connector) => connector.id,
);
const scenarioIds = (spec.spec?.scenarioPacks ?? []).map((pack) => pack.id);
check(
  new Set(connectorIds).size === connectorIds.length,
  'connector ids unique',
);
check(new Set(scenarioIds).size === scenarioIds.length, 'scenario ids unique');

if (errors.length > 0) {
  console.error('GOLDEN FACTORY AUDIT FAILED');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(
  `Golden factory audit: ${spec.metadata.name} ${spec.metadata.version} | ` +
    `${spec.spec.modules.length} modules | ${connectorIds.length} connectors | ` +
    `${scenarioIds.length} scenario packs | ${checked.length} checks passed`,
);
