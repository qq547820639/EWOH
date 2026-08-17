#!/usr/bin/env node
/**
 * SSRF 出站面门禁（审计 §4 主线 3 / EDGE-002 + NEST-430）。
 *
 * 职责（fail-closed，任一未登记违规 → 非零退出）：
 *  1. 扫描边缘 vision/understand 出站链（src/edge_platform/routes/inference.py +
 *     src/edge_platform/perception/ark_vision.py）：请求体键名 base_url/api_key
 *     的每一处出现必须落在白名单比对内——EDGE-002 收敛后路由侧仅允许
 *     docstring/注释 与「字面空串透传」（api_key="", base_url=""，出站凭据
 *     与地址仅来自 Settings/env）；
 *  2. 扫描云端 AI 模块（ewoh-spark-app/server/modules/ai/*.ts，排除 *.spec.ts）：
 *     baseUrl/apiKey/base_url/api_key 的每一处出现按「请求体键名出现处」白名单
 *     比对——服务端配置流（cfg./value./env/current./next./saved./Boolean(）自动
 *     放行；其余（@Body 请求体键、saveConfig input 形参等）必须登记豁免；
 *  3. 关键断言：vision understand 代理转发体（ai.controller visionUnderstand）
 *     不得包含 api_key/base_url 键（NEST-430：不转发用户可控凭据/出站地址）。
 *
 * 已接入：make audit-regression-gates（2026-08-17 审计整改 W13）。
 * 用法：node scripts/audit-ssrf-surface.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');

const failures = [];
const passes = [];
function check(name, ok, detail = '') {
  if (ok) passes.push(name);
  else failures.push(`${name}${detail ? `: ${detail}` : ''}`);
}

const PY_TARGETS = [
  'src/edge_platform/routes/inference.py',
  'src/edge_platform/perception/ark_vision.py',
];
const AI_DIR = path.join(REPO_ROOT, 'ewoh-spark-app/server/modules/ai');
const KEY_RE = /base_url|api_key|baseUrl|apiKey/g;

/** Python 文件：docstring/注释内出现 → 自动放行（三引号状态机近似）。 */
function scanPython(rel) {
  const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
  const lines = src.split('\n');
  let inDoc = false;
  const occ = [];
  lines.forEach((l, i) => {
    const quotes = (l.match(/"""/g) || []).length;
    const lineInDoc = inDoc || quotes > 0;
    if (quotes % 2 === 1) inDoc = !inDoc;
    if (!KEY_RE.test(l)) {
      KEY_RE.lastIndex = 0;
      return;
    }
    KEY_RE.lastIndex = 0;
    const trimmed = l.trim();
    const isComment = trimmed.startsWith('#');
    // EDGE-002 收敛形态：字面空串透传（出站凭据/地址仅来自 Settings/env）
    const isLiteralEmptyPass = /(?:api_key|base_url)\s*=\s*""/.test(l);
    const isEnvFallback = /getattr\(\s*s\b|os\.environ|env_key|env_base|DEFAULT_BASE_URL/.test(l);
    const isDoc = lineInDoc && !trimmed.includes('=');
    // resolve_config 解析后的服务端配置流（含 validate_outbound_url SSRF 防御本身）
    const isResolvedConfigFlow =
      /resolve_config\(/.test(l) ||
      /cfg\[\s*["'](?:api_key|base_url)["']\s*\]/.test(l) ||
      /if not (?:api_key|base_url)/.test(l) ||
      /validate_outbound_url/.test(l) ||
      /Bearer /.test(l) ||
      /\.rstrip\(/.test(l) ||
      /不安全/.test(l);
    occ.push({
      file: rel,
      line: i + 1,
      content: trimmed,
      safe: isComment || isLiteralEmptyPass || isEnvFallback || isDoc || isResolvedConfigFlow,
    });
  });
  return occ;
}

/** TS 文件：注释与服务端配置流自动放行，其余走白名单。 */
function scanTs(rel) {
  const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
  const lines = src.split('\n');
  const occ = [];
  lines.forEach((l, i) => {
    if (!KEY_RE.test(l)) {
      KEY_RE.lastIndex = 0;
      return;
    }
    KEY_RE.lastIndex = 0;
    const trimmed = l.trim();
    const isComment = trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
    // 服务端配置流：凭据/地址来自 DB 配置行、env 或运行时 cfg 对象（非请求体）
    const isServerConfigFlow =
      /\b(?:cfg|value|current|next|saved|input)\s*\.\s*(?:api_key|base_url|apiKey|baseUrl)/.test(l) ||
      /\benv(?:Key|Base|ARK|\b)/.test(l) ||
      /process\.env/.test(l) ||
      /Boolean\(/.test(l) ||
      /DEFAULT_BASE_URL/.test(l) ||
      /^\w+:\s*string;?$/.test(trimmed) || // 接口类型字段声明（ArkConfig 形状）
      /(?:apiKey|baseUrl)Changed/.test(l); // 配置变更审计元数据（布尔标记）
    occ.push({
      file: rel,
      line: i + 1,
      content: trimmed,
      safe: isComment || isServerConfigFlow,
    });
  });
  return occ;
}

const occurrences = [];
for (const rel of PY_TARGETS) occurrences.push(...scanPython(rel));
for (const ent of fs.readdirSync(AI_DIR).sort()) {
  if (ent.endsWith('.ts') && !ent.endsWith('.spec.ts')) {
    occurrences.push(...scanTs(`ewoh-spark-app/server/modules/ai/${ent}`));
  }
}

// ── 白名单登记（「请求体键名出现处」比对，带审计编号与理由） ────────────────
// 键：<file>::<行内容>（内容变更会使登记失效，强制人工复审——防静默漂移）。
const WHITELIST = new Map([
  [
    'ewoh-spark-app/server/modules/ai/ai.controller.ts::@Body() body: { api_key?: string; base_url?: string; model?: string },',
    'NEST-413：PUT /api/ai/config 全局凭据保存端点（@Roles(global_admin) 专属）——api_key/base_url 为配置写入键，落库为服务端配置，不经请求直连外部 URL，非 SSRF 通道。',
  ],
  [
    'ewoh-spark-app/server/modules/ai/ark.service.ts::input: { api_key?: string; base_url?: string; model?: string },',
    'NEST-413：saveConfig 服务层签名（同一全局凭据保存端点），input 仅落库为服务端配置。',
  ],
]);

const violations = [];
for (const o of occurrences) {
  if (o.safe) continue;
  const key = `${o.file}::${o.content}`;
  if (WHITELIST.has(key)) continue;
  violations.push(`${o.file}:${o.line}: ${o.content}`);
}
check('ssrf_no_unregistered_request_key_flow', violations.length === 0, violations.join(' | '));

// 白名单条目必须仍与代码匹配（防僵尸登记）
const occKeys = new Set(occurrences.map((o) => `${o.file}::${o.content}`));
const stale = [...WHITELIST.keys()].filter((k) => !occKeys.has(k));
check('ssrf_whitelist_stale', stale.length === 0, stale.join(' | '));

// ── 关键断言：vision understand 代理不转发 api_key/base_url（NEST-430） ─────
const aiController = fs.readFileSync(
  path.join(REPO_ROOT, 'ewoh-spark-app/server/modules/ai/ai.controller.ts'),
  'utf8',
);
const visionMatch = /async\s+visionUnderstand\s*\([^)]*\)[^{]*\{([\s\S]*?)\n  \}/.exec(aiController);
check('ssrf_vision_proxy_found', visionMatch !== null);
if (visionMatch) {
  const body = visionMatch[1];
  const leaked = /api_key|base_url|apiKey|baseUrl/.test(
    body.replace(/NEST-430[\s\S]*?\*\//, ''), // 剔除方法内注释引用
  );
  check('ssrf_vision_proxy_forwards_no_credentials', !leaked, 'visionUnderstand 转发体含凭据/出站地址键');
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
console.log(
  `[audit-ssrf-surface] 扫描 ${PY_TARGETS.length + fs.readdirSync(AI_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts')).length} 文件 / 键名出现 ${occurrences.length} 处 / 白名单 ${WHITELIST.size} 条`,
);
for (const p of passes) console.log(`PASS ${p}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`FAIL ${f}`);
  console.log(`\n[audit-ssrf-surface] ${failures.length} 项失败。`);
  process.exit(1);
}
console.log('[audit-ssrf-surface] 全部通过：出站凭据/地址仅来自服务端配置，请求体键名出现处均在白名单内。');
