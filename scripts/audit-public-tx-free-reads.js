#!/usr/bin/env node
/**
 * 身份前 / 守卫阶段「事务外数据库访问」清单门禁（CFG-01b 的静态面，V68）。
 *
 * 为什么需要它（不是"再跑几个 spec"）：
 *  `EWOH_DB_REQUIRE_TX=1` 是租户隔离的 fail-closed 兜底（V61 起可用、V62 起进重放 D2 档）。
 *  它只在**请求上下文内回落根句柄**时抛错，而 `OrgContextInterceptor` 只把带 `userContext`
 *  的请求包进事务 ⇒ 结构性存在两类**永远不在请求事务里**的读：
 *    ① `@Public()` 端点（身份之前）；
 *    ② 守卫（Nest 的执行次序是 guard 先于 interceptor，所以守卫里的读一定在事务外）。
 *  V65 已经在**链外**带开关普查过 8 个 e2e spec，抓到并修掉一条真缺陷（F-14 就绪探针恒 503），
 *  但那条路收敛不了剩下的面：**没有 e2e 会走到的路径**跑多少次都不会暴露。
 *  本门禁把这两类位点变成一张只许缩小的清单——新引入一个事务外读会在 CI 上爆红，而不是等某次
 *  探针恰好打到它。
 *
 * 三条规则（fail-closed）：
 *  1. `cfg01b_guard_no_unguarded_db`：任何 `*.guard.ts` 引用数据库句柄（`DRIZZLE_DATABASE` /
 *     `PostgresJsDatabase` / `this.db` / `RequestDatabaseContext`）都必须登记（守卫先于拦截器 ⇒ 无事务）；
 *  2. `cfg01b_public_no_unguarded_read`：`@Public()` 处理方法若**一跳之内**可达数据库
 *     （控制器自己用句柄，或注入的服务里存在**同名方法**且该方法体不含显式事务标记），必须登记；
 *  3. `cfg01b_scan_nonempty` + 僵尸登记：清单非空、且登记项不得虚挂（文件/方法已消失也要处理）。
 *
 * 判定边界（诚实声明，防止把它当成"证明安全"）：
 *  - 深度：controller → service（V88 起默认两跳，含各文件内私有方法 ≤2 层）。更深的链需要过程间分析，
 *    V56 的教训是"判据分不清上下文就造误报"，所以这里宁缺毋滥：清单是**覆盖面声明**，
 *    不是"未登记即安全"的证明；
 *  - `@Public()` 的归属（V192）：按**成员所属类**求值——从定义行向上收集连续装饰器块，
 *    并取该成员所在那个类的装饰器块（多类文件不再只看文件里第一个 `export class`）。
 *    旧的两个魔数窗口（方法 6 行／类 8 行）由 `GATE17_DECOR=window` 保留做对照。
 *    实测代价：结构档比窗口档多暴露 2 条真位点（control.controller.ts 的 receiptByCommand/ack，
 *    已登记并逐条核对），丢位点 0 ⇒ 默认档已翻到 struct。
 *  - 显式事务标记 = `systemTransaction` / `systemGlobalAdminTransaction` /
 *    `runDetachedTransaction` / `runInTransaction` / `.transaction(` / `requestDatabaseContextSafe`
 *    出现在该方法**自己的作用域内**（V191 起与主线7 共用 `scripts/tx-scope-shared.js`：
 *    先屏蔽注释/字符串/模板/正则，再按花括号配定作用域；允许一种外推——本方法是交给执行器的
 *    具名回调）。旧口径（区域内出现文本即算）由 `GATE14_REGION=text GATE14_COMMENTS=raw` 保留做对照。
 *
 * 自测：`node scripts/audit-public-tx-free-reads.js --self-test`
 * （喂合成语料证明：守卫能抓到、@Public 一跳/两跳能抓到、有显式事务的不误报、
 *  基线变大能报红、登记虚挂能报僵尸；V191 另加 6 项两档极性对照——"标记只是一行注释"与
 *  "标记来自隔壁方法（旧区域拖到文件尾）"在收紧档必须报、在旧档确实不报，
 *  外加"具名回调交给执行器"两档都不误报与"注释换成真语句即不报"的元反证；
 *  V192 再加 3 项类归属极性（第二个类的公开面必须报、旧窗口确实看不见、非公开类成员不得被拖进来））。
 *
 * 用法：
 *   node scripts/audit-public-tx-free-reads.js            # 比对基线（CI 口径）
 *   node scripts/audit-public-tx-free-reads.js --report   # 只打印当前位点清单（人读）
 *   node scripts/audit-public-tx-free-reads.js --self-test
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SERVER_DIR = path.join(REPO_ROOT, 'ewoh-spark-app/server');

/**
 * 现状基线（V68 实测冻结，**只许缩小**）。
 * 键：`相对路径#处理方法`；值：为什么它可以在请求事务之外（或虽在事务内但需显式声明）访问数据库。
 * 三条都是**机器面**：类级 `@Public()` + `@UseGuards(IngestGuard)`，
 * 而 `IngestGuard` 会认证 ingest key 并挂上 `request.userContext`
 * （`server/modules/ingest/ingest.guard.ts:210`）⇒ 请求确实被 `OrgContextInterceptor` 包进事务。
 * 登记它们不是"承认有问题"，而是**声明这三条面由守卫而不是由身份建立事务**：
 * 一旦有人摘掉 `@UseGuards(IngestGuard)` 或让 IngestGuard 不再挂上下文，本门禁立刻爆红。
 * 对照：`@Public` 且**无**挂上下文的守卫（如 health 探针）必须走显式 `systemTransaction`
 * ——那是 V61（登录）与 V65（就绪探针 F-14）两次修掉的真实缺陷形状，不再出现在本清单里。
 */
const BASELINE = new Map([
  // V192：本文件的类级 @Public() 挂在**第三个**类（ControlGatewayController，:152-155）上，
  // 而旧口径只对"文件里第一个 export class"求值类级归属 ⇒ 这个类的另外两个机器面端点一直没进清单
  // （只有 `pending` 因恰好落在方法上方 6 行窗口内被碰上）。逐条核对：类级
  // @UseGuards(IngestGuard) 认证并挂 userContext ⇒ handler 与其服务链在 OrgContextInterceptor
  // 的请求事务内；服务方法自己不自建事务（this.db 直读）。两条都已有常驻链级用例真打该路由。
  ['ewoh-spark-app/server/modules/control/control.controller.ts#receiptByCommand',
    '机器面（V192 补登）：类级 @UseGuards(IngestGuard) 挂 userContext ⇒ 请求事务；'
    + 'control.service.ts receiveReceiptByCommandId 走 this.db 不自建事务。'
    + '行为面常驻覆盖：control-receipt-boundary / control-restart-boundary（D+D2）真打 POST /api/control/commands/{id}/receipt'],
  ['ewoh-spark-app/server/modules/control/control.controller.ts#ack',
    '机器面（V192 补登）：同上；control.service.ts ackCommand 走 this.db 不自建事务。'
    + '行为面常驻覆盖：control-restart-boundary / control-verification-projection（D+D2）与 C 段 control-actuator-loop'
    + '（含"无 ingest key 直接 ack"的负向分支）'],
  ['ewoh-spark-app/server/modules/control/control.controller.ts#pending',
    '机器面：@UseGuards(IngestGuard) 认证并挂 userContext ⇒ 有请求事务；投递前的授权复核/撤回走 runDetachedTransaction（安全决策不被外层回滚带走）。D2 档常驻覆盖（control-delivery-race）'],
  ['ewoh-spark-app/server/modules/ingest/ingest.controller.ts#ingestExoskeletonBatch',
    '机器面：同上（IngestGuard 挂 userContext）；批内自动重排走 detached 事务（RUN-01 修复，见 §5.3h）'],
  ['ewoh-spark-app/server/modules/ingest/ingest.controller.ts#ingestEvents',
    '机器面：同上（IngestGuard 挂 userContext）；ingest 触发的重排在 V50 后不再继承已结束的请求事务'],
  // V88：扫描从"一跳"加深到"两跳"后新暴露的 6 条同形状位点。它们一直在，只是 1-hop 看不见
  // ——V68 那句"3 条位点全部由 IngestGuard 挂上下文"因此是**对一半**：面其实是 9 条。
  // 逐条核对：控制器类级 @UseGuards(IngestGuard) + @Public() ⇒ 守卫挂 userContext，
  // handler 及其服务链在 OrgContextInterceptor 的请求事务内执行；无守卫阶段直接读句柄。
  ['ewoh-spark-app/server/modules/ingest/ingest.controller.ts#ingestExoskeleton',
    '机器面：IngestGuard 挂 userContext ⇒ 请求事务；两跳经 ingestService.ingestExoskeleton → processOneFrame（V88 加深后可见）'],
  ['ewoh-spark-app/server/modules/ingest/ingest.controller.ts#ingestEnvironment',
    '机器面：同上；经 sensorIngest.ingestEnvironment 落遥测（V88 加深后可见）'],
  ['ewoh-spark-app/server/modules/ingest/ingest.controller.ts#ingestCamera',
    '机器面：同上；经 sensorIngest.ingestCamera（V88 加深后可见）'],
  ['ewoh-spark-app/server/modules/ingest/ingest.controller.ts#ingestSpatialScan',
    '机器面：同上；经 sensorIngest.ingestSpatialScan（V88 加深后可见）'],
  ['ewoh-spark-app/server/modules/ingest/ingest.controller.ts#ingestActuator',
    '机器面：同上；经 sensorIngest.ingestActuator（V88 加深后可见）'],
  ['ewoh-spark-app/server/modules/ingest/ingest.controller.ts#ingestLocation',
    '机器面：同上；经 sensorIngest.ingestLocation 落 UWB 帧（FLAKE-02 的 2g 就核对这张表）（V88 加深后可见）'],
  // V193（GATE-17 闭合的代价项）：服务解析改成"按类名声明处"后，第二跳跨模块的这条一直存在的
  // 位点才进清单。逐条核对：控制器类级 @UseGuards(IngestGuard) 挂 userContext ⇒ 请求事务；
  // ingest.service.ts:1130 显式转发 actor { userId: 'ingest', primaryOrgId: orgId }，
  // mes.service.ts createWorkOrder 先 requireOrgId（缺上下文 fail-closed）、getWorkOrder 带 orgCondition。
  // ⇒ 覆盖面 +1，不是新的无保护读。
  ['ewoh-spark-app/server/modules/ingest/ingest.controller.ts#ingestMes',
    '机器面：IngestGuard 挂 userContext ⇒ 请求事务；两跳经 mesService.createWorkOrder（显式转发 actor，V193 跨目录解析后可见）'],
  // V189（AUTH-02）：AccessTokenGuard 的 org 层级解析先于请求上下文（TracingInterceptor）
  // 与请求事务（OrgContextInterceptor）建立，兜底开关对它结构性不可见（V188 推断的
  // "降级"被两档实测证伪——落在无上下文豁免面，不抛 NEST-504）。收口 = 读显式包进
  // RequestDatabaseContext.systemTransaction（无 GUC，SECURITY DEFINER ewoh_find_org*，
  // V61/V65 同款；见 root-db-allowlist.audit.spec.ts 的 NEST-509 登记）。
  // 常驻行为位点 = test/e2e/auth-org-scope-boundary.e2e.spec.ts（D+D2 双档）。
  ['ewoh-spark-app/server/modules/shared/access-token.guard.ts#guard',
    '身份前系统读：守卫期无请求上下文 ⇒ REQUIRE_TX 不可见；resolveOrgScope 已显式包进 systemTransaction（V61/V65 同款，行为零变化，见基线文档 §5.3em）'],
]);

const DB_HANDLE_RE = /DRIZZLE_DATABASE|PostgresJsDatabase|this\.db\b|RequestDatabaseContext/;
/* ── V193：GATE-17 剩下两条形状盲区的两档对照 ───────────────────────────────
 * ① 句柄成员名：旧判据只认 `this.db`/类型名字面量 ⇒ `@Inject(DRIZZLE_DATABASE)
 *    private readonly negctlPool` 这种换了成员名的写法整个看不见（GATE-17 探针 s1）。
 *    bindings 档先把本文件里"被注入成数据库句柄的成员名"收集出来，再判 `this.<成员>`。
 * ② 服务解析：旧判据按类名 kebab 化后在**本目录/父目录**猜文件名 ⇒ 服务放在别的模块目录
 *    就断链（GATE-17 探针 s3）。index 档在本轮扫描的文件全集里按 `export class X` 建索引，
 *    kebab 猜不到时按索引补齐（猜得到时结果不变 ⇒ 只加覆盖不改判据方向）。
 * 档位：GATE17_HANDLE=legacy|bindings、GATE17_SVCRES=kebab|index。V193 起两档默认均为收紧版
 * （旧口径留作对照档，自测里成对断言"新档必须报 / 旧档确实不报"）。
 * 收紧代价：句柄档 0 处（@Public 控制器里没有非 this.db 的句柄成员名）；服务档 **+1 处**
 * （`ingest.controller.ts#ingestMes`，链在第二跳才跨进 mes 模块）。
 * 预量时这条没报出来，是因为预量用的正是"只在第一跳透传 index"的那版判据 ⇒ 代价不是零，
 * 是 +1；默认翻过来后被真语料自己撞上（见 BASELINE 内该条的逐条核对）。
 */
const handleMode = () => (process.env.GATE17_HANDLE || 'bindings').toLowerCase();
const svcResMode = () => (process.env.GATE17_SVCRES || 'index').toLowerCase();

const HANDLE_INJECT_RE = /@Inject\(\s*DRIZZLE_DATABASE\s*\)[^)]*?\b(?:private|public|protected)\s+(?:readonly\s+)?([A-Za-z_$][\w$]*)/g;
const HANDLE_TYPE_RE = /\b(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*(?::\s*(?:PostgresJsDatabase|RequestDatabaseContext|Database|\w+Database)\b)/g;

/** 本文件里被当数据库句柄用的成员名（类型注解或 @Inject(DRIZZLE_DATABASE) 两种来源）。 */
function handleMembers(lines) {
  const out = new Set();
  const text = lines.join('\n');
  for (const re of [HANDLE_INJECT_RE, HANDLE_TYPE_RE]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) out.add(m[1]);
  }
  return out;
}

/** 句柄命中判据（bindings 档比 legacy 档只多不少：先走原正则，再补成员名）。 */
function dbHandleHit(ownerLines, body) {
  if (DB_HANDLE_RE.test(body)) return true;
  if (handleMode() !== 'bindings') return false;
  for (const name of handleMembers(ownerLines)) {
    if (new RegExp(`this\\.${name}\\b`).test(body)) return true;
  }
  return false;
}

/** 类名 → 声明它的文件（按本轮扫描到的文件全集建一次）。 */
function buildServiceIndex(files) {
  const map = new Map();
  for (const f of files) {
    for (const l of readLines(f)) {
      const m = /^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(l);
      if (!m) continue;
      const bucket = map.get(m[1]);
      if (bucket) bucket.push(f);
      else map.set(m[1], [f]);
    }
  }
  return map;
}


const TX_MARKER_RE = /systemTransaction|systemGlobalAdminTransaction|runDetachedTransaction|runInTransaction|\.transaction\(|requestDatabaseContextSafe/;

const failures = [];
const passes = [];
function check(name, ok, detail = '') {
  if (ok) passes.push(name);
  else failures.push(`${name}${detail ? `: ${detail}` : ''}`);
}

/* ── V191：作用域判据取自共用件（与主线7 同一把尺子）────────────────────────
 * 本门禁的头注释原本自陈"判据与 audit-scheduler-transactions 同一口径"，但两处各写一份 ⇒
 * 主线7 在 V190 收紧（括号配定作用域＋剥注释）后，这句就成了假话。这里改为 require 共用件，
 * 并留两档环境开关做代价对照（V191 实测四档位点面逐字节相同 ⇒ 默认已翻到收紧档 brace+strip）：
 *   GATE14_REGION=text|brace   区域取法：上一条定义到下一条（末条拖到文件尾） vs 花括号配定
 *   GATE14_COMMENTS=raw|strip  是否把注释/字符串/模板/正则的内容屏蔽后再判
 * 注意方向：本门禁的标记是**豁免证据**（区域内有显式事务标记 ⇒ 不报），所以判据放松会
 * 让清单变小、判据收紧会让清单变大 ⇒ 代价必须按"新增多少未登记位点"来量。
 */
const SCOPE = require('./tx-scope-shared.js');
const regionMode = () => (process.env.GATE14_REGION || 'brace').toLowerCase();
const commentMode = () => (process.env.GATE14_COMMENTS || 'strip').toLowerCase();
const LINE_CACHE = new Map();

/* ── V192：@Public 的归属判据（GATE-17 的形状盲区之一）──────────────────────
 * 旧口径是两处魔数窗口：方法看签名上方 6 行、类看 `export class` 上方 8 行。
 * 窗口两个方向都会错：装饰器多于 6 条 ⇒ @Public 看不见（漏报，清单少一格）；
 * 上一个成员很短、它的 `@Public()` 恰好落进下一个方法的 6 行窗口 ⇒ 误报（清单多一格，
 * 而这条"位点"其实没有公开面）。改成结构判定：从定义行向上收集**连续装饰器块**
 * （中间允许空行与注释，遇到语句行即停），类级同理。
 * 档位：GATE17_DECOR=window|struct（对照用；默认先留 window，代价量完再翻档）。
 */
// V192 实测代价：结构档比窗口档多暴露 2 条真位点（已登记、逐条核对），丢位点 0 ⇒ 默认档翻到 struct
const decorMode = () => (process.env.GATE17_DECOR || 'struct').toLowerCase();
const DECORATOR_LINE_RE = /^\s*@/;
const COMMENT_LINE_RE = /^\s*(?:\/\/|\/\*|\*)/;
const IS_PUBLIC_LINE = (l) => /@Public\(\)/.test(l);

/** 收集第 idx 行（定义行）上方**连续的装饰器块**：跳过空行与注释，遇语句行即停。 */
function decoratorBlockAbove(lines, idx) {
  const out = [];
  let i = idx - 1;
  let blanks = 0;
  while (i >= 0) {
    const line = lines[i];
    if (line.trim() === '') {
      blanks += 1;
      if (blanks > 3) break;
      i -= 1;
      continue;
    }
    blanks = 0;
    if (COMMENT_LINE_RE.test(line) || DECORATOR_LINE_RE.test(line)) {
      out.push(line);
      i -= 1;
      continue;
    }
    break;
  }
  return out;
}

/** 旧口径（窗口）：与 V192 之前的实现逐字一致，作 A 档对照。 */
function windowSaysPublic(lines, anchor, w) {
  return lines.slice(Math.max(0, anchor - w), anchor + 1).some(IS_PUBLIC_LINE);
}

/** 旧口径（V191 之前）：只认"顶层缩进"的方法定义行，区域到下一条定义为止、末条拖到文件尾。 */
function methodRegions(lines) {
  return SCOPE.methodRegions(lines, { region: regionMode() });
}

/** lines 数组身份稳定（readLines 按 文件+档 缓存）⇒ 用它做 defs 的 memo key。 */
const VIEW_CACHE = new WeakMap();
function viewOf(lines) {
  if (!VIEW_CACHE.has(lines)) VIEW_CACHE.set(lines, { lines, defs: SCOPE.defsOf(lines) });
  return VIEW_CACHE.get(lines);
}

/**
 * "这段可达方法是不是已经走显式事务"的统一判据（V191 与主线7 同一把尺子）。
 * 收紧档：以该方法定义的行为起点做作用域判定，允许一种外推——本方法是**被交给执行器的具名回调**
 * （`const persist = async (): Promise<void> => {…}` + `db.transaction(persist)`）；
 * 旧档：区域内出现标记文本即算（注释也算 ⇒ 一行注释就能让位点消失）。
 */
function txCovered(lines, region) {
  if (regionMode() !== 'brace') {
    return TX_MARKER_RE.test(lines.slice(region.start, region.end).join('\n'));
  }
  return SCOPE.resolveScope(viewOf(lines), region.line, { marker: TX_MARKER_RE, region: 'brace' }).inTx;
}

function walk(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.isFile() && p.endsWith('.ts') && !p.endsWith('.spec.ts')) out.push(p);
  }
  return out;
}

function readLines(file) {
  const key = `${file}|${commentMode()}`;
  if (!LINE_CACHE.has(key)) {
    const raw = fs.readFileSync(file, 'utf8').split('\n');
    LINE_CACHE.set(key, commentMode() === 'raw' ? raw : SCOPE.blankNonCode(raw.join('\n')).split('\n'));
  }
  return LINE_CACHE.get(key);
}

function rel(file) {
  return path.relative(REPO_ROOT, file).split(path.sep).join('/');
}

/** 规则 1：守卫里的数据库句柄使用（守卫先于拦截器 ⇒ 结构上无请求事务）。 */
/** 守卫识别：文件名只是快路径，真正的判据是 `implements CanActivate`——
 * 否则任何换了文件名的守卫（如 `auth/checks.ts` 里的 CanActivate 类）都不在这道清单里。 */
function isGuardFile(lines) {
  return lines.some((l) => /implements\s+CanActivate\b/.test(l)) || false;
}

function scanGuards(files) {
  const found = [];
  const guardFiles = files.filter((f) => {
    if (f.endsWith('.guard.ts')) return true;
    return isGuardFile(readLines(f));
  });
  for (const file of guardFiles) {
    const lines = readLines(file);
    const hits = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => dbHandleHit(lines, l))
      .map(({ i }) => i + 1);
    if (hits.length > 0) {
      found.push({ key: `${rel(file)}#guard`, file: rel(file), lines: hits.slice(0, 6) });
    }
  }
  return found;
}

/** 控制器注入的服务：`private readonly x: FooService` → ['FooService']（同文件里的引用名）。 */
function injectedServices(lines) {
  const out = [];
  for (const l of lines) {
    const m = l.match(/private\s+readonly\s+([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*Service)\b/);
    if (m) out.push({ member: m[1], type: m[2] });
  }
  return out;
}

/** 把服务类名映射到文件（只在本模块目录内找 `<kebab>.ts` 或同名 ts，找不到即不判）。 */
function resolveServiceFile(serviceType, controllerFile, index = null) {
  const dir = path.dirname(controllerFile);
  const stem = serviceType.replace(/Service$/, '').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  const candidates = [];
  for (const d of [dir, path.join(dir, '..')]) {
    if (!fs.existsSync(d)) continue;
    for (const ent of fs.readdirSync(d)) {
      if (!ent.endsWith('.ts') || ent.endsWith('.spec.ts')) continue;
      if (ent.toLowerCase().startsWith(`${stem}-`) || ent === `${stem}.service.ts`) candidates.push(path.join(d, ent));
    }
  }
  if (svcResMode() === 'index' && index) {
    // kebab 猜不到（或猜到了但那个文件里其实没声明这个类）时，按类名声明处补齐
    for (const f of index.get(serviceType) ?? []) {
      if (!candidates.includes(f)) candidates.push(f);
    }
  }
  return [...new Set(candidates)];
}

/**
 * 规则 2：@Public 处理方法的可达数据库访问（同文件私有方法 ≤2 层 + 服务一跳）。
 *
 * 为什么要跟同文件私有方法：`ready()` 自己不碰句柄，它调 `this.probeDatabase()`——
 * 只看方法体自身会把一条真实的身份前读判成"无访问"（V65 修的就是这条链）。
 * 判据与 `audit-scheduler-transactions` 同一口径：**可达方法体内出现显式事务标记即视为已收口**。
 * 返回命中的路径描述（用于登记理由），未命中返回 null。
 */
function reachFromHandler(file, lines, regions, handlerName) {
  const byName = new Map();
  for (const r of regions) if (!byName.has(r.name)) byName.set(r.name, r);

  /** @type {{path: string[], seen: Set<string>, depth: number}[]} */
  const queue = [{ path: [handlerName], seen: new Set([handlerName]), depth: 0 }];
  const hits = [];
  while (queue.length > 0) {
    const node = queue.shift();
    const region = byName.get(node.path[node.path.length - 1]);
    if (!region) continue;
    const body = lines.slice(region.start, region.end).join('\n');
    if (txCovered(lines, region)) continue; // 该路径已走显式事务 ⇒ 不是事务外访问
    if (dbHandleHit(lines, body)) {
      hits.push({ path: node.path.join(' → '), where: rel(file), sameFile: true });
      continue;
    }
    if (node.depth >= 2) continue;
    for (const m of body.matchAll(/this\.([A-Za-z_$][\w$]*)\s*\(/g)) {
      const next = m[1];
      if (node.seen.has(next) || !byName.has(next)) continue;
      queue.push({ path: [...node.path, next], seen: new Set([...node.seen, next]), depth: node.depth + 1 });
    }
  }
  return hits;
}

/**
 * 服务面可达性深度。V68 建门禁时只有 1 跳，并把"只做一跳"写成了结论文本；
 * V88 量过一次：1 跳会漏掉 `ingest.controller.ts` 的 6 条同形状位点（经 ingestService → sensorIngest
 * 两跳才可见）⇒ 默认改为 2 跳，让那 6 条进入只许缩小的清单。`EWOH_CFG01B_SERVICE_HOPS=1` 可退回旧口径
 * （自测里保留了一组对照，用来证明"加深确实买到覆盖"而不是"换个说法多报几条"）。
 */
function serviceHops() {
  return Math.max(1, Number(process.env.EWOH_CFG01B_SERVICE_HOPS || 2) || 2);
}

function deepServiceReach(svcFile, svcLines, region, prefix, hopsLeft, seenFiles, index = null) {
  const regions = methodRegions(svcLines);
  const hits = reachFromHandler(svcFile, svcLines, regions, region.name);
  if (hits.length > 0) {
    return hits.map((h) => ({
      path: `${prefix} → ${h.path}`,
      where: h.sameFile ? rel(svcFile) : h.where,
      sameFile: false,
    }));
  }
  if (hopsLeft <= 0) return [];
  const self = regions.find((r) => r.name === region.name);
  if (!self) return [];
  const body = svcLines.slice(self.start, self.end).join('\n');
  const byMember = new Map(injectedServices(svcLines).map((s) => [s.member, s.type]));
  const out = [];
  for (const m of body.matchAll(/this\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/g)) {
    const svcType = byMember.get(m[1]);
    if (!svcType) continue;
    for (const nextFile of resolveServiceFile(svcType, svcFile, index)) {
      if (seenFiles.has(rel(nextFile))) continue;
      seenFiles.add(rel(nextFile));
      const nextLines = readLines(nextFile);
      for (const nr of methodRegions(nextLines).filter((r) => r.name === m[2])) {
        out.push(...deepServiceReach(nextFile, nextLines, nr,
          `${prefix} → ${m[1]}.${m[2]}`, hopsLeft - 1, seenFiles, index));
      }
    }
  }
  return out;
}

function scanPublic(files, guardsByName = new Map(), index = null) {
  const found = [];
  const hops = serviceHops();
  const controllers = files.filter((f) => f.endsWith('.controller.ts'));
  for (const file of controllers) {
    const lines = readLines(file);
    if (!lines.some((l) => /@Public\(\)/.test(l))) continue;
    // 类级 @Public()（装饰器出现在 `export class` 之前且不在任何方法体内）⇒ 全部方法都是公开面。
    const classIdx = lines.findIndex((l) => /^\s*export\s+class\s/.test(l));
    // 旧口径：类级 @Public 只对**文件里第一个** `export class` 求值（多类文件里的第 2/3 个类
    // 拿不到类级归属，只能靠方法上方 6 行窗口碰运气）；struct 档改为按成员所属类求值。
    const classBlocks = decorMode() === 'struct' ? SCOPE.classBlocksOf(lines) : [];
    const ownerClassPublic = (idx) => {
      const own = SCOPE.owningClass(classBlocks, idx);
      return !!(own && decoratorBlockAbove(lines, own.start).some(IS_PUBLIC_LINE));
    };
    const classLevelPublic = decorMode() === 'struct'
      ? false /* struct 档按成员所属类逐个判，见下 ownerClassPublic(r.line) */
      : (classIdx > 0 && windowSaysPublic(lines, classIdx - 1, 8));

    const regions = methodRegions(lines);
    const services = injectedServices(lines);
    const serviceByMember = new Map(services.map((s) => [s.member, s.type]));
    const publicMethods = [];
    for (const r of regions) {
      const isPublicMethod = decorMode() === 'struct'
        ? (decoratorBlockAbove(lines, r.line).some(IS_PUBLIC_LINE) || ownerClassPublic(r.line))
        : windowSaysPublic(lines, r.line, 6);
      if (classLevelPublic || isPublicMethod) publicMethods.push(r);
    }
    if (publicMethods.length === 0) continue;

    for (const r of publicMethods) {
      const hits = reachFromHandler(file, lines, regions, r.name);
      if (hits.length === 0) {
        // 同文件不可达时再看服务一跳：`this.xxxService.method()` 的**同名**服务方法。
        const body = lines.slice(r.start, r.end).join('\n');
        for (const m of body.matchAll(/this\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/g)) {
          const svcType = serviceByMember.get(m[1]);
          if (!svcType) continue;
          for (const svcFile of resolveServiceFile(svcType, file, index)) {
            const svcLines = readLines(svcFile);
            const svcRegions = methodRegions(svcLines);
            for (const sr of svcRegions.filter((s) => s.name === m[2])) {
              const sBody = svcLines.slice(sr.start, sr.end).join('\n');
              if (!dbHandleHit(svcLines, sBody) || txCovered(svcLines, sr)) continue;
              hits.push({
                path: `${r.name} → ${m[1]}.${m[2]}`,
                where: rel(svcFile),
                sameFile: false,
              });
            }
            // 第一跳没命中时按配置的深度继续：服务方法体自身不碰句柄，就再跟它的私有方法
            // （≤2 层，与同文件规则同一口径）与它注入的服务。
            if (hops > 1 && hits.length === 0) {
              for (const sr of svcRegions.filter((s) => s.name === m[2])) {
                // index 必须透传：不传就只有第一跳享受跨目录解析，"补了第一跳"看起来像补全了，
                // 而 ingest 那族两跳位点恰恰在第二跳上断链（自测 22 号项钉的就是这条）。
                hits.push(...deepServiceReach(svcFile, svcLines, sr,
                  `${r.name} → ${m[1]}.${m[2]}`, hops - 1, new Set([rel(svcFile)]), index));
              }
            }
          }
        }
      }
      if (hits.length > 0) {
        // 只记**调用式**而不是方法名：`#live` 与 `#ready` 的区别就是有没有数据库访问，
        // 键必须能区分它们，理由必须能说明它为什么被算进来。
        const guards = appliedGuards(lines).map((g) => ({
          name: g,
          ...(guardsByName.get(g) ?? { file: '(未在本目录解析)', setsContext: false }),
        }));
        found.push({
          key: `${rel(file)}#${r.name}`,
          why: hits[0].path + '（' + hits[0].where + '）',
          guards,
          coveredByGuard: guards.some((g) => g.setsContext === true),
        });
      }
    }
  }
  // 同一键可能因多个服务命中 ⇒ 去重，保留首条理由（清单键必须唯一，否则"缩小"无从判断）。
  const seen = new Map();
  for (const f of found) if (!seen.has(f.key)) seen.set(f.key, f);
  return [...seen.values()];
}

/** 守卫类名 → {file, setsContext}：`setsContext` 指该守卫会给请求挂 `request.userContext`。 */
function guardIndex(files) {
  const map = new Map();
  for (const f of files.filter((x) => x.endsWith('.guard.ts'))) {
    const text = readLines(f).join('\n');
    const cls = (text.match(/export class ([A-Za-z_$][\w$]*)/) ?? [])[1];
    if (!cls) continue;
    map.set(cls, {
      file: rel(f),
      // 挂了 userContext ⇒ OrgContextInterceptor 会把这条请求包进事务（机器面的租户来源）。
      setsContext: /\.userContext\s*=\s*\{/.test(text),
    });
  }
  return map;
}

/** 控制器声明的守卫（类级与方法级都算），用于把"谁为这条面建立租户上下文"写成事实。 */
function appliedGuards(lines) {
  const out = new Set();
  for (const m of lines.join('\n').matchAll(/@UseGuards\(([^)]*)\)/g)) {
    for (const g of m[1].split(',')) {
      const name = g.trim();
      if (name) out.add(name);
    }
  }
  return [...out];
}

function analyse(rootDir) {
  const files = walk(rootDir, []);
  const guards = scanGuards(files);
  const publicSites = scanPublic(files, guardIndex(files), buildServiceIndex(files));
  // 被扫描的**总体**大小：位点清单为空时用它区分"确实没有位点"与"扫描器失效了"。
  const publicControllerCount = files
    .filter((f) => f.endsWith('.controller.ts') && readLines(f).some((l) => /@Public\(\)/.test(l))).length;
  return { guards, publicSites, fileCount: files.length, publicControllerCount };
}

function runSelfTest() {
  const os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg01b-self-'));
  const mk = (p, content) => {
    const full = path.join(root, p);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  // 1) 守卫用句柄 ⇒ 必须被抓到
  mk('a/roles.guard.ts', `export class RolesGuard {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}
  canActivate() { return this.db.execute(sql\`select 1\`); }
}\n`);
  // 2) 守卫不用句柄 ⇒ 不该被抓
  mk('b/static.guard.ts', `export class StaticGuard {
  canActivate() { return true; }
}\n`);
  // 3) @Public 经同名服务方法到句柄、无事务标记 ⇒ 抓
  mk('c/ping.controller.ts', `@Controller('ping')
export class PingController {
  constructor(private readonly pingService: PingService) {}

  @Get('x')
  @Public()
  async x() {
    return this.pingService.x();
  }
}\n`);
  mk('c/ping.service.ts', `export class PingService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  async x() {
    return this.db.select().from(t);
  }
}\n`);
  // 4) 同样一跳但服务里走显式系统事务 ⇒ 不该误报（V61/V65 的修法被承认）
  mk('d/ok.controller.ts', `@Controller('ok')
export class OkController {
  constructor(private readonly okService: OkService) {}

  @Get('y')
  @Public()
  async y() {
    return this.okService.y();
  }
}\n`);
  mk('d/ok.service.ts', `export class OkService {
  constructor(private readonly ctx: RequestDatabaseContext, private readonly db: PostgresJsDatabase) {}

  async y() {
    return this.ctx.systemTransaction(() => this.db.execute(sql\`select 1\`));
  }
}\n`);
  // 5) 非 @Public 的控制器方法 ⇒ 不该被抓（有请求事务兜底）
  mk('e/private.controller.ts', `@Controller('p')
export class PController {
  constructor(private readonly pService: PService) {}

  @Get('z')
  async z() {
    return this.pService.z();
  }
}\n`);
  mk('e/p.service.ts', `export class PService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  async z() {
    return this.db.select().from(t);
  }
}\n`);

  // 6) @Public 方法自己不碰句柄、但经**同文件私有 helper** 读库 ⇒ 必须被抓到
  //    （health.controller 的 `ready → probeDatabase` 就是这个形状，V65 修的正是它）
  mk('f/helper.controller.ts', `@Controller('h')
export class HelperController {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  @Get('r')
  @Public()
  async ready() {
    await this.probe();
    return { ok: true };
  }

  private async probe() {
    await this.db.execute(sql\`select 1\`);
  }
}\n`);
  // 7) 同形状但 helper 走显式系统事务 ⇒ 不该误报（这正是 V61/V65 的修法）
  mk('g/helper2.controller.ts', `@Controller('h2')
export class Helper2Controller {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
              private readonly rdc: RequestDatabaseContext) {}

  @Get('r')
  @Public()
  async ready() {
    await this.probe();
    return { ok: true };
  }

  private async probe() {
    await this.rdc.systemTransaction(() => this.db.execute(sql\`select 1\`));
  }
}\n`);

  // 8) 机器面：@Public + 挂了 userContext 的守卫 ⇒ 该位点的"事务来源"可被证明
  mk('h/machine.guard.ts', `export class MachineGuard {
  canActivate(ctx) {
    ctx.getRequest().userContext = { userId: 'ingest', primaryOrgId: 'ORG-1' };
    return true;
  }
}\n`);
  // 9) 守卫存在但**不**挂上下文 ⇒ coveredByGuard 必须为 false（不能拿"有个守卫"当挡箭牌）
  mk('i/keyonly.guard.ts', `export class KeyOnlyGuard {
  canActivate(ctx) { return ctx.getRequest().headers['x-key'] === 'k'; }
}\n`);
  mk('i/m2.controller.ts', `@Controller('m2')
@UseGuards(KeyOnlyGuard)
@Public()
export class M2Controller {
  constructor(private readonly m2Service: M2Service) {}

  @Get('p')
  async p() {
    return this.m2Service.p();
  }
}\n`);
  mk('i/m2.service.ts', `export class M2Service {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  async p() {
    return this.db.select().from(t);
  }
}\n`);
  mk('h/m1.controller.ts', `@Controller('m1')
@UseGuards(MachineGuard)
@Public()
export class M1Controller {
  constructor(private readonly m1Service: M1Service) {}

  @Get('p')
  async p() {
    return this.m1Service.p();
  }
}\n`);
  mk('h/m1.service.ts', `export class M1Service {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  async p() {
    return this.db.select().from(t);
  }
}\n`);

  // 10) 守卫**不叫** *.guard.ts（只在别的文件里 implements CanActivate）⇒ 也必须被抓到
  mk('j/hidden-checks.ts', `export class HiddenChecks implements CanActivate {
  canActivate(ctx) {
    return this.db.execute(sql\`select 1\`);
  }
}\n`);

  // 11) @Public → 服务 A（自己不碰句柄）→ 服务 B（碰句柄、无事务）⇒ 只有两跳才看得见。
  //     这就是 V88 把默认深度从 1 抬到 2 买到的东西：真实语料里 ingest 的 6 条端点正是这个形状。
  mk('k/deep.controller.ts', `@Controller('deep')
export class DeepController {
  constructor(private readonly hopService: HopService) {}

  @Get('k')
  @Public()
  async k() {
    return this.hopService.k();
  }
}
`);
  mk('k/hop.service.ts', `export class HopService {
  constructor(private readonly hop2Service: Hop2Service) {}

  async k() {
    return this.hop2Service.k();
  }
}
`);
  mk('k/hop2.service.ts', `export class Hop2Service {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  async k() {
    return this.db.select().from(t);
  }
}
`);
  // 12) 同样两跳，但最深处走显式事务 ⇒ 不该报（深度的精度对照，防"加深=多报"）
  mk('l/deepok.controller.ts', `@Controller('deepok')
export class DeepOkController {
  constructor(private readonly txHopService: TxHopService) {}

  @Get('q')
  @Public()
  async q() {
    return this.txHopService.q();
  }
}
`);
  mk('l/txhop.service.ts', `export class TxHopService {
  constructor(private readonly txHop2Service: TxHop2Service) {}

  async q() {
    return this.txHop2Service.q();
  }
}
`);
  mk('l/txhop2.service.ts', `export class TxHop2Service {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  async q() {
    return this.db.transaction(async () => 1);
  }
}
`);

  // 13-15) V191 两档极性对照：显式事务标记是**豁免证据**，所以"注释也算标记 / 隔壁方法的标记"
  // 会让真位点消失（假阴性）。这三形在收紧档必须报、在旧档必须不报 ⇒ 证明收紧确实咬到东西。
  const CTRL_HEAD = `@Controller('%NAME%')
export class %CLS%Controller {
  constructor(private readonly %MEM%Service: %CLS%Service) {}

  @Get('r')
  @Public()
  async r() {
    return this.%MEM%Service.read();
  }
}
`;
  mk('m/cmt.controller.ts', CTRL_HEAD.replace(/%NAME%/g, 'cmt').replace(/%CLS%/g, 'Cmt').replace(/%MEM%/g, 'cmt'));
  mk('m/cmt.service.ts', `export class CmtService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  async read() {
    // systemTransaction 由调用方保证（本行只是注释，不是事务）
    return this.db.select();
  }
}
`);
  mk('n/neighbor.controller.ts', CTRL_HEAD.replace(/%NAME%/g, 'neighbor').replace(/%CLS%/g, 'Neighbor').replace(/%MEM%/g, 'neighbor'));
  mk('n/neighbor.service.ts', `export class NeighborService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  async read() {
    return this.db.select();
  }
}

export async function neighborUnrelated(db: PostgresJsDatabase) {
  return db.transaction(async () => 1);
}
`);
  mk('o/callback.controller.ts', CTRL_HEAD.replace(/%NAME%/g, 'callback').replace(/%CLS%/g, 'Callback').replace(/%MEM%/g, 'callback'));
  // 具名回调交给执行器 ⇒ 收紧档也不得误报（这是"作用域内没标记"但"确实在事务里"的合法形状）
  mk('p/cmtfix.controller.ts', CTRL_HEAD.replace(/%NAME%/g, 'cmtfix').replace(/%CLS%/g, 'Cmtfix').replace(/%MEM%/g, 'cmtfix'));
  mk('p/cmtfix.service.ts', `export class CmtfixService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  async read() {
    return this.db.transaction(async () => 1);
  }
}
`);
  mk('o/callback.service.ts', `export class CallbackService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  async writeAll(rows: unknown[]) {
    const persistBatch = async (): Promise<void> => {
      await this.db.insert(rows);
    };
    return this.db.transaction(persistBatch);
  }
}
`);

  // 19-20) V193 形状①：数据库句柄换了成员名。旧判据只认 `this.db`／类型名字面量 ⇒ 整条位点
  //        不存在；bindings 档先把本文件里被注入成句柄的成员名收出来，再判 `this.<成员>`。
  //        同文件再放一个只写日志的公开方法做**过度报告**对照：logger 不是句柄，两档都不得报。
  mk('r/pool.controller.ts', `@Controller('pool')
export class PoolController {
  private readonly logger = new Logger(PoolController.name);
  constructor(@Inject(DRIZZLE_DATABASE) private readonly negctlPool: PostgresJsDatabase) {}

  @Get('hit')
  @Public()
  async hit() {
    return this.negctlPool.execute(sql\`select 1\`);
  }

  @Get('log')
  @Public()
  async log() {
    this.logger.log('ok');
    return { ok: true };
  }
}
`);

  // 21-22) V193 形状②：服务声明在别的模块目录 ⇒ 按类名 kebab 化猜文件名会断链。
  //        第一跳与第二跳各一条：只补第一跳的"半修好"看不见第二跳，必须分开钉。
  mk('s/xdir.controller.ts', `@Controller('xdir')
export class XdirController {
  constructor(private readonly farService: FarService) {}

  @Get('v')
  @Public()
  async v() {
    return this.farService.v();
  }
}
`);
  mk('z/far.service.ts', `export class FarService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  async v() {
    return this.db.select().from(t);
  }
}
`);
  mk('t/ydir.controller.ts', `@Controller('ydir')
export class YdirController {
  constructor(private readonly nearService: NearService) {}

  @Get('w')
  @Public()
  async w() {
    return this.nearService.w();
  }
}
`);
  mk('t/near.service.ts', `export class NearService {
  constructor(private readonly far2Service: Far2Service) {}

  async w() {
    return this.far2Service.w();
  }
}
`);
  mk('z/far2.service.ts', `export class Far2Service {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  async w() {
    return this.db.select().from(t);
  }
}
`);

  // 深/浅各跑一次：让"加深买到覆盖"这件事本身可断言，而不是只改一句注释。
  const deepScan = analyse(root);
  const prevHops = process.env.EWOH_CFG01B_SERVICE_HOPS;
  process.env.EWOH_CFG01B_SERVICE_HOPS = '1';
  const shallowScan = analyse(root);
  if (prevHops === undefined) delete process.env.EWOH_CFG01B_SERVICE_HOPS;
  else process.env.EWOH_CFG01B_SERVICE_HOPS = prevHops;
  const pkDeep = deepScan.publicSites.map((x) => x.key);
  const pkShallow = shallowScan.publicSites.map((x) => x.key);

  const withArms = (region, comments, fn) => {
    const keep = [process.env.GATE14_REGION, process.env.GATE14_COMMENTS];
    process.env.GATE14_REGION = region;
    process.env.GATE14_COMMENTS = comments;
    try {
      return fn();
    } finally {
      if (keep[0] === undefined) delete process.env.GATE14_REGION; else process.env.GATE14_REGION = keep[0];
      if (keep[1] === undefined) delete process.env.GATE14_COMMENTS; else process.env.GATE14_COMMENTS = keep[1];
    }
  };
  // 16-18) V192 类归属与装饰器窗口的两档极性对照。旧口径：类级 @Public 只对文件里**第一个**
  // export class 求值；方法级看签名上方 6 行窗口 ⇒ 第二个类的公开面整个看不见。
  mk('q/multi.controller.ts', `@Controller('q1')
export class Q1Controller {
  constructor(private readonly db: PostgresJsDatabase) {}
  @Get('a')
  async a() {
    return this.db.execute('select 1');
  }
}

@Controller('q2')
@UseGuards(IngestGuard)
@Public()
export class Q2Controller {
  constructor(private readonly db: PostgresJsDatabase) {}
  @Get('b')
  @Throttle0({ ttl: 1 })
  @Throttle1({ ttl: 1 })
  @Throttle2({ ttl: 1 })
  @Throttle3({ ttl: 1 })
  @Throttle4({ ttl: 1 })
  @Throttle5({ ttl: 1 })
  @Throttle6({ ttl: 1 })
  @Throttle7({ ttl: 1 })
  async b() {
    return this.db.execute('select 1');
  }
}
`);
  const withDecor = (arm, fn) => {
    const keep = process.env.GATE17_DECOR;
    process.env.GATE17_DECOR = arm;
    try {
      return fn();
    } finally {
      if (keep === undefined) delete process.env.GATE17_DECOR; else process.env.GATE17_DECOR = keep;
    }
  };
  const qStructKeys = withDecor('struct', () => analyse(root).publicSites.map((x) => x.key));
  const qWindowKeys = withDecor('window', () => analyse(root).publicSites.map((x) => x.key));

  // V193 两档对照：默认档已是收紧版（bindings + index），旧口径靠环境变量退回。
  // 每个形状都必须"新档报得出、旧档报不出"，否则报红来自新增文件而不是来自判据收紧。
  const withArm = (name, value, fn) => {
    const keep = process.env[name];
    process.env[name] = value;
    try {
      return fn();
    } finally {
      if (keep === undefined) delete process.env[name]; else process.env[name] = keep;
    }
  };
  const keysOf = () => analyse(root).publicSites.map((x) => x.key);
  // 差集比对要用**去掉临时目录前缀**的键：合成语料的 rel() 会带一串 `../`，整串比对必然不等。
  const tag = path.basename(root);
  const norm = (k) => k.slice(k.indexOf(tag) + tag.length + 1);
  const normKeys = () => keysOf().map(norm);
  const tight173Keys = normKeys();
  const legacyHandleKeys = withArm('GATE17_HANDLE', 'legacy', normKeys);
  const kebabSvcKeys = withArm('GATE17_SVCRES', 'kebab', normKeys);
  const onlyIn = (a, b) => a.filter((k) => !b.includes(k)).sort().join(',');

  const tightKeys = withArms('brace', 'strip', () => analyse(root).publicSites.map((x) => x.key));
  const looseKeys = withArms('text', 'raw', () => analyse(root).publicSites.map((x) => x.key));

  const { guards, publicSites, fileCount, publicControllerCount } = analyse(root);
  const gk = guards.map((g) => g.key);
  const pk = publicSites.map((p) => p.key);
  const site = (suffix) => publicSites.find((s) => s.key.endsWith(suffix));
  fs.rmSync(root, { recursive: true, force: true });

  const t = [];
  const want = (name, ok, detail = '') => t.push([name, ok, detail]);
  // 注意：合成语料在临时目录下，键里的相对路径会带一串 `../`（rel() 以仓库根为基准）
  // ⇒ 一律用 endsWith 比对后缀。用 includes/全等会让"没抓到"和"抓错了"同形（自测第一版就这样假通过过）。
  const has = (arr, suffix) => arr.some((k) => k.endsWith(suffix));
  want('守卫使用句柄被识别', has(gk, 'a/roles.guard.ts#guard'));
  want('无句柄守卫不误报', !has(gk, 'b/static.guard.ts#guard'));
  want('@Public 一跳无事务被识别', has(pk, 'c/ping.controller.ts#x'));
  want('@Public 但服务走显式系统事务 ⇒ 不误报', !has(pk, 'd/ok.controller.ts#y'));
  want('非 @Public 方法不进清单', !has(pk, 'e/private.controller.ts#z'));
  want('@Public 经同文件私有 helper 读库被识别', has(pk, 'f/helper.controller.ts#ready'));
  want('同形状但 helper 走显式系统事务 ⇒ 不误报', !has(pk, 'g/helper2.controller.ts#ready'));
  want('挂 userContext 的守卫 ⇒ 该位点事务来源成立', site('h/m1.controller.ts#p')?.coveredByGuard === true);
  want('只校验 key、不挂上下文的守卫 ⇒ 事务来源不成立', site('i/m2.controller.ts#p')?.coveredByGuard === false);
  want('被扫描总体可度量（防"扫描器坏了也算通过"）', fileCount > 0 && publicControllerCount >= 4);
  want('非 .guard.ts 命名的守卫也被纳入清单', has(gk, 'j/hidden-checks.ts#guard'));
  want('@Public 两跳无事务被识别（V88 默认深度 2）', has(pkDeep, 'k/deep.controller.ts#k'));
  want('同一语料在一跳下确实看不见（加深买的是覆盖，不是措辞）', !has(pkShallow, 'k/deep.controller.ts#k'));
  want('@Public 两跳但最深处走显式事务 ⇒ 不误报', !has(pkDeep, 'l/deepok.controller.ts#q'));
  // 清单键是"@Public 处理方法"，不是服务方法 ⇒ 极性断言一律比控制器键（比服务键会恒真、假通过）。
  want('V191 仅注释标记：收紧档必须报出该 @Public 位点', has(tightKeys, 'm/cmt.controller.ts#r'));
  want('V191 仅注释标记：旧档确实不报（对照：报红来自剥注释，不是来自换文件）', !has(looseKeys, 'm/cmt.controller.ts#r'));
  want('V191 隔壁方法的标记：收紧档必须报（旧区域末条拖到文件尾会借到标记）', has(tightKeys, 'n/neighbor.controller.ts#r'));
  want('V191 隔壁方法的标记：旧档确实不报（对照）', !has(looseKeys, 'n/neighbor.controller.ts#r'));
  want('具名回调交给执行器：两档都不得误报（合法形状）',
    !has(tightKeys, 'o/callback.controller.ts#r') && !has(looseKeys, 'o/callback.controller.ts#r'));
  want('元反证：把注释换成真事务语句 ⇒ 收紧档也不再报（说明报的是"只有注释"这件事）',
    !has(tightKeys, 'p/cmtfix.controller.ts#r') && has(tightKeys, 'm/cmt.controller.ts#r'));

  want('V192 类级 @Public 在第二个类上：结构档必须报该类成员', has(qStructKeys, 'q/multi.controller.ts#b'));
  want('V192 同一语料旧窗口档看不见（类归属只算第一个类＋装饰器压过 6 行窗口）',
    !has(qWindowKeys, 'q/multi.controller.ts#b'));
  want('V192 过度报告对照：同文件里非公开类的成员两档都不得被拖进来',
    !has(qStructKeys, 'q/multi.controller.ts#a') && !has(qWindowKeys, 'q/multi.controller.ts#a'));

  // V193：GATE-17 最后两条形状盲区。极性成对断言——新档报得出、旧档报不出，
  // 且差集恰为对应那几条（多报别的 = 判据外溢，同样不放过）。
  want('V193 句柄换成员名（this.negctlPool）：bindings 档必须报',
    has(tight173Keys, 'r/pool.controller.ts#hit'));
  want('V193 同一形状 legacy 档确实不报（对照：报红来自成员名收集，不是新增文件）',
    !has(legacyHandleKeys, 'r/pool.controller.ts#hit'));
  want('V193 过度报告对照：只写日志的公开方法两档都不得报（logger 不是句柄）',
    !has(tight173Keys, 'r/pool.controller.ts#log') && !has(legacyHandleKeys, 'r/pool.controller.ts#log'));
  want('V193 服务在别的模块目录（第一跳）：index 档必须报',
    has(tight173Keys, 's/xdir.controller.ts#v'));
  want('V193 同一形状 kebab 猜路径档确实不报（对照）',
    !has(kebabSvcKeys, 's/xdir.controller.ts#v'));
  want('V193 跨目录服务在第二跳：index 档必须报（钉住 index 透传，防"只补第一跳"的半修好）',
    has(tight173Keys, 't/ydir.controller.ts#w'));
  want('V193 第二跳同一形状 kebab 档确实不报（对照）',
    !has(kebabSvcKeys, 't/ydir.controller.ts#w'));
  want('V193 handle 档差集恰为成员名那一条（不牵动其他判据）',
    onlyIn(tight173Keys, legacyHandleKeys) === 'r/pool.controller.ts#hit',
    onlyIn(tight173Keys, legacyHandleKeys));
  want('V193 svcres 档差集恰为跨目录两条（不牵动其他判据）',
    onlyIn(tight173Keys, kebabSvcKeys) === 's/xdir.controller.ts#v,t/ydir.controller.ts#w',
    onlyIn(tight173Keys, kebabSvcKeys));

  // 基线方向自测：合成一份"更小/有僵尸"的基线，确认两向都能报
  const keys = ['c/ping.controller.ts#x', 'a/roles.guard.ts#guard'];
  const shrinkOnly = (baselineKeys, discovered) => {
    const extra = discovered.filter((k) => !baselineKeys.has(k));
    const zombies = [...baselineKeys].filter((k) => !discovered.includes(k));
    return { extra, zombies };
  };
  const grown = shrinkOnly(new Set(['x#only']), keys);
  want('基线未登记的位点会报红', grown.extra.length === 2);
  const zombied = shrinkOnly(new Set([...keys, 'gone.ts#ghost']), keys);
  want('虚挂登记（僵尸）会报红', zombied.zombies.length === 1 && zombied.extra.length === 0);
  const equal = shrinkOnly(new Set(keys), keys);
  want('等集不报红（门禁不是永远红）', equal.extra.length === 0 && equal.zombies.length === 0);

  let ok = true;
  for (const [name, passed, detail] of t) {
    console.log(`  ${passed ? 'OK  ' : 'FAIL'} ${name}${passed || !detail ? '' : ` ⇒ 实际 ${detail}`}`);
    if (!passed) ok = false;
  }
  console.log(`${ok ? '✅ 自测通过' : '❌ 自测失败'}（${t.length} 项）`);
  process.exit(ok ? 0 : 1);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) runSelfTest();
  const reportOnly = argv.includes('--report');

  if (!fs.existsSync(SERVER_DIR)) {
    console.error(`[cfg01b] 找不到目录 ${SERVER_DIR}`);
    process.exit(2);
  }
  const { guards, publicSites, fileCount, publicControllerCount } = analyse(SERVER_DIR);
  const discovered = [...guards, ...publicSites];
  const keys = discovered.map((d) => d.key);

  const extra = discovered.filter((d) => !BASELINE.has(d.key));
  const zombies = [...BASELINE.keys()].filter((k) => !keys.includes(k));

  if (reportOnly) {
    console.log(
      `[cfg01b] 扫描 ${fileCount} 文件（其中 @Public 控制器 ${publicControllerCount} 个），`
      + `发现 ${discovered.length} 个身份前/守卫阶段数据库访问位点：`,
    );
    for (const d of discovered) {
      const lines = d.lines ? ` (行 ${d.lines.join(',')})` : '';
      const guard = d.guards
        ? ` [守卫 ${d.guards.map((g) => `${g.name}${g.setsContext ? '+挂上下文' : ''}`).join(',') || '无'}]`
        : '';
      console.log(`  ${d.key}${lines}${guard}${d.why ? ` — ${d.why}` : ''}`);
    }
    console.log('[cfg01b] 报告模式：不与基线比对');
    process.exit(0);
  }

  // 「清单为空」既可能是"真的没有位点"，也可能是"扫描器坏了"——用被扫描的总体大小区分，
  // 否则这道门禁会在某次重构后静默变成永真（本项目已经吃过三次这类空转门禁）。
  check('cfg01b_population_nonempty', fileCount > 200 && publicControllerCount > 0,
    `扫描 ${fileCount} 文件 / @Public 控制器 ${publicControllerCount} 个`);
  // 每条登记必须说清"谁为它建立事务"：有挂 userContext 的守卫，或理由里写明显式系统事务。
  const uncovered = discovered.filter((d) => !d.coveredByGuard
    && !/systemTransaction|runDetachedTransaction|runInTransaction/.test(BASELINE.get(d.key) ?? ''));
  check('cfg01b_every_site_has_transaction_source', uncovered.length === 0,
    uncovered.map((d) => `${d.key}[守卫 ${d.guards?.map((g) => g.name).join(',') || '无'}]`).join(', '));
  check('cfg01b_no_new_site', extra.length === 0,
    extra.map((d) => d.key).join(', '));
  check('cfg01b_no_zombie', zombies.length === 0, zombies.join(', '));

  console.log(
    `[cfg01b] 位点 ${discovered.length}（守卫 ${guards.length} / @Public 可达 ${publicSites.length}）`
    + `，基线 ${BASELINE.size}；新增 ${extra.length}、虚挂 ${zombies.length}`,
  );
  for (const d of extra) console.log(`  未登记：${d.key}${d.why ? ` — ${d.why}` : ''}`);
  for (const k of zombies) console.log(`  虚挂登记：${k}`);
  if (failures.length) {
    console.error(`❌ ${failures.length} 项失败：\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`✅ cfg01b 清单门禁通过（${passes.length} 项断言）`);
}

main();
