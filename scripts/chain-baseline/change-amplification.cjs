#!/usr/bin/env node
'use strict';
/**
 * 改动放大系数普查（V226 新增）
 * ─────────────────────────────────────────────────────────────────────────
 * 这条量具只回答一个问题：**在链上改一个业务事实（一个状态词 / 一个结果类型 /
 * 一个 API 字段），今天必须同步几个"登记面"，其中几个落在全量重放的覆盖集里
 * （改了会让 stamp 作废、机器看得见），几个只在人手。**
 *
 * 为什么这算"维护成本"的证据：推广判据①说的是维护成本下降，而可数的量不是代码行数，
 * 是**一次语义改动的同步面数 ×（其中没有机器拦的比例）**。
 * 覆盖集不自造：直接复用 `replay-freshness.cjs` 的 `collectScope()`——它才是
 * "哪些文件一改旧重放读数即作废"的权威；另写一套枚举器会让两个读数打架（本仓老教训）。
 *
 * 限度（不许读成"已穷尽"）：
 *  - 词面匹配只是**定位同步面**的筛子，不判语义正确性；同名词落在无关文件里也会被计入，
 *    所以每个面都打印文件名供人逐条复核 ⇒ 第一轮读数必须人工过一遍才登记。
 *  - "落在覆盖集内"只说明改动会让 stamp 作废，**不说明有断言会红**。
 *  - 样本取自登记册里真实改过的业务事实，不是全集；换样本即换分母。
 *  - 本脚本自身与 tmp/ 一律不计入面（否则自测夹具会把自己的词面算成同步面）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { collectScope } = require('./replay-freshness.cjs');

const root = path.resolve(__dirname, '../..');
const SELF = 'scripts/chain-baseline/change-amplification.cjs';
const SKIP_DIRS = new Set(['node_modules', 'dist', 'tmp', 'coverage', 'build', '.git', 'output']);
// V227 更正：漏了 `.js` ⇒ scripts/*.js 那 25 条门禁实现整个不在扫描面里，
// 面数是**下界**（V226 读数按旧 EXT 记，差集见登记册 §5.3gb ③）。
const EXT = /\.(ts|tsx|sql|ya?ml|json|md|mjs|cjs|js|py|sh)$/;

/**
 * 面（face）＝一次语义改动必须同步落笔的登记类别。
 * 分类是**有序首匹配**（先具体后泛化），最后一条 `other` 是兜底：兜底里的文件单列打印、
 * 不算成一个面——"没有任何规则认识它"必须看得见，不能被静默归进某个面（V226 自测抓到过一次
 * 重叠规则 ⇒ 同一文件同时匹配 ledger 与 other_docs ⇒ 被判未归类，面数虚低）。
 */
const FACES = [
  { id: 'db_migration', label: '迁移（db/migrations）', test: (r) => r.startsWith('db/migrations/') },
  { id: 'db_verify', label: '迁移验证（db/verify）', test: (r) => r.startsWith('db/verify/') },
  { id: 'schema_manifest', label: 'schema 清单', test: (r) => r === 'db/contracts/schema-manifest.yaml' },
  { id: 'runner', label: '迁移 runner', test: (r) => r.startsWith('db/runner/') },
  { id: 'db_other', label: 'db 其余（脚本/校验）', test: (r) => r.startsWith('db/') },
  { id: 'state_machine', label: '状态机契约', test: (r) => r.startsWith('contracts/state-machines/') },
  { id: 'event_catalog', label: '事件契约', test: (r) => r.startsWith('contracts/events/') },
  { id: 'other_contracts', label: '契约其余', test: (r) => r.startsWith('contracts/') },
  { id: 'drizzle_schema', label: 'Drizzle 表定义', test: (r) => r.endsWith('server/database/schema.ts') },
  { id: 'openapi', label: '对外契约（openapi）', test: (r) => r.startsWith('openapi/') },
  { id: 'resident_spec', label: '常驻用例', test: (r) => /^ewoh-spark-app\/(test|server)\/.*\.spec\.ts$/.test(r) },
  { id: 'product_code', label: '产品码（server/shared）', test: (r) => /^ewoh-spark-app\/(server|shared)\//.test(r) },
  { id: 'client', label: '前端（client/src）', test: (r) => /^ewoh-spark-app\/client\/src\//.test(r) },
  { id: 'edge', label: '边缘侧（Python）', test: (r) => /^edge\//.test(r) || /(^|\/)edge[A-Za-z-]*\//.test(r) },
  { id: 'ledger', label: '试点登记册／审计文档', test: (r) => r.startsWith('docs/audit/') },
  { id: 'other_docs', label: '其它文档与脚本', test: (r) => r.startsWith('docs/') || r.startsWith('scripts/') || r === 'Makefile' },
  { id: 'repo_docs', label: '仓根文档与清单', test: (r) => !r.includes('/') },
  { id: 'other', label: '兜底（不算面）', test: () => true },
];

/**
 * 样本＝**精确**词面（一个业务事实的名字，不是它的通用说法）。
 * 为什么必须精确：第一版拿 `expired` / `truncated` 这类宽词当样本，读数分别是
 * 376 个文件（其中 251 个落兜底）与 84 个文件——那测的是"词面复用度"，不是
 * "改一个事实要同步几处"，两者混在一起会把结论读成"改一个状态词要碰 376 个文件"这种
 * 无意义的话。宽词的那次读数因此只作为"为什么不这么做"的证据留在登记册里。
 */
const SAMPLES = [
  { id: 'result_delivery_expired', needle: 'delivery_expired', note: 'F-02 投递积压收敛的结果行类型（result_type 词表新增项）' },
  { id: 'evt_control_expired', needle: 'control.command.expired', note: '巡检收敛写的审计事件名（事件契约里的字面量）' },
  { id: 'cmd_expire_method', needle: 'expireBacklogCommands', note: 'F-02：expired 的唯一 writer 方法名（产品码＋单测＋e2e 指名它）' },
  { id: 'backlog_table', needle: 'ewoh_control_backlog_snapshot', note: '投递积压历史快照表名（迁移＋verify＋清单＋RLS 策略＋读侧）' },
  { id: 'backlog_scan_cap', needle: 'BACKLOG_SCAN_CAP', note: 'V225 新增：积压明细的扫描上限常量（本轮自己的一次语义改动，最干净的样本）' },
  { id: 'truncated_field', needle: 'truncated', note: 'V225 新增的 API 字段名（响应形状＋前端＋契约三处同步；宽词，读数按上方法读）', broad: true },
  /* V281 补：试点模块化样本自身的三个事实。为什么要它们——判据①"维护成本下降"今天有两套单位：
   *   (a) 写点/文件数（V279/V280 登记的就是这个，逐行读码所得）；
   *   (b) 本件的"同步面数"（改一个业务事实要落几个登记类别）。
   * 只报 (a) 会把"收口"说成"放大系数下降"，而后者今天**没有被量过**。这三条就是把 (b) 也量出来，
   * 期望值很低：模块化改的是写点归属，不改事实名出现在哪些类别里 ⇒ 若读数没降，就登记为判据①的限度。
   * 词面一律取精确名（同上面 V226 的教训，宽词读数会把"复用度"当"同步面"）。 */
  { id: 'asg_table', needle: 'ewoh_scheduling_plan_assignment', note: '派工关联表名（迁移/RLS/清单/Drizzle/读侧/常驻用例都会出现——事实本身的同步面）' },
  { id: 'asg_receipt_conflict', needle: 'ASSIGNMENT_STATE_CONFLICT', note: '回执 CAS 0 命中的对外错误码（产品码＋单测＋登记册三处）' },
  { id: 'asg_projection_entry', needle: 'projectAssignmentsApproved', note: 'V279 具名转移入口名（归属集中的证据：应只落产品码＋常驻用例＋登记面）' },
];

function walk(dir, rel, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(abs, r, acc);
    else if (EXT.test(entry.name) && r !== SELF) acc.push(r);
  }
  return acc;
}

function faceOf(rel) {
  return FACES.find((f) => f.test(rel)).id;   // 有序首匹配；最后一条是兜底，永远有结果
}

/** 「只在人手」里的第二根轴（V336）：不在覆盖集 ≠ 要跟着改。
 *  这个尺子原来把两类混成一个数——`asg_table` 那 15 个"仅人手"文件里，CHANGELOG／交付成稿／
 *  带日期的审计快照／ADR 这类**写定就不再随 schema 改**的记载占了大头，把它们算进"同步成本"
 *  会把维护成本高估。这里不排除任何文件（排除就会藏掉真同步面），只**分档并报**，
 *  并硬断式 活面＋历史记载 = 仅人手，任一文件丢了就非零退出。 */
const RECORD_RULES = [
  { id: 'changelog', why: '变更历史：写定即定格', test: (r) => r === 'CHANGELOG.md' },
  { id: 'deliverable', why: '交付/对外成稿', test: (r) => r.startsWith('deliverables/') },
  { id: 'dated', why: '文件名或路径带日期 ⇒ 某次快照', test: (r) => /(?:^|[-_ \/])\d{4}-\d{2}-\d{2}/.test(r) },
  { id: 'adr', why: '架构决策记录（accepted 后不改写）', test: (r) => /(^|\/)adr-/i.test(path.basename(r)) },
];

function recordOf(rel, text) {
  const byName = RECORD_RULES.find((p) => p.test(rel));
  if (byName) return byName.id;
  // 生成物：头部三行里带 generated_at 的就是某次跑出来的定格清单
  const head = text.slice(0, 400);
  if (/(^|\n)\s*#\s.*generated_at:/i.test(head) || /(^|\n)#\s.*HEAD [0-9a-f]{7,}/.test(head)) return 'generated';
  return null;
}

let fileList = null;
function allFiles() {
  if (!fileList) fileList = walk(root, '', []).sort();
  return fileList;
}

/* 第三根轴（V336 新增）：**「仅人手」只说明链级重放的 stamp 看不见这次改动，不说明链外没有
 * 别的机器面碰到这个文件。** 本轮实测的动因：`asg_table` 那 6 个"活面"里有 4 个是执行 SQL 的
 * 文件（两个 e2e 循环脚本、一支单测、一支多租户校验脚本），它们各有链外入口——`Makefile` 配方／
 * `package.json` 脚本／CI workflow／jest `testMatch`——只是不在 `verify.sh` 的默认全跑清单
 * （`SCENARIOS="golden wave control-actuator receipt edge approval-expiry fault-replan"`）里。
 * 把这一档并进"要人手同步"会**高估**维护成本；把它从读数里摘掉又等于藏面 ⇒ 与活面／历史记载
 * 同一手法：只分档并报、不剔除，并硬断「有入口＋无入口＋不可判 = 仅人手」。
 * 限度（不许读成"有入口＝有断言"）：
 *  - 「入口面里出现该路径」既包含"被当脚本跑"也包含"被当数据读"，本尺不区分；它只回答
 *    "链级重放之外还有没有机器面引用这个文件"，不回答"改了它会不会有机器判红"——后者要逐条读配方。
 *  - 已扫的执行面是封闭枚举（见 EXEC_FACES／JEST_CONFIGS／instrument-readers 普查）：动态拼出来的路径、
 *    别的 harness（Playwright／Cargo／tox 那一类）一律读不到 ⇒ 只能落「无入口（在已扫面内）」，
 *    **不等于"没人跑"**。所以判语措辞固定为"在已扫面内没找到入口"，不写"没有入口"。
 *  - 第四面「仓内量具读取」（V339）与前三面**问的不是同一件事**：前三面问"有没有配方提到这个路径"，
 *    这一面问"有没有判据把这份文件当输入读"。两条限度：读到的路径只认**字面量**（拼接与二跳以上读不到 ⇒ 下界）；
 *    "被读"不等于"被按内容核对"——量具也可能只把它当排除表／清单读，所以红了不一定是内容漂移，
 *    逐条读那一步不许省（当期被翻档的六个文件全是登记文档，读取者与档名逐条印在 `instrument-readers` 的读数里）。
 *  - jest 那条腿（V338）以 **jest 自报的 `--listTests` 为准**，自研 glob 档只在权威档跑不起时退回
 *    （退回必须在读数里点名）；两档同时在场时打印双向差集。今天实测差集 0／0／0（413＋42＋176 个文件
 *    两档逐一对上）⇒ 这次换档对读数是零判翻，但它把"自研档替 jest 说话"从一次性核对变成了常驻机检。
 *  - 注释面剥掉（整行 `#`／Makefile 的 `##`／yaml·py 的行内 `#`），否则"文档式提及"会算成入口。 */
const EXEC_FACES = [
  { id: 'make', label: 'Makefile 配方', dir: '.', ext: null, fixed: ['Makefile'] },
  { id: 'pkg', label: 'package.json 脚本', dir: 'ewoh-spark-app', ext: null, fixed: ['ewoh-spark-app/package.json'] },
  { id: 'ci', label: 'CI workflow', dir: '.github/workflows', ext: /\.ya?ml$/ },
  { id: 'sh', label: 'shell 脚本', dir: 'scripts', ext: /\.sh$/ },
  { id: 'py', label: 'tests/*.py', dir: 'tests', ext: /\.py$/ },
];
const JEST_CONFIGS = [
  // V342：后端默认档从 package.json 的 `jest` 键迁进 ewoh-spark-app/jest.config.cjs（别名表要由 tsconfig
  // 现算，而 JSON 装不了函数调用；jest 29 见到两份并存会直接拒跑，所以是"迁"不是"加"）。配置名跟着文件走。
  { name: 'jest(jest.config.cjs)', rel: 'ewoh-spark-app/jest.config.cjs', cwd: 'ewoh-spark-app', lt: ['--config', 'jest.config.cjs', '--listTests'] },
  { name: 'jest(test/e2e)', rel: 'ewoh-spark-app/test/e2e/jest.config.js', cwd: 'ewoh-spark-app', lt: ['--config', 'test/e2e/jest.config.js', '--listTests'] },
  { name: 'jest(client)', rel: 'ewoh-spark-app/client/jest.config.cjs', cwd: 'ewoh-spark-app/client', lt: ['--config', 'jest.config.cjs', '--listTests'] },
];
/* V338：jest 那条腿原先由本尺自己实现 glob＋`<rootDir>`＋ignore 的语义（globToRx），
 * 而 jest 官方有 `--listTests`（"Lists all test files that Jest will run given the arguments, and exits."
 * — https://jestjs.io/docs/cli）。自研档已实测错过一次（rootDir 写死包根把 client 那条腿静默读空），
 * 所以换成**权威档优先、自研档退回**：跑得起就用 jest 自己报的清单，跑不起（离线／无 node／被
 * `EWOH_AS_JEST=static` 关掉／自测夹具）才用自研档，并在读数里点名用的是哪档——
 * 两档同时在时打印**双向差集**，让"自研档替 jest 说话"这件事本身可被证伪。 */
const JEST_ARM = process.env.EWOH_AS_JEST === 'static' ? 'static' : 'auto';
function jestListTests(cfg) {
  try {
    const out = execFileSync('npx', ['jest', ...cfg.lt], {
      cwd: path.join(root, cfg.cwd), encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const set = new Set(out.split('\n').map((l) => l.trim()).filter(Boolean)
      .map((abs) => path.relative(root, abs).split(path.sep).join('/')));
    return { ok: true, files: set };
  } catch (e) {
    return { ok: false, why: `${e.code || e.signal || 'err'} ${(String(e.message).split('\n')[0] || '').slice(0, 60)}` };
  }
}
/** 返回 Map<配置名, {files:Set}|{failed:why}>；`'auto'`＝真跑 jest，Map＝自测注入，缺省＝不启用。 */
function jestAuthority(cfgs, spec) {
  if (JEST_ARM === 'static' || !spec) return null;
  if (spec !== 'auto' && !(spec instanceof Map)) return null;   // 只认这两个形状，别的值一律不 spawn
  const injected = spec instanceof Map ? spec : null;
  const m = new Map();
  for (const c of cfgs) {
    if (injected) { if (injected.has(c.name)) m.set(c.name, { files: injected.get(c.name) }); continue; }
    const r = jestListTests(c);
    m.set(c.name, r.ok ? { files: r.files } : { failed: r.why });
  }
  return m.size ? m : null;
}
const READER_LABEL = '仓内量具读取';
const CLOSURE_LABEL = '测试 import 闭包';
const ENTRY_LABELS = [...EXEC_FACES.map((f) => f.label), ...JEST_CONFIGS.map((c) => c.name),
  READER_LABEL, CLOSURE_LABEL];
/** 第四类入口面（V339）：**这一份文件有没有被仓里哪把量具读**。语义与 EXEC_FACES 那几面不同——
 *  那几面问"有没有配方提到这个路径"，这一面问"有没有判据把它当输入读"（AST 绑定追踪，见
 *  `instrument-readers.cjs` 头部）。取不到解析器 ⇒ 本面记为未启用并在读数里点名，绝不把
 *  "没启用"折成"没人读"。自测靠 opts.readers 注入，不去解析真语料。 */
function readerIndex(opts, overlay) {
  if (opts && opts.readers) return { out: opts.readers, note: '注入档（自测夹具）' };
  if (overlay && overlay.size) return { out: null, note: '夹具臂未启用（自测不解析真语料）' };
  try {
    const r = require('./instrument-readers.cjs').measure(null);
    if (r.unreadable) return { out: null, note: `未启用：${r.unreadable}` };
    return { out: r.out, note: `已启用：扫 ${r.scanned.length} 份量具、被读 ${r.out.size} 个文件` };
  } catch (e) { return { out: null, note: `未启用：取不到 instrument-readers（${String(e.message).slice(0, 50)}）` }; }
}

/** 场景脚本入口（V340）：从 package.json 的 `e2e:<名>` 命令串里取 `node <path>.mjs`，
 *  相对包目录解析后确认在盘上——与 `resident-recovery-assertion-census` 第 1 步那条配方同源，
 *  这里只借"入口清单"这一件事，闭包解析一律交给 import-closure。 */
function scenarioEntryFiles() {
  const rel = 'ewoh-spark-app/package.json';
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')).scripts || {}; } catch { return []; }
  const out = [];
  for (const [k, v] of Object.entries(pkg)) {
    if (!k.startsWith('e2e:')) continue;
    for (const m of String(v).matchAll(/node\s+(\S+\.mjs)/g)) {
      const r = path.posix.normalize(path.posix.join('ewoh-spark-app', m[1]));
      try { if (fs.statSync(path.join(root, r)).isFile()) out.push(r); } catch { /* 盘上没有就不当入口 */ }
    }
  }
  return [...new Set(out)];
}

/** 第五类入口面（V340）：**这份文件有没有被测试代码经 import／require 链间接载入**。
 *  入口清单＝jest 权威档的测试文件 ∪ 场景脚本；解析用 `import-closure.cjs`（别名表取自
 *  `ewoh-spark-app/tsconfig.app.json`，另认 `.d.ts`）。三条不许打折：
 *   - 拿不到权威入口清单 ⇒ 本面**未启用并点名**，绝不把"没启用"折成"无入口"；
 *   - 自测靠 opts.closure 注入，电池不 spawn jest、不解析真语料；
 *   - 取不到 typescript 解析件 ⇒ 未启用（import-closure 自己 rc=3 那一支）。 */
function closureIndex(opts, overlay, auth) {
  if (opts && opts.closure) return { out: opts.closure, note: '注入档（自测夹具）' };
  if (overlay && overlay.size) return { out: null, note: '夹具臂未启用（自测不解析真语料）' };
  const files = [];
  if (auth) for (const a of auth.values()) if (a && a.files) for (const f of a.files) files.push(f);
  const scen = scenarioEntryFiles();
  const entries = [...new Set([...files, ...scen])];
  if (!entries.length) return { out: null, note: '未启用：拿不到 jest 权威入口清单（闭包面不折成"无入口"）' };
  try {
    const r = require('./import-closure.cjs').closure(root, entries);
    if (r.error) return { out: null, note: `未启用：${r.error}` };
    return { out: r.deps, entries: entries.length, jestEntries: files.length, scenarioEntries: scen.length,
      unresolved: r.unresolved.length, missingEntries: r.missingEntries.length, packages: r.packages.size,
      note: `已启用：入口 ${entries.length} 个（jest 权威 ${files.length}＋场景脚本 ${scen.length}）`
        + `、闭包拉到 ${r.deps.size} 个文件｜未命中说明符点名 ${r.unresolved.length} 处`
        + `｜入口不存在 ${r.missingEntries.length} 个｜包说明符 ${r.packages.size} 种不计` };
  } catch (e) {
    return { out: null, note: `未启用：取不到 import-closure（${String(e.message).split('\n')[0].slice(0, 50)}）` };
  }
}

/** 入口清单的唯一来源（V340）：jest 权威档的测试文件 ∪ 场景脚本。
 *  closureIndex 与 CLI 的 `--entries-from-jest` 都走这里，避免两处各列一份清单而读数分叉。 */
function jestEntryFiles() {
  const jest = jestConfigs(new Map());
  const auth = jestAuthority(jest.cfgs, 'auto');
  if (!auth) return null;
  const files = [];
  for (const a of auth.values()) if (a && a.files) for (const f of a.files) files.push(f);
  const all = [...new Set([...files, ...scenarioEntryFiles()])];
  return all.length ? all : null;
}

function listByExt(relDir, extRe) {
  let entries;
  try { entries = fs.readdirSync(path.join(root, relDir), { withFileTypes: true }); } catch { return []; }
  return entries.filter((e) => e.isFile() && extRe.test(e.name)).map((e) => `${relDir}/${e.name}`);
}
function readFace(rel, overlay) {
  if (overlay && overlay.has(rel)) return overlay.get(rel);
  try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; }
}
/** 只留"会被机器执行/消费"的那一面：注释与 package.json 里 scripts 之外的字段全部剥掉。 */
function strippedFace(faceId, text) {
  if (faceId === 'pkg') {
    let scripts;
    try { scripts = JSON.parse(text).scripts; } catch { return null; }
    if (!scripts) return null;
    return Object.values(scripts).join('\n');
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (/^\s*#/.test(line)) continue;
    if (faceId === 'make') out.push(line.split('##')[0]);
    else out.push(line.replace(/\s+#(?:\s|$).*$/, ''));
  }
  return out.join('\n');
}
function globToRx(glob, rootDir) {
  const base = glob.replace(/^<rootDir>\//, `${rootDir}/`).replace(/^<rootDir>$/, rootDir);
  let rx = '';
  for (let i = 0; i < base.length; i += 1) {
    const c = base[i];
    if (c === '*' && base[i + 1] === '*') {
      rx += '[\\s\\S]*';
      i += 1;
      if (base[i + 1] === '/') i += 1;
    } else if (c === '*') rx += '[^/]*';
    else rx += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${rx}$`);
}
/** `<rootDir>` 的落点**逐份配置各算各的**（jest 语义：默认＝该配置文件所在目录，`rootDir:` 相对它再解）。
 *  客户端那份默认 rootDir 是 `ewoh-spark-app/client`，写死成包根会让它的 `src/**` 永远匹配不到 ⇒
 *  少一档假阴面（本轮第一版就是这么错的，被 jest 那条控制抓到）。 */
function resolveRootDir(text, rel, isJson) {
  const cfgDir = path.posix.dirname(rel);
  let declared = null;
  if (isJson) { try { declared = JSON.parse(text).jest?.rootDir; } catch { /* 下面按不可判处理 */ } }
  else { const m = text.match(/rootDir:\s*['"]([^'"]+)['"]/); if (m) declared = m[1]; }
  if (!declared || /\$\{|\benv\b/.test(declared)) return cfgDir === '.' ? '' : cfgDir;
  const raw = declared.replace(/\/$/, '');
  if (raw.startsWith('<rootDir>')) return cfgDir;
  const joined = path.posix.normalize(path.posix.join(cfgDir, raw));
  return joined === '.' ? '' : joined;
}
function jestConfigs(overlay) {
  const cfgs = [];
  const unreadable = [];
  for (const c of JEST_CONFIGS) {
    const text = readFace(c.rel, overlay);
    if (text == null) { unreadable.push(c.name); continue; }
    let patterns = [];
    let ignores = [];
    if (c.json) {
      let j;
      try { j = JSON.parse(text).jest; } catch { unreadable.push(c.name); continue; }
      if (!j || !Array.isArray(j.testMatch)) { unreadable.push(c.name); continue; }
      patterns = j.testMatch;
      ignores = Array.isArray(j.testPathIgnorePatterns) ? j.testPathIgnorePatterns : [];
    } else {
      const m = text.match(/testMatch:\s*\[([^\]]*)\]/);
      if (!m) { unreadable.push(c.name); continue; }
      patterns = [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
      const gi = text.match(/testPathIgnorePatterns:\s*\[([^\]]*)\]/);
      ignores = gi ? [...gi[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]) : [];
    }
    const rd = resolveRootDir(text, c.rel, c.json);
    cfgs.push({
      name: c.name,
      rootDir: rd,
      cwd: c.cwd, lt: c.lt,          // 权威档（`jest --listTests`）要用的两条：在哪个目录跑、带什么参数
      rx: patterns.map((g) => globToRx(g, rd)),
      // jest 的 testPathIgnorePatterns 是**按正则子串匹配路径**，不是 glob；这里只做 <rootDir> 代入，
      // 判定用 includes（够粗，但把"该配置排除的目录"这一层保住——e2e／browser 两个目录就是这么从
      // package.json 那份默认配置里被摘出去、改由各自的 config 认的）。
      ig: ignores.map((g) => g.replace(/^<rootDir>\//, rd ? `${rd}/` : '')),
    });
  }
  return { cfgs, unreadable };
}
function faceRels(f, overlay) {
  const disk = f.fixed ? f.fixed.filter((r) => fs.existsSync(path.join(root, r))) : listByExt(f.dir, f.ext);
  const fromOverlay = overlay ? [...overlay.keys()].filter((k) => path.posix.dirname(k) === f.dir && (f.ext ? f.ext.test(path.posix.basename(k)) : f.fixed.includes(k))) : [];
  return [...new Set([...disk, ...fromOverlay])];
}
/** 返回 { faces:[入口面名…] }｜{ faces:[], none:true }｜{ indeterminate:true, why }。
 *  不可判只在"该文件本身读不到／一面都没读到"时给——少一面由 Σ 那条硬断言去炸，
 *  已扫到的档不许冒充不可判。 */
function buildEntryIndex(overlay, opts) {
  const corpus = [];
  const missingFaces = [];
  for (const f of EXEC_FACES) {
    const rels = faceRels(f, overlay);
    if (!rels.length) { missingFaces.push(f.label); continue; }
    for (const rel of rels) {
      const text = readFace(rel, overlay);
      const s = text == null ? null : strippedFace(f.id, text);
      if (s == null) missingFaces.push(f.label);
      else corpus.push({ face: f.label, text: s });
    }
  }
  const jest = jestConfigs(overlay);
  // 权威档**只在调用方显式要求时启用**（真语料那一遍传 `'auto'`，自测传 Map 注入）：
  // 默认关＝电池永远不 spawn jest，判据自测在无 node_modules 的临时副本里也跑得动。
  const spec = opts && opts.jestAuthority;
  const auth = spec ? jestAuthority(jest.cfgs, spec) : null;
  const readers = readerIndex(opts, overlay);
  const closure = closureIndex(opts, overlay, auth);
  const arms = [];
  const index = { corpus, jest, missingFaces, auth, arms, readers, closure };
  index.of = (rel) => {
    const base = path.basename(rel);
    // 左边界只排除"名字的一部分"（字母数字下划线点横杠），**不排除斜杠**——入口配方里写的常是
    // `test/e2e/x.mjs` 这种相对包根的路径，把斜杠当非法边界会让整条 pkg 腿静默读不到（本轮实测：
    // 第一版就是这么把 agv-transport-loop 判成无入口的）。
    const baseRx = new RegExp(`(^|[^A-Za-z0-9_.-])${escapeRx(base)}([^A-Za-z0-9]|$)`);
    const faces = [];
    for (const c of index.corpus) if (c.text.includes(rel) || baseRx.test(c.text)) if (!faces.includes(c.face)) faces.push(c.face);
    for (const cfg of index.jest.cfgs) {
      const a = auth && auth.get(cfg.name);
      if (a && a.files) {
        if (a.files.has(rel)) faces.push(cfg.name);
        continue;                         // 权威档在场就不让自研档插嘴（两档混判＝差集永远看不见）
      }
      const hit = cfg.rx.some((rx) => rx.test(rel)) && !cfg.ig.some((ig) => rel.includes(ig));
      if (hit) faces.push(cfg.name);
    }
    if (index.readers.out && index.readers.out.has(rel)) faces.push(READER_LABEL);
    if (index.closure.out && index.closure.out.has(rel)) faces.push(CLOSURE_LABEL);
    if (faces.length) return { faces };
    if (!index.corpus.length && !index.jest.cfgs.length) return { indeterminate: true, why: '执行面一个都没读到' };
    return { faces: [], none: true };
  };
  // 两档同时在 ⇒ 报双向差集（自研档多报＝假阳、少报＝假阴），这是"换成权威档"这件事自身的可证伪面。
  // 注入档同样算差集：判据自测靠它证明"多报/漏报"两向都读得出来（不 spawn jest 也能证这条腿有牙）。
  if (auth) {
    const universe = allFiles();
    const tag = spec === 'auto' ? '' : '（注入档）';
    for (const cfg of jest.cfgs) {
      const a = auth.get(cfg.name);
      if (!a || !a.files) { arms.push(`${cfg.name}：权威档跑不起来（${a ? a.failed : '未取'}）⇒ 退回自研档`); continue; }
      const staticOnly = []; const authOnly = [];
      for (const rel of universe) {
        const s = cfg.rx.some((rx) => rx.test(rel)) && !cfg.ig.some((ig) => rel.includes(ig));
        if (s && !a.files.has(rel)) staticOnly.push(rel);
        if (!s && a.files.has(rel)) authOnly.push(rel);
      }
      arms.push(`${cfg.name}${tag}：jest 自报 ${a.files.size} 个文件｜自研档多报 ${staticOnly.length}｜自研档漏报 ${authOnly.length}`
        + (staticOnly.length ? `｜多报样例 ${staticOnly.slice(0, 4).join('、')}` : '')
        + (authOnly.length ? `｜漏报样例 ${authOnly.slice(0, 4).join('、')}` : ''));
    }
  } else if (spec) {
    arms.push(`jest 腿＝自研档（${JEST_ARM === 'static' ? 'EWOH_AS_JEST=static 显式关掉权威档' : '权威档未启用'}）`);
  }
  return index;
}

/** overlay：内存里的合成面（自测用），不写盘。 */
function measure(covered, overlay = new Map(), opts) {
  const rows = [];
  const entry = buildEntryIndex(overlay, opts);
  for (const sample of SAMPLES) {
    const rx = new RegExp(`(^|[^A-Za-z0-9_.])${escapeRx(sample.needle)}([^A-Za-z0-9_]|$)`);
    const faceDetail = {};
    const uncoveredFiles = [];
    const livingFiles = [];
    const recordFiles = [];
    const otherFiles = [];
    const entryFiles = [];
    const noentryFiles = [];
    const entryUnknownFiles = [];
    const entryFaces = {};
    // 每个"仅人手"文件都要在三档里恰好落一次（第三根轴，见 EXEC_FACES 上方注释）
    const classifyUncovered = (rel, text) => {
      (recordOf(rel, text) ? recordFiles : livingFiles).push(rel);
      const e = entry.of(rel);
      if (e.indeterminate) entryUnknownFiles.push(rel);
      else if (e.faces.length) { entryFiles.push(rel); entryFaces[rel] = e.faces; }
      else noentryFiles.push(rel);
    };
    let files = 0, coveredCount = 0;
    const hits = [];
    for (const rel of allFiles()) {
      const text = overlay.get(rel) ?? fs.readFileSync(path.join(root, rel), 'utf8');
      if (!rx.test(text)) continue;
      const face = faceOf(rel);
      hits.push({ rel, face });
      const inScope = covered.has(rel);
      files += 1;
      if (inScope) coveredCount += 1;
      else {
        uncoveredFiles.push(rel);
        classifyUncovered(rel, text);
      }
      hits.push({ rel, face, inScope });
      const bucket = faceDetail[face] ?? { total: 0, covered: 0, files: [] };
      bucket.total += 1;
      if (inScope) bucket.covered += 1;
      bucket.files.push(rel);
      faceDetail[face] = bucket;
    }
    // overlay 里的合成面
    for (const [rel, text] of overlay) {
      if (!rx.test(text)) continue;
      if (allFiles().includes(rel)) continue;   // 真实在盘的文件已在上面判过，别重复计一次
      const face = faceOf(rel);
      if (face === 'other') { otherFiles.push(rel); continue; }
      files += 1;
      uncoveredFiles.push(rel);
      classifyUncovered(rel, text);
      const bucket = faceDetail[face] ?? { total: 0, covered: 0, files: [] };
      bucket.total += 1;
      bucket.files.push(rel);
      faceDetail[face] = bucket;
    }
    rows.push({
      id: sample.id, needle: sample.needle, note: sample.note, broad: !!sample.broad,
      faces: Object.keys(faceDetail).length, files, covered: coveredCount,
      uncovered: uncoveredFiles.length, faceDetail, uncoveredFiles,
      living: livingFiles.length, record: recordFiles.length, livingFiles, recordFiles,
      entry: entryFiles.length, noentry: noentryFiles.length, entryUnknown: entryUnknownFiles.length,
      entryFiles, noentryFiles, entryUnknownFiles, entryFaces,
      otherFiles, arms: entry.arms, readerNote: entry.readers.note, closureNote: entry.closure.note,
    });
  }
  return rows;
}

function escapeRx(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function report(rows) {
  /* jest 那条腿用的是哪一档、两档差多少——先报这一组再看数（读数与档必须同框）。
     整组只加一个前导空行，免得两档遍的日志差被空行数污染（下一轮要靠逐行 diff 比读数）。 */
  if (rows[0] && rows[0].arms && rows[0].arms.length) {
    console.log('\n[入口面/jest 档]');
    for (const a of rows[0].arms) console.log(`  ${a}`);
  }
  if (rows[0] && rows[0].readerNote) console.log(`[入口面/量具读取] ${rows[0].readerNote}`);
  if (rows[0] && rows[0].closureNote) console.log(`[入口面/import 闭包] ${rows[0].closureNote}`);
  for (const r of rows) {
    console.log(`\n[${r.id}] 词面「${r.needle}」——${r.note}${r.broad ? '【宽词样本：只作"词面复用度"参考，不进同步面结论】' : ''}`);
    console.log(`  同步面 ${r.faces} 个｜命中文件 ${r.files}｜覆盖集内 ${r.covered}｜仅人手 ${r.uncovered}`
      + `（活面 ${r.living}＋历史记载 ${r.record}）`
      + `｜机器可见率 ${r.files ? Math.round((r.covered / r.files) * 100) : 0}%`);
    for (const f of FACES) {
      const d = r.faceDetail[f.id];
      if (d) console.log(`    ${f.label.padEnd(22)} ${String(d.total).padStart(4)} 处｜覆盖集内 ${d.covered}`);
    }
    console.log(`    只在人手（${r.uncovered} 个，取前 10）：${r.uncoveredFiles.slice(0, 10).join(' , ') || '（无）'}`);
    console.log(`    其中要跟着改的活面（${r.living} 个）：${r.livingFiles.slice(0, 10).join(' , ') || '（无）'}`);
    console.log(`    历史记载（${r.record} 个，写定不再随 schema 改）：${r.recordFiles.slice(0, 10).join(' , ') || '（无）'}`);
    console.log(`    链外机器入口（第三根轴）：有入口 ${r.entry}｜已扫面内无入口 ${r.noentry}｜不可判 ${r.entryUnknown}`
      + `（读到的执行面：${ENTRY_LABELS.join('／')}${r.entryUnknown ? ' ⇒ 有文件读不到，见下' : ''}）`);
    if (r.entry) console.log(`      有入口（${r.entry} 个）：`
      + r.entryFiles.slice(0, 10).map((f) => `${f}←${r.entryFaces[f].join('+')}`).join(' , '));
    if (r.entryUnknown) console.log(`      不可判（${r.entryUnknown} 个）：${r.entryUnknownFiles.slice(0, 10).join(' , ')}`);
    if (r.otherFiles.length) console.log(`    ⚠ 规则没认识的兜底文件：${r.otherFiles.join(' , ')}`);
  }
  console.log('\n—— 汇总（推广判据①的可数量）');
  // 恒等式一：活面＋历史记载 必须等于"只在人手"，一个文件都不许多算或漏算（漏算＝把真同步面藏进"记载"那一档）
  // 恒等式二（V336 第三根轴）：有入口＋已扫面内无入口＋不可判 也必须等于"只在人手"——
  // 这一条防的是"把有链外机器的文件留在档外"，那会让"仅人手"读起来比实际更没人管。
  for (const r of rows) {
    if (r.living + r.record !== r.uncovered) {
      console.error(`✕ ${r.id}：活面 ${r.living}＋记载 ${r.record} ≠ 仅人手 ${r.uncovered} ⇒ 读数作废`);
      process.exit(9);
    }
    if (r.entry + r.noentry + r.entryUnknown !== r.uncovered) {
      console.error(`✕ ${r.id}：有入口 ${r.entry}＋无入口 ${r.noentry}＋不可判 ${r.entryUnknown} ≠ 仅人手 ${r.uncovered} ⇒ 读数作废`);
      process.exit(9);
    }
  }
  for (const r of rows) {
    console.log(`  ${r.id.padEnd(26)} 面 ${String(r.faces).padStart(2)}｜文件 ${String(r.files).padStart(4)}`
      + `｜仅人手 ${String(r.uncovered).padStart(4)}｜其中活面 ${String(r.living).padStart(3)}`
      + `｜链外有入口 ${String(r.entry).padStart(3)}`);
  }
}

function selfTest() {
  const cases = [];
  const ok = (name, cond, detail = '') => cases.push({ name, pass: !!cond, detail });
  // 正向对照：分类必须是**有序首匹配**，具体规则要赢过泛化规则（V226 实测：两条规则重叠时
  // 旧写法把 docs/audit 判成"未归类"，面数虚低）
  const expect = {
    'db/migrations/a.sql': 'db_migration', 'db/verify/a.verify.sql': 'db_verify',
    'db/contracts/schema-manifest.yaml': 'schema_manifest', 'db/runner/run_migrations.js': 'runner',
    'contracts/state-machines/control.yaml': 'state_machine', 'contracts/events/event-catalog.yaml': 'event_catalog',
    'contracts/decision/x.json': 'other_contracts', 'openapi/ewoh.yaml': 'openapi',
    'ewoh-spark-app/server/database/schema.ts': 'drizzle_schema',
    'ewoh-spark-app/test/e2e/x.e2e.spec.ts': 'resident_spec',
    'ewoh-spark-app/server/modules/a/b.ts': 'product_code',
    'ewoh-spark-app/client/src/api/c.ts': 'client',
    'docs/audit/current/d.md': 'ledger', 'docs/architecture/e.md': 'other_docs',
    'CHANGELOG.md': 'repo_docs', 'feature-status.yaml': 'repo_docs',
  };
  ok('分类的有序首匹配必须把具体面赢过泛化面',
    Object.entries(expect).every(([p, want]) => faceOf(p) === want),
    Object.entries(expect).filter(([p, want]) => faceOf(p) !== want).map(([p, want]) => `${p}→${faceOf(p)}≠${want}`).join(' '));
  // 必须不开火的对照：本脚本自身与 tmp/ 不得算成面
  ok('本脚本自身不进面（防自测夹具污染分母）', !allFiles().includes(SELF) && !allFiles().some((f) => f.startsWith('tmp/')),
    allFiles().filter((f) => f.startsWith('tmp/') || f === SELF).slice(0, 3).join(','));
  const empty = new Set(['nothing-at-all']);
  const base = measure(empty);
  // 下界取 2 而不是 3：事件名（control.command.expired）今天确实只落契约与审计两面，
  // 把阈值定到 3 会让"这条事实本来就只同步两处"被读成尺子坏了（V226 第一版就是这么写的）。
  ok('真实业务事实至少落 2 个面', base.every((r) => r.faces >= 2), base.map((r) => `${r.id}:${r.faces}`).join(' '));
  ok('兜底桶必须逐条打印（规则不认识的文件不许静默消失）',
    base.every((r) => Array.isArray(r.otherFiles)), base.map((r) => `${r.id}:${r.otherFiles.length}`).join(' '));
  // 必须开火的注入 1：不存在的词面 ⇒ 0 面 0 文件（与"干净"不同形）
  SAMPLES.push({ id: '__probe_absent', needle: 'qqz_not_a_real_symbol_8123', note: '自测夹具' });
  const withAbsent = measure(empty).find((r) => r.id === '__probe_absent');
  SAMPLES.pop();
  ok('不存在的词面必须报 0 面 0 文件', withAbsent.faces === 0 && withAbsent.files === 0,
    JSON.stringify({ faces: withAbsent.faces, files: withAbsent.files }));
  // 必须开火的注入 2：在"覆盖集"里的文件 ⇒ 机器可见率必须升
  const real = base.find((r) => r.id === 'backlog_scan_cap');
  const coveredAll = new Set(allFiles());
  const allCovered = measure(coveredAll).find((r) => r.id === 'backlog_scan_cap');
  ok('覆盖集判据必须能翻转读数（不是装饰）', real.covered === 0 && allCovered.uncovered === 0
    && allCovered.covered === real.files, `base covered=${real.covered} allCovered uncovered=${allCovered.uncovered}`);
  // 必须开火的注入 3：内存里加一个面文件 ⇒ 面数或文件数必须变
  const overlay = new Map([['docs/audit/current/zz-selftest-probe.md', '本文件提到 BACKLOG_SCAN_CAP 用于自测\n']]);
  const grown = measure(empty, overlay).find((r) => r.id === 'backlog_scan_cap');
  ok('新增一个面文件必须让读数变化', grown.files === real.files + 1, `${real.files} -> ${grown.files}`);
  // 必须不开火的对照：overlay 里没有词面 ⇒ 读数不变
  const noGrow = measure(empty, new Map([['docs/audit/current/zz-no-needle.md', '无关内容\n']]))
    .find((r) => r.id === 'backlog_scan_cap');
  ok('不含词面的文件不得被计入', noGrow.files === real.files, `${real.files} vs ${noGrow.files}`);
  // V336 第二根轴：「只在人手」里混着"要跟着改的活面"与"写定不再改的历史记载"，两档必须分开且加总等于原数
  const rec = {
    'CHANGELOG.md': 'changelog',
    'deliverables/audit-architecture-deep-dive.md': 'deliverable',
    'docs/reviews/rls-coverage-audit-2026-08-08.md': 'dated',
    'delivery/开发指令-AI调度说明生成-2026-08-21.md': 'dated',
    'docs/decisions/ADR-004-scheduler-tenancy.md': 'adr',
    'docs/architecture/adr-004-mes-scheduling-convergence.md': 'adr',
  };
  ok('历史记载四类规则都要认得（CHANGELOG／交付成稿／带日期／ADR）',
    Object.entries(rec).every(([p, want]) => recordOf(p, '') === want),
    Object.entries(rec).filter(([p, want]) => recordOf(p, '') !== want)
      .map(([p, want]) => `${p}→${recordOf(p, '')}≠${want}`).join(' '));
  ok('登记册本体不得被记成历史记载（那样等于把真同步面藏进"记载"档）',
    recordOf('docs/audit/current/chain-behavior-baseline.md', '') === null,
    String(recordOf('docs/audit/current/chain-behavior-baseline.md', '')));
  ok('头部 generated_at/HEAD 钉住的定格清单算记载，正文里出现该词不算',
    recordOf('docs/audit/current/old-finding-regression.yaml',
      '# old-finding-regression.yaml — 回归验证（HEAD 58b7819e）\n# generated_at: 2026-08-17T13:24:48\nsummary: {}\n') === 'generated'
    && recordOf('docs/live-note.md', '正文里提了一句 generated_at 这个键名\n') === null, '');
  ok('逐条样本恒等：活面＋记载 = 仅人手（漏算即读数作废）',
    base.every((r) => r.living + r.record === r.uncovered),
    base.filter((r) => r.living + r.record !== r.uncovered)
      .map((r) => `${r.id}:${r.living}+${r.record}≠${r.uncovered}`).join(' '));
  const probeRec = measure(empty, new Map([['docs/reviews/probe-selftest-2026-01-01.md', 'BACKLOG_SCAN_CAP\n']]))
    .find((r) => r.id === 'backlog_scan_cap');
  ok('新增一个带日期的记录文件 ⇒ 记载 +1 而活面不涨',
    probeRec.record === real.record + 1 && probeRec.living === real.living,
    `${real.record}/${real.living} → ${probeRec.record}/${probeRec.living}`);
  const probeLive = measure(empty, new Map([['docs/architecture/probe-selftest-live.md', 'BACKLOG_SCAN_CAP\n']]))
    .find((r) => r.id === 'backlog_scan_cap');
  ok('新增一个活文档 ⇒ 活面 +1（不许被误判成记载）',
    probeLive.living === real.living + 1 && probeLive.record === real.record,
    `${real.record}/${real.living} → ${probeLive.record}/${probeLive.living}`);
  /* V336 第三根轴：「仅人手」≠「链外没有机器碰它」。四条控制——前两条是一正一反的同一注入
   * （配方行 vs 注释行），第三条钉 jest 那条腿（不钉它就是死码），第四条钉真语料上本轮实际
   * 读到的那三个执行文件；另加两条不开火：注释面提及、别的文件命中。 */
  const PROBE = 'docs/audit/current/zz-entry-selftest-probe.md';
  const mkOverlay = (line) => new Map([
    [PROBE, `本文件提到 BACKLOG_SCAN_CAP 用于自测\n`],
    ['Makefile', `chain-baseline-probe:\n${line}\n`],
  ]);
  const fired = measure(empty, mkOverlay('	node scripts/run-probe.sh zz-entry-selftest-probe.md docs/audit/current/zz-entry-selftest-probe.md'))
    .find((r) => r.id === 'backlog_scan_cap');
  ok('入口配方行引用该文件 ⇒ 必须落「链外有机器入口」档',
    fired.entryFiles.includes(PROBE), `entry=${fired.entry} ${fired.entryFiles.join(',')}`);
  const commented = measure(empty, mkOverlay('# 只是注释里提一句 docs/audit/current/zz-entry-selftest-probe.md\n	node scripts/run-probe.sh other.md'))
    .find((r) => r.id === 'backlog_scan_cap');
  ok('注释面里的路径提及不得算入口（否则"文档式提及"会把入口档撑满）',
    !commented.entryFiles.includes(PROBE), `entry=${commented.entry} ${commented.entryFiles.join(',')}`);
  const otherName = measure(empty, mkOverlay('	node scripts/run-probe.sh totally-other-file.md'))
    .find((r) => r.id === 'backlog_scan_cap');
  ok('入口面提到的是别的文件 ⇒ 本面文件仍须落无入口档',
    !otherName.entryFiles.includes(PROBE) && otherName.noentryFiles.includes(PROBE),
    `entry=${otherName.entryFiles.join(',') || '（空）'}`);
  const jestPkg = new Map([
    ['ewoh-spark-app/test/unit/zz-entry-selftest-probe.spec.ts', 'BACKLOG_SCAN_CAP\n'],
    ['ewoh-spark-app/package.json', JSON.stringify({
      scripts: {}, jest: { testMatch: ['<rootDir>/test/**/*.spec.ts'] },
    })],
  ]);
  const byJest = measure(empty, jestPkg).find((r) => r.id === 'backlog_scan_cap');
  const JEST_PROBE = 'ewoh-spark-app/test/unit/zz-entry-selftest-probe.spec.ts';
  ok('jest testMatch 那条腿必须能单独把文件判成有入口（不钉它就是死码）',
    byJest.entryFiles.includes(JEST_PROBE) && byJest.entryFaces[JEST_PROBE]?.some((f) => f.startsWith('jest(')),
    `entry=${byJest.entry} faces=${(byJest.entryFaces[JEST_PROBE] ?? []).join('+')}`);
  const bareIdx = buildEntryIndex(new Map());
  bareIdx.corpus = []; bareIdx.jest.cfgs = [];
  ok('一面都没读到时必须落「不可判」，不得折成「无入口」',
    bareIdx.of('anything.md').indeterminate === true, JSON.stringify(bareIdx.of('anything.md')));
  /* <rootDir> 必须**逐份配置**解：client 那份默认 rootDir 是 `ewoh-spark-app/client`，写死成包根
   * 会让它那条 `src` 下的 `*.test.ts` 模式永远匹配不到（本轮第一版就是这样，控制把它抓回来了）。 */
  const idx = buildEntryIndex(new Map());
  ok('<rootDir> 按各配置文件所在目录解：client 的 src 测试必须认得、包根同款形状不得认得',
    idx.of('ewoh-spark-app/client/src/lib/offlineDb.test.ts').faces?.some((f) => f === 'jest(client)')
    && !idx.of('ewoh-spark-app/src/lib/offlineDb.test.ts').faces?.some((f) => f === 'jest(client)'),
    `client=${JSON.stringify(idx.of('ewoh-spark-app/client/src/lib/offlineDb.test.ts').faces)}`
    + ` 包根=${JSON.stringify(idx.of('ewoh-spark-app/src/lib/offlineDb.test.ts').faces)}`);
  ok('e2e 那批 spec 由 test/e2e 的配置认、并被包根配置排除（两档各归各的，不许并成一档）',
    idx.of('ewoh-spark-app/test/e2e/control-delivery-race.e2e.spec.ts').faces
      .every((f) => f === 'jest(test/e2e)'),
    JSON.stringify(idx.of('ewoh-spark-app/test/e2e/control-delivery-race.e2e.spec.ts').faces));
  /* V338：jest 那条腿换成"权威档优先、自研档退回"。四支控制钉三件事——
   * ① 权威档真的**接管**判定（不是与自研档并列加分），两向极性各一支；
   * ② 差集那一行两个方向都读得出来（多报＝自研档假阳面、漏报＝假阴面）；
   * ③ 不显式请求时绝不 spawn jest（判据自测要在没有 node_modules 的临时副本里跑）。 */
  const CLI = 'jest(client)';
  const CLI_TEST = 'ewoh-spark-app/client/src/lib/offlineDb.test.ts';
  const authIdx = (files) => buildEntryIndex(new Map(), { jestAuthority: new Map([[CLI, files]]) });
  // 注入集里放两个名字：`Makefile` 只验 `of()` 的极性（它没有代码扩展名，不在差集扫描面里），
  // 那份 `.md` 才验差集的**漏报**侧——它在必扫面内、又不被 client 的 testMatch 认得。
  const onlyMake = authIdx(new Set(['Makefile', 'docs/audit/current/chain-behavior-baseline.md']));
  ok('注入档接管 jest 判定（假阳侧）：自研档认得的 client 测试，权威档没列 ⇒ 必须不再算 jest 入口',
    !(onlyMake.of(CLI_TEST).faces || []).includes(CLI) && (idx.of(CLI_TEST).faces || []).includes(CLI),
    `注入后=${JSON.stringify(onlyMake.of(CLI_TEST).faces)}｜自研档=${JSON.stringify(idx.of(CLI_TEST).faces)}`);
  ok('注入档接管 jest 判定（假阴侧）：权威档列了 Makefile，自研档的模式认不得 ⇒ 必须算它有入口',
    (onlyMake.of('Makefile').faces || []).includes(CLI), JSON.stringify(onlyMake.of('Makefile').faces));
  const armLine = onlyMake.arms.find((a) => a.startsWith(`${CLI}（注入档）`)) || '';
  ok('两档差集必须双向可读：注入一支"完全不合"的权威档 ⇒ 同一行里既报自研档多报（>0）也报漏报 1',
    /自研档多报 [1-9]\d*/.test(armLine) && /自研档漏报 1｜/.test(armLine), armLine || `arms=${onlyMake.arms.join(' § ')}`);
  ok('调用方不显式请求 ⇒ 不启用权威档也不打印档位行（判据自测结构上不 spawn jest）',
    buildEntryIndex(new Map()).arms.length === 0 && buildEntryIndex(new Map(), {}).arms.length === 0,
    `默认 arms=${buildEntryIndex(new Map()).arms.length}｜空 opts arms=${buildEntryIndex(new Map(), {}).arms.length}`);
  const dup = measure(empty, new Map([['docs/audit/current/chain-behavior-baseline.md', 'BACKLOG_SCAN_CAP 在真实在盘文件里的覆盖文本\n']]))
    .find((r) => r.id === 'backlog_scan_cap');
  ok('overlay 一个真实在盘的文件不得让它被计两次（磁盘遍与 overlay 遍只能有一遍认它）',
    dup.files === real.files, `${real.files} vs ${dup.files}`);
  const asg = base.find((r) => r.id === 'asg_table');
  const mustHaveEntry = [
    'ewoh-spark-app/test/e2e/agv-transport-loop.mjs',
    'scripts/verify-scheduler-multitenant.mjs',
    'ewoh-spark-app/test/unit/scripts/reset-scenario-data.spec.ts',
  ];
  ok('真语料：asg_table 那三个执行文件必须读得出链外入口（本轮据此否证"消副本"那条杠杆）',
    mustHaveEntry.every((f) => asg.entryFiles.includes(f)),
    mustHaveEntry.filter((f) => !asg.entryFiles.includes(f)).map((f) => `${f}∉[${asg.entryFiles.join(',')}]`).join(' '));
  /* V339 第四入口面（「仓内量具读取」）：一支开火、一支不开火、一支钉"未启用要点名"。 */
  const rdOv = new Map([[PROBE, 'BACKLOG_SCAN_CAP 只被量具读，配方里没人提\n'], ['Makefile', 'chain-baseline-probe:\n\tnode scripts/run-probe.sh other.md\n']]);
  const rdOff = measure(empty, rdOv).find((r) => r.id === 'backlog_scan_cap');
  const rdOn = measure(empty, rdOv, { readers: new Map([[PROBE, [{ instrument: 'scripts/chain-baseline/zz-fixture.cjs', kind: 'const1hop' }]]]) })
    .find((r) => r.id === 'backlog_scan_cap');
  ok('量具读取面必须单独就能把文件判成有入口（注入档，不解析真语料）',
    rdOn.entryFiles.includes(PROBE) && (rdOn.entryFaces[PROBE] || []).includes(READER_LABEL),
    `faces=${(rdOn.entryFaces[PROBE] || []).join('+')} entry=${rdOn.entry}`);
  ok('未注入时该文件仍在「无入口」档，且读数要说明这一面**没启用**（不把"没启用"折成"没人读"，也不折成不可判）',
    rdOff.noentryFiles.includes(PROBE) && /夹具臂未启用/.test(rdOff.readerNote), rdOff.readerNote);
  ok('接入第四面后恒等式仍成立：有入口＋无入口＋不可判 = 仅人手（注入遍与真语料遍各自都要过）',
    [rdOn, rdOff, asg].every((r) => r.entry + r.noentry + r.entryUnknown === r.uncovered),
    [rdOn, rdOff, asg].map((r) => `${r.entry}+${r.noentry}+${r.entryUnknown}≠${r.uncovered}`).filter((x) => !x.includes('≠')).join(',') || '三遍各自加总都对');
  /* V340 第五入口面（「测试 import 闭包」）：一支开火、一支钉"未启用要点名"、一支钉两面各自加分不重复计。 */
  const clOff = measure(empty, rdOv).find((r) => r.id === 'backlog_scan_cap');
  const clOn = measure(empty, rdOv, { closure: new Map([[PROBE, { depth: 2, by: 'ewoh-spark-app/client/src/zz.fixture.test.ts' }]]) })
    .find((r) => r.id === 'backlog_scan_cap');
  ok('import 闭包面必须单独就能把文件判成有入口（注入档，电池不 spawn jest、不解析真语料）',
    clOn.entryFiles.includes(PROBE) && (clOn.entryFaces[PROBE] || []).includes(CLOSURE_LABEL),
    `faces=${(clOn.entryFaces[PROBE] || []).join('+')} entry=${clOn.entry}`);
  ok('闭包面未启用时读数必须点名（不把"没启用"折成"无入口"，也不折成不可判）',
    clOff.noentryFiles.includes(PROBE) && /夹具臂未启用/.test(clOff.closureNote), clOff.closureNote);
  const bothOn = measure(empty, rdOv, {
    readers: new Map([[PROBE, [{ instrument: 'scripts/chain-baseline/zz-fixture.cjs', kind: 'const1hop' }]]]),
    closure: new Map([[PROBE, { depth: 1, by: 'ewoh-spark-app/client/src/zz.fixture.test.ts' }]]),
  }).find((r) => r.id === 'backlog_scan_cap');
  ok('读取面与闭包面各自加分、同一个文件只算一个入口（两面不得并成一档，也不得重复计数）',
    (bothOn.entryFaces[PROBE] || []).includes(READER_LABEL) && (bothOn.entryFaces[PROBE] || []).includes(CLOSURE_LABEL)
    && bothOn.entry === new Set(bothOn.entryFiles).size,
    `faces=${(bothOn.entryFaces[PROBE] || []).join('+')} entry=${bothOn.entry} files=${bothOn.entryFiles.length}`);
  ok('第三根轴逐条样本恒等：有入口＋无入口＋不可判 = 仅人手',
    base.every((r) => r.entry + r.noentry + r.entryUnknown === r.uncovered),
    base.filter((r) => r.entry + r.noentry + r.entryUnknown !== r.uncovered)
      .map((r) => `${r.id}:${r.entry}+${r.noentry}+${r.entryUnknown}≠${r.uncovered}`).join(' '));
  let bad = 0;
  for (const c of cases) { console.log(`${c.pass ? '✔' : '✗'} ${c.name}${c.pass ? '' : ` → ${c.detail}`}`); if (!c.pass) bad += 1; }
  console.log(`[change-amplification] 判据自测 ${cases.length - bad}/${cases.length} 通过`);
  return bad === 0;
}

function main(argv) {
  if (argv.includes('--self-test')) { process.exitCode = selfTest() ? 0 : 1; return; }
  const scope = collectScope(root);
  if (scope.error) { console.error(`[change-amplification] 覆盖集解析失败：${scope.error}`); process.exitCode = 2; return; }
  const covered = new Set(scope.files.map((f) => f.rel));
  const rows = measure(covered, new Map(), { jestAuthority: 'auto' });
  report(rows);
  const bad = [];
  if (argv.includes('--json')) {
    fs.writeFileSync(path.join(root, 'tmp/change-amplification.json'), JSON.stringify({
      generatedBy: 'scripts/chain-baseline/change-amplification.cjs',
      coverageSource: 'replay-freshness.collectScope', scopeFiles: scope.files.length, filesScanned: allFiles().length, rows,
    }, null, 2));
  }
  console.log(`\n[change-amplification] 扫过 ${allFiles().length} 个文件｜覆盖集 ${scope.files.length} 个（replay-freshness 权威清单）`);
  const other = rows.flatMap((r) => r.otherFiles);
  if (other.length) console.log(`（提示：${new Set(other).size} 个文件落在规则之外，已逐条打印 ⇒ 要么补面、要么承认它不是登记面）`);
}

if (require.main === module) main(process.argv.slice(2));
// V341：`alias-table-sync.cjs` 复用同一份跑测档名册与权威档取法（别名面若自己再列一份清单，
// 两份清单读数一冲突，本次读数就作废——所以这里只导出，不复制）。
module.exports = { measure, faceOf, allFiles, FACES, SAMPLES, jestEntryFiles, scenarioEntryFiles,
  JEST_CONFIGS, jestConfigs, jestAuthority };
