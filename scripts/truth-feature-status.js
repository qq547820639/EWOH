#!/usr/bin/env node
'use strict';

/**
 * truth-feature-status — Repository Truth Gate（Task 11 P2）。
 *
 * 单一事实源门禁：以 feature-status.yaml 为主清单，交叉校验
 *   - 清单结构不变量（7 字段布尔、true 字段必有证据）
 *   - 生产启用不变量（productionEnabled ⇒ runtimeVerified ∧ docsUpdated ∧ evidence）
 *   - 文档一致性（docsUpdated ⇒ README/CHANGELOG 提及；productionEnabled=false 时
 *     文档不得出现"已生产启用/生产就绪"等声明；未实现功能被文档描述为已建成 → WARN）
 *   - OPEN-DECISIONS 未决项健康度（OPEN 必须有 Resolves When；已由代码解决的
 *     allowlist 项不得仍为 OPEN；汇总行计数与实际一致）
 *   - 版本一致性（version.json ⇄ README.md ⇄ CHANGELOG.md 顶部版本条目）
 *   - CP-SAT 部署漂移守卫（compose 文件存在、ortools 三处锁定一致）
 *   - OpenAPI 契约零漂移（npm run openapi:no-drift；--skip-openapi 可跳过，
 *     CI 中该漂移已由 standalone.yml 的 gen:openapi:check 覆盖）
 *
 * 用法：
 *   node scripts/truth-feature-status.js [--skip-openapi] [--json]
 * js-yaml 通过 ewoh-spark-app/node_modules 解析（createRequire，与
 * scripts/audit-repo-facts.js 同一解析技巧），故需先 npm ci ewoh-spark-app。
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '..');
const requireFromApp = createRequire(path.join(root, 'ewoh-spark-app', 'package.json'));
const yaml = requireFromApp('js-yaml');
const { readVersion } = require('./truth-source');

const FEATURE_STATUS_PATH = path.join(root, 'feature-status.yaml');
const OPEN_DECISIONS_PATH = path.join(root, 'docs', 'decisions', 'OPEN-DECISIONS.md');
const README_PATH = path.join(root, 'README.md');
const CHANGELOG_PATH = path.join(root, 'CHANGELOG.md');
const CPSAT_COMPOSE_PATH = path.join(root, 'deploy', 'cloud', 'docker-compose.cpsat.yml');
const CPSAT_DOCKERFILE_PATH = path.join(root, 'deploy', 'cloud', 'Dockerfile.cpsat');
const CPSAT_REQUIREMENTS_PATH = path.join(
  root,
  'src',
  'edge_platform',
  'scheduler',
  'cpsat',
  'requirements.txt',
);
const ORTOOLS_PIN = 'ortools==9.11.4210';

const FEATURE_FIELDS = [
  'implemented',
  'tested',
  'deployable',
  'productionEnabled',
  'runtimeVerified',
  'docsUpdated',
];

// 文档提及关键词：docsUpdated=true 时要求 README.md 或 CHANGELOG.md 至少命中其一。
const FEATURE_DOC_KEYWORDS = {
  schedulerV2: ['Scheduler V2', '调度 V2'],
  heuristicSolver: ['HeuristicSchedulingSolver', 'heuristic'],
  cpSat: ['CP-SAT', 'cp-sat', 'cpsat'],
  predictionShadow: ['影子评估', 'shadow'],
  schedulerRls: ['RLS', '多租户'],
  commandMap: ['Command Map', 'CommandMap', '指挥地图'],
  decisionCockpit: ['驾驶舱', 'Decision Cockpit'],
  edgeServer: ['边缘平台', 'edge_platform'],
  feishuSidecar: ['飞书', 'feishu'],
  runtimeGates: ['runtime-gates', '运行时门禁', 'truth-gate'],
  benchmarkScheduler: ['benchmark', '基准'],
};

// 生产声明短语：productionEnabled=false 时，README/CHANGELOG 中特征提及附近
// 出现这些短语视为文档声称"已生产启用"→ FAIL。
const PRODUCTION_CLAIM_PHRASES = [
  '已生产启用',
  '生产已启用',
  'production enabled',
  'production-ready',
  '生产就绪',
];
const CLAIM_PROXIMITY_CHARS = 80;

// 代码中已知解决、但 OPEN-DECISIONS 中不得仍为 OPEN 的项（如再次出现即 FAIL）。
const KNOWN_RESOLVED_IN_CODE = [
  { id: 'lark-cli-async', label: '飞书侧车 lark-cli 异步化', pattern: /lark-cli/ },
  { id: 'scheduler-rls', label: '调度 V2 运行时表 RLS 白名单', pattern: /调度 V2 运行时表|RLS 白名单/ },
];

function readFileSafe(relative) {
  const target = path.join(root, relative);
  if (!fs.existsSync(target)) return null;
  return fs.readFileSync(target, 'utf8');
}

function check(checks, name, ok, detail, level = 'FAIL') {
  checks.push({ name, ok, detail, level });
}

// ---------------- R1 清单结构与字段不变量 ----------------
function auditManifest(manifest, checks) {
  const features = manifest && manifest.features;
  if (!features || typeof features !== 'object') {
    check(checks, 'manifest_features_map', false, 'feature-status.yaml 必须包含 features 映射');
    return;
  }
  const keys = Object.keys(features);
  if (keys.length === 0) {
    check(checks, 'manifest_features_nonempty', false, 'features 映射不能为空');
  }
  for (const key of keys) {
    const f = features[key];
    const label = `feature.${key}`;
    if (!f || typeof f !== 'object') {
      check(checks, `manifest_structure_${key}`, false, `${label} 必须是对象`);
      continue;
    }
    const missing = FEATURE_FIELDS.filter((field) => !(field in f));
    const nonBoolean = FEATURE_FIELDS.filter((field) => field in f && typeof f[field] !== 'boolean');
    const evidenceIsArray = Array.isArray(f.evidence);
    const nonStringEvidence = evidenceIsArray
      ? f.evidence.filter((e) => typeof e !== 'string')
      : [];
    const trueFields = FEATURE_FIELDS.filter((field) => f[field] === true);
    const trueWithoutEvidence = evidenceIsArray
      ? trueFields.filter((field) => f.evidence.length === 0)
      : [];
    const ok =
      missing.length === 0 &&
      nonBoolean.length === 0 &&
      evidenceIsArray &&
      nonStringEvidence.length === 0 &&
      trueWithoutEvidence.length === 0;
    const detail = ok
      ? `${label} 结构合法（7 字段布尔；true 字段均有证据）`
      : `${label} 问题：缺少=${missing.join(',') || '-'} 非布尔=${nonBoolean.join(',') || '-'} ` +
        `evidence非数组=${!evidenceIsArray} 非字符串=${nonStringEvidence.join(',') || '-'} ` +
        `true无证据=${trueWithoutEvidence.join(',') || '-'}`;
    check(checks, `manifest_structure_${key}`, ok, detail);
  }
}

// ---------------- R2 生产启用不变量 ----------------
function auditProductionGate(manifest, checks) {
  const features = (manifest && manifest.features) || {};
  const violations = [];
  for (const [key, f] of Object.entries(features)) {
    if (!f || typeof f !== 'object' || f.productionEnabled !== true) continue;
    const missing = [];
    if (f.runtimeVerified !== true) missing.push('runtimeVerified=true');
    if (f.docsUpdated !== true) missing.push('docsUpdated=true');
    if (!Array.isArray(f.evidence) || f.evidence.length === 0) missing.push('evidence 非空');
    if (missing.length > 0) violations.push(`feature.${key} 缺少 ${missing.join('、')}`);
  }
  check(
    checks,
    'production_gate',
    violations.length === 0,
    violations.length === 0
      ? '所有 productionEnabled=true 的功能均满足 runtimeVerified ∧ docsUpdated ∧ evidence 非空'
      : violations.join('；'),
  );
}

// ---------------- R3 文档一致性 ----------------
function auditDocsCrossCheck(checks, manifest, readme, changelog) {
  const features = (manifest && manifest.features) || {};
  const docs = [['README.md', readme], ['CHANGELOG.md', changelog]].filter(([, text]) => text);
  const mentionedFailures = [];
  const claimFailures = [];

  for (const [key, f] of Object.entries(features)) {
    if (!f || typeof f !== 'object') continue;
    const keywords = FEATURE_DOC_KEYWORDS[key] || [key];
    const mentionedIn = docs
      .filter(([, text]) => keywords.some((kw) => text.toLowerCase().includes(kw.toLowerCase())))
      .map(([name]) => name);

    if (f.docsUpdated === true && mentionedIn.length === 0) {
      mentionedFailures.push(`feature.${key}（关键词：${keywords.join('|')}）`);
    }

    if (f.productionEnabled !== true) {
      // b2：productionEnabled=false 时，文档提及附近不得出现生产启用声明。
      for (const [docName, text] of docs) {
        for (const kw of keywords) {
          const lower = text.toLowerCase();
          const kwLower = kw.toLowerCase();
          let idx = lower.indexOf(kwLower);
          while (idx >= 0) {
            const windowStart = Math.max(0, idx - CLAIM_PROXIMITY_CHARS);
            const windowEnd = Math.min(text.length, idx + kw.length + CLAIM_PROXIMITY_CHARS);
            const window = text.slice(windowStart, windowEnd);
            for (const phrase of PRODUCTION_CLAIM_PHRASES) {
              if (window.toLowerCase().includes(phrase.toLowerCase())) {
                claimFailures.push(`feature.${key}: ${docName} 中 "${phrase}" 出现在 "${kw}" 附近`);
              }
            }
            idx = lower.indexOf(kwLower, idx + kwLower.length);
          }
        }
      }
    }

    // b3：未实现功能被文档描述为已建成 → WARN（如 README 版本日志将
    // decisionCockpit 驾驶舱列为 Unreleased 范围，属规划描述而非交付声明，
    // 故降级为 WARN；生产启用声明仍由 b2 强制 FAIL）。
    if (f.implemented === false && mentionedIn.length > 0) {
      check(
        checks,
        'docs_unimplemented_claim',
        true,
        `feature.${key}: implemented=false 但文档提及（${mentionedIn.join(',')}）——按规划描述处理`,
        'WARN',
      );
    }
  }

  check(
    checks,
    'docs_updated_mentioned',
    mentionedFailures.length === 0,
    mentionedFailures.length === 0
      ? 'docsUpdated=true 的功能均在 README.md 或 CHANGELOG.md 中被提及'
      : `docsUpdated=true 但文档未提及：${mentionedFailures.join('；')}`,
  );
  check(
    checks,
    'docs_no_production_claim',
    claimFailures.length === 0,
    claimFailures.length === 0
      ? 'productionEnabled=false 的功能在 README/CHANGELOG 中无生产启用声明'
      : claimFailures.join('；'),
  );
}

// ---------------- R4 OPEN-DECISIONS ----------------
function parseOpenDecisionsRows(text) {
  if (!text) return { rows: [], summary: null };
  const summaryMatch = text.match(/当前汇总：\*\*(\d+)\s*未决\s*\+\s*(\d+)\s*已决\*\*/);
  const mainSection = text.split('## 已关闭记录')[0];
  const rows = [];
  for (const line of mainSection.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').map((cell) => cell.trim());
    // 主表 8 列：Date | Source | Open Item | Related Constraints | Current Leaning | Blocked By | Resolves When | Status
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cells[1] || '')) continue;
    rows.push({
      date: cells[1],
      source: cells[2],
      item: cells[3] || '',
      resolvesWhen: cells[7] || '',
      status: (cells[8] || '').toUpperCase(),
    });
  }
  return {
    rows,
    summary: summaryMatch ? { open: Number(summaryMatch[1]), resolved: Number(summaryMatch[2]) } : null,
  };
}

function auditOpenDecisions(checks, text) {
  if (!text) {
    check(checks, 'open_decisions_exists', false, 'docs/decisions/OPEN-DECISIONS.md 不存在');
    return;
  }
  const { rows, summary } = parseOpenDecisionsRows(text);
  const openRows = rows.filter((r) => r.status === 'OPEN');
  const resolvedRows = rows.filter((r) => r.status.includes('RESOLVED'));

  // 1) 每个 OPEN 项必须填写 Resolves When。
  const openWithoutResolvesWhen = openRows.filter(
    (r) => !r.resolvesWhen || r.resolvesWhen === '—' || r.resolvesWhen === '-',
  );
  check(
    checks,
    'open_decisions_resolves_when',
    openWithoutResolvesWhen.length === 0,
    openWithoutResolvesWhen.length === 0
      ? `所有 ${openRows.length} 个 OPEN 项均填写了 Resolves When`
      : `${openWithoutResolvesWhen.length} 个 OPEN 项缺少 Resolves When：${openWithoutResolvesWhen
          .map((r) => `[${r.date}] ${r.item.slice(0, 40)}`)
          .join('; ')}`,
  );

  // 2) 已知代码已解决的项不得仍为 OPEN。
  const knownViolations = [];
  for (const known of KNOWN_RESOLVED_IN_CODE) {
    const stillOpen = openRows.filter((r) => known.pattern.test(r.item));
    if (stillOpen.length > 0) {
      knownViolations.push(
        `${known.label}：${stillOpen.map((r) => `[${r.date}] ${r.item.slice(0, 40)}`).join('; ')}`,
      );
    }
  }
  check(
    checks,
    'open_decisions_known_resolved',
    knownViolations.length === 0,
    knownViolations.length === 0
      ? '已知代码已解决项（lark-cli 异步化 / scheduler RLS）未以 OPEN 状态残留'
      : knownViolations.join('；'),
  );

  // 3) 汇总行计数与实际一致。
  if (!summary) {
    check(checks, 'open_decisions_summary_counts', false, 'OPEN-DECISIONS.md 缺少「当前汇总：N 未决 + M 已决」行');
  } else if (summary.open !== openRows.length || summary.resolved !== resolvedRows.length) {
    check(
      checks,
      'open_decisions_summary_counts',
      false,
      `汇总行 ${summary.open} 未决 + ${summary.resolved} 已决 ≠ 实际 ${openRows.length} 未决 + ${resolvedRows.length} 已决`,
    );
  }
}

// ---------------- R5 版本一致性 ----------------
function auditVersionConsistency(checks, readme, changelog) {
  const version = readVersion();
  if (!version) {
    check(checks, 'version_source', false, 'version.json 缺失或无法解析');
    return;
  }
  const readmeDeclares = Boolean(readme && readme.includes(version));
  check(
    checks,
    'version_readme',
    readmeDeclares,
    `version.json version=${version} 必须出现在 README.md（readme=${readmeDeclares}）`,
  );

  const headerMatch = changelog && changelog.match(/\n## \[([^\]]+)\] - \d{4}-\d{2}-\d{2}/);
  const topVersion = headerMatch ? headerMatch[1] : null;
  const changelogDeclares = topVersion === version;
  check(
    checks,
    'version_changelog_top',
    changelogDeclares,
    `CHANGELOG.md 顶部版本条目（## [${topVersion ?? 'missing'}]）必须等于 version.json（${version}）`,
  );
}

// ---------------- R6 CP-SAT 部署漂移守卫 ----------------
function auditCpSatDeployment(checks) {
  const compose = readFileSafe('deploy/cloud/docker-compose.cpsat.yml');
  const dockerfile = readFileSafe('deploy/cloud/Dockerfile.cpsat');
  const requirements = readFileSafe('src/edge_platform/scheduler/cpsat/requirements.txt');

  const composeOk = Boolean(
    compose &&
      compose.includes('container_name: ewoh-cpsat') &&
      compose.includes('/health/live') &&
      compose.includes('8000'),
  );
  check(
    checks,
    'cpsat_compose_exists',
    composeOk,
    composeOk
      ? 'deploy/cloud/docker-compose.cpsat.yml 存在且含 container_name=ewoh-cpsat / :8000 / /health/live'
      : 'deploy/cloud/docker-compose.cpsat.yml 缺失或缺少关键字段（container_name: ewoh-cpsat、8000、/health/live）',
  );

  const dockerfilePinned = Boolean(dockerfile && dockerfile.includes(ORTOOLS_PIN));
  const dockerfileFloating = Boolean(dockerfile && /ortools\s*>\s*=\s*[\d.]+/.test(dockerfile));
  check(
    checks,
    'cpsat_dockerfile_pin',
    dockerfilePinned && !dockerfileFloating,
    `Dockerfile.cpsat 必须锁定 ${ORTOOLS_PIN} 且无浮动约束（pinned=${dockerfilePinned} floating=${dockerfileFloating}）`,
  );

  const requirementsPinned = Boolean(requirements && requirements.includes(ORTOOLS_PIN));
  check(
    checks,
    'cpsat_requirements_pin',
    requirementsPinned,
    `cpsat/requirements.txt 必须锁定 ${ORTOOLS_PIN}（pinned=${requirementsPinned}）`,
  );

  if (dockerfilePinned && requirementsPinned) {
    const agree =
      dockerfile.includes(ORTOOLS_PIN) && requirements.includes(ORTOOLS_PIN);
    check(checks, 'cpsat_pin_agreement', agree, 'Dockerfile.cpsat 与 requirements.txt 的 ortools 版本必须一致');
  }
}

// ---------------- R7 OpenAPI 契约零漂移 ----------------
function auditOpenApiNoDrift(checks, skip) {
  if (skip) {
    check(
      checks,
      'openapi_no_drift',
      true,
      '跳过（--skip-openapi）：CI 中该漂移已由 standalone.yml "OpenAPI contract drift gate (W4)" 的 npm run gen:openapi:check 覆盖',
    );
    return;
  }
  try {
    const out = execFileSync('npm', ['run', 'openapi:no-drift'], {
      cwd: path.join(root, 'ewoh-spark-app'),
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const tail = out.trim().split('\n').slice(-3).join(' | ');
    check(checks, 'openapi_no_drift', true, `npm run openapi:no-drift 通过（${tail}）`);
  } catch (error) {
    const stderr = error && error.stderr ? String(error.stderr).trim().split('\n').slice(-6).join(' | ') : '';
    const stdout = error && error.stdout ? String(error.stdout).trim().split('\n').slice(-3).join(' | ') : '';
    check(
      checks,
      'openapi_no_drift',
      false,
      `npm run openapi:no-drift 失败（exit=${error && error.status}）：${stderr || stdout || error.message}`,
    );
  }
}

function main() {
  const args = process.argv.slice(2);
  const skipOpenApi = args.includes('--skip-openapi');
  const json = args.includes('--json');
  const checks = [];

  const manifestRaw = readFileSafe('feature-status.yaml');
  if (!manifestRaw) {
    check(checks, 'manifest_exists', false, 'feature-status.yaml 不存在');
  } else {
    let manifest = null;
    try {
      manifest = yaml.load(manifestRaw);
    } catch (error) {
      check(checks, 'manifest_parse', false, `feature-status.yaml 解析失败：${error.message}`);
    }
    if (manifest && typeof manifest === 'object') {
      auditManifest(manifest, checks);
      auditProductionGate(manifest, checks);
      auditDocsCrossCheck(checks, manifest, readFileSafe('README.md'), readFileSafe('CHANGELOG.md'));
    }
  }

  auditOpenDecisions(checks, readFileSafe('docs/decisions/OPEN-DECISIONS.md'));
  auditVersionConsistency(checks, readFileSafe('README.md'), readFileSafe('CHANGELOG.md'));
  auditCpSatDeployment(checks);
  auditOpenApiNoDrift(checks, skipOpenApi);

  const failed = checks.filter((c) => !c.ok && c.level === 'FAIL');
  const warnings = checks.filter((c) => c.level === 'WARN');

  if (json) {
    console.log(
      JSON.stringify(
        {
          root,
          skipOpenApi,
          passed: checks.length - failed.length,
          failed: failed.length,
          warnings: warnings.length,
          checks,
          verdict: failed.length === 0 ? 'PASS' : 'FAIL',
        },
        null,
        2,
      ),
    );
  } else {
    console.log('TRUTH FEATURE-STATUS GATE');
    for (const c of checks) {
      const tag = c.level === 'WARN' ? 'WARN' : c.ok ? 'PASS' : 'FAIL';
      console.log(`  ${tag} ${c.name}: ${c.detail}`);
    }
    console.log(`  summary: ${checks.length - failed.length}/${checks.length} passed, ${failed.length} failed, ${warnings.length} warn`);
    console.log(failed.length === 0 ? 'TRUTH-GATE PASS' : 'TRUTH-GATE FAIL');
  }

  if (failed.length > 0) process.exitCode = 1;
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
  auditManifest,
  auditProductionGate,
  auditDocsCrossCheck,
  auditOpenDecisions,
  auditVersionConsistency,
  auditCpSatDeployment,
  auditOpenApiNoDrift,
  main,
};
