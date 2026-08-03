#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function evaluateSiteReadiness(report) {
  const items = Array.isArray(report.items) ? report.items : [];
  const required = items.filter((item) => item.required === true);
  const requiredPassed = required.filter((item) => item.status === 'pass');
  const requiredFailed = required.filter((item) => item.status !== 'pass');
  const checks = items.map((item) => ({
    id: item.id,
    label: item.label,
    required: item.required === true,
    passed: item.required !== true || item.status === 'pass',
    status: item.status,
    evidence: item.evidence,
  }));
  return {
    factoryName: report.factoryName,
    siteContact: report.siteContact,
    ready: requiredFailed.length === 0,
    requiredCount: required.length,
    requiredPassed: requiredPassed.length,
    requiredFailed: requiredFailed.length,
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
  const result = evaluateSiteReadiness(report);
  console.log(JSON.stringify(result, null, 2));
  if (options.strict && !result.ready) {
    process.exitCode = 1;
  }
}

module.exports = { evaluateSiteReadiness };

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && (error.stack || error.message || error));
    process.exitCode = 1;
  }
}
