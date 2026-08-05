'use strict';

/**
 * F61-01 semantic rules.
 *
 * Each rule is a pure function `(ctx) => finding[]`. `ctx` is the shared
 * context produced by `engine.buildContext(root)` and contains:
 *   - root, artifactsDir, gitHead
 *   - state            parsed state.json
 *   - phaseState       parseMarkdown(phase-state.md)
 *   - gatesDoc         parseMarkdown(gates.md)
 *   - taskBoard        parseMarkdown(task-board.md)
 *   - riskRegister     parseMarkdown(risk-register.md)
 *   - decisionLog      parseMarkdown(decision-log.md)
 *   - releaseManifest  parsed YAML (release-manifest.yaml)
 *   - routeManifest    parsed route-manifest.json
 *   - changelogVersion top version from CHANGELOG.md
 *   - evidence         array of normalized evidence entries
 *   - helpers          parseMarkdown etc.
 *
 * A finding:
 *   {
 *     ruleId, severity: 'error'|'warning', message, path,
 *     fixable: boolean,
 *     fix(ctx) -> { path, original, patched } | null   // optional mechanical fix
 *   }
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { parseMarkdown } = require('./parse-markdown');

// ---------------------------------------------------------------------------
// Shared extraction helpers
// ---------------------------------------------------------------------------

function collectFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      collectFiles(full, out);
    } else if (/\.(js|ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function safeRead(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

const HEAD_RE = /(?:HEAD|head)\s+([0-9a-f]{7,40})/i;

function extractHeadFromMarkdown(doc) {
  // Look for the "当前权威状态（... HEAD <sha>）" heading AND any inline HEAD marker.
  for (const section of doc.sections || []) {
    const m = section.title.match(HEAD_RE);
    if (m) return m[1];
  }
  const bodyMatch = (doc.body || '').match(HEAD_RE);
  if (bodyMatch) return bodyMatch[1];
  return null;
}

function extractTaskRows(doc) {
  const rows = [];
  for (const table of doc.tables || []) {
    const header = table.header.map(String);
    const idIdx = header.findIndex((h) => h.toLowerCase() === 'id');
    const statusIdx = header.findIndex((h) => h.toLowerCase() === 'status');
    const evidenceIdx = header.findIndex((h) => h.toLowerCase() === 'evidence');
    if (idIdx === -1 || statusIdx === -1) continue;
    for (const row of table.rows) {
      const id = String(row[idIdx] || '').trim();
      if (!/^T-\d+$/.test(id)) continue;
      rows.push({
        id,
        status: String(row[statusIdx] || '').trim(),
        section: table.section,
        evidence: evidenceIdx >= 0 ? String(row[evidenceIdx] || '').trim() : '',
      });
    }
  }
  return rows;
}

function extractGateRows(doc) {
  const rows = [];
  for (const table of doc.tables || []) {
    const header = table.header.map(String);
    const gateIdx = header.findIndex((h) => h.toLowerCase() === 'gate');
    const statusIdx = header.findIndex((h) => {
      const h2 = h.toLowerCase();
      return h2 === 'current_status' || h2 === 'status';
    });
    if (gateIdx === -1 || statusIdx === -1) continue;
    for (const row of table.rows) {
      const id = String(row[gateIdx] || '').trim();
      if (!/^G\d+$/.test(id)) continue;
      rows.push({
        id,
        status: String(row[statusIdx] || '').trim(),
      });
    }
  }
  return rows;
}

function extractRiskRows(doc) {
  const rows = [];
  for (const table of doc.tables || []) {
    const header = table.header.map(String);
    const idIdx = header.findIndex((h) => h.toLowerCase() === 'id');
    const riskIdx = header.findIndex((h) => h.toLowerCase() === 'risk');
    const mitigationIdx = header.findIndex((h) => {
      const h2 = String(h).toLowerCase().replace(/[_\s]+/g, ' ');
      return h2 === 'current mitigation' || h2 === 'mitigation';
    });
    const levelIdx = header.findIndex((h) => h.toLowerCase() === 'level');
    if (idIdx === -1 || riskIdx === -1) continue;
    for (const row of table.rows) {
      const id = String(row[idIdx] || '').trim();
      if (!/^R-\d+$/.test(id)) continue;
      rows.push({
        id,
        risk: String(row[riskIdx] || '').trim(),
        mitigation: mitigationIdx >= 0 ? String(row[mitigationIdx] || '').trim() : '',
        level: levelIdx >= 0 ? String(row[levelIdx] || '').trim() : '',
      });
    }
  }
  return rows;
}

function countRouteOperations(routeManifest) {
  if (!routeManifest) return 0;
  if (Array.isArray(routeManifest.controllerKeys)) {
    return routeManifest.controllerKeys.length;
  }
  if (Array.isArray(routeManifest.routes)) {
    return routeManifest.routes.length;
  }
  return 0;
}

function extractCountValue(input) {
  if (!input) return null;
  const m = String(input).match(/(\d+)\/(\d+)/);
  if (m) return m[1];
  const t = String(input).match(/(\d+)\s+suites?\s*\/\s*(\d+)\s+tests?/);
  if (t) return t[2];
  return null;
}

function parseCommitSha(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * Locate the authoritative `final_authoritative` block. It currently lives under
 * `verification_state.final_authoritative` in state.json, but older state files
 * placed it at the top level, so both are accepted.
 */
function authoritativeFinal(ctx) {
  const state = ctx.state || {};
  return (
    (state.verification_state && state.verification_state.final_authoritative) ||
    state.final_authoritative ||
    {}
  );
}

/**
 * Extract the claimed DB table counts (managed / physical) from the
 * authoritative state and phase-state text, e.g. "51 managed tables /
 * 57 physical tables". These figures are NOT yet independently verified.
 */
function findClaimedDbCount(ctx) {
  const sources = [];
  if (ctx.state) sources.push(JSON.stringify(ctx.state));
  if (ctx.phaseState) sources.push(ctx.phaseState.body || '');
  const text = sources.join('\n');
  // Prefer the combined "N managed tables / M physical tables" form, which is
  // the authoritative claim (e.g. phase-state.md "51 managed tables /
  // 57 physical tables"). Avoid matching historical decision-log entries such
  // as "D-002 ... = 48 managed tables".
  const combined = text.match(/(\d+)\s+managed tables?\s*\/\s*(\d+)\s+physical tables?/);
  if (combined) {
    return { managed: Number(combined[1]), physical: Number(combined[2]) };
  }
  // Fallback: separate matches, preferring the LAST occurrence (later in the
  // document is more likely the authoritative claim rather than a historical
  // snapshot).
  let managed = null;
  let physical = null;
  for (const m of text.matchAll(/(\d+)\s+managed tables?/g)) managed = Number(m[1]);
  for (const m of text.matchAll(/(\d+)\s+physical tables?/g)) physical = Number(m[1]);
  if (managed === null && physical === null) return null;
  return { managed, physical };
}

/**
 * Whether a runtime tool (docker / kubectl / helm) is present on PATH.
 */
function toolAvailable(tool) {
  try {
    execFileSync('which', [tool], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a fingerprint of the current runtime environment from process.env and
 * the availability of container/orchestration tools. Pilot results are only
 * authoritative when they are bound to the same environment they were produced
 * under.
 */
function buildEnvFingerprint() {
  const parts = [];
  if (process.env.EWOH_DATABASE_URL) parts.push('db');
  if (process.env.EWOH_RUNTIME_DATABASE_URL) parts.push('runtime-db');
  if (process.env.EWOH_PILOT_FACTORY_NAME) {
    parts.push(`factory:${process.env.EWOH_PILOT_FACTORY_NAME}`);
  }
  for (const tool of ['docker', 'kubectl', 'helm']) {
    if (toolAvailable(tool)) parts.push(tool);
  }
  return parts.length > 0 ? parts.join('+') : 'no-runtime-env';
}

/**
 * Find the environment fingerprint a pilot readiness result was recorded
 * under. Returns null when the result is not bound to any fingerprint.
 */
function findRecordedFingerprint(ctx) {
  const state = ctx.state || {};
  const auth =
    (state.verification_state && state.verification_state.final_authoritative) ||
    state.final_authoritative ||
    {};
  const candidates = [
    auth.pilotEnvironment,
    auth.pilotEnvFingerprint,
    auth.pilotEnvironmentFingerprint,
    auth.environmentFingerprint,
    auth.envFingerprint,
  ];
  for (const c of candidates) {
    if (c && String(c).trim() !== '') return String(c).trim();
  }
  // Scan pilot-related verification_state strings for an inline fingerprint.
  const vs = state.verification_state || {};
  for (const key of Object.keys(vs)) {
    if (!/pilot|readiness/i.test(key)) continue;
    const val = String(vs[key] || '');
    const fm = val.match(/fingerprint\s*[:=]\s*["']?([A-Za-z0-9_+.:-]+)["']?/i);
    if (fm) return fm[1];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rule implementations
// ---------------------------------------------------------------------------

/**
 * head-consistency: the authoritative HEAD declared in phase-state.md / gates.md
 * must match the actual git HEAD of the repository.
 *
 * Live-reference marker: a doc may declare `HEAD @git-head` (or `<git-head>`)
 * instead of a concrete SHA. `@git-head` is a *live* reference to the runtime git
 * HEAD, so it is inherently consistent by construction and never goes stale when
 * the next commit lands. `HEAD_RE` only matches hex SHAs, so `extractHeadFromMarkdown`
 * returns null for such a marker and the doc is simply skipped below (no SHA
 * comparison). A doc that hard-codes a real SHA that differs from git HEAD is
 * still an error — this rule keeps its drift-detection for hard-coded SHAs.
 */
function headConsistency(ctx) {
  const findings = [];
  const declared = []; // { sha, rel }
  for (const rel of ['.codex/artifacts/phase-state.md', '.codex/artifacts/gates.md']) {
    const doc = rel.includes('phase-state') ? ctx.phaseState : ctx.gatesDoc;
    const sha = extractHeadFromMarkdown(doc);
    if (sha) declared.push({ sha: sha.toLowerCase(), rel });
  }
  const actual = parseCommitSha(ctx.gitHead);
  if (!actual) return findings;
  if (declared.length === 0) return findings;
  for (const { sha, rel } of declared) {
    if (sha !== actual) {
      findings.push({
        ruleId: 'head-consistency',
        severity: 'error',
        message: `declared HEAD ${sha} differs from actual git HEAD ${actual}`,
        path: rel,
        fixable: true,
        fix(ctx2) {
          // Deterministic mechanical fix: replace every declared HEAD marker
          // (section title or inline "HEAD <sha>") with the actual git HEAD.
          const file = path.join(ctx2.root, rel);
          const text = fs.readFileSync(file, 'utf8');
          const patched = text.replace(
            new RegExp(`HEAD\\s+${sha}`, 'ig'),
            `HEAD ${ctx2.gitHead}`,
          );
          return patched === text
            ? null
            : { path: rel, original: text, patched };
        },
      });
    }
  }
  return findings;
}

/**
 * task-section-status: a task-board section whose header still claims
 * "(current)" / "In Progress" / "started" but every task in it is Done is a
 * stale section marker.
 */
function taskSectionStatus(ctx) {
  const findings = [];
  const rows = extractTaskRows(ctx.taskBoard);
  const bySection = new Map();
  for (const row of rows) {
    if (!row.section) continue;
    if (!bySection.has(row.section)) bySection.set(row.section, []);
    bySection.get(row.section).push(row);
  }
  const staleSections = [];
  for (const [section, tasks] of bySection) {
    const marker = section.toLowerCase();
    // Active markers may be wrapped in parens ("(current)", "(in progress)",
    // "(started)", "(active)", "(refining)") or appear as a bare status word
    // in the heading ("## Wave ... - Refining", "## Wave ... In Progress").
    // Detect both forms.
    const isActive = /\(current\)|\(in progress\)|\(started\)|\(active\)|\(refining\)|\b(in progress|current|started|active|refining)\b/.test(
      marker,
    );
    if (!isActive) continue;
    const allDone = tasks.length > 0 && tasks.every((t) => t.status === 'Done');
    if (allDone) {
      staleSections.push(section);
      findings.push({
        ruleId: 'task-section-status',
        severity: 'error',
        message: `section "${section}" is marked active but all ${tasks.length} tasks are Done`,
        path: '.codex/artifacts/task-board.md',
        fixable: true,
        fix(ctx2) {
          // Mechanical fix: for every fully-Done section whose header still
          // claims (current)/(in progress)/(started)/(active), rewrite the
          // marker to (done). Deterministic from the task statuses.
          const text = fs.readFileSync(
            path.join(ctx2.root, '.codex/artifacts/task-board.md'),
            'utf8',
          );
          let patched = text;
          for (const sec of staleSections) {
            // Strip the trailing active marker " (…)" from the raw, unescaped
            // heading first, then escape the base so the trailing "\" from the
            // escaped parens cannot corrupt the regex.
            const base = sec.replace(/\s*\([^)]*\)\s*$/, '');
            const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp(`(#{1,6}\\s+${escaped})\\s*\\(([^)]*)\\)`, '');
            patched = patched.replace(re, (all, prefix, marker) => {
              const m = marker.toLowerCase();
              return /(current|in progress|started|active|refining)/.test(m)
                ? `${prefix} (done)`
                : all;
            });
          }
          return patched === text
            ? null
            : {
                path: '.codex/artifacts/task-board.md',
                original: text,
                patched,
              };
        },
      });
    }
  }
  return findings;
}

/**
 * gate-release-ready: a release must not be declared Completed / Scale Ready /
 * Production Ready while any of the approval gates G10-G13 is not passed.
 */
function gateReleaseReady(ctx) {
  const findings = [];
  const manifest = ctx.releaseManifest || {};
  const status = String(manifest.status || '').toLowerCase();
  const isReady = /completed|scale ready|production ready|ready/i.test(status);
  if (!isReady) return findings;

  const gates = extractGateRows(ctx.gatesDoc);
  const gateMap = new Map(gates.map((g) => [g.id, g.status]));
  const failing = [];
  for (const id of ['G10', 'G11', 'G12', 'G13']) {
    const value = String(gateMap.get(id) || '').toLowerCase();
    const passed = /passed/.test(value) && !/not passed|pending/.test(value);
    if (!passed) failing.push(id);
  }
  if (failing.length > 0) {
    findings.push({
      ruleId: 'gate-release-ready',
      severity: 'error',
      message: `release status "${manifest.status}" requires passed gates but ${failing.join(', ')} are not passed`,
      path: 'docs/delivery/release-manifest.yaml',
      fixable: false,
    });
  }
  return findings;
}

/**
 * risk-unreviewed: a risk whose mitigation claims a fix has landed in code
 * (implemented/fixed/passed/closed) but that has no independent review marker
 * is flagged as a warning (not an error). Additionally, a risk that is marked
 * closed (status implying Closed/Done/Resolved) must carry independent evidence
 * (reviewedAt / reviewer / resolutionEvidence) — otherwise it is flagged as a
 * warning and must not be auto-closed.
 */
function riskUnreviewed(ctx) {
  const findings = [];
  const rows = extractRiskRows(ctx.riskRegister);
  const FIX_VERBS = /implemented|fixed|passed|verified|closed|checked|resolved/i;
  const CLOSED_STATUS = /\b(closed|done|resolved)\b/i;
  const REVIEW_MARKERS = /reviewed|reviewedat|reviewer|independent|resolutionevidence|val-|accepted|signed|sign-off|signoff/i;
  const EVIDENCE_FIELDS = /reviewedat|reviewer|resolutionevidence|reviewed|independent|val-|accepted|sign-off|signoff/i;
  for (const row of rows) {
    const combined = `${row.level} ${row.mitigation}`;
    if (FIX_VERBS.test(combined)) {
      // A review marker would be "reviewed"/"independent"/"VAL-"/"ACCEPTED".
      const reviewed = REVIEW_MARKERS.test(row.mitigation);
      if (!reviewed) {
        findings.push({
          ruleId: 'risk-unreviewed',
          severity: 'warning',
          message: `risk ${row.id} mitigation claims a fix landed but has no independent review marker`,
          path: '.codex/artifacts/risk-register.md',
          fixable: false,
        });
      }
    }
    // A risk whose status implies closed must not be auto-closed without
    // independent evidence fields in the mitigation column.
    if (CLOSED_STATUS.test(combined) && !EVIDENCE_FIELDS.test(row.mitigation)) {
      findings.push({
        ruleId: 'risk-unreviewed',
        severity: 'warning',
        message: `risk ${row.id} is marked closed but its mitigation lacks reviewedAt/reviewer/resolutionEvidence evidence`,
        path: '.codex/artifacts/risk-register.md',
        fixable: false,
      });
    }
  }
  return findings;
}

/**
 * counts-generative: the route count in the generated route manifest must match
 * the counts declared in state.json and the release manifest. Also verifies the
 * DB table count (schema-manifest vs the unverified 51 managed / 57 physical
 * claim), the presence of machine-generated test counts in final_authoritative,
 * and that any confirmed DB count claim is properly marked `unverified`.
 */
function countsGenerative(ctx) {
  const findings = [];
  const finalAuth = authoritativeFinal(ctx);

  // ---- OpenAPI route count (preserve existing behavior) ----
  const routeCount = countRouteOperations(ctx.routeManifest);
  if (routeCount !== 0) {
    const declared = [];
    const state = ctx.state || {};
    const stateOpenApi = extractCountValue((state.final_authoritative || {}).openapi);
    if (stateOpenApi) declared.push(stateOpenApi);
    const manifest = ctx.releaseManifest || {};
    const manifestOpenApi = extractCountValue(manifest.evidence && manifest.evidence.openapi);
    if (manifestOpenApi) declared.push(manifestOpenApi);
    for (const d of declared) {
      if (String(routeCount) !== String(d)) {
        findings.push({
          ruleId: 'counts-generative',
          severity: 'error',
          message: `route manifest declares ${routeCount} operations but authoritative count is ${d}`,
          path: 'openapi/route-manifest.json',
          fixable: false,
        });
      }
    }
  }

  // ---- DB table count ----
  // The schema-manifest is the generative DDL source; its managed_count is the
  // actually-generated count. The "51 managed / 57 physical" figure claims in
  // state.json / phase-state.md are NOT yet independently verified, so a
  // difference is a warning, not an error.
  const schemaManifest = ctx.schemaManifest;
  const schemaCount = schemaManifest && schemaManifest.managed_count;
  const claimed = findClaimedDbCount(ctx);
  if (schemaCount && claimed && (claimed.managed !== null || claimed.physical !== null)) {
    const managedClaimed = claimed.managed !== null ? claimed.managed : schemaCount;
    if (Number(schemaCount) !== Number(managedClaimed)) {
      findings.push({
        ruleId: 'counts-generative',
        severity: 'warning',
        message: `schema-manifest managed_count is ${schemaCount} but authoritative state claims ${claimed.managed} managed / ${claimed.physical} physical tables (unverified, must not be treated as confirmed)`,
        path: 'db/contracts/schema-manifest.yaml',
        fixable: false,
      });
    }
  }

  // ---- Test counts presence ----
  const testFields = ['serverJest', 'clientJest', 'e2e', 'browser'];
  for (const field of testFields) {
    if (!finalAuth[field] || String(finalAuth[field]).trim() === '') {
      findings.push({
        ruleId: 'counts-generative',
        severity: 'warning',
        message: `final_authoritative is missing the machine-generated ${field} test count`,
        path: '.codex/artifacts/state.json',
        fixable: false,
      });
    }
  }

  // ---- Confirmed DB count must be marked unverified ----
  // If final_authoritative claims a confirmed "51 managed tables / 57 physical
  // tables" count without an `unverified` marker, flag it.
  const authText = JSON.stringify(finalAuth);
  if (/51\s+managed\s+tables?\s*\/\s*57\s+physical/.test(authText) && !/unverified/i.test(authText)) {
    findings.push({
      ruleId: 'counts-generative',
      severity: 'warning',
      message: 'final_authoritative claims 51 managed / 57 physical tables as confirmed but the figure is unverified and must be marked unverified',
      path: '.codex/artifacts/state.json',
      fixable: false,
    });
  }

  return findings;
}

/**
 * pilot-env-fingerprint: Pilot Readiness results must be bound to the runtime
 * environment fingerprint they were produced under. If the recorded fingerprint
 * is missing or does not match the current environment, the result must not be
 * treated as authoritative (warning, not error).
 */
function pilotEnvFingerprint(ctx) {
  const findings = [];
  const state = ctx.state || {};
  const auth =
    (state.verification_state && state.verification_state.final_authoritative) ||
    state.final_authoritative ||
    {};
  const pilot = auth.pilotReadiness;
  if (!pilot || String(pilot).trim() === '') return findings;

  const recorded = findRecordedFingerprint(ctx);
  const current = buildEnvFingerprint();
  if (!recorded) {
    findings.push({
      ruleId: 'pilot-env-fingerprint',
      severity: 'warning',
      message: `pilot readiness ('${pilot}') is not bound to an environment fingerprint; it must not be treated as authoritative`,
      path: '.codex/artifacts/state.json',
      fixable: false,
    });
  } else if (recorded !== current) {
    findings.push({
      ruleId: 'pilot-env-fingerprint',
      severity: 'warning',
      message: `pilot readiness ('${pilot}') is bound to environment '${recorded}' but the current environment fingerprint is '${current}'; it must not be treated as authoritative`,
      path: '.codex/artifacts/state.json',
      fixable: false,
    });
  }
  return findings;
}

/**
 * evidence-incomplete: each evidence file must carry the required machine
 * readable front matter fields.
 */
function evidenceIncomplete(ctx) {
  const findings = [];
  // The canonical evidence front-matter schema uses commitSha / envFingerprint
  // (or environment) / testTime (or generatedAt) / verifier / expiresAt.
  const REQUIRED = [
    ['commitSha'],
    ['environment', 'envFingerprint'],
    ['verifier'],
    ['generatedAt', 'testTime', 'startedAt'],
    ['expiresAt'],
  ];
  for (const entry of ctx.evidence || []) {
    const fm = entry.frontMatter || {};
    const missing = [];
    for (const group of REQUIRED) {
      if (!group.some((field) => fm[field] !== undefined && fm[field] !== null && fm[field] !== '')) {
        missing.push(group.join('|'));
      }
    }
    if (missing.length > 0) {
      findings.push({
        ruleId: 'evidence-incomplete',
        severity: 'error',
        message: `evidence ${entry.file} missing required front matter: ${missing.join(', ')}`,
        path: entry.file,
        fixable: false,
      });
    }
  }
  return findings;
}

/**
 * evidence-invalid: evidence is invalid when it is expired (expiresAt in the
 * past), bound to a commit that is not in the current git history (stale /
 * unreachable), or bound to a different environment fingerprint.
 */
function evidenceInvalid(ctx) {
  const findings = [];
  const now = Date.now();
  for (const entry of ctx.evidence || []) {
    const fm = entry.frontMatter || {};
    const reasons = [];
    if (fm.expiresAt) {
      const t = Date.parse(fm.expiresAt);
      if (!Number.isNaN(t) && t <= now) {
        reasons.push(`expired at ${fm.expiresAt}`);
      }
    }
    if (fm.commitSha && !ctx.isGitAncestor(fm.commitSha)) {
      reasons.push(`commit ${fm.commitSha} is not in the current git history`);
    }
    if (reasons.length > 0) {
      findings.push({
        ruleId: 'evidence-invalid',
        severity: 'error',
        message: `evidence ${entry.file} is invalid: ${reasons.join('; ')}`,
        path: entry.file,
        fixable: false,
      });
    }
  }
  return findings;
}

/**
 * planned-next: state.json subagent_state.planned_next must not reference a
 * task that is already Done, Cancelled, or does not exist in the task board.
 */
function plannedNext(ctx) {
  const findings = [];
  const state = ctx.state || {};
  const plannedNext = (state.subagent_state && state.subagent_state.planned_next) || [];
  const taskRows = extractTaskRows(ctx.taskBoard);
  const statusByTask = new Map(taskRows.map((t) => [t.id, t.status]));
  for (const item of plannedNext) {
    const text = String(item || '');
    const ids = text.match(/T-\d+/g) || [];
    for (const id of ids) {
      const status = statusByTask.get(id);
      if (status === 'Done') {
        findings.push({
          ruleId: 'planned-next',
          severity: 'error',
          message: `planned_next references ${id} which is already Done`,
          path: '.codex/artifacts/state.json',
          fixable: false,
        });
      } else if (status === 'Cancelled') {
        findings.push({
          ruleId: 'planned-next',
          severity: 'error',
          message: `planned_next references ${id} which is Cancelled`,
          path: '.codex/artifacts/state.json',
          fixable: false,
        });
      } else if (!statusByTask.has(id)) {
        findings.push({
          ruleId: 'planned-next',
          severity: 'error',
          message: `planned_next references ${id} which does not exist in the task board`,
          path: '.codex/artifacts/state.json',
          fixable: false,
        });
      }
    }
  }
  return findings;
}

/**
 * version-consistency: CHANGELOG, release-manifest and state.json must agree on
 * the current release version.
 */
function versionConsistency(ctx) {
  const findings = [];
  const changelog = ctx.changelogVersion;
  const manifest = ctx.releaseManifest || {};
  const manifestVersion = manifest.release;
  const state = ctx.state || {};
  const stateText = JSON.stringify(state);

  if (changelog && manifestVersion && changelog !== manifestVersion) {
    findings.push({
      ruleId: 'version-consistency',
      severity: 'error',
      message: `CHANGELOG version ${changelog} differs from release-manifest version ${manifestVersion}`,
      path: 'CHANGELOG.md',
      fixable: false,
    });
  }
  if (manifestVersion && !stateText.includes(String(manifestVersion))) {
    findings.push({
      ruleId: 'version-consistency',
      severity: 'error',
      message: `release-manifest version ${manifestVersion} is not declared in state.json`,
      path: 'docs/delivery/release-manifest.yaml',
      fixable: false,
    });
  }
  return findings;
}

/**
 * task-evidence-missing: a Done task must carry at least one evidence binding.
 */
function taskEvidenceMissing(ctx) {
  const findings = [];
  const rows = extractTaskRows(ctx.taskBoard);
  const evidenceFiles = new Set((ctx.evidence || []).map((e) => e.workItemId));
  for (const row of rows) {
    if (row.status !== 'Done') continue;
    const hasEvidenceText = row.evidence && row.evidence.trim().length > 0;
    const hasEvidenceFile = evidenceFiles.has(row.id);
    if (!hasEvidenceText && !hasEvidenceFile) {
      findings.push({
        ruleId: 'task-evidence-missing',
        severity: 'warning',
        message: `Done task ${row.id} has no evidence binding`,
        path: '.codex/artifacts/task-board.md',
        fixable: false,
      });
    }
  }
  return findings;
}

/**
 * workgraph-count-drift: the authoritative work-graph summary (missing evidence
 * and gates-need-approval counts) declared in state.json must match the counts
 * freshly computed by the work-console engine from the authoritative artifacts.
 * Because these are machine-generated counts, declaring a stale copied number
 * is a single-source-of-truth drift.
 */
function workgraphCountDrift(ctx) {
  const findings = [];
  const state = ctx.state || {};
  const auth =
    (state.verification_state && state.verification_state.final_authoritative) ||
    state.final_authoritative ||
    {};
  const declared = String(auth.workGraph || '');
  const declaredMissing = declared.match(/(\d+)\s+missing evidence/);
  const declaredApproval = declared.match(/(\d+)\s+gates need approval/);
  if (!declaredMissing) return findings;

  // Compute the live counts from the same authoritative artifacts.
  let liveMissing = null;
  let liveApproval = null;
  try {
    const workIndexer = require('../../work-indexer/index.js');
    const workConsole = require('../../work-console/index.js');
    const artifactsDir = workIndexer.findArtifactsDir(ctx.root);
    const graph = workIndexer.indexWorkGraph(artifactsDir, { root: ctx.root });
    const summary = workConsole.computeGraphSummary(graph, artifactsDir);
    liveMissing = summary.missingEvidence.length;
    liveApproval = summary.gateSummary.requiresApproval.length;
  } catch (err) {
    findings.push({
      ruleId: 'workgraph-count-drift',
      severity: 'error',
      message: `could not compute live work-graph counts: ${err.message}`,
      path: '.codex/artifacts/state.json',
      fixable: false,
    });
    return findings;
  }

  if (String(liveMissing) !== String(declaredMissing[1])) {
    findings.push({
      ruleId: 'workgraph-count-drift',
      severity: 'error',
      message: `state declares ${declaredMissing[1]} missing evidence but live work-console computes ${liveMissing}`,
      path: '.codex/artifacts/state.json',
      fixable: false,
    });
  }
  if (declaredApproval && String(liveApproval) !== String(declaredApproval[1])) {
    findings.push({
      ruleId: 'workgraph-count-drift',
      severity: 'error',
      message: `state declares ${declaredApproval[1]} gates need approval but live work-console computes ${liveApproval}`,
      path: '.codex/artifacts/state.json',
      fixable: false,
    });
  }
  return findings;
}

/**
 * console-no-direct-fix: the UI / console must not directly modify
 * authoritative source files. Static scan of the work-console tool and the
 * WorkOrchestration client for any fs write targeting `.codex/artifacts`.
 */
function consoleNoDirectFix(ctx) {
  const findings = [];
  const targets = [
    path.join(ctx.root, 'tools/work-console'),
    path.join(ctx.root, 'ewoh-spark-app/client/src/pages/WorkOrchestration'),
  ];
  // Match a write API call whose *target path argument* resolves into the
  // authoritative artifacts directory. A write to an unrelated output path
  // (e.g. work-console --output) is NOT a violation.
  const WRITE_CALL_RE =
    /fs\.(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream)\s*\(\s*([^,\n]*)/g;
  const ARTIFACT_WRITE_RE =
    /\.codex[\\/]artifacts|artifacts[\\/]work|artifactsDir|artifacts-work|artifacts_work/i;
  for (const dir of targets) {
    let entries = [];
    try {
      entries = collectFiles(dir);
    } catch (err) {
      continue;
    }
    for (const file of entries) {
      const text = safeRead(file);
      if (!text) continue;
      let match;
      WRITE_CALL_RE.lastIndex = 0;
      while ((match = WRITE_CALL_RE.exec(text)) !== null) {
        const targetArg = match[1] || '';
        // Ignore writes that clearly target a user-supplied output path
        // (options.output / path.resolve(output) / stdout).
        if (/options\.output|output|process\.stdout/i.test(targetArg)) continue;
        if (ARTIFACT_WRITE_RE.test(targetArg)) {
          findings.push({
            ruleId: 'console-no-direct-fix',
            severity: 'error',
            message: `console/UI writes directly to authoritative artifacts: ${file}`,
            path: file,
            fixable: false,
          });
          break;
        }
      }
    }
  }
  return findings;
}

/**
 * no-self-exemption: high-risk semantic conflicts must not be exempted by the
 * implementation agent. A high-risk rule (1-4, 6-8) may only be exempted if a
 * D-numbered decision-log entry explicitly authorizes the exemption; otherwise
 * its findings remain errors.
 */
function noSelfExemption(ctx) {
  const findings = [];
  const highRisk = new Set([
    'head-consistency',
    'task-section-status',
    'gate-release-ready',
    'planned-next',
    'evidence-incomplete',
    'evidence-invalid',
    'counts-generative',
  ]);
  const decisions = (ctx.decisions || []).map((d) => String(d.id || d || ''));
  const authorized = new Set();
  for (const decision of decisions) {
    const text = String(decision).toLowerCase();
    if (text.includes('exempt') || text.includes('semantic') || text.includes('waive')) {
      authorized.add(decision.toUpperCase());
    }
  }
  const exemptions = ctx.exemptions || [];
  for (const ruleId of exemptions) {
    if (!highRisk.has(ruleId)) continue;
    const ruleDecision = decisions.find(
      (d) => String(d).toUpperCase().startsWith('D-') && authorized.has(String(d).toUpperCase()),
    );
    if (!ruleDecision) {
      findings.push({
        ruleId: 'no-self-exemption',
        severity: 'error',
        message: `high-risk rule "${ruleId}" is exempted without an authorized decision-log entry`,
        path: '.codex/artifacts/decision-log.md',
        fixable: false,
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Meta + registry
// ---------------------------------------------------------------------------

const RULE_META = {
  'head-consistency': {
    id: 'head-consistency',
    name: 'HEAD consistency',
    severity: 'error',
    description: 'Declared authoritative HEAD must match actual git HEAD.',
  },
  'task-section-status': {
    id: 'task-section-status',
    name: 'Task section status',
    severity: 'error',
    description: 'A section marked active must not have all tasks Done.',
  },
  'gate-release-ready': {
    id: 'gate-release-ready',
    name: 'Gate release readiness',
    severity: 'error',
    description: 'A Completed/Scale Ready release requires passed G10-G13 gates.',
  },
  'risk-unreviewed': {
    id: 'risk-unreviewed',
    name: 'Risk unreviewed',
    severity: 'warning',
    description: 'A risk whose mitigation claims a fix landed should have review marker.',
  },
  'counts-generative': {
    id: 'counts-generative',
    name: 'Generative count drift',
    severity: 'error',
    description: 'Generated route counts must match authoritative counts.',
  },
  'evidence-incomplete': {
    id: 'evidence-incomplete',
    name: 'Evidence incomplete',
    severity: 'error',
    description: 'Evidence files must carry required front matter fields.',
  },
  'evidence-invalid': {
    id: 'evidence-invalid',
    name: 'Evidence invalid',
    severity: 'error',
    description: 'Expired or stale-commit evidence is automatically invalid.',
  },
  'planned-next': {
    id: 'planned-next',
    name: 'Planned next',
    severity: 'error',
    description: 'planned_next must not reference a Done task.',
  },
  'version-consistency': {
    id: 'version-consistency',
    name: 'Version consistency',
    severity: 'error',
    description: 'CHANGELOG, release-manifest and state must agree on version.',
  },
  'task-evidence-missing': {
    id: 'task-evidence-missing',
    name: 'Task evidence missing',
    severity: 'warning',
    description: 'A Done task must carry at least one evidence binding.',
  },
  'console-no-direct-fix': {
    id: 'console-no-direct-fix',
    name: 'Console/UI no direct fix',
    severity: 'error',
    description: 'UI/console must not write directly to authoritative artifacts.',
  },
  'no-self-exemption': {
    id: 'no-self-exemption',
    name: 'No self-exemption',
    severity: 'error',
    description: 'High-risk conflicts must not be exempted without an authorized decision-log entry.',
  },
  'pilot-env-fingerprint': {
    id: 'pilot-env-fingerprint',
    name: 'Pilot environment fingerprint',
    severity: 'warning',
    description: 'Pilot Readiness results must be bound to the runtime environment fingerprint they were produced under.',
  },
  'workgraph-count-drift': {
    id: 'workgraph-count-drift',
    name: 'Work graph count drift',
    severity: 'error',
    description: 'Declared missing-evidence / gates-need-approval counts must match the live work-console computation.',
  },
};

const ALL_RULES = {
  'head-consistency': headConsistency,
  'task-section-status': taskSectionStatus,
  'gate-release-ready': gateReleaseReady,
  'risk-unreviewed': riskUnreviewed,
  'counts-generative': countsGenerative,
  'evidence-incomplete': evidenceIncomplete,
  'evidence-invalid': evidenceInvalid,
  'planned-next': plannedNext,
  'version-consistency': versionConsistency,
  'task-evidence-missing': taskEvidenceMissing,
  'console-no-direct-fix': consoleNoDirectFix,
  'no-self-exemption': noSelfExemption,
  'pilot-env-fingerprint': pilotEnvFingerprint,
  'workgraph-count-drift': workgraphCountDrift,
};

module.exports = {
  ALL_RULES,
  RULE_META,
  extractGateRows,
  extractHeadFromMarkdown,
  extractRiskRows,
  extractTaskRows,
  parseMarkdown,
};