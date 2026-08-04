'use strict';

/**
 * F61-01 semantic consistency engine.
 *
 * Responsibilities:
 *   - buildContext(root)  -> load + normalize all authoritative artifacts
 *   - runRules(ctx, opts) -> run selected rules, return findings + summary
 *   - applyFixes(ctx, findings) -> apply mechanical fixes, return diffs/applied
 *
 * Uses only Node built-ins. Never writes to authoritative artifacts unless a
 * finding carries a concrete, mechanical `fix` producing {path, original, patched}.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { ALL_RULES, RULE_META, parseMarkdown } = require('./rules');

// ---------------------------------------------------------------------------
// Context loading
// ---------------------------------------------------------------------------

function findArtifactsDir(cwd) {
  const candidates = [
    process.env.EWOH_WORK_ARTIFACTS_DIR,
    path.resolve(cwd, '.codex', 'artifacts'),
    path.resolve(cwd, '..', '.codex', 'artifacts'),
    path.resolve(cwd, '..', '..', '.codex', 'artifacts'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'task-board.md'))) {
      return candidate;
    }
  }
  return path.resolve(cwd, '.codex', 'artifacts');
}

function readFileSafe(root, rel) {
  const file = path.resolve(root, rel);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readJsonSafe(root, rel) {
  const text = readFileSafe(root, rel);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readYamlSafe(root, rel) {
  const text = readFileSafe(root, rel);
  if (!text) return null;
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    } else if (value === 'true' || value === 'false') {
      value = value === 'true';
    } else if (value !== '' && !Number.isNaN(Number(value))) {
      value = Number(value);
    }
    result[key] = value;
  }
  return result;
}

function runGit(root, args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .trim()
      .replace(/\s+$/g, '');
  } catch {
    return '';
  }
}

function currentGitHead(root) {
  return runGit(root, ['rev-parse', 'HEAD']) || '';
}

/**
 * Return true if `commit` is an ancestor of (or equal to) HEAD, i.e. it exists
 * in the current git history.
 */
function isGitAncestor(root, commit) {
  if (!/^[0-9a-f]{7,40}$/i.test(String(commit))) return false;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], {
      cwd: root,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the managed schema manifest and extract the authoritative managed table
 * count. The YAML is large and mostly a flat list, so we only pull the
 * `managed_count` from `managed_package` via a targeted regex.
 */
function readSchemaManifest(root) {
  const text = readFileSafe(root, 'db/contracts/schema-manifest.yaml');
  if (!text) return null;
  const match = text.match(/^\s*managed_count\s*:\s*(\d+)\s*$/m);
  return {
    managed_count: match ? Number(match[1]) : null,
    text,
  };
}

function currentChangelogVersion(root) {
  const text = readFileSafe(root, 'CHANGELOG.md');
  if (!text) return null;
  const match = text.match(/^## \[([^\]]+)\]\s*-\s*\d{4}-\d{2}-\d{2}/m);
  return match ? match[1] : null;
}

function loadEvidence(artifactsDir) {
  const evidenceDir = path.join(artifactsDir, 'work', 'evidence');
  const result = [];
  if (!fs.existsSync(evidenceDir)) return result;
  for (const entry of fs.readdirSync(evidenceDir).sort()) {
    if (!entry.endsWith('.md')) continue;
    const file = path.join(evidenceDir, entry);
    const text = fs.readFileSync(file, 'utf8');
    const { frontMatter, body } = parseMarkdown(text);
    const linked = body.match(/\b(T-\d{3})\b/);
    result.push({
      file: `.codex/artifacts/work/evidence/${entry}`,
      frontMatter,
      body,
      workItemId: frontMatter.workItemId
        ? String(frontMatter.workItemId)
        : frontMatter.workItemIds
          ? Array.isArray(frontMatter.workItemIds)
            ? frontMatter.workItemIds.map(String)
            : String(frontMatter.workItemIds).split(',').map((s) => s.trim())
          : linked
            ? linked[1]
            : '',
    });
  }
  return result;
}

/**
 * Build the shared rule context for a repository root.
 */
function buildContext(root, options = {}) {
  const opts = { root: root || process.cwd(), ...options };
  const artifactsDir = opts.artifactsDir || findArtifactsDir(opts.root);

  const markdown = (rel) => {
    const text = readFileSafe(opts.root, rel);
    return text ? parseMarkdown(text) : null;
  };

  const fact = (rel) => {
    const text = readFileSafe(opts.root, rel);
    return text ? parseMarkdown(text) : null;
  };

  return {
    root: opts.root,
    artifactsDir,
    gitHead: currentGitHead(opts.root),
    isGitAncestor: (commit) => isGitAncestor(opts.root, commit),
    state: readJsonSafe(opts.root, '.codex/artifacts/state.json'),
    phaseState: markdown('.codex/artifacts/phase-state.md'),
    gatesDoc: markdown('.codex/artifacts/gates.md'),
    taskBoard: markdown('.codex/artifacts/task-board.md'),
    riskRegister: markdown('.codex/artifacts/risk-register.md'),
    decisionLog: markdown('.codex/artifacts/decision-log.md'),
    releaseManifest: readYamlSafe(opts.root, 'docs/delivery/release-manifest.yaml'),
    routeManifest: readJsonSafe(opts.root, 'openapi/route-manifest.json'),
    schemaManifest: readSchemaManifest(opts.root),
    changelogVersion: currentChangelogVersion(opts.root),
    evidence: loadEvidence(artifactsDir),
    decisions: parseDecisions(artifactsDir),
    exemptions: opts.exemptions || [],
    helpers: { parseMarkdown },
    fact,
  };
}

/**
 * Parse decision-log entries into a list of decision ids.
 */
function parseDecisions(artifactsDir) {
  const text = readFileSafe(artifactsDir, 'decision-log.md');
  if (!text) return [];
  const ids = [];
  const re = /^\|\s*(D-\d+)\s*\|/gm;
  let match;
  while ((match = re.exec(text)) !== null) {
    ids.push(match[1]);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Rule orchestration
// ---------------------------------------------------------------------------

/**
 * Run the requested rules against a context.
 * @param {object} ctx built by buildContext
 * @param {object} [opts] { rules?: string[] | null, strict?: boolean }
 * @returns {{ findings: Array, summary: object }}
 */
function runRules(ctx, opts = {}) {
  const selected = opts.rules || Object.keys(ALL_RULES);
  const findings = [];
  for (const ruleId of selected) {
    const rule = ALL_RULES[ruleId];
    if (!rule) continue;
    try {
      const result = rule(ctx) || [];
      for (const finding of result) {
        findings.push(finding);
      }
    } catch (error) {
      findings.push({
        ruleId,
        severity: 'error',
        message: `rule ${ruleId} crashed: ${error.message}`,
        path: null,
        fixable: false,
      });
    }
  }

  const errors = findings.filter((f) => f.severity === 'error');
  const warnings = findings.filter((f) => f.severity === 'warning');
  const byRule = {};
  for (const finding of findings) {
    byRule[finding.ruleId] = (byRule[finding.ruleId] || 0) + 1;
  }

  // In strict mode ANY unexempted semantic conflict (error or warning) fails
  // the run. Exemptions are per-rule and come from the context (authorized by
  // a decision-log entry, enforced by no-self-exemption).
  const exempted = new Set(ctx.exemptions || []);
  const unexempted = findings.filter((f) => !exempted.has(f.ruleId));

  return {
    findings,
    summary: {
      total: findings.length,
      errors: errors.length,
      warnings: warnings.length,
      byRule,
      pass: opts.strict ? unexempted.length === 0 : findings.length === 0,
      rulesRun: selected.length,
    },
  };
}

/**
 * Apply mechanical fixes for findings that carry a concrete `fix`.
 * @param {object} ctx built by buildContext
 * @param {Array} findings result of runRules
 * @returns {{ applied: Array, diffs: Array, skipped: Array }}
 */
function applyFixes(ctx, findings) {
  const applied = [];
  const diffs = [];
  const skipped = [];
  const seen = new Set();

  for (const finding of findings) {
    if (!finding.fixable || typeof finding.fix !== 'function') continue;
    const key = `${finding.ruleId}:${finding.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const fix = finding.fix(ctx);
      if (!fix || !fix.patched) {
        skipped.push({ ruleId: finding.ruleId, path: finding.path, reason: 'no mechanical fix' });
        continue;
      }
      const file = path.resolve(ctx.root, fix.path);
      const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : fix.original || '';
      if (original === fix.patched) {
        skipped.push({ ruleId: finding.ruleId, path: fix.path, reason: 'already applied' });
        continue;
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, fix.patched, 'utf8');
      applied.push({ ruleId: finding.ruleId, path: fix.path });
      diffs.push({
        ruleId: finding.ruleId,
        path: fix.path,
        original,
        patched: fix.patched,
      });
    } catch (error) {
      skipped.push({
        ruleId: finding.ruleId,
        path: finding.path,
        reason: `error: ${error.message}`,
      });
    }
  }
  return { applied, diffs, skipped };
}

module.exports = {
  ALL_RULES,
  RULE_META,
  applyFixes,
  buildContext,
  currentChangelogVersion,
  currentGitHead,
  findArtifactsDir,
  loadEvidence,
  readSchemaManifest,
  runRules,
};