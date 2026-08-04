#!/usr/bin/env node
'use strict';

/**
 * F61-01 "single source of truth" semantic consistency CLI.
 *
 * Usage:
 *   node tools/semantic-rules/index.js --root <repo> [flags]
 *
 * Flags:
 *   --root <path>   repository root (default: cwd)
 *   --check         check only (default; exit 1 if errors, 0 otherwise)
 *   --fix           apply mechanical fixes and print applied paths
 *   --json          emit a JSON report to stdout
 *   --strict        treat any error as a failure (exit non-zero)
 *   --rule <id>     run a single rule (repeatable); default: all rules
 *   --exempt <id>   exempt a rule id from strict failure (repeatable); an
 *                   exemption of a high-risk rule is itself rejected by the
 *                   no-self-exemption rule unless an authorized decision-log
 *                   entry exists
 *
 * Programmatic API:
 *   const { buildContext, runRules, applyFixes } = require('./');
 *   const ctx = buildContext(process.cwd());
 *   const { findings, summary } = runRules(ctx);
 */

const { buildContext, applyFixes, runRules, RULE_META, ALL_RULES } = require('./lib/engine');

function parseArgs(argv) {
  const options = {
    root: process.cwd(),
    check: false,
    fix: false,
    json: false,
    strict: false,
    rules: [],
    exemptions: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') {
      options.root = argv[++index];
    } else if (argument === '--check') {
      options.check = true;
    } else if (argument === '--fix') {
      options.fix = true;
    } else if (argument === '--json') {
      options.json = true;
    } else if (argument === '--strict') {
      options.strict = true;
    } else if (argument === '--rule') {
      options.rules.push(argv[++index]);
    } else if (argument === '--exempt') {
      options.exemptions.push(argv[++index]);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function buildReport(ctx, runOpts, fixesApplied) {
  const { findings, summary } = runRules(ctx, runOpts);
  return {
    tool: 'ewoh:///semantic-rules/v1',
    root: ctx.root,
    gitHead: ctx.gitHead,
    generatedAt: new Date().toISOString(),
    summary,
    findings: findings.map((f) => ({
      ruleId: f.ruleId,
      severity: f.severity,
      message: f.message,
      path: f.path,
      fixable: f.fixable,
    })),
    fixesApplied: fixesApplied || [],
  };
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`error: ${error.message}`);
    console.error(
      'Usage: node tools/semantic-rules/index.js --root <repo> [--check|--fix] [--json] [--strict] [--rule <id>]',
    );
    process.exitCode = 2;
    return;
  }

  const runOpts = {
    strict: options.strict,
    rules: options.rules.length > 0 ? options.rules : null,
  };

  let ctx;
  try {
    ctx = buildContext(options.root, { exemptions: options.exemptions });
  } catch (error) {
    console.error(`error: failed to build context: ${error.message}`);
    process.exitCode = 2;
    return;
  }

  let fixesApplied = [];
  if (options.fix) {
    const { findings } = runRules(ctx, runOpts);
    const result = applyFixes(ctx, findings);
    fixesApplied = result.applied;
    for (const applied of result.applied) {
      console.log(`[fix] ${applied.path}`);
    }
    if (fixesApplied.length > 0) {
      // Rebuild the context so the report reflects the fixed state on disk.
      ctx = buildContext(options.root, { exemptions: ctx.exemptions });
    }
  }

  const report = buildReport(ctx, runOpts, fixesApplied);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const { summary } = report;
    console.log(
      `Semantic rules: ${summary.total} findings (${summary.errors} errors / ${summary.warnings} warnings) across ${summary.rulesRun} rules`,
    );
    for (const finding of report.findings) {
      console.log(
        `  [${finding.severity}] ${finding.ruleId}: ${finding.message}${finding.path ? ` (${finding.path})` : ''}`,
      );
    }
  }

  // `--strict` fails on ANY unexempted semantic conflict (error or warning).
  process.exitCode = options.strict && !report.summary.pass ? 1 : 0;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && (error.stack || error.message || error));
    process.exitCode = 1;
  }
}

module.exports = {
  ALL_RULES,
  RULE_META,
  applyFixes,
  buildContext,
  runRules,
};