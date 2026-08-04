'use strict';

/**
 * F61-01 drift-fixture test runner.
 *
 * Traverses every directory under ./fixtures/ (each a minimal, self-contained
 * fake repo that reproduces one semantic drift), runs the engine's strict mode
 * against it, and asserts that strict mode returns a non-zero exit code (i.e.
 * the drift is caught as a conflict). For fixtures whose drift is mechanically
 * fixable (head-consistency, task-section-status) it additionally verifies the
 * fix-closure: --fix --strict then a fresh --strict must both exit 0.
 *
 * Fixtures are run on their pristine checkout; the fix-closure step operates on
 * a throwaway temp copy so the committed fixtures are never mutated.
 *
 * Usage:
 *   node tools/semantic-rules/run-fixtures.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const INDEX_JS = path.join(__dirname, 'index.js');

// Fixtures whose drift is mechanically fixable. For these we also prove the
// fix-closure (strict returns 0 after --fix). All other fixtures are verified
// for "strict non-zero" only, because their rules are not auto-fixable.
const FIXABLE = new Set([
  'fixture-01-stale-head',
  'fixture-02-task-done-section-inprogress',
]);

// Extra CLI args injected for a specific fixture. fixture-13 reproduces the
// no-self-exemption scenario: a high-risk drift (head-consistency) plus an
// exemption request for that rule, but with NO authorized decision-log entry.
// Passing `--exempt head-consistency` makes the no-self-exemption rule fire.
const EXTRA_ARGS = {
  'fixture-13-no-self-exemption': ['--exempt', 'head-consistency'],
};

function runNode(args, cwd) {
  try {
    const stdout = execFileSync(process.execPath, args, { cwd, encoding: 'utf8' });
    return { exit: 0, stdout };
  } catch (err) {
    return { exit: err.status === undefined ? 1 : err.status, stdout: err.stdout || '' };
  }
}

function copyFixture(src, prefix) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  return dest;
}

/**
 * Copy a fixture to a throwaway temp dir and initialize it as a fresh git repo
 * with a single commit. The committed fixtures on disk are plain files (no
 * embedded .git), but the head-consistency rule needs a real git HEAD, so we
 * mint one here at runtime. This keeps the repo clean while the fixtures stay
 * self-contained and CI-portable.
 */
function gitBackedFixture(src, prefix) {
  const dest = copyFixture(src, prefix);
  execFileSync('git', ['init', '-q'], { cwd: dest, stdio: 'ignore' });
  execFileSync('git', ['add', '-A'], { cwd: dest, stdio: 'ignore' });
  execFileSync(
    'git',
    ['-c', 'user.email=fixture@test', '-c', 'user.name=Fixture', 'commit', '-qm', 'fixture'],
    { cwd: dest, stdio: 'ignore' },
  );
  return dest;
}

function main() {
  const fixtures = fs
    .readdirSync(FIXTURES_DIR)
    .filter(
      (name) =>
        name.startsWith('fixture-') &&
        fs.statSync(path.join(FIXTURES_DIR, name)).isDirectory(),
    )
    .sort();

  let passed = 0;
  let failed = 0;
  const lines = [];

  for (const name of fixtures) {
    const abs = path.join(FIXTURES_DIR, name);

    // 1) Drift check: strict mode must report the conflict => non-zero exit.
    //    Run against a throwaway git-backed copy so the committed fixture files
    //    stay plain (no embedded .git) while head-consistency gets a real HEAD.
    const extra = EXTRA_ARGS[name] || [];
    const driftTmp = gitBackedFixture(abs, 'semantic-rules-drift-');
    const drift = runNode([INDEX_JS, '--root', driftTmp, '--strict', ...extra], __dirname);
    fs.rmSync(driftTmp, { recursive: true, force: true });
    const driftOk = drift.exit !== 0;

    // 2) Fix closure (only for mechanically fixable fixtures).
    let closure = null;
    if (FIXABLE.has(name)) {
      const tmp = copyFixture(abs, 'semantic-rules-fix-');
      const fixed = runNode([INDEX_JS, '--root', tmp, '--fix', '--strict'], __dirname);
      const after = runNode([INDEX_JS, '--root', tmp, '--strict'], __dirname);
      fs.rmSync(tmp, { recursive: true, force: true });
      closure = {
        ok: fixed.exit === 0 && after.exit === 0,
        fixExit: fixed.exit,
        recheckExit: after.exit,
      };
    } else {
      closure = { ok: true, skipped: true };
    }

    const ok = driftOk && closure.ok;
    if (ok) passed += 1;
    else failed += 1;

    const closeTxt = closure.skipped
      ? 'fix-closure skipped (non-fixable)'
      : `fix-closure fix=${closure.fixExit} recheck=${closure.recheckExit}`;
    lines.push(
      `${ok ? 'PASS' : 'FAIL'}  ${name}  (drift strict exit=${drift.exit}) ${closeTxt}`,
    );
  }

  for (const line of lines) console.log(line);
  console.log(`\n${passed}/${fixtures.length} PASSED`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main();
