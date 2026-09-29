#!/usr/bin/env node
/**
 * V108 扫描器（试点自己的取证工具，不接产品门禁）：
 * 前端硬编码的"状态字面量"是否都落在对应域的**契约词表**里。
 *
 * 为什么要域限定：逐条把 7 张词表并成一个大全集太宽松（`cancelled` 在 approval 里合法、
 * 在 plan 里是 V60 记的未声明态），会把这个家族的真实漂移读成"没问题"；
 * 反过来只看字面形状又会在 `personId`/`org` 这类字符串上造误报（V87 的教训）。
 * 所以判据是：**同一个域内**（由字段名/常量名/类型名推断）出现的状态字面量 ∉ 该域权威词表 ⇒ 命中。
 *
 * 权威词表来源：
 *   · 7 张 `contracts/state-machines/*.yaml` 的 `states:`；
 *   · 执行面词表只存在于代码里（`execution-receipt-state.ts` 的 `allowed` 键），一并纳入。
 *
 * 常驻入口：`make chain-baseline-client-drift`（等价于 node scripts/chain-baseline/client-status-drift.cjs）
 *   --self-test  只跑判据自测（9 项，含 3 条反向控制）；默认先自检再扫真实前端——
 *                **尺子不可信时拒绝输出任何"未命中"结论**（V83/V68 的同一顺序）。
 *   --strict     用第二轮的严格判据（65 处/命中 31，逐条人工判定见基线 §5.3bc）；
 *                缺省是松判据，其 71% 假正面率已被量出来并据此**否决作为门禁**（V87 口径）。
 * 已确认的两条读侧问题登记在 §5.4：UIX-01（前端徽标恒假分支 + 兜底吞态）、
 * DFLT-01（status 列 DB 默认值从未与契约对账）。本脚本只报告，不做门禁，也不接进十七条产品主线。
 */
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
// 这个脚本按仓库根目录的相对路径找契约与前端；不在根目录跑会静默扫到空集合，
// 而"扫到 0 个文件"看起来像"没有漂移"——正是 V96/V97 反复提醒的假绿形状。
if (!fs.existsSync(path.join(ROOT, 'contracts/state-machines/plan.yaml'))) {
  console.error('必须在仓库根目录运行（找不到 contracts/state-machines/plan.yaml）');
  process.exit(3);
}
const CM_DIR = path.join(ROOT, 'contracts/state-machines');
const EXEC_STATE = path.join(ROOT, 'ewoh-spark-app/server/modules/scheduler/execution-receipt-state.ts');
const CLIENT_DIR = path.join(ROOT, 'ewoh-spark-app/client/src');

const DOMAIN_BY_YAML = {
  'agent-task.yaml': 'agent-task', 'alert.yaml': 'alert', 'approval.yaml': 'approval',
  'control.yaml': 'control', 'fleet.yaml': 'fleet', 'plan.yaml': 'plan', 'task.yaml': 'task',
};
// 一个域可以有多张词表（跨域同名字段），命中判定按"该字面量出现在哪个域的上下文"走。
const DOMAIN_HINTS = [
  ['execution', /execution|Execution|EXECUTION/],
  ['plan', /plan|Plan|PLAN/],
  ['task', /task|Task|TASK/],
  ['control', /command|Command|COMMAND|control|Control|CONTROL/],
  ['approval', /approval|Approval|APPROVAL/],
  ['agent-task', /agent|Agent|AGENT/],
  ['alert', /alert|Alert|ALERT/],
  ['fleet', /fleet|Fleet|FLEET/],
];

function parseYamlStates(file) {
  const txt = fs.readFileSync(file, 'utf8');
  const m = txt.match(/states:\s*\n((?:[ \t]*-[ \t]+\S+\n?)+)/);
  if (!m) throw new Error(`词表解析失败（没找到 states: 列表）：${file}`);
  const out = [...m[1].matchAll(/^[ \t]+-[ \t]+([A-Za-z_][\w]*)/gm)].map((x) => x[1]);
  if (out.length < 3) throw new Error(`词表过小（${out.length} 个），解析器可能漏读：${file}`);
  return new Set(out);
}

function parseExecutionVocabulary() {
  const txt = fs.readFileSync(EXEC_STATE, 'utf8');
  const block = txt.match(/const allowed: Record<string, string\[\]> = \{([\s\S]*?)\n\};/);
  if (!block) throw new Error('执行面词表解析失败');
  // 先剥掉右侧数组再取键：一行里可能并排写三个状态（V107 的 AV-04 就是这么漏读 FAILED/CANCELLED 的）。
  const keysOnly = block[1].replace(/\[[^\]]*\]/g, '');
  const out = [...keysOnly.matchAll(/([A-Z_]+)\s*:/g)].map((m) => m[1]);
  const expected = ['PLANNED', 'DISPATCHED', 'STARTED', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED'];
  if (out.sort().join(',') !== expected.slice().sort().join(',')) {
    throw new Error(`执行面词表自测失败：解析得到 ${JSON.stringify(out)}，应为 ${JSON.stringify(expected)}`);
  }
  return new Set(expected);
}

function buildAuthorities() {
  const auth = {};
  for (const [file, domain] of Object.entries(DOMAIN_BY_YAML)) {
    auth[domain] = parseYamlStates(path.join(CM_DIR, file));
  }
  auth.execution = parseExecutionVocabulary();
  return auth;
}

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

function guessDomain(text) {
  for (const [domain, re] of DOMAIN_HINTS) if (re.test(text)) return domain;
  return null;
}

// 只在"状态上下文"里取字面量：同一行/前两行出现 status/STATUS/state 才算，
// 且字面量形状得像个状态词（小写 snake 或大写常量），排除 id/中文/URL。
const STATUS_CONTEXT = /(status|state)/i;
const LITERAL = /'([a-z][a-z0-9_]{2,}|[A-Z][A-Z0-9_]{2,})'/g;
const STOPWORDS = new Set(['string', 'number', 'boolean', 'object', 'array', 'json', 'text', 'button', 'month', 'user', 'admin']);

function scanFiles(files, auth) {
  const hits = [];
  const perDomainCount = {};
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const window = [lines[i - 2], lines[i - 1], lines[i]].filter(Boolean).join(' ');
      if (!STATUS_CONTEXT.test(window)) continue;
      const domain = guessDomain(window);
      if (!domain || !auth[domain]) continue;
      for (const m of String(lines[i]).matchAll(LITERAL)) {
        const lit = m[1];
        if (STOPWORDS.has(lit)) continue;
        perDomainCount[domain] = (perDomainCount[domain] ?? 0) + 1;
        if (!auth[domain].has(lit)) {
          hits.push({ domain, literal: lit, file: path.relative(ROOT, file), line: i + 1, text: String(lines[i]).trim().slice(0, 160) });
        }
      }
    }
  }
  return { hits, perDomainCount };
}

// 命中项带上下文原文，便于逐条人工判定"真漂移 / 域推断错 / 与本域无关"（V87 的处置前提）。
function groupAndPrint(hits) {
  const grouped = {};
  for (const h of hits) (grouped[`${h.domain}:${h.literal}`] ??= []).push(`${h.file}:${h.line}｜${h.text}`);
  for (const [k, list] of Object.entries(grouped).sort()) {
    console.log(`  ${k}  ×${list.length}`);
    for (const entry of list.slice(0, 4)) console.log(`      ${entry}`);
    if (list.length > 4) console.log(`      …另 ${list.length - 4} 处`);
  }
}

function selfTest(auth) {
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'v108-selftest-'));
  const cases = [
    {
      name: '已知阳性：plan 上下文里用了契约未声明的态',
      file: path.join(tmp, 'posPlan.tsx'),
      body: `const x = { planStatus: 'nosuchstate' };\nif (plan.status === 'nosuchstate') return 1;\n`,
      expect: (h) => h.some((x) => x.domain === 'plan' && x.literal === 'nosuchstate'),
    },
    {
      name: '反向控制：合法态不得命中',
      file: path.join(tmp, 'negPlan.tsx'),
      body: `if (plan.status === 'pending_review' || plan.status === 'dispatched') return 1;\n`,
      expect: (h) => h.length === 0,
    },
    {
      name: '反向控制：非状态上下文（人名/键名）不得命中',
      file: path.join(tmp, 'negOther.tsx'),
      body: `const columns = [{ key: 'owner' }, { key: 'warehouse' }];\n`,
      expect: (h) => h.length === 0,
    },
    {
      name: '执行面走代码词表：PAUSED 合法、RUNNING 未声明',
      file: path.join(tmp, 'exec.tsx'),
      body: `if (execution.status === 'PAUSED') return 1;\nif (execution.status === 'RUNNING') return 2;\n`,
      expect: (h) => h.length === 1 && h[0].literal === 'RUNNING' && h[0].domain === 'execution',
    },
  ];
  // 严格判据单独一组（含"数字状态码不得命中"的反向控制——HTTP 码与业务态同叫 status）
  const strictCases = [
    { name: '严格阳性：plan.status 与未声明态比较',
      body: `if (plan.status === 'nosuchstate') return 1;\n`,
      expect: (h) => h.length === 1 && h[0].literal === 'nosuchstate' && h[0].domain === 'plan' },
    { name: '严格反向控制：HTTP 数字状态码不得命中',
      body: `if (res.status === 500) return 1;\n`, expect: (h) => h.length === 0 },
    { name: '严格反向控制：动作名/键名上下文不得命中',
      body: `const actions = { approve: 'a', reject: 'b' };\nlabel: 'approve',\n`,
      expect: (h) => h.length === 0 },
    { name: '严格阳性：taskStatus: 字面量形态',
      body: `const row = { taskStatus: 'sent' };\n`, expect: (h) => h.length === 1 && h[0].literal === 'sent' },
    { name: '严格反向控制：测试文件整体不参与',
      file: 'foo.test.ts', body: `if (plan.status === 'nosuchstate') return 1;\n`,
      expect: (h) => h.length === 0 },
  ];
  let failed = 0;
  for (const c of strictCases) {
    const spath = path.join(tmp, c.file ?? 'strictCase.ts');
    fs.writeFileSync(spath, c.body);
    const { hits } = scanFilesStrict([spath], auth);
    const ok = c.expect(hits);
    if (!ok) failed += 1;
    console.log(`  ${ok ? '✔' : '✕'} [严格] ${c.name} → ${JSON.stringify(hits.map((x) => `${x.domain}:${x.literal}`))}`);
    fs.rmSync(path.join(tmp, c.file ?? 'strictCase.ts'));
  }
  cases.length = cases.length; // 松判据那组继续跑（它记录了第一轮的读数）
  for (const c of cases) {
    fs.writeFileSync(c.file, c.body);
    const { hits } = scanFiles([c.file], auth);
    const ok = c.expect(hits);
    if (!ok) failed += 1;
    console.log(`  ${ok ? '✔' : '✕'} ${c.name} → 命中 ${JSON.stringify(hits.map((h) => `${h.domain}:${h.literal}`))}`);
    fs.rmSync(c.file);
  }
  fs.rmdirSync(tmp);
  console.log(`判据自测：${cases.length - failed}/${cases.length} 通过`);
  return failed === 0;
}

// 严格判据（第二轮）：只认"拿某个 `.status`/`status:` 字段与字面量**比较**"这一种形状，
// 且排除测试与 mock 文件——第一轮用"同一行出现 status 字样"的松判据得到 614 个字面量、
// 439 处"不在词表"，其中绝大多数是动作名（approve/reject）、错误码（CONFLICT）、
// HTTP 方法（POST）与测试夹具，假正面率 ≈71%，不能作为门禁（同 V87 的处置口径）。
// 字段名允许 camelCase 前后缀（taskStatus / planStatus / executionState）。
// 第一版写了 `\\b(status|state)`（还残留了一处 python 转义带来的 `\\.`），`taskStatus:` 直接漏读，
// 判据自测的严格阳性用例当场不通过——召回有洞时不许读任何"未命中"结论。
const STRICT_CONTEXT = /\w*(?:status|state)\s*(?:===|!==|==|!=|:|\.includes|\.indexOf)/i;
const STRICT_LITERAL = /\w*(?:status|state)\s*(?:===|!==|==|!=)\s*'([A-Za-z_][\w]*)'|'([A-Za-z_][\w]*)'\s*(?:===|!==|==|!=)\s*\w*(?:status|state)|\w*(?:status|state)\s*:\s*'([A-Za-z_][\w]*)'/gi;

function scanFilesStrict(files, auth) {
  const hits = [];
  const perDomainCount = {};
  for (const file of files) {
    if (/\.(test|spec|stories)\.[tj]sx?$/.test(file) || /[\\/]__tests__[\\/]/.test(file)) continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!STRICT_CONTEXT.test(line)) continue;
      const domain = guessDomain(line);
      if (!domain || !auth[domain]) continue;
      for (const m of line.matchAll(STRICT_LITERAL)) {
        const lit = m[1] || m[2] || m[3];
        if (!lit || STOPWORDS.has(lit)) continue;
        perDomainCount[domain] = (perDomainCount[domain] ?? 0) + 1;
        if (!auth[domain].has(lit)) {
          hits.push({ domain, literal: lit, file: path.relative(ROOT, file), line: i + 1, text: line.trim().slice(0, 160) });
        }
      }
    }
  }
  return { hits, perDomainCount };
}

function main() {
  const auth = buildAuthorities();
  console.log('权威词表：' + Object.entries(auth).map(([k, v]) => `${k}=${v.size}`).join(' '));
  if (process.argv.includes('--self-test')) {
    const ok = selfTest(auth);
    console.log(ok ? '（尺子可红，真实前端的"未命中"结论才可读）' : '（尺子失效：不得据此下结论）');
    process.exit(ok ? 0 : 3);
  }
  if (!process.argv.includes('--scan-selftest')) {
    // 先自检再读真实结果（V83/V68 同一顺序：运行健康先于判定）
    const files = walk(CLIENT_DIR);
    const scanner = process.argv.includes('--strict') ? scanFilesStrict : scanFiles;
    const { hits, perDomainCount } = scanner(files, auth);
    console.log(`扫描前端文件 ${files.length} 个；状态上下文里取到的字面量按域计数：`
      + Object.entries(perDomainCount).map(([k, v]) => `${k}=${v}`).join(' '));
    console.log(`不在本域契约词表里的状态字面量：${hits.length} 处`);
    groupAndPrint(hits);
  }
}

main();
