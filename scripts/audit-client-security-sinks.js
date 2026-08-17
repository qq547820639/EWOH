#!/usr/bin/env node
/**
 * 前端凭据与注入面门禁（审计 §4 主线 4 / CLI-301/302/401/402/501）。
 *
 * 职责（fail-closed，任一未登记违规 → 非零退出）：
 *  1. **凭据存储**：ewoh-spark-app/client/src 全部 `localStorage.setItem` /
 *     `sessionStorage.setItem` 语句不得涉及 token/refresh 凭据（CLI-501：
 *     refresh token 已迁 httpOnly cookie；access token 迁 sessionStorage——
 *     本门禁全局 grep 兜底 auth.ts 之外的旁路写入）；
 *  2. **XSS href sink**：全部 `href={` 动态赋值必须满足其一——
 *     a) 模板以安全前缀字面量开头（# 锚点 / mailto: / tel:）；
 *     b) 值为 sanitize 产物变量（safeUrl/safeHref 等约定命名，上游经
 *        sanitizeUrl/isSafeUrl 白名单校验，见 lib/urlSafety.ts）；
 *     c) 登记于下方白名单（带审计编号与理由，双向比对防僵尸登记）。
 *
 * 已接入：make audit-regression-gates（2026-08-17 审计整改 W13）。
 * 用法：node scripts/audit-client-security-sinks.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const CLIENT_SRC = path.join(REPO_ROOT, 'ewoh-spark-app/client/src');

const failures = [];
const passes = [];
function check(name, ok, detail = '') {
  if (ok) passes.push(name);
  else failures.push(`${name}${detail ? `: ${detail}` : ''}`);
}

function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (/\.(tsx?|ts)$/.test(ent.name) && !/\.(test|spec)\.[jt]sx?$/.test(ent.name)) out.push(p);
  }
  return out;
}

// ── href={` 动态 sink 白名单（带审计编号与理由；键 = 文件::行内容） ──────────
const HREF_WHITELIST = new Map([
  // 当前为空：四处已知 sink（Timeline #锚点/safeUrl、streamdown safeHref、
  // user-profile mailto:）均命中自动安全规则。新增不合规 href 需显式登记。
]);

const files = walk(CLIENT_SRC, []).sort();
const credViolations = [];
const hrefViolations = [];
let setItemTotal = 0;
let hrefTotal = 0;

for (const file of files) {
  const rel = path.relative(REPO_ROOT, file);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((l, i) => {
    // 1. 凭据存储：storage.setItem 涉及 token/refresh → 违规
    if (/(local|session)Storage\.setItem/.test(l)) {
      setItemTotal++;
      if (/token|refresh/i.test(l)) {
        credViolations.push(`${rel}:${i + 1}: ${l.trim()}`);
      }
    }
    // 2. href={ 动态赋值（排除静态字符串 href="..."）
    const hrefMatch = /href=\{/.test(l);
    if (hrefMatch) {
      hrefTotal++;
      const trimmed = l.trim();
      const safePrefixTemplate = /href=\{\s*[`'"](#|mailto:|tel:)/.test(l);
      const sanitizedVar = /href=\{\s*(safe\w*|sanitized\w*)\b/.test(l);
      if (!safePrefixTemplate && !sanitizedVar) {
        const key = `${rel}::${trimmed}`;
        if (!HREF_WHITELIST.has(key)) {
          hrefViolations.push(`${rel}:${i + 1}: ${trimmed}`);
        }
      }
    }
  });
}

check('client_no_credential_in_web_storage', credViolations.length === 0, credViolations.join(' | '));
check(
  'client_href_sinks_sanitized',
  hrefViolations.length === 0,
  hrefViolations.join(' | ') || undefined,
);

// 白名单条目必须仍与代码匹配（防僵尸登记）
const allLines = new Set();
for (const file of files) {
  const rel = path.relative(REPO_ROOT, file);
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    if (/href=\{/.test(l)) allLines.add(`${rel}::${l.trim()}`);
  }
}
const stale = [...HREF_WHITELIST.keys()].filter((k) => !allLines.has(k));
check('client_href_whitelist_stale', stale.length === 0, stale.join(' | '));
for (const [key] of HREF_WHITELIST) {
  if (!/:/.test(key)) {
    check('client_href_whitelist_invalid', false, `白名单键格式非法: ${key}`);
  }
}

// 扫描面健全性：防 import 演化后扫描面静默清空
check('client_scan_surface_sane', files.length > 200 && hrefTotal >= 4, `${files.length} 文件 / ${hrefTotal} 处 href sink / ${setItemTotal} 处 setItem`);

// ── 汇总 ────────────────────────────────────────────────────────────────────
console.log(
  `[audit-client-security-sinks] 扫描 ${files.length} 文件 / href sink ${hrefTotal} 处 / storage.setItem ${setItemTotal} 处 / 白名单 ${HREF_WHITELIST.size} 条`,
);
for (const p of passes) console.log(`PASS ${p}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`FAIL ${f}`);
  console.log(`\n[audit-client-security-sinks] ${failures.length} 项失败。`);
  process.exit(1);
}
console.log('[audit-client-security-sinks] 全部通过：无凭据入 Web Storage，href 动态 sink 均经白名单/净化。');
