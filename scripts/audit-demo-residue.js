#!/usr/bin/env node
/**
 * 演示/伪造数据残留门禁（审计 §4 主线 10 / CLI-001/011/012/201/303）。
 *
 * grep 扫描 ewoh-spark-app/client/src 与 src/edge_platform/static：
 *  - '演示'（显式演示文案/注释——修复后仅允许「显式标注」形态，白名单按
 *    文件+出现次数登记，超出即新残留）；
 *  - 'AG-00'（伪造 actor 预填，CLI-201）——非注释出现即违规；
 *  - `occupancy ?? 0.5`（伪造占用缺省，CLI-011/012）——白名单登记制；
 *  - `Math.random`（CLI-505 簇：安全用途禁用）——非注释出现按 lib 白名单
 *    （已裁决的非安全用途：抖动/采样/骨架宽度/非安全 fallback id）登记；
 *  - `execCommand`（CLI-705：废弃 API）——非注释出现即违规；
 *  - 'admin123'（弱口令残留）——出现即违规。
 *
 * 白名单登记制：脚本双向比对——超量/未登记文件 FAIL，登记项在代码中消失
 * FAIL（防僵尸登记）。每条登记带审计编号与理由。
 *
 * 已接入：make audit-regression-gates（2026-08-17 审计整改 W13）。
 * 用法：node scripts/audit-demo-residue.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCAN_ROOTS = [
  { dir: 'ewoh-spark-app/client/src', exts: /\.(tsx?|ts|css)$/, excludeTest: true },
  { dir: 'src/edge_platform/static', exts: /\.(html|js|css)$/, excludeTest: false },
];
// 构建产物/第三方 vendor（static/cm 为打包后的演示前端 bundle，不参与源码残留判定）
const EXCLUDED_PATHS = [/static\/cm\//];

const failures = [];
const passes = [];
function check(name, ok, detail = '') {
  if (ok) passes.push(name);
  else failures.push(`${name}${detail ? `: ${detail}` : ''}`);
}

/** TS/TSX 注释行（演示模式允许出现在注释/文案中的项由各 pattern 自行决定）。 */
function isCommentLine(trimmed) {
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('#');
}

// ── 白名单登记（pattern → file → { max, audit, reason }） ───────────────────
// max = 该文件允许的出现次数上限（非注释计数，除非 pattern 标注计注释）。
const WHITELIST = {
  演示: {
    'ewoh-spark-app/client/src/components/app-shell/ContextBar.tsx': {
      max: 2, audit: 'CLI-303',
      reason: '修复后的条件展示标注：仅在真实后端未接入时显示「演示 / 待接入真数据」（不再永久标签），源码注释同步声明。',
    },
    'ewoh-spark-app/client/src/components/app-shell/PendingInbox.tsx': {
      max: 3, audit: 'CLI-303 簇裁决',
      reason: '审计点名的显式演示标注：待同步数量为离线队列真实值，风险告警/指挥中心入口显式标注「演示导航（待接入真实数据）」防误认。',
    },
    'ewoh-spark-app/client/src/lib/appContext.ts': {
      max: 2, audit: 'CLI-303 簇裁决',
      reason: '注释：组织/工厂/产线为演示用本地默认值且 UI 明确标注「演示/待接入真数据」，不伪造后端数据。',
    },
    'ewoh-spark-app/client/src/lib/siteReadinessMapping.ts': {
      max: 1, audit: 'CLI-303 簇裁决',
      reason: '注释：本地 Dry Run 逻辑与后端 applyMappingTransform 语义对齐的演示说明。',
    },
    'ewoh-spark-app/client/src/pages/CommandMap/panels/SchedulePanel.tsx': {
      max: 8, audit: 'P1-5/CLI-204',
      reason: 'Demo 兜底方案的显式标注体系：面板「Demo 演示数据」badge + 不可审批/驳回/下发的 toast 拦截（演示方案一律禁止真实副作用），仅开发/演示构建启用兜底。',
    },
    'ewoh-spark-app/client/src/pages/CommandMap/panels/schedule-panel-demo.ts': {
      max: 3, audit: 'P1-5',
      reason: 'Production Demo 隔离模块本体：演示方案识别纯逻辑（Demo 方案禁审批/驳回/派工），模块自述文案。',
    },
    'ewoh-spark-app/client/src/pages/RoleWorkbench/RoleWorkbench.tsx': {
      max: 1, audit: 'CLI-303 簇裁决',
      reason: '「演示工厂上线」按钮为显式演示入口文案（用户可辨识的演示动作，非伪造数据）。',
    },
    'ewoh-spark-app/client/src/pages/RoleWorkbench/WorkbenchChrome.tsx': {
      max: 1, audit: 'CLI-303 簇裁决',
      reason: '管理员「模拟查看」诊断视图说明文案：显式声明「不代表您的真实权限，仅用于诊断与演示」。',
    },
    'ewoh-spark-app/client/src/pages/System/System.tsx': {
      max: 3, audit: 'CLI-303 簇裁决',
      reason: '视觉理解演示模式说明：默认演示图/服务端演示密钥的显式标注文案（凭据面由 SSRF 门禁另行覆盖）。',
    },
    'ewoh-spark-app/client/src/pages/WorkOrchestration/SiteReadinessWizard.tsx': {
      max: 1, audit: 'CLI-303 簇裁决',
      reason: 'Dry Run 本地示例说明：显式声明「本地示例为非真实映射，仅供演示」。',
    },
    'src/edge_platform/static/index.html': {
      max: 2, audit: 'EDGE-demo 裁决',
      reason: '边缘平台演示 UI 文案（一键重置演示/15 分钟六步演示）：stub 演示页面本体，受 EWOH_ALLOW_STUB/development 模式约束。',
    },
  },
  AG_00: {}, // CLI-201 修复后无残留（仅注释提及修复历史，注释不计）
  occupancy_05: {
    'ewoh-spark-app/client/src/pages/CommandMap/FactoryMap.tsx': {
      max: 1, audit: 'CLI-011/012 裁决',
      reason: 'occupancy 缺省仅用于告警呼吸动画时长 dur 计算（纯视觉参数）；占用数值展示与 WIP 派生已改真实遥测/显式 unknown，不再由 0.5 伪造。',
    },
  },
  math_random: {
    'ewoh-spark-app/client/src/components/business-ui/user-select/utils.tsx': {
      max: 2, audit: 'CLI-505 簇裁决',
      reason: '未知用户 fallback 渲染 key（_unknown_ 前缀 + 随机后缀防 key 碰撞）——非安全标识，不涉加密。',
    },
    'ewoh-spark-app/client/src/components/ui/sidebar.tsx': {
      max: 1, audit: 'CLI-505 簇裁决',
      reason: 'Skeleton 骨架屏随机宽度（纯视觉动画参数）。',
    },
    'ewoh-spark-app/client/src/lib/observability.ts': {
      max: 2, audit: 'CLI-505 簇裁决',
      reason: '可观测性采样率判定与指数退避抖动系数——采样/抖动用途，非加密。',
    },
    'ewoh-spark-app/client/src/lib/offlineDb.ts': {
      max: 2, audit: 'CLI-505/510 裁决',
      reason: '离线队列记录 id 后缀与重试抖动——非安全 id（上传队列可见性 key）；安全 IV 在 offlineCrypto 已强制 WebCrypto。',
    },
    'ewoh-spark-app/client/src/lib/offlineLeader.ts': {
      max: 2, audit: 'CLI-505 簇裁决',
      reason: '离线主选举实例 id 与选举延迟抖动——选举语义允许非加密随机；lease 密钥面在 offlineCrypto（WebCrypto）。',
    },
    'ewoh-spark-app/client/src/lib/offlineSettings.ts': {
      max: 1, audit: 'CLI-505 簇裁决',
      reason: '设置存储迁移 id 后缀——非安全 id。',
    },
    'ewoh-spark-app/client/src/lib/uploadGuard.ts': {
      max: 1, audit: 'CLI-505 簇裁决',
      reason: '上传会话 id 后缀——非安全 id（并发上传去重 key）。',
    },
  },
  exec_command: {}, // CLI-705 修复后无调用残留（仅注释说明移除历史）
  admin123: {}, // 无弱口令残留（server 侧测试账号属 Python 测试域，不在本扫描面）
};

const PATTERNS = {
  演示: { re: /演示/g, commentAware: false }, // 含文案/注释全计数（显式标注制）
  AG_00: { re: /AG-00/g, commentAware: true },
  occupancy_05: { re: /occupancy\s*\?\?\s*0\.5/g, commentAware: false },
  math_random: { re: /Math\.random/g, commentAware: true },
  exec_command: { re: /document\.execCommand\s*\(/g, commentAware: true },
  admin123: { re: /admin123/g, commentAware: false },
};

function walk(root, cfg, out) {
  const abs = path.join(REPO_ROOT, root);
  for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
    const p = path.join(abs, ent.name);
    const rel = path.relative(REPO_ROOT, p);
    if (EXCLUDED_PATHS.some((re) => re.test(rel + '/'))) continue;
    if (ent.isDirectory()) walk(path.relative(REPO_ROOT, p), cfg, out);
    else if (cfg.exts.test(ent.name) && !(cfg.excludeTest && /\.(test|spec)\./.test(ent.name))) {
      out.push(p);
    }
  }
  return out;
}

const files = SCAN_ROOTS.flatMap((cfg) => walk(cfg.dir, cfg, [])).sort();

const counts = {}; // pattern → file → { n, lines: [lineno] }
for (const [name, { re, commentAware }] of Object.entries(PATTERNS)) {
  counts[name] = {};
  for (const file of files) {
    const rel = path.relative(REPO_ROOT, file);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const hits = [];
    lines.forEach((l, i) => {
      re.lastIndex = 0;
      const matched = re.test(l);
      re.lastIndex = 0;
      if (!matched) return;
      if (commentAware && isCommentLine(l.trim())) return;
      hits.push(i + 1);
    });
    if (hits.length > 0) counts[name][rel] = { n: hits.length, lines: hits };
  }
}

// ── 比对（双向） ─────────────────────────────────────────────────────────────
for (const [name, perFile] of Object.entries(counts)) {
  const wl = WHITELIST[name];
  const overs = [];
  for (const [rel, { n, lines }] of Object.entries(perFile)) {
    const entry = wl[rel];
    if (!entry) {
      overs.push(`${rel} 未登记（${n} 处 @ ${lines.join(',')}）`);
    } else if (n > entry.max) {
      overs.push(`${rel} ${n} 处 > 登记 ${entry.max}（@ ${lines.join(',')}）`);
    }
  }
  check(`demo_residue:${name}`, overs.length === 0, overs.join(' | '));

  const stale = Object.keys(wl).filter((rel) => !perFile[rel] || perFile[rel].n === 0);
  check(`demo_whitelist_stale:${name}`, stale.length === 0, stale.join(' | '));
  for (const [rel, entry] of Object.entries(wl)) {
    if (!entry.audit || !entry.reason) {
      check(`demo_whitelist_invalid:${name}`, false, `${rel} 登记缺 audit/reason`);
    }
  }
}

// 扫描面健全性（防 import 演化后扫描面静默清空）
check('demo_scan_surface_sane', files.length > 400, `${files.length} 文件`);

// ── 汇总 ────────────────────────────────────────────────────────────────────
const wlTotal = Object.values(WHITELIST).reduce((s, m) => s + Object.keys(m).length, 0);
const hitTotal = Object.values(counts).reduce((s, m) => s + Object.values(m).length, 0);
console.log(
  `[audit-demo-residue] 扫描 ${files.length} 文件 / 命中 ${hitTotal} 文件次 / 白名单 ${wlTotal} 条`,
);
for (const p of passes) console.log(`PASS ${p}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`FAIL ${f}`);
  console.log(`\n[audit-demo-residue] ${failures.length} 项失败（新残留或僵尸登记）。`);
  process.exit(1);
}
console.log('[audit-demo-residue] 全部通过：无未登记的演示/伪造残留。');
