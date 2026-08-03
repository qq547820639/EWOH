#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function evaluateReport(report) {
  const requirements = Array.isArray(report.requirements) ? report.requirements : [];
  const configCount = requirements.filter((item) => item.satisfiedBy === 'config').length;
  const assetCount = requirements.filter((item) => item.satisfiedBy === 'asset').length;
  const customCount = requirements.filter((item) => item.satisfiedBy === 'custom').length;
  const notSatisfiedCount = requirements.filter(
    (item) => item.satisfiedBy === 'not-satisfied',
  ).length;
  const total = requirements.length;
  const configSatisfactionRate =
    total > 0 ? (configCount + assetCount) / total : 0;
  const customRate = total > 0 ? customCount / total : 0;
  const checks = [
    {
      name: 'schema-version',
      passed: report.schemaVersion === 'ewoh:///factory-replication/v1',
      detail: report.schemaVersion,
    },
    {
      name: 'factory-identity',
      passed: Boolean(report.factoryName && report.profileId && report.templateId),
      detail: `${report.factoryName ?? ''} ${report.profileId ?? ''} ${report.templateId ?? ''}`,
    },
    {
      name: 'no-core-fork',
      passed: report.coreFork === false,
      detail: String(report.coreFork),
    },
    {
      name: 'profile-replay',
      passed: report.profileReplayPassed === true,
      detail: String(report.profileReplayPassed),
    },
    {
      name: 'config-satisfaction',
      passed: configSatisfactionRate >= 0.8,
      detail: `${configCount + assetCount}/${total} config+asset (${(configSatisfactionRate * 100).toFixed(1)}%)`,
    },
    {
      name: 'custom-under-20-percent',
      passed: customRate <= 0.2,
      detail: `${customCount}/${total} custom (${(customRate * 100).toFixed(1)}%)`,
    },
    {
      name: 'no-unresolved-requirement',
      passed: notSatisfiedCount === 0,
      detail: `${notSatisfiedCount} not-satisfied`,
    },
    {
      name: 'difference-resolution',
      passed: (report.differencesResolvedRate ?? 1) >= 0.8,
      detail: String(report.differencesResolvedRate ?? 1),
    },
  ];
  return {
    factoryName: report.factoryName,
    profileId: report.profileId,
    templateId: report.templateId,
    configSatisfactionRate,
    customRate,
    notSatisfiedCount,
    passed: checks.every((check) => check.passed),
    checks,
  };
}

function parseArgs(argv) {
  const options = { report: null, strict: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--report') {
      options.report = argv[++index];
    } else if (argument === '--strict') {
      options.strict = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.report) {
    throw new Error('--report path is required');
  }
  const report = JSON.parse(fs.readFileSync(path.resolve(options.report), 'utf8'));
  const result = evaluateReport(report);
  console.log(JSON.stringify(result, null, 2));
  if (options.strict && !result.passed) {
    process.exitCode = 1;
  }
}

module.exports = { evaluateReport };

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && (error.stack || error.message || error));
    process.exitCode = 1;
  }
}
