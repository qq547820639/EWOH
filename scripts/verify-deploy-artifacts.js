#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const root = path.resolve(__dirname, '..');
const requireFromApp = createRequire(path.join(root, 'ewoh-spark-app', 'package.json'));
const yaml = requireFromApp('js-yaml');

const K8S_DIR = path.join(root, 'deploy', 'cloud', 'k8s');
const errors = [];
const checked = [];

function check(condition, message) {
  checked.push(message);
  if (!condition) {
    errors.push(message);
  }
}

function parseYamlFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  return yaml.load(text);
}

function validateKubernetes() {
  const files = fs
    .readdirSync(K8S_DIR)
    .filter((name) => name.endsWith('.yaml'))
    .sort();
  check(files.length >= 9, `k8s manifests present (${files.length})`);
  for (const name of files) {
    const doc = parseYamlFile(path.join(K8S_DIR, name));
    check(doc && doc.apiVersion, `${name}: apiVersion present`);
    check(doc && doc.kind, `${name}: kind present`);
    check(doc && doc.metadata && doc.metadata.name, `${name}: metadata.name present`);
    if (doc.kind !== 'Namespace') {
      check(doc.metadata.namespace === 'ewoh', `${name}: namespace is ewoh`);
    }
  }

  const deployment = parseYamlFile(path.join(K8S_DIR, 'api-deployment.yaml'));
  const container = deployment.spec.template.spec.containers[0];
  check(container.readinessProbe?.httpGet?.path === '/health/ready', 'deployment readiness probe path');
  check(container.livenessProbe?.httpGet?.path === '/health/live', 'deployment liveness probe path');
  check(container.securityContext?.readOnlyRootFilesystem === true, 'deployment readOnlyRootFilesystem');
  check(container.securityContext?.allowPrivilegeEscalation === false, 'deployment no privilege escalation');
  check(deployment.spec.replicas >= 3, 'deployment replicas >= 3');

  const migration = parseYamlFile(path.join(K8S_DIR, 'migration-job.yaml'));
  const migrationContainer = migration.spec.template.spec.containers[0];
  check(
    migrationContainer.securityContext?.allowPrivilegeEscalation === false,
    'migration job no privilege escalation',
  );
  check(migration.spec.template.spec.restartPolicy === 'Never', 'migration restartPolicy Never');

  const hpa = parseYamlFile(path.join(K8S_DIR, 'hpa.yaml'));
  check(hpa.spec.minReplicas >= 3 && hpa.spec.maxReplicas >= hpa.spec.minReplicas, 'HPA replicas bounded');
  const pdb = parseYamlFile(path.join(K8S_DIR, 'pdb.yaml'));
  check(Number(pdb.spec.minAvailable) >= 2, 'PDB minAvailable >= 2');
  const service = parseYamlFile(path.join(K8S_DIR, 'api-service.yaml'));
  check(service.spec.ports[0].targetPort === 3000, 'service targetPort 3000');

  for (const secretFile of ['secret.example.yaml', 'migration-secret.example.yaml']) {
    const secret = parseYamlFile(path.join(K8S_DIR, secretFile));
    const values = Object.values(secret.stringData ?? {}).join(' ');
    check(values.includes('REPLACE_'), `${secretFile} contains placeholders only`);
  }
}

function validateCompose() {
  const compose = parseYamlFile(path.join(root, 'deploy', 'cloud', 'docker-compose.standalone.yml'));
  for (const service of ['postgres', 'redis', 'migrate', 'api']) {
    check(compose.services?.[service], `compose service ${service}`);
  }
  const api = compose.services.api;
  check(api.healthcheck?.test?.[0] === 'CMD', 'compose api healthcheck');
  check(api.ports?.[0] === '3000:3000', 'compose api port mapping');
}

function validateDockerfiles() {
  const api = fs.readFileSync(path.join(root, 'deploy', 'cloud', 'Dockerfile.api'), 'utf8');
  check(api.includes('FROM node:22-alpine'), 'Dockerfile.api base image');
  check(api.includes('CMD ["node", "dist/server/main.js"]'), 'Dockerfile.api command');
  const migrate = fs.readFileSync(path.join(root, 'deploy', 'cloud', 'Dockerfile.migrate'), 'utf8');
  check(migrate.includes('FROM node:22-alpine'), 'Dockerfile.migrate base image');
  check(migrate.includes('db/runner/run_migrations.js'), 'Dockerfile.migrate command');
}

validateKubernetes();
validateCompose();
validateDockerfiles();

console.log(
  JSON.stringify(
    {
      checked: checked.length,
      passed: checked.length - errors.length,
      failed: errors.length,
      errors,
    },
    null,
    2,
  ),
);

if (errors.length > 0) {
  process.exitCode = 1;
}
