#!/usr/bin/env node
/**
 * 授权上下文转发判据（V267）——只回答一个问题：
 *   在调度模块里，有没有代码读 `OrgContext` 上的某个字段，而起**归一化器**（`toOrgContext`）不转发它？
 *
 * 起因＝RCPTCTX-01（V265）：`toOrgContext` 只转发 5 个字段，把 `roles`/`personId` 丢掉，
 * 而下游谓词正是读这两个字段判"谁能推进回执" ⇒ 文档写明的回执端点对除 global_admin 外的所有角色 403。
 * 那条修法当时只由一条 e2e 腿（FC 系列）偶然兜着：第二类同类削薄不会有机械信号。本尺把这条约束变成棘轮。
 *
 * 为什么按**声明类型**而不是按变量名：V266 的预备探针实测，按"形参名＋注解文本"匹配会造出
 * 5 个伪字段（userContext/ctx/orgId/snapshotVersion/seed）——名字像 OrgContext 的对象被算进来，判据就成了假阳性机器。
 * 改用 TypeChecker 比 `OrgContext` 接口符号后：真语料读点 268 处、读字段 7 个、违规 0。
 * 别名与多跳也不用本尺自己追：`const ctx = actor;` 之后的 `ctx.roles` 在类型层面仍是 OrgContext，
 * 普查按模块整体扫，天然覆盖"谓词隔两跳"那个瞎点（一跳调用图解析对 RCPTCTX-01 完全瞎，实测见登记册 §5.3lj 限度③）。
 *
 * 判据形状（保守并集）：读字段全集 ⊆ 归一化器转发集。
 *  违规 ⇒ 退出码 1；输入读不到 ⇒ 退出码 3（**不可判**，绝不折成"没有读点所以干净"）。
 * 诊断档（不判红）：模块内其它同名归一化器的转发集差异，只打印、交给人判。
 *
 * 用法：node scripts/chain-baseline/context-forwarding.cjs [--json] [--self-test] [--root <dir>] [--quiet]
 * 自测夹具＝临时合成树（含"同名不同类型"与"作用域外"两支**必须不开火**的假阳性对照）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const argv = () => process.argv.slice(2);
const flag = (n) => argv().includes(n);
const opt = (n) => { const a = argv(); const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };

function loadTs() {
  const candidates = [
    path.join(__dirname, '..', '..', 'ewoh-spark-app', 'node_modules', 'typescript'),
    'typescript',
  ];
  for (const c of candidates) { try { return require(c); } catch { /* 下一个 */ } }
  return null;
}

const TYPE_FILE = 'ewoh-spark-app/server/modules/shared/org-context.interceptor.ts';
const TYPE_NAME = 'OrgContext';
const NORMALIZER = 'ewoh-spark-app/server/modules/scheduler/scheduler-run-context.ts';
const NORMALIZER_FN = 'toOrgContext';
const SCOPE = 'ewoh-spark-app/server/modules/scheduler';

/** 递归列出作用域内的实现文件（跳过测试与生成物）。 */
function listScope(root, dir) {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) return null;
  const out = [];
  (function walk(p) {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const f = path.join(p, e.name);
      if (e.isDirectory()) { if (!['node_modules', 'dist', '__tests__'].includes(e.name)) walk(f); }
      else if (e.name.endsWith('.ts') && !/\.spec\.ts$/.test(e.name)) out.push(path.relative(root, f));
    }
  })(abs);
  return out.sort();
}

function judge(root) {
  const ts = loadTs();
  const problems = [];
  const notes = [];
  const read = (rel) => {
    const p = path.join(root, rel);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  };
  if (!ts) return { rc: 3, problems: ['读不到 typescript（node_modules）⇒ 不可判，不折成干净'], notes, files: [] };

  const scopeFiles = listScope(root, SCOPE);
  if (!scopeFiles || !scopeFiles.length) return { rc: 3, problems: [`作用域内没有 .ts 文件：${SCOPE} ⇒ 不可判`], notes, files: [] };
  if (!read(NORMALIZER)) return { rc: 3, problems: [`归一化器文件读不到：${NORMALIZER} ⇒ 不可判`], notes, files: [] };
  if (!read(TYPE_FILE)) return { rc: 3, problems: [`类型声明文件读不到：${TYPE_FILE} ⇒ 不可判`], notes, files: [] };

  const appDir = path.join(root, 'ewoh-spark-app');
  const program = ts.createProgram(scopeFiles.map((r) => path.join(root, r)), {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    experimentalDecorators: true, emitDecoratorMetadata: true,
    esModuleInterop: true, skipLibCheck: true, noEmit: true, strict: false,
    baseUrl: appDir, paths: { '@server/*': [path.join(appDir, 'server/*')], '@shared/*': [path.join(appDir, 'shared/*')] },
  });
  const checker = program.getTypeChecker();

  // ① 目标类型符号
  let typeSym = null;
  for (const sf of program.getSourceFiles()) {
    if (!sf.fileName.endsWith(TYPE_FILE)) continue;
    ts.forEachChild(sf, (n) => {
      if ((ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) && n.name.text === TYPE_NAME) {
        typeSym = checker.getSymbolAtLocation(n.name) || (n.symbol);
      }
    });
  }
  if (!typeSym) return { rc: 3, problems: [`在 ${TYPE_FILE} 里找不到 interface ${TYPE_NAME} ⇒ 类型改了名，判据不猜`], notes, files: [] };

  // ② 归一化器转发集
  let forwarded = null;
  const otherProducers = [];
  for (const sf of program.getSourceFiles()) {
    if (!sf.fileName.endsWith(NORMALIZER)) continue;
    ts.forEachChild(sf, (n) => {
      if (ts.isFunctionDeclaration(n) && n.name && n.name.text === NORMALIZER_FN && n.body) {
        const ret = n.body.statements.find((s) => ts.isReturnStatement(s) && s.expression);
        if (ret && ts.isObjectLiteralExpression(ret.expression)) {
          forwarded = ret.expression.properties.map((p) => p.name.getText().replace(/["']/g, ''));
        }
      }
    });
  }
  if (!forwarded) return { rc: 3, problems: [`读不到 ${NORMALIZER_FN} 的返回对象字面量 ⇒ 不可判（写法变了别当"没转发"）`], notes, files: [] };

  // 其它同名归一化器（诊断档，不判红）
  const nf = new Set(forwarded);
  for (const sf of program.getSourceFiles()) {
    if (!sf.fileName.startsWith(path.join(root, SCOPE)) || /\.spec\.ts$/.test(sf.fileName)) continue;
    (function walk(n) {
      const isProd = (ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n)) && n.name && n.name.text === NORMALIZER_FN;
      if (isProd && !sf.fileName.endsWith(NORMALIZER)) {
        const ret = n.body && n.body.statements.find((s) => ts.isReturnStatement(s) && s.expression && ts.isObjectLiteralExpression(s.expression));
        if (ret) {
          const set = ret.expression.properties.map((p) => p.name.getText().replace(/["']/g, ''));
          const missing = [...nf].filter((x) => !set.includes(x));
          otherProducers.push({ file: path.relative(root, sf.fileName), forwarded: set.length, missing });
        }
      }
      ts.forEachChild(n, walk);
    })(sf);
  }

  // ③ 按声明类型的成员读普查
  const matchesType = (t) => {
    if (!t) return false;
    const one = (x) => { const s = x.getSymbol(); return !!(s && s === typeSym); };
    if (one(t)) return true;
    if (t.isUnionOrIntersection && t.isUnionOrIntersection()) return t.types.some(one);
    return false;
  };
  const reads = new Map();
  for (const sf of program.getSourceFiles()) {
    const rel = path.relative(root, sf.fileName);
    if (!rel.startsWith(SCOPE) || !sf.fileName.startsWith(path.join(root, SCOPE)) || /\.spec\.ts$/.test(rel)) continue;
    (function walk(n) {
      if (ts.isPropertyAccessExpression(n)) {
        const t = checker.getTypeAtLocation(n.expression);
        if (matchesType(t)) {
          const f = n.name.text;
          const { line } = sf.getLineAndCharacterOfPosition(n.getStart());
          if (!reads.has(f)) reads.set(f, []);
          reads.get(f).push(`${rel}:${line + 1}`);
        }
      }
      ts.forEachChild(n, walk);
    })(sf);
  }

  const readFields = [...reads.keys()].sort();
  const bad = readFields.filter((f) => !nf.has(f));
  const ok = readFields.length - bad.length;
  const sites = readFields.reduce((a, f) => a + reads.get(f).length, 0);
  // Σ=分母硬断言：档位加总必须等于读字段全集，否则枚举本身漏了
  if (ok + bad.length !== readFields.length) {
    problems.push(`档位加总 ${ok}+${bad.length} ≠ 读字段全集 ${readFields.length}（本尺枚举有洞，读数作废）`);
  }
  notes.push(`读字段 ${readFields.length} 个／读点 ${sites} 处｜转发集 ${forwarded.length} 件：${forwarded.join(',')}`);
  notes.push(`合规 ${ok}｜违规 ${bad.length}${bad.length ? '：' + bad.map((f) => `${f}(${reads.get(f).join(' ')})`).join('；') : ''}`);
  for (const o of otherProducers) {
    notes.push(`诊断（不判红）：${o.file} 也有同名归一化器，只转发 ${o.forwarded} 件，未转发 ${o.missing.join(',') || '（无）'}——是否属"写路径谓词"由人判`);
  }
  for (const f of bad) problems.push(`读而未转发：${f} ← ${reads.get(f).slice(0, 6).join(' ')}${reads.get(f).length > 6 ? ` 等 ${reads.get(f).length} 处` : ''}`);
  return { rc: problems.length ? 1 : 0, problems, notes, files: readFields, forwarded, reads, bad };
}

/** 合成树：接口三字段（userId/primaryOrgId/roles），归一化器转发集与读点由各控制在配置里给。 */
function fixture(over) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxfwd-'));
  const w = (rel, text) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  };
  const T = 'ewoh-spark-app/server/modules/shared/org-context.interceptor.ts';
  const N = 'ewoh-spark-app/server/modules/scheduler/scheduler-run-context.ts';
  const A = 'ewoh-spark-app/server/modules/scheduler/a.service.ts';
  const O = 'ewoh-spark-app/server/modules/other/b.service.ts';
  w(T, 'export interface OrgContext { userId?: string; primaryOrgId?: string; roles?: string[]; }\n' + (over.extraType || ''));
  w(N, `import type { OrgContext } from '../shared/org-context.interceptor';\n`
    + `export function toOrgContext(actor?: OrgContext): OrgContext { return { ${over.forward} }; }\n`);
  if (over.readInScope != null || over.scopeExtra) {
    w(A, `import type { OrgContext } from '../shared/org-context.interceptor';\n`
      + `export function can(ctx?: OrgContext) { ${over.readInScope || 'return 0;'} }\n${over.scopeExtra || ''}`);
  }
  if (over.readOutside) {
    w(O, `import type { OrgContext } from '../shared/org-context.interceptor';\n`
      + `export function out(ctx?: OrgContext) { ${over.readOutside} }\n`);
  }
  return root;
}

function selfTest() {
  const cases = [];
  const t = (name, expect, cfg) => {
    const root = fixture(cfg);
    const r = judge(root);
    const got = expect === 'red' ? r.rc === 1 : expect === 'clean' ? r.rc === 0 : r.rc === 3;
    cases.push({ name, ok: got, want: expect, rc: r.rc, first: (r.problems[0] || '').slice(0, 90) });
    fs.rmSync(root, { recursive: true, force: true });
  };
  t('T1 读点落在归一化器没转发的字段上 ⇒ 必须红（RCPTCTX-01 的形状）', 'red', {
    forward: 'userId: actor?.userId, primaryOrgId: actor?.primaryOrgId ?? ""',
    readInScope: 'return (ctx.roles ?? []).length;',
  });
  t('T2 合规形状：读的两个字段都转发了 ⇒ 不得红', 'clean', {
    forward: 'userId: actor?.userId, primaryOrgId: actor?.primaryOrgId ?? "", roles: actor?.roles',
    readInScope: 'return (ctx.roles ?? []).length + (ctx.userId ?? "").length;',
  });
  // T3 是"按名字匹配会误伤"那一族的两支：①同名变量但声明类型是别的接口；②字面量对象恰好有同名键。
  t('T3 假阳性对照：作用域内 `ctx.roles` 的 ctx 声明成**别的接口**／匿名对象 ⇒ 不得算读点（探针实测这类伪字段有 5 个）', 'clean', {
    forward: 'userId: actor?.userId, primaryOrgId: actor?.primaryOrgId ?? ""',
    readInScope: 'return 0;',
    scopeExtra: 'interface OtherCtx { roles?: string[]; }\n'
      + 'export function f(c: OtherCtx) { return c.roles; }\n'
      + 'export function g() { const ctx = { roles: ["a"] }; return ctx.roles; }\n',
  });
  t('T4 假阳性对照：读点在**作用域外**的模块里 ⇒ 不进本尺分母', 'clean', {
    forward: 'userId: actor?.userId, primaryOrgId: actor?.primaryOrgId ?? ""',
    readInScope: 'return 0;',
    readOutside: 'return ctx.roles;',
  });
  t('T6 别名与多跳：读点挂在 `const c = ctx;` 之后 ⇒ 仍须算进来（一跳调用图会瞎在这里）', 'red', {
    forward: 'userId: actor?.userId, primaryOrgId: actor?.primaryOrgId ?? ""',
    readInScope: 'const c = ctx; return (c.roles ?? []).length;',
  });
  return cases;
}

if (flag('--self-test')) {
  const cases = selfTest();
  // T5／T7：两支 fail-closed——少文件必须判「不可判」（rc=3），不许折成"没有读点所以干净"。
  for (const [label, victim, code] of [
    ['T5 归一化器文件缺失', NORMALIZER, 'unjudgeable'],
    ['T7 类型声明文件缺失', TYPE_FILE, 'unjudgeable'],
  ]) {
    const root = fixture({ forward: 'userId: actor?.userId', readInScope: 'return ctx.userId;' });
    fs.rmSync(path.join(root, victim));
    const r = judge(root);
    cases.push({ name: `${label} ⇒ 必须判"不可判"（不得折成已核）`, ok: r.rc === 3, want: code, rc: r.rc, first: (r.problems[0] || '').slice(0, 90) });
    fs.rmSync(root, { recursive: true, force: true });
  }
  let fail = 0;
  for (const c of cases) {
    if (!c.ok) fail++;
    console.log(`${c.ok ? '✔' : '✘'} ${c.name}（期望 ${c.want}，实得 rc=${c.rc}）${c.ok ? '' : ' → ' + c.first}`);
  }
  console.log(`判据自测 ${cases.length - fail}/${cases.length} 通过；夹具＝临时合成树，真产物从未被写`);
  process.exit(fail ? 1 : 0);
}

const r = judge(opt('--root') || process.cwd());
if (!flag('--quiet')) for (const n of r.notes) console.log(`  · ${n}`);
for (const p of r.problems) console.log(`  ✗ ${p}`);
console.log(r.rc === 0 ? '✅ 授权上下文转发判据：读字段全部在转发集内' : r.rc === 3 ? '⚠️ 不可判（输入读不到，不折算成已核）' : `⚠️ ${r.problems.length} 项读而未转发`);
if (flag('--json')) console.log(JSON.stringify({ rc: r.rc, forwarded: r.forwarded, files: r.files, bad: r.bad, notes: r.notes, problems: r.problems }));
process.exit(r.rc);
