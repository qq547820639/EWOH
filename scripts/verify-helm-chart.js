#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const root = path.resolve(__dirname, '..');
const requireFromApp = createRequire(path.join(root, 'ewoh-spark-app', 'package.json'));
const yaml = requireFromApp('js-yaml');

const chartDir = path.join(root, 'deploy/cloud/helm/ewoh');
const errors = [];
const checked = [];

function check(condition, message) {
  checked.push(message);
  if (!condition) {
    errors.push(message);
  }
}

function readYaml(file) {
  return yaml.load(fs.readFileSync(file, 'utf8'));
}

function resolveValuePath(values, pathSegments) {
  let current = values;
  for (const segment of pathSegments) {
    if (current === null || typeof current !== 'object') {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

const chart = readYaml(path.join(chartDir, 'Chart.yaml'));
const values = readYaml(path.join(chartDir, 'values.yaml'));

check(chart.apiVersion === 'v2', 'Chart.yaml apiVersion v2');
check(chart.name === 'ewoh', 'Chart.yaml name ewoh');
check(/^\d+\.\d+\.\d+$/.test(chart.version ?? ''), 'Chart.yaml version semver');
check(typeof chart.appVersion === 'string' && chart.appVersion.length > 0, 'Chart.yaml appVersion');

for (const key of [
  'namespace.name',
  'image.repository',
  'image.tag',
  'replicaCount',
  'service.port',
  'ingress.host',
  'autoscaling.minReplicas',
  'autoscaling.maxReplicas',
  'pdb.minAvailable',
  'resources.requests',
  'resources.limits',
  'secret.name',
  'secret.keys.databaseUrl',
  'secret.keys.jwtSecret',
  'secret.keys.redisUrl',
  'migration.image.repository',
  'migration.secretName',
  'storage.driver',
  'storage.pvcName',
  'factory.id',
  'factory.name',
  'factory.upgradeRing',
]) {
  check(
    resolveValuePath(values, key.split('.')) !== undefined,
    `values.${key} present`,
  );
}

check(values.secret.create === false, 'chart does not generate a secret from values');
check(
  ['dev', 'integration', 'shadow', 'pilot', 'small', 'full'].includes(
    values.factory.upgradeRing,
  ),
  'factory.upgradeRing is a known ring',
);
check(values.replicaCount >= 3, 'default replicas >= 3');
check(values.autoscaling.minReplicas >= 3, 'HPA minReplicas >= 3');
check(values.autoscaling.maxReplicas >= values.autoscaling.minReplicas, 'HPA max >= min');
check(Number(values.pdb.minAvailable) >= 2, 'PDB minAvailable >= 2');

const templateDir = path.join(chartDir, 'templates');
const expectedTemplates = [
  '_helpers.tpl',
  'namespace.yaml',
  'configmap.yaml',
  'persistentvolumeclaim.yaml',
  'migration-job.yaml',
  'deployment.yaml',
  'service.yaml',
  'ingress.yaml',
  'hpa.yaml',
  'pdb.yaml',
];
const presentTemplates = fs.readdirSync(templateDir).sort();
for (const name of expectedTemplates) {
  check(presentTemplates.includes(name), `template ${name} present`);
}

const templateTexts = new Map(
  expectedTemplates
    .filter((name) => presentTemplates.includes(name))
    .map((name) => [name, fs.readFileSync(path.join(templateDir, name), 'utf8')]),
);

for (const [name, text] of templateTexts) {
  check(text.includes('{{'), `${name} contains Helm templating`);
  const refs = [...text.matchAll(/\.Values\.([A-Za-z0-9_.]+)/g)].map(
    (match) => match[1],
  );
  for (const ref of refs) {
    const resolved = resolveValuePath(values, ref.split('.'));
    check(resolved !== undefined, `${name} .Values.${ref} resolves`);
  }
}

const deployment = templateTexts.get('deployment.yaml') ?? '';
check(deployment.includes('/health/live'), 'deployment liveness probe');
check(deployment.includes('/health/ready'), 'deployment readiness probe');
check(deployment.includes('allowPrivilegeEscalation: false'), 'deployment no privilege escalation');

const migration = templateTexts.get('migration-job.yaml') ?? '';
check(migration.includes('run_migrations.js --apply-standalone'), 'migration apply command');
check(migration.includes('run_migrations.js --verify-standalone'), 'migration verify command');
check(migration.includes('run_migrations.js --seed-standalone-admin'), 'migration admin seed');

const ingress = templateTexts.get('ingress.yaml') ?? '';
check(ingress.includes('networking.k8s.io/v1'), 'ingress apiVersion');
check(ingress.includes('pathType: Prefix'), 'ingress pathType');

if (errors.length > 0) {
  console.error('HELM CHART AUDIT FAILED');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(
  `Helm chart audit: ${chart.name} ${chart.version} (app ${chart.appVersion}) | ` +
    `${presentTemplates.length} templates | ${checked.length} checks passed`,
);
