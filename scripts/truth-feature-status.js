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

// ---------------- R3b README 能力状态表行级检查（Task 17.3） ----------------
// feature-status.yaml 的每个 feature 必须在 README「能力状态清单」表中有一行，
// 且 6 个状态列（实现/测试/可部署/生产启用/运行时验证/文档一致）用 是/否 与
// 清单布尔值逐列一致：yaml 为 true 的行不得在 README 中标记为「未启用/未验证」，
// 反之亦然。表行首列以（featureKey）标注，使检查可精确映射。
const CAPABILITY_TABLE_HEADER = '能力状态清单';
// 列顺序与 feature-status.yaml FEATURE_FIELDS 一致（表头：功能|实现|测试|可部署|生产启用|运行时验证|文档一致）
const CAPABILITY_COLUMNS = [
  'implemented',
  'tested',
  'deployable',
  'productionEnabled',
  'runtimeVerified',
  'docsUpdated',
];

function parseCapabilityTableRows(readme) {
  if (!readme) return [];
  const headerIdx = readme.indexOf(CAPABILITY_TABLE_HEADER);
  if (headerIdx < 0) return [];
  const section = readme.slice(headerIdx);
  const tableStart = section.indexOf('|');
  if (tableStart < 0) return [];
  const rows = [];
  for (const line of section.slice(tableStart).split('\n')) {
    if (!line.trim().startsWith('|')) break; // 表格结束（后续小节不属于能力状态表）
    const cells = line.split('|').map((cell) => cell.trim());
    rows.push(cells);
  }
  return rows;
}

function auditReadmeCapabilityTable(checks, manifest, readme) {
  if (!manifest || !manifest.features || typeof manifest.features !== 'object') return;
  const features = manifest.features;
  const rows = parseCapabilityTableRows(readme);
  const missing = [];
  const inconsistent = [];
  const rowFeatureKeys = new Set();
  let tableFound = false;

  for (const row of rows) {
    const first = row[1] || '';
    if (!first) continue; // 表头/分隔线
    const keyMatch = first.match(/[（(]([A-Za-z][A-Za-z0-9]*)[）)]/);
    if (!keyMatch || !(keyMatch[1] in features)) continue;
    tableFound = true;
    const key = keyMatch[1];
    rowFeatureKeys.add(key);
    const f = features[key];
    if (!f || typeof f !== 'object') continue;
    for (let col = 0; col < CAPABILITY_COLUMNS.length; col++) {
      const expected = f[CAPABILITY_COLUMNS[col]] === true ? '是' : '否';
      const actual = String(row[2 + col] || '').trim();
      if (actual !== expected) {
        inconsistent.push(
          `feature.${key}.${CAPABILITY_COLUMNS[col]}: README 标记「${actual || '（空）'}」应为「${expected}」`,
        );
      }
    }
  }

  for (const key of Object.keys(features)) {
    if (!rowFeatureKeys.has(key)) missing.push(key);
  }

  check(
    checks,
    'readme_capability_table_exists',
    tableFound || rows.length === 0,
    tableFound
      ? 'README 包含「能力状态清单」表且解析到 feature 行'
      : 'README 未解析到「能力状态清单」表的 feature 行（需添加或检查（featureKey）标注）',
  );
  check(
    checks,
    'readme_capability_table_rows',
    missing.length === 0,
    missing.length === 0
      ? `README 能力状态清单包含全部 ${Object.keys(features).length} 个 feature 行`
      : `README 能力状态清单缺少行：${missing.join(', ')}`,
  );
  check(
    checks,
    'readme_capability_table_status',
    inconsistent.length === 0,
    inconsistent.length === 0
      ? 'README 能力状态清单各行状态与 feature-status.yaml 一致（是/否 逐列匹配）'
      : inconsistent.join('；'),
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

// ---------------- R6b Solver 激活阶梯真相门禁（Task A / P0） ----------------
// 求解器激活唯一事实源：SolverService 默认激活必须为 OFF（heuristic canonical），
// 与 feature-status.yaml cpSat.productionEnabled=false 一致；EWOH_SOLVER_ACTIVATION
// 与默认 OFF 必须在 README / feature-status.yaml / deploy/.env.example 三处文档化。
const SOLVER_ACTIVATION_ENV = 'EWOH_SOLVER_ACTIVATION';
const SOLVER_SERVICE_SRC = 'ewoh-spark-app/server/modules/scheduler/solver.service.ts';
const SOLVER_ENV_EXAMPLE = 'deploy/.env.example';

function auditSolverActivation(checks, manifest, readme, envExample) {
  const cpSat = manifest && manifest.features && manifest.features.cpSat;
  const productionEnabled = Boolean(cpSat && cpSat.productionEnabled === true);
  const solverSrc = readFileSafe(SOLVER_SERVICE_SRC) || '';

  // (a) 代码默认激活必须为 OFF；productionEnabled=false 时严禁非 OFF 缺省。
  const defaultOffInCode =
    solverSrc.includes("cpSat?.activation ?? 'OFF'") &&
    /case 'OFF':|case 'SHADOW':/.test(solverSrc) &&
    /heuristicSolver\.solve\(/.test(solverSrc);
  check(
    checks,
    'solver_activation_default_off',
    defaultOffInCode,
    defaultOffInCode
      ? `${SOLVER_SERVICE_SRC} 默认激活解析为 'OFF'（heuristic canonical，与 productionEnabled 一致）`
      : `${SOLVER_SERVICE_SRC} 缺少默认 'OFF' 解析（cpSat?.activation ?? 'OFF' / OFF 分支 heuristic）`,
  );
  if (!productionEnabled && !defaultOffInCode) {
    check(
      checks,
      'solver_activation_code_vs_manifest',
      false,
      `feature-status.yaml cpSat.productionEnabled=false 但 ${SOLVER_SERVICE_SRC} 默认激活非 OFF → 漂移（默认必须仅 heuristic）`,
    );
  }

  // (b) EWOH_SOLVER_ACTIVATION 与默认 OFF 必须三处文档化（README / feature-status.yaml / deploy/.env.example）。
  const readmeDocsEnv = Boolean(
    readme &&
      readme.includes(SOLVER_ACTIVATION_ENV) &&
      /EWOH_SOLVER_ACTIVATION[^\n]*OFF/.test(readme),
  );
  check(
    checks,
    'solver_env_readme',
    readmeDocsEnv,
    readmeDocsEnv
      ? `README.md 文档化 ${SOLVER_ACTIVATION_ENV} 且默认 OFF`
      : `README.md 必须文档化 ${SOLVER_ACTIVATION_ENV} 且默认 OFF（heuristic canonical）`,
  );

  const manifestDocsEnv = Boolean(
    manifest &&
      manifest.features &&
      manifest.features.cpSat &&
      JSON.stringify(manifest.features.cpSat).includes(SOLVER_ACTIVATION_ENV),
  );
  check(
    checks,
    'solver_env_feature_status',
    manifestDocsEnv,
    manifestDocsEnv
      ? `feature-status.yaml cpSat 块文档化 ${SOLVER_ACTIVATION_ENV}`
      : `feature-status.yaml cpSat 块必须文档化 ${SOLVER_ACTIVATION_ENV}（激活阶梯单一事实源）`,
  );

  const envExampleDocs = Boolean(
    envExample &&
      envExample.includes(`${SOLVER_ACTIVATION_ENV}=OFF`) &&
      envExample.includes('EWOH_SOLVER_PRODUCTION_ENABLED=0'),
  );
  check(
    checks,
    'solver_env_example',
    envExampleDocs,
    envExampleDocs
      ? `deploy/.env.example 文档化 ${SOLVER_ACTIVATION_ENV}=OFF 与 EWOH_SOLVER_PRODUCTION_ENABLED=0`
      : `deploy/.env.example 必须文档化 ${SOLVER_ACTIVATION_ENV}=OFF 与 EWOH_SOLVER_PRODUCTION_ENABLED=0`,
  );

  // (c) productionEnabled=false 时，README 不得声称 CP-SAT 为 canonical。
  // 判据：README 必须声明 heuristic canonical + 显式标注 CP-SAT OPTIONAL/EXPERIMENTAL（否定标记），
  // 且不得出现主语为 CP-SAT 的 canonical/生产就绪 声称（跨标点（，。;；）视为不同子句，不判声称）。
  if (readme && !productionEnabled) {
    const heuristicCanonical = /heuristic[\s\S]{0,80}canonical/i.test(readme);
    const cpsatMarkedNonCanonical =
      /CP-SAT[^\n]{0,120}(OPTIONAL|EXPERIMENTAL|不生产启用|未启用|未部署 OR-Tools)/i.test(readme);
    const cpsatCanonicalClaim =
      /CP-SAT[^\n，。;；]{0,40}(canonical|production[\s-]?ready|生产就绪|已生产启用)/i.test(readme) ||
      /(canonical|production[\s-]?ready|生产就绪|已生产启用)[^\n，。;；]{0,40}CP-SAT/i.test(readme);
    check(
      checks,
      'solver_readme_no_cpsat_canonical_claim',
      heuristicCanonical && cpsatMarkedNonCanonical && !cpsatCanonicalClaim,
      heuristicCanonical && cpsatMarkedNonCanonical && !cpsatCanonicalClaim
        ? 'README 声明 heuristic canonical 且显式标注 CP-SAT OPTIONAL/EXPERIMENTAL（无 CP-SAT canonical 声称）'
        : `productionEnabled=false 时 README 不得声称 CP-SAT canonical（heuristicCanonical=${heuristicCanonical} cpsatMarkedNonCanonical=${cpsatMarkedNonCanonical} cpsatCanonicalClaim=${cpsatCanonicalClaim}）`,
    );
  } else if (readme && productionEnabled) {
    check(checks, 'solver_readme_no_cpsat_canonical_claim', true, 'productionEnabled=true：跳过 canonical 声称检查');
  }
}

// ---------------- --self-test：solver-activation 不变量数据级断言（Task 17.2） ----------------
// 直接对原始事实源（feature-status.yaml / deploy/.env.example / solver.service.ts /
// README.md）做独立断言，不依赖上方审计函数的正则——防止审计自身被“改坏”后仍通过。
// 断言内容：cpSat.productionEnabled=false ⇔ 代码默认激活 'OFF' ⇔ .env.example
// 文档化默认 OFF 与生产门控 0 ⇔ README 不声称 CP-SAT canonical。
function runSelfTest() {
  const manifest = yaml.load(readFileSafe('feature-status.yaml') || '{}');
  const envExample = readFileSafe(SOLVER_ENV_EXAMPLE) || '';
  const readme = readFileSafe('README.md') || '';
  const solverSrc = readFileSafe(SOLVER_SERVICE_SRC) || '';
  const cpSat = manifest && manifest.features && manifest.features.cpSat;

  const assertions = [
    ['feature-status.yaml 存在且 cpSat.productionEnabled=false', Boolean(cpSat && cpSat.productionEnabled === false)],
    ['deploy/.env.example 文档化 EWOH_SOLVER_ACTIVATION=OFF', envExample.includes('EWOH_SOLVER_ACTIVATION=OFF')],
    ['deploy/.env.example 文档化 EWOH_SOLVER_PRODUCTION_ENABLED=0', envExample.includes('EWOH_SOLVER_PRODUCTION_ENABLED=0')],
    ['feature-status.yaml cpSat 块文档化 EWOH_SOLVER_ACTIVATION', Boolean(cpSat && JSON.stringify(cpSat).includes(SOLVER_ACTIVATION_ENV))],
    [`${SOLVER_SERVICE_SRC} 默认激活解析为 'OFF'（cpSat?.activation ?? 'OFF'）`, solverSrc.includes("cpSat?.activation ?? 'OFF'")],
    [
      'README 声明 heuristic canonical 且无 CP-SAT canonical 声称',
      /heuristic[\s\S]{0,80}canonical/i.test(readme) &&
        !/CP-SAT[^\n，。;；]{0,40}(canonical|production[\s-]?ready|生产就绪|已生产启用)/i.test(readme),
    ],
    [
      '不变量自洽：cpSat.productionEnabled=false 时代码默认非 PRODUCTION',
      cpSat && cpSat.productionEnabled === false ? !solverSrc.includes("cpSat?.activation ?? 'PRODUCTION'") : true,
    ],
  ];

  console.log('TRUTH FEATURE-STATUS SELF-TEST (solver activation invariant)');
  let failed = 0;
  for (const [label, ok] of assertions) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}`);
    if (!ok) failed += 1;
  }
  console.log(`  summary: ${assertions.length - failed}/${assertions.length} passed`);
  console.log(failed === 0 ? 'SELF-TEST PASS' : 'SELF-TEST FAIL');
  if (failed > 0) process.exitCode = 1;
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
  const selfTest = args.includes('--self-test');
  const checks = [];

  if (selfTest) {
    runSelfTest();
    return;
  }

  const manifestRaw = readFileSafe('feature-status.yaml');
  let manifest = null;
  if (!manifestRaw) {
    check(checks, 'manifest_exists', false, 'feature-status.yaml 不存在');
  } else {
    try {
      manifest = yaml.load(manifestRaw);
    } catch (error) {
      check(checks, 'manifest_parse', false, `feature-status.yaml 解析失败：${error.message}`);
    }
    if (manifest && typeof manifest === 'object') {
      auditManifest(manifest, checks);
      auditProductionGate(manifest, checks);
      auditDocsCrossCheck(checks, manifest, readFileSafe('README.md'), readFileSafe('CHANGELOG.md'));
      auditReadmeCapabilityTable(checks, manifest, readFileSafe('README.md'));
    }
  }

  auditOpenDecisions(checks, readFileSafe('docs/decisions/OPEN-DECISIONS.md'));
  auditVersionConsistency(checks, readFileSafe('README.md'), readFileSafe('CHANGELOG.md'));
  auditCpSatDeployment(checks);
  auditSolverActivation(
    checks,
    manifest,
    readFileSafe('README.md'),
    readFileSafe(SOLVER_ENV_EXAMPLE),
  );
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
  auditReadmeCapabilityTable,
  auditOpenDecisions,
  auditVersionConsistency,
  auditCpSatDeployment,
  auditSolverActivation,
  auditOpenApiNoDrift,
  runSelfTest,
  main,
};
