#!/usr/bin/env node
/**
 * 门禁主线「能不能红」的负向控制覆盖度量（V115）。
 *
 * 为什么需要这一条：`make audit-regression-gates` 连绿只说明「这次没发现问题」，
 * 不说明「问题出现时它会响」。V110 抓到 verify.sh 的 0 passed 假绿、V114 抓到 28 项修法里
 * 只有 23 项真的有常驻位点，同族根因都是：**判据自己没被反证过**。本轮把反证做成常驻入口。
 *
 * 四类判据分开记账，不混成一个「有自测/没自测」的粗标记：
 *  fixture   把门禁脚本连同它**真实读的那份语料**只读复制进 tmp 夹具 →
 *             ① 干净对照必须绿（夹具不成立时注入结论一律作废，不把「夹具本来就红」当成抓到）；
 *             ② 逐条注入已知缺陷：必须非零退出 **且** 报出预期判据名（只要求非零会把
 *                「夹具缺文件而崩」算成抓到）；③ 撤销注入后复跑必须回绿（证明注入确实
 *                改变了输入，而不是改了个无人读的地方）。
 *  in-file   负向控制写在门禁自己里面（内置检测器自测 / 同名自测 spec / 变异用例）：
 *             这里把它跑到并确认它执行了，不重复实现。
 *  self-test 主线命令自带 --self-test 的那些：不重复跑（它们各自主线里已在门禁内），
 *             本脚本只把分母从 Makefile 现抽出来登记。
 *  probe     夹具跑不动的主线（要真实服务进程 / 数据库 / 需改产品面）：量出它当前有什么、
 *             缺什么，缺的**登记为限制**，不写成已覆盖。
 *
 * 只读：不改仓库任何被扫文件，只在 tmp/ 下建副本；夹具用完即删（--keep 保留）。
 * 用法：node scripts/chain-baseline/gate-negative-control.cjs [--only=1,3] [--keep]
 * 退出码：0=已度量的负向控制全部成立；1=有门禁不会响（逐条列在上）；3=夹具自身不成立。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = process.cwd();
const ARGS = process.argv.slice(2);
const ONLY = (ARGS.find((a) => a.startsWith('--only=')) || '').replace('--only=', '')
  .split(',').filter(Boolean).map(Number);
const KEEP = ARGS.includes('--keep');
const FIXROOT = path.join(ROOT, 'tmp/v115-fixture');
const findingsGate = [];   // 形状盲区探针的账（必须在 fixtureGate 之前声明：TDZ）

/** 元反证（--self-check）：造一条"永远 exit 0"的假门禁喂给本度量，
 *  度量必须把它报成「注入后仍绿 ⇒ 该判据不会响」。没有这一步，
 *  本门禁自己就是一条没被反证过的判据——正是本轮要消灭的形状。 */
function selfCheck() {
  const fix = path.join(FIXROOT, 'meta');
  rmrf(fix);
  fs.mkdirSync(path.join(fix, 'scripts'), { recursive: true });
  const g = { n: 0, script: 'scripts/audit-never-responds.js', copy: [], small: null,
    synthetic: "console.log('PASS 一切正常');\nprocess.exit(0);\n",
    inj: [{ label: '对假门禁注入已知缺陷', files: { 'a.txt': 'bad\n' }, needle: 'FAIL never' }] };
  const r = fixtureGate(g);
  const row = r.rows.find((x) => x.step.startsWith('注入'));
  const cleanGreen = r.rows[0].ok;
  const caught = row && !row.ok && /不会响/.test(row.note);
  rmrf(fix);
  console.log(`${cleanGreen && caught ? '✅' : '❌'} 元反证：假门禁（永不响）被判为「该判据不会响」= ${caught}｜夹具干净对照先绿 = ${cleanGreen}`);
  process.exit(cleanGreen && caught ? 0 : 1);
}

/* ── Makefile 原文抽取：主线清单与 --self-test 分母都不写死（写死的分母每加一条主线就过期） ── */
function parseMainlines() {
  const lines = fs.readFileSync(path.join(ROOT, 'Makefile'), 'utf8').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /──\s*主线(\d+)\s+([^']*)/.exec(lines[i]);
    if (!m) continue;
    const body = [lines[i]];
    for (let j = i + 1; j < lines.length && lines[j].startsWith('\t') && !/──\s*主线\d/.test(lines[j]); j++) body.push(lines[j]);
    out.push({ n: Number(m[1]), title: m[2], cmd: body.join('\n'), selfTest: /--self-test/.test(body.join(' ')) });
  }
  return out.sort((a, b) => a.n - b.n);
}

/* ── 夹具工具（全部只读源、只写 tmp） ────────────────────────────────────── */
const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true });
function cpInto(rel, toAbs) {
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src)) throw new Error(`夹具源不存在: ${rel}`);
  fs.mkdirSync(path.dirname(toAbs), { recursive: true });
  fs.cpSync(src, toAbs, { recursive: true });
}
function writeAbs(abs, text) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}
function runIn(cwd, cmd, cmdArgs, env) {
  // spawnSync 而不是 execFileSync：jest 的 `Tests:` 汇总行写在 **stderr**，
  // execFileSync 成功时只回 stdout ⇒ 绿跑反而"没有输出"，判据被误判成不成立。
  const r = spawnSync(cmd, cmdArgs, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, env || {}), maxBuffer: 64 << 20,
  });
  return { rc: typeof r.status === 'number' ? r.status : -1, out: `${r.stdout || ''}${r.stderr || ''}`, err: r.error };
}
const firstFail = (out) => (out.split('\n').find((l) => /^(FAIL|AssertionError|Error)/.test(l.trim())) || out.trim().slice(0, 90) || '（无输出）').trim();

/** 注入 = 一组「记原文、写新内容、事后还原」的操作；不改变未被触及的文件。 */
function applyInjection(fix, spec, undo) {
  for (const [rel, text] of Object.entries(spec.files || {})) {
    const abs = path.join(fix, rel);
    undo.push(() => fs.rmSync(abs, { force: true }));
    writeAbs(abs, text);
  }
  for (const [rel, text] of Object.entries(spec.append || {})) {
    const abs = path.join(fix, rel);
    const orig = fs.readFileSync(abs, 'utf8');
    undo.push(() => fs.writeFileSync(abs, orig));
    fs.appendFileSync(abs, text);
  }
  for (const [rel, pair] of Object.entries(spec.patch || {})) {
    const abs = path.join(fix, rel);
    const orig = fs.readFileSync(abs, 'utf8');
    const next = orig.replace(pair[0], pair[1]);
    if (next === orig) throw new Error(`注入未改变输入：${rel} 里找不到 /${pair[0]}/（注入失效会伪装成"已度量"）`);
    undo.push(() => fs.writeFileSync(abs, orig));
    fs.writeFileSync(abs, next);
  }
  return undo;
}

/* ── 每条 fixture 主线的定义 ──────────────────────────────────────────────── */
const NEG_BARE = `import { Injectable } from '@nestjs/common';
import { ewohDevice } from '../../database/schema';

@Injectable()
export class NegctlService {
  constructor(private readonly db: any) {}
  listAllDevices() {
    const rows = await this.db
      .select()
      .from(ewohDevice)
      .execute();
    return rows;
  }
}
`;
const NEG_TYPED = `import { Injectable } from '@nestjs/common';
import { ewohDevice } from '../../database/schema';

@Injectable()
export class NegctlTypedService {
  constructor(private readonly db: any) {}
  listByKind(orgId: string) {
    const rows = await this.db.select().from(ewohDevice).execute();
    return rows;
  }
}
`;

const NEG_MEMBER = `import { Injectable } from '@nestjs/common';
import { schema } from '../../database/schema';

@Injectable()
export class NegctlMemberService {
  constructor(private readonly db: any) {}
  list() {
    return this.db.select().from(schema.ewohDevice).execute();
  }
}
`;
const NEG_DYNAMIC = `import { Injectable } from '@nestjs/common';
import { schema } from '../../database/schema';

@Injectable()
export class NegctlDynamicService {
  constructor(private readonly db: any) {}
  list(source: any) {
    const filters = [source.statusColumn ? undefined : undefined].filter(Boolean);
    return this.db.select().from(source.table).where(filters).execute();
  }
}
`;
const BQ = String.fromCharCode(96);   // 反引号：拼字符串避免嵌套模板字面量截断
const NEG_RAWSQL = [
  "import { Injectable } from '@nestjs/common';",
  "import { sql } from 'drizzle-orm';",
  '',
  '@Injectable()',
  'export class NegctlRawService {',
  '  constructor(private readonly db: any) {}',
  '  list() {',
  '    return this.db.execute(sql' + BQ + 'select * from ewoh_device' + BQ + ');',
  '  }',
  '}',
].join('\n') + '\n';

/* V125 主线7 事务边界三形：对照（裸调用，必须红）+ 跨函数标记 + 仅注释标记（两条已知盲区）。
   写法刻意贴合本仓风格：类方法缩进 2（判据认得的"方法定义"），helper 是模块级 export（判据认不得）。 */
const NEG_TX_BARE = `import { Injectable } from '@nestjs/common';

@Injectable()
export class NegctlBareService {
  constructor(private readonly repo: any) {}
  async bad(plan: any) {
    await this.repo.persistPlan(plan);
  }
}
`;
const NEG_TX_CROSSFN = `import { Injectable } from '@nestjs/common';

@Injectable()
export class NegctlCrossFnService {
  constructor(private readonly repo: any) {}
  async good(planId: string) {
    return this.repo.runInTransaction(async (tx: any) => tx.count(planId));
  }
}

export async function negctlHelper(repo: any, plan: any) {
  await repo.persistPlan(plan);
}
`;
const NEG_TX_COMMENT = `import { Injectable } from '@nestjs/common';

@Injectable()
export class NegctlCommentService {
  constructor(private readonly repo: any) {}
  async bad(plan: any) {
    // runInTransaction 由下游负责（本行只是注释，不是事务）
    await this.repo.persistPlan(plan);
  }
}
`;

/* V126 主线14 无事务读：三形（句柄成员名 / @Public 装饰器窗口 / 跨目录服务解析）。
   判据要点（本人读 scripts/audit-public-tx-free-reads.js:85,295,305-311）：
   方法体文本要出现 `this.db`/类型名才算"碰到句柄"；@Public 只往签名上方看 6 行；
   一跳服务按类名 kebab 在**本目录或父目录**里找文件。 */
const NEG14_HEAD = `import { Controller, Get } from '@nestjs/common';
import { Public } from '../../auth/public.decorator';
import { PostgresJsDatabase } from '../../database/schema';

`;
const NEG14_BODY = `  async ping() {
    return this.db.execute('select 1');
  }
}
`;
const NEG14_CAUGHT_DB = `${NEG14_HEAD}@Controller('negctl14-c1')
export class Negctl14C1Controller {
  constructor(private readonly db: PostgresJsDatabase) {}
  @Get()
  @Public()
${NEG14_BODY}`;
const NEG14_BLIND_HANDLE = `${NEG14_HEAD}@Controller('negctl14-s1')
export class Negctl14S1Controller {
  constructor(private readonly negctlPool: PostgresJsDatabase) {}
  @Get()
  @Public()
  async ping() {
    return this.negctlPool.execute('select 1');
  }
}
`;
// V191：显式事务标记是**豁免证据**，因此"标记只是一行注释"与"标记来自隔壁方法（旧区域拖到文件尾）"
// 都是让真位点消失的假阴性形状。收紧作用域判据后这两形必须被点名。
const NEG14_COMMENT_ONLY = `${NEG14_HEAD}@Controller('negctl14-cmt')
export class Negctl14CmtController {
  constructor(private readonly db: PostgresJsDatabase) {}
  @Get()
  @Public()
  async ping() {
    // systemTransaction 由调用方保证（本行只是注释，不是事务）
    return this.db.execute('select 1');
  }
}
`;
const NEG14_NEIGHBOR_TX = `${NEG14_HEAD}@Controller('negctl14-nb')
export class Negctl14NbController {
  constructor(private readonly db: PostgresJsDatabase) {}
  @Get()
  @Public()
  async ping() {
    return this.db.execute('select 1');
  }
}

export async function negctlUnrelated(db: PostgresJsDatabase) {
  return db.transaction(async () => 1);
}
`;
const NEG14_DECOS = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => `  @Throttle${i}({ ttl: 60 })`).join('\n') + '\n';
// V192：类级 @Public 挂在**第二个类**上（旧口径只对文件里第一个 export class 求值）
const NEG14_MULTICLASS = `${NEG14_HEAD}@Controller('negctl14-mc1')
export class Negctl14Mc1Controller {
  constructor(private readonly db: PostgresJsDatabase) {}
  @Get('safe')
  async safe() {
    return this.db.execute('select 1');
  }
}

@Controller('negctl14-mc2')
@Public()
export class Negctl14Mc2Controller {
  constructor(private readonly db: PostgresJsDatabase) {}
  @Get('open')
  async open() {
    return this.db.execute('select 1');
  }
}
`;
const NEG14_BLIND_WINDOW = `${NEG14_HEAD}@Controller('negctl14-s2')
export class Negctl14S2Controller {
  constructor(private readonly db: PostgresJsDatabase) {}
  @Get()
  @Public()
` + NEG14_DECOS + NEG14_BODY;
const NEG14_SVC = `import { Injectable } from '@nestjs/common';
import { PostgresJsDatabase } from '../../database/schema';

@Injectable()
export class Negctl14RemoteService {
  constructor(private readonly db: PostgresJsDatabase) {}
  async readRows(orgId: string) {
    return this.db.execute('select 1');
  }
}
`;
const neg14Ctrl = (tag, from) => `${NEG14_HEAD}import { Negctl14RemoteService } from '${from}';

@Controller('negctl14-${tag.toLowerCase()}')
export class Negctl14${tag}Controller {
  constructor(private readonly remote: Negctl14RemoteService) {}
  @Get()
  @Public()
  async ping() {
    return this.remote.readRows('org-x');
  }
}
`;
const NEG14_BLIND_CROSSDIR = neg14Ctrl('S3', '../shared/negctl14-remote.service');
const NEG14_CAUGHT_SVC = neg14Ctrl('S3B', './negctl14-remote.service');
// V193：跨目录解析必须**每一跳**都生效。这条把断点放在第二跳（控制器 → 同目录服务 → 别的目录的服务）：
// 只补第一跳的实现在这里会显出原形——真实语料里 `ingestMes` 正是这样被预量漏掉一次的。
const NEG14_NEAR = `import { Injectable } from '@nestjs/common';
import { Negctl14RemoteService } from '../shared/negctl14-remote.service';

@Injectable()
export class Negctl14NearService {
  constructor(private readonly remote: Negctl14RemoteService) {}
  async readRows(orgId: string) {
    return this.remote.readRows(orgId);
  }
}
`;
const NEG14_CROSSDIR_HOP2 = `${NEG14_HEAD}import { Negctl14NearService } from './negctl14-near.service';

@Controller('negctl14-s4')
export class Negctl14S4Controller {
  constructor(private readonly near: Negctl14NearService) {}
  @Get()
  @Public()
  async ping() {
    return this.near.readRows('org-x');
  }
}
`;

const GATES = [
  {
    n: 1, name: '主线1 租户隔离 org 谓词（audit-org-predicates）',
    script: 'scripts/audit-org-predicates.js',
    copy: ['ewoh-spark-app/server/database/schema.ts', 'ewoh-spark-app/server/modules'],
    inj: [
      { label: '未登记的裸 org 表查询', files: { 'ewoh-spark-app/server/modules/negctl/neg.service.ts': NEG_BARE }, needle: 'FAIL org_predicate:.*negctl' },
      { label: 'orgId 只出现在参数类型声明里（不得算租户覆盖）', files: { 'ewoh-spark-app/server/modules/negctl/typed.service.ts': NEG_TYPED }, needle: 'FAIL org_predicate:.*typed' },
      // 形状变体三条（V123）：租户隔离门禁只认 `.from(裸标识符)`／`.update(裸标识符)`，
      // 成员表达式、动态表变量、裸 SQL 三种写法实测**全部静默通过** ⇒ 记 knownGap：
      // 度量把"没抓到"如实报成 ⚠️ 而不是 ❌，等哪天门禁补上形状识别，这里会自动翻成"已能抓"。
      { label: '成员表达式表引用 .from(schema.ewohDevice)', files: { 'ewoh-spark-app/server/modules/negctl/member.service.ts': NEG_MEMBER }, needle: 'FAIL org_predicate:.*member', knownGap: true },
      { label: '动态表变量 .from(source.table)（role-workbench 的真实形状）', files: { 'ewoh-spark-app/server/modules/negctl/dynamic.service.ts': NEG_DYNAMIC }, needle: 'FAIL org_predicate:.*dynamic', knownGap: true },
      { label: '裸 SQL 直读表 execute(sql`select ... from ewoh_device`)', files: { 'ewoh-spark-app/server/modules/negctl/rawsql.service.ts': NEG_RAWSQL }, needle: 'FAIL org_predicate:.*rawsql', knownGap: true },
    ],
  },
  {
    n: 3, name: '主线3 SSRF 出站面（audit-ssrf-surface）',
    script: 'scripts/audit-ssrf-surface.js',
    copy: ['src/edge_platform/routes/inference.py', 'src/edge_platform/perception/ark_vision.py', 'ewoh-spark-app/server/modules/ai'],
    inj: [
      { label: '请求体 baseUrl 直连出站（未登记键名）', append: { 'ewoh-spark-app/server/modules/ai/ark.service.ts': '\nconst negctlTarget = body.baseUrl + "/v1/chat";\n' }, needle: 'FAIL ssrf_no_unregistered_request_key_flow' },
      { label: 'visionUnderstand 被改名（被扫对象消失必须响，不得静默绿）', patch: { 'ewoh-spark-app/server/modules/ai/ai.controller.ts': [/async\s+visionUnderstand\s*\(/, 'async negctlRenamed('] }, needle: 'FAIL ssrf_vision_proxy_found' },
      { label: 'visionUnderstand 转发体里出现凭据键', patch: { 'ewoh-spark-app/server/modules/ai/ai.controller.ts': [/(async\s+visionUnderstand\([\s\S]*?\)\s*\{\n)/, '$1    const negctl = { api_key: body.api_key };\n'] }, needle: 'FAIL ssrf_vision_proxy_forwards_no_credentials' },
      // V124 形状变体：上面两条会红的注入用的是 `baseUrl`/`api_key` 这两个**写死的键名**。
      // 换成同义但不同拼写的出站地址键，门禁是否还看得见？（判据只匹配 base_url|api_key|baseUrl|apiKey，
      // 且大小写敏感 ⇒ 预期静默通过，登记为 GATE-15 而不是"已覆盖"）
      { label: '出站地址键名换成同义词 endpoint（语义等价、名字不在匹配表里）', append: { 'ewoh-spark-app/server/modules/ai/ark.service.ts': '\nconst negctlEndpoint = String(body.endpoint);\nawait fetch(negctlEndpoint + "/v1/chat", { method: "POST" });\n' }, needle: 'FAIL ssrf_no_unregistered_request_key_flow', knownGap: true, finding: 'GATE-15/主线3' },
      { label: '同一键名换大小写 BASE_URL（匹配式无 i 标志）', append: { 'ewoh-spark-app/server/modules/ai/ark.service.ts': '\nconst negctlCase = String(body.BASE_URL) + "/v1/chat";\nawait fetch(negctlCase);\n' }, needle: 'FAIL ssrf_no_unregistered_request_key_flow', knownGap: true, finding: 'GATE-15/主线3' },
    ],
  },
  {
    n: 4, name: '主线4 前端凭据/href sink（audit-client-security-sinks）',
    script: 'scripts/audit-client-security-sinks.js', copy: ['ewoh-spark-app/client/src'],
    inj: [
      { label: '凭据写入 Web Storage', files: { 'ewoh-spark-app/client/src/pages/Negctl/neg.tsx': 'export const s = (t: string) => localStorage.setItem("access_token", t);\n' }, needle: 'FAIL client_no_credential_in_web_storage' },
      { label: '未净化的动态 href sink', files: { 'ewoh-spark-app/client/src/pages/Negctl/href.tsx': 'export const A = ({ row }: any) => <a href={row.url}>x</a>;\n' }, needle: 'FAIL client_href_sinks_sanitized' },
      // V124 形状变体（GATE-15）：上面两条用的是字面 `localStorage.setItem` 与 JSX `href={...}`。
      // 语义等价但形状不同：存储句柄被别名/包装、导航 sink 不在 JSX 里。
      { label: '凭据写进**别名化**的 storage 句柄（store.setItem 而非 localStorage.setItem）', files: { 'ewoh-spark-app/client/src/pages/Negctl/alias.tsx': 'const store = sessionStorageSafe();\nexport const w = (t: string) => { store.setItem("access_token", t); };\n' }, needle: 'FAIL client_no_credential_in_web_storage', knownGap: true, finding: 'GATE-15/主线4' },
      { label: '非 JSX 的导航 sink window.location.assign(用户输入)', files: { 'ewoh-spark-app/client/src/pages/Negctl/nav.tsx': 'export const go = (u: string) => { window.location.assign(u); };\n' }, needle: 'FAIL client_href_sinks_sanitized', knownGap: true, finding: 'GATE-15/主线4' },
    ],
    small: { label: '扫描面健全性：只放 2 个文件不得空转判绿', mkdirs: [], files: { 'ewoh-spark-app/client/src/a.tsx': 'export const A = 1;\n', 'ewoh-spark-app/client/src/b.tsx': 'export const B = 2;\n' }, needle: 'FAIL client_scan_surface_sane' },
  },
  {
    n: 5, name: '主线5 迁移链全新安装可装性（静态先建后改）',
    shell: 'scripts/migration-fresh-install-check.sh', copy: ['db/migrations'],
    inj: [
      { label: 'ALTER 的目标表在任何更早文件里都没有 CREATE', files: { 'db/migrations/standalone_999999_negctl.sql': 'ALTER TABLE negctl_missing_table ADD COLUMN c text;\n' }, needle: 'FAIL migration_static_order' },
    ],
    small: { label: '空迁移目录（无证据不得判绿）', mkdirs: ['db/migrations'], files: {}, needle: '未找到迁移文件' },
  },
  {
    n: 7, name: '主线7 调度事务边界（audit-scheduler-transactions）',
    script: 'scripts/audit-scheduler-transactions.js',
    // V191：门禁的作用域判据抽到共用件 ⇒ 夹具必须一起搬，否则 require 不到（这条是夹具自己报出来的）
    copy: ['ewoh-spark-app/server/modules/scheduler', 'scripts/tx-scope-shared.js'],
    inj: [
      // 对照（必须红）：证明"这条调用点判据会响"，而不是夹具空转。
      { label: '类方法里的裸 persistPlan 调用点（无任何标记）', files: { 'ewoh-spark-app/server/modules/scheduler/negctl-bare.service.ts': NEG_TX_BARE }, needle: 'FAIL persistplan_callsites_transactional' },
      // V125 记下的两处形状盲区（GATE-16：标记来自**另一个函数**的区域塌陷、标记**只是一行注释**）
      // 在 V190 收紧作用域判据后已能抓到 ⇒ 摘掉 knownGap，升为常规"必须红"对照。
      { label: '事务标记来自同文件另一个函数（模块级 helper 的调用点被跨函数清掉）', files: { 'ewoh-spark-app/server/modules/scheduler/negctl-crossfn.service.ts': NEG_TX_CROSSFN }, needle: 'FAIL persistplan_callsites_transactional' },
      { label: '同方法内只有一行 // runInTransaction 注释（文本判据不剥注释）', files: { 'ewoh-spark-app/server/modules/scheduler/negctl-comment.service.ts': NEG_TX_COMMENT }, needle: 'FAIL persistplan_callsites_transactional' },
    ],
  },
  {
    n: 14, name: '主线14 身份前/守卫阶段无事务读（audit-public-tx-free-reads）',
    script: 'scripts/audit-public-tx-free-reads.js',
    copy: ['ewoh-spark-app/server', 'scripts/tx-scope-shared.js'],
    inj: [
      // 三条"形状只差一点"的对照：认得的写法必须点名我们的文件（否则夹具是空转）。
      { label: '@Public 处理器经 this.db 读（认得的形状 ⇒ 必须点名）', files: { 'ewoh-spark-app/server/modules/negctl14/c1.controller.ts': NEG14_CAUGHT_DB }, needle: 'c1\\.controller\\.ts' },
      { label: '@Public 一跳到的服务与本控制器同目录（认得的解析形状 ⇒ 必须点名）', files: { 'ewoh-spark-app/server/modules/negctl14/s3b.controller.ts': NEG14_CAUGHT_SVC, 'ewoh-spark-app/server/modules/negctl14/negctl14-remote.service.ts': NEG14_SVC }, needle: 's3b\\.controller\\.ts' },
      // V126 立规时的三条形状盲区（GATE-17）：句柄换成员名 / @Public 距签名 >6 行 / 服务在别的模块目录。
      // V192 收第二条，V193 收第一、三条并补第二跳 ⇒ 三条全部转为必须红，GATE-17 闭合。
      { label: '@Public 读库只靠一行注释当显式事务证据（V191 剥注释后必须点名）', files: { 'ewoh-spark-app/server/modules/negctl14/cmt.controller.ts': NEG14_COMMENT_ONLY }, needle: 'cmt\\.controller\\.ts' },
      { label: '@Public 读库的事务标记来自隔壁方法（V191 花括号作用域后必须点名）', files: { 'ewoh-spark-app/server/modules/negctl14/nb.controller.ts': NEG14_NEIGHBOR_TX }, needle: 'nb\\.controller\\.ts' },
      { label: '数据库句柄换了成员名（this.negctlPool 而非 this.db，V193 bindings 档必须点名）', files: { 'ewoh-spark-app/server/modules/negctl14/s1.controller.ts': NEG14_BLIND_HANDLE }, needle: 's1\\.controller\\.ts' },
      // V192 起这两形已能被点名（装饰器块按结构收集 + 类级归属按成员所属类）⇒ 摘掉 knownGap
      { label: '@Public() 之后还压 8 行装饰器（旧口径掉出签名上方 6 行窗口）', files: { 'ewoh-spark-app/server/modules/negctl14/s2.controller.ts': NEG14_BLIND_WINDOW }, needle: 's2\\.controller\\.ts' },
      { label: '类级 @Public 挂在文件里的第二个类上（旧口径只对第一个类求值）', files: { 'ewoh-spark-app/server/modules/negctl14/mc.controller.ts': NEG14_MULTICLASS }, needle: 'mc\\.controller\\.ts' },
      { label: '@Public 一跳的服务在别的模块目录（V193 按类名声明处解析后必须点名）', files: { 'ewoh-spark-app/server/modules/negctl14/s3.controller.ts': NEG14_BLIND_CROSSDIR, 'ewoh-spark-app/server/modules/shared/negctl14-remote.service.ts': NEG14_SVC }, needle: 's3\\.controller\\.ts' },
      { label: '@Public 两跳才跨到别的模块目录（第二跳也要按声明处解析，V193）', files: { 'ewoh-spark-app/server/modules/negctl14/s4.controller.ts': NEG14_CROSSDIR_HOP2, 'ewoh-spark-app/server/modules/negctl14/negctl14-near.service.ts': NEG14_NEAR, 'ewoh-spark-app/server/modules/shared/negctl14-remote.service.ts': NEG14_SVC }, needle: 's4\\.controller\\.ts' },
    ],
  },
  {
    n: 10, name: '主线10 演示/伪造残留（audit-demo-residue）',
    script: 'scripts/audit-demo-residue.js', copy: ['ewoh-spark-app/client/src', 'src/edge_platform/static'],
    inj: [
      { label: '未登记的「演示」字样', files: { 'ewoh-spark-app/client/src/negctl.tsx': 'export const L = "演示";\n' }, needle: 'FAIL demo_residue:演示' },
      { label: '未登记的 Math.random 伪造源', files: { 'ewoh-spark-app/client/src/negrnd.tsx': 'export const v = Math.random();\n' }, needle: 'FAIL demo_residue:math_random' },
      // V124 形状变体（GATE-15）：匹配式是逐行字面量 ⇒ 换别名/换拼写即隐身；
      // 而这三条模式（AG-00 / execCommand / admin123）的登记表是**空的正例空间**（`{}`），
      // 一旦语料换成下面的写法，两个方向都"零命中且通过"——与 GATE-14 同一族"静默零"。
      { label: '伪造 ID 去掉连字符（AG-00 → AG001）', files: { 'ewoh-spark-app/client/src/negag.tsx': 'export const id = "AG001";\n' }, needle: 'FAIL demo_residue:AG_00', knownGap: true, finding: 'GATE-15/主线10' },
      { label: 'Math.random 换成方属性写法 Math["random"]()', files: { 'ewoh-spark-app/client/src/negbrk.tsx': 'export const v = Math["random"]();\n' }, needle: 'FAIL demo_residue:math_random', knownGap: true, finding: 'GATE-15/主线10' },
    ],
    small: { label: '扫描面健全性：只放 1 个文件不得空转判绿', mkdirs: ['src/edge_platform/static'], files: { 'ewoh-spark-app/client/src/a.tsx': 'export const A = 1;\n' }, needle: 'FAIL demo_scan_surface_sane' },
  },
  {
    n: 12, name: '主线12 含 org_id 未开 RLS 的裁决面（audit-unrls-tenant-tables）',
    script: 'scripts/audit-unrls-tenant-tables.js', copy: ['db/migrations', 'db/contracts/schema-manifest.yaml'],
    inj: [
      { label: '新增含 org_id、不开 RLS 也不登记的表', files: { 'db/migrations/standalone_999998_negctl.sql': 'CREATE TABLE negctl_unrls (id text primary key, org_id text not null);\n' }, needle: 'FAIL unrls_org_tables_all_decided' },
      { label: '裁决清单里的表被补了 RLS（僵尸登记必须响）', needle: 'FAIL unrls_allowlist_no_stale',
        // 受害者从干净对照自己打印的「未开 RLS 表」清单里取，不写死表名：
        // 写死的话清单一变（补 RLS/改名/删除），这条注入就静默失效（V98 R1、V102 R6 同族教训）。
        dynamic: (cleanOut) => {
          const m = /·\s+([a-z0-9_]+)（org_id，RLS off）→\s+\S/.exec(cleanOut);
          if (!m) throw new Error('干净对照未打印未开 RLS 表清单，无法派生受害者');
          return { files: { 'db/migrations/standalone_999997_victim.sql': `ALTER TABLE ${m[1]} ENABLE ROW LEVEL SECURITY;\n` } };
        } },
      // V124 形状变体（GATE-15）：CREATE 的匹配式要求"表名后紧跟括号列清单"，
      // 而 CREATE TABLE ... AS SELECT 同样会造出一张带 org_id 的表，只是没有列清单可解析。
      { label: 'CTAS 造出没列清单、含 org_id、未开 RLS 也未登记的表', files: { 'db/migrations/standalone_999996_negctl_ctas.sql': 'CREATE TABLE negctl_ctas AS SELECT id, org_id FROM ewoh_organization;\n' }, needle: 'FAIL unrls_org_tables_all_decided', knownGap: true, finding: 'GATE-15/主线12' },
    ],
  },
];

/* in-file：负向控制本来就在门禁里面，这里只跑到并确认它执行了 */
const IN_FILE = [
  { n: 16, name: '主线16 边缘测试进程隔离守卫（TEST-01）', why: '同文件自带反向控制用例，把探针挪进合成源码证明能变红', cmd: ['python3', ['-m', 'pytest', 'src/edge_platform/tests/test_run_main_process_isolation.py', '-k', 'negative_control_can_go_red', '-q']], env: { PYTHONPATH: 'src' }, needle: '1 passed' },
  { n: 6, name: '主线6 gate-scripts 合成向量自测 spec', why: '主线本体就是 canonical ID 正则向量 + truth-manifest 缺 baseline 的反向控制', cmd: ['npx', ['jest', '--silent', 'test/unit/scripts/gate-scripts.selftest.spec.ts']], cwd: 'ewoh-spark-app', needle: 'Tests:' },
  { n: 11, name: '主线11 软底徽标对比度数值模型', why: '模型含低于 WCAG 阈值的反例，判据是不等式而非清单比对', cmd: ['npx', ['jest', '--config', 'client/jest.config.cjs', '--runInBand', 'src/lib/softSurfaceContrast.test.ts']], cwd: 'ewoh-spark-app', needle: 'Tests:' },
];

/* probe：夹具跑不动的主线，只量现状并把缺口登记为限制 */
const PROBE = [
  {
    n: 13, name: '主线13 世界快照契约（需真实库）',
    cmd: ['node', ['scripts/audit-world-snapshot-contract.js']], env: { EWOH_DATABASE_URL: '', EWOH_PG_URL: '' },
    // 形状实测：无库时 SKIP→exit 0；本轮又实测出 CI 侧确实每次都走这条支路
    // （long-cycle-gates.yml 唯一的调用方无 Postgres service），故登记为 GATE-03。
    verdict: (r) => (r.rc === 0 && /SKIP/.test(r.out)
      ? { finding: 'GATE-03', note: '无库时打印 SKIP 且 exit 0 ⇒ 门禁在 CI 里与真绿不可分辨（把 SKIP 记成 PASS，违反本试点常设约束）；零快照时同样走 PASS 分支（无证据判绿，同 V110 的 0 passed 形状）。修法需要么给 long-cycle-gates.yml 加 Postgres service、要么让它非零退出——两处都是他人/共享面，待裁决' }
      : { ok: true, note: `rc=${r.rc}（不是 SKIP→0 的形状）` }),
  },
  {
    n: 2, name: '主线2 边缘 GET 面鉴权矩阵（真实进程 + 临时库）',
    cmd: ['python3', ['-m', 'pytest', 'src/edge_platform/tests/test_get_route_auth_matrix.py', '--collect-only', '-q']], env: { PYTHONPATH: 'src' },
    verdict: (r) => { const m = /(\d+) tests? collected/.exec(r.out); return { ok: true, collected: m ? Number(m[1]) : null, note: `用例存量 ${m ? m[1] : '?'} 条；夹具注入要起边缘服务进程（与主线16 的进程隔离守卫相冲），故本轮登记为未覆盖` }; },
  },
  {
    n: 8, name: '主线8 TS↔Python 契约 parity（跨语言真实导入）',
    cmd: ['python3', ['-m', 'pytest', 'tests/test_ts_python_contract_parity.py', '--collect-only', '-q']], env: { PYTHONPATH: 'src' },
    verdict: (r) => { const m = /(\d+) tests? collected/.exec(r.out); return { ok: true, collected: m ? Number(m[1]) : null, note: `用例存量 ${m ? m[1] : '?'} 条；注入需改共享契约文件（产品面），试点范围内不改` }; },
  },
];

/* ── fixture 执行器 ───────────────────────────────────────────────────────── */
function runGate(fix, g) {
  return g.shell ? runIn(fix, 'bash', [g.shell]) : runIn(fix, 'node', [g.script]);
}

function buildFixture(g, { minimal = false } = {}) {
  const fix = path.join(FIXROOT, `g${g.n}`);
  rmrf(fix);
  fs.mkdirSync(path.join(fix, path.dirname(g.shell || g.script)), { recursive: true });
  if (g.synthetic) writeAbs(path.join(fix, g.script), g.synthetic);   // 元反证用的合成门禁，仓库里没有
  else cpInto(g.shell || g.script, path.join(fix, g.shell || g.script));
  if (!minimal) for (const rel of g.copy) cpInto(rel, path.join(fix, rel));
  return fix;
}

function fixtureGate(g) {
  const rows = [];
  let unusable = false;

  const fix = buildFixture(g);
  const clean = runGate(fix, g);
  rows.push({ step: '干净对照（未注入的同份真实语料）', ok: clean.rc === 0, note: clean.rc === 0 ? '绿 ⇒ 夹具成立' : `夹具本身不红/不绿不成立 ⇒ 本主线注入结论作废：${firstFail(clean.out)}` });
  unusable = clean.rc !== 0;

  if (!unusable) {
    for (const spec0 of g.inj) {
      let spec = spec0;
      let undo = [];
      try {
        if (spec0.dynamic) spec = Object.assign({}, spec0, spec0.dynamic(clean.out));
        undo = applyInjection(fix, spec, undo);
      } catch (e) {
        for (const fn of undo.reverse()) fn();
        rows.push({ step: `注入「${spec.label}」`, ok: false, note: `注入未成立：${e.message}` });
        continue;
      }
      const r = runGate(fix, g);
      const hit = new RegExp(spec.needle).test(r.out);
      if (spec.knownGap) {
        const caught = hit && r.rc !== 0;
        if (!caught) findingsGate.push(`${g.n}:${spec.label}`);
        rows.push({
          step: `注入「${spec.label}」（已知形状盲区）`,
          finding: spec.finding || `GATE-13/主线${g.n}`,
          ok: true,
          note: caught
            ? `已被抓到 ⇒ 盲区已修，可把 knownGap 摘掉（不再算 ⚠️）`
            : `实测静默通过（rc=${r.rc}）⇒ 该形状门禁看不见，已登记为开放项而非"已覆盖"`,
        });
      } else
      rows.push({
        step: `注入「${spec.label}」`,
        ok: r.rc !== 0 && hit,
        note: r.rc === 0 ? '注入后仍绿 ⇒ 该判据不会响（真缺口）'
          : hit ? `红（rc=${r.rc}）并报出 /${spec.needle}/`
            : `红（rc=${r.rc}）但没报出预期判据 ${spec.needle}，实际首条：${firstFail(r.out)}`,
      });
      for (const fn of undo.reverse()) fn();
    }
    const reverted = runGate(fix, g);
    rows.push({ step: '撤销全部注入后复跑', ok: reverted.rc === 0, note: reverted.rc === 0 ? '回绿 ⇒ 注入确实改变了输入' : `未回绿：${firstFail(reverted.out)}` });
  }

  if (g.small) {
    const sfix = buildFixture(g, { minimal: true });
    for (const d of g.small.mkdirs || []) fs.mkdirSync(path.join(sfix, d), { recursive: true });
    for (const [rel, text] of Object.entries(g.small.files)) writeAbs(path.join(sfix, rel), text);
    const r = runGate(sfix, g);
    const hit = new RegExp(g.small.needle).test(r.out);
    rows.push({ step: g.small.label, ok: r.rc !== 0 && hit, note: hit ? `红（rc=${r.rc}）并报出 /${g.small.needle}/` : `rc=${r.rc}，未报出超小语料判据：${firstFail(r.out)}` });
  }
  rmrf(path.join(FIXROOT, `g${g.n}`));
  return { rows, unusable };
}

function genericEntry(e) {
  const cwd = e.cwd ? path.join(ROOT, e.cwd) : ROOT;
  const r = runIn(cwd, e.cmd[0], e.cmd[1], e.env);
  if (e.verdict) {
    const v = e.verdict(r);
    const finding = Boolean(v.finding);
    return { rows: [{ step: `现状度量（探针）${finding ? ` ⇒ 抓到门禁自身缺陷 ${v.finding}` : ''}`, ok: finding ? true : Boolean(v.ok), note: v.note, finding }], probe: true };
  }
  const hit = new RegExp(e.needle).test(r.out);
  return { rows: [{ step: '内置反向控制跑到并执行', ok: r.rc === 0 && hit, note: `${e.why}；rc=${r.rc}，输出含 /${e.needle}/ = ${hit}${r.rc === 0 && hit ? '' : '｜' + firstFail(r.out)}` }] };
}

/* 夹具里放的是"故意有缺陷"的副本（凭据入 storage、裸 org 查询、演示字样），
   异常退出也必须清掉，否则 tmp/ 里留着会误导后续任何全仓扫描。 */
process.on('exit', () => { if (!KEEP) rmrf(FIXROOT); });

if (ARGS.includes('--self-check')) selfCheck();   // 必须在所有 const 定义之后调用（TDZ）

/* ── 主流程 ───────────────────────────────────────────────────────────────── */
const mainlines = parseMainlines();
const results = [];
const wanted = (n) => !ONLY.length || ONLY.includes(n);
for (const g of GATES) if (wanted(g.n)) results.push({ n: g.n, name: g.name, ...fixtureGate(g) });
for (const e of IN_FILE) if (wanted(e.n)) results.push({ n: e.n, name: e.name, ...genericEntry(e) });
for (const e of PROBE) if (wanted(e.n)) results.push({ n: e.n, name: e.name, ...genericEntry(e) });

let okGates = 0, badGates = 0, probes = 0, injTotal = 0, injCaught = 0, unusable = 0, findings = 0;
for (const r of results.sort((a, b) => a.n - b.n)) {
  const bad = r.rows.filter((x) => !x.ok);
  if (r.probe) probes += 1; else if (r.unusable) unusable += 1; else if (bad.length === 0) okGates += 1; else badGates += 1;
  findings += r.rows.filter((x) => x.finding).length;
  const inj = r.rows.filter((x) => x.step.startsWith('注入') && !/已知形状盲区/.test(x.step));
  injTotal += inj.length; injCaught += inj.filter((x) => x.ok).length;
  console.log(`\n── 主线${r.n} ${r.name.replace(/^主线\d+\s*/, '')}${r.probe ? '｜登记为限制（未做负向控制）' : bad.length === 0 ? '｜负向控制成立' : '｜负向控制不成立'}`);
  for (const x of r.rows) console.log(`   ${x.finding ? '⚠️' : x.ok ? '✅' : '❌'} ${x.step} → ${x.note}`);
}

const selfTested = mainlines.filter((m) => m.selfTest).map((m) => m.n);
const covered = new Set([...GATES.map((g) => g.n), ...IN_FILE.map((e) => e.n), ...PROBE.map((p) => p.n)]);
const SELF_N = 22;
const residual = mainlines.filter((m) => !m.selfTest && !covered.has(m.n) && m.n !== SELF_N).map((m) => m.n);
console.log('\n────────────────────────────────────────────');
console.log(`主线总数（Makefile 现抽）= ${mainlines.length}｜命令自带 --self-test = ${selfTested.length} 条（${selfTested.join(',')}）`);
console.log(`本轮外置/内置负向控制成立 = ${okGates} 条｜不成立 = ${badGates} 条｜夹具不成立 = ${unusable} 条｜登记为限制（需真实进程/DB/产品面）= ${probes} 条`);
console.log(`⚠️ 开放项（形状盲区探针与无证据判绿形状）= ${findings} 处：已进登记册等待裁决，既不算本门禁失败、也不算「已覆盖」`);
console.log(`注入 ${injTotal} 次，抓到 ${injCaught} 次（未抓到的逐条列在上面，不折算成"已覆盖"）`);
console.log(`形状盲区探针（记为 ⚠️ 开放项，不算抓到也不算漏网）= ${findingsGate.length} 条：${findingsGate.join(' | ')}`);
const metaCount = mainlines.some((m) => m.n === SELF_N) ? 1 : 0;
// 一条主线可以"既有自带 --self-test 又做了形状注入"（V125 主线7 就是这个形状）：
// 它只能计一次，否则账面会凭空多出一条。重叠条数显式打印，不靠读者发现。
const overlap = GATES.filter((g) => selfTested.includes(g.n)).map((g) => g.n);
const closure = selfTested.length + okGates + badGates + probes + metaCount - overlap.length;
console.log(`既自带 --self-test 又纳入本轮注入（只计一次）= ${overlap.length ? overlap.join(',') : '（无）'}`);
console.log(`本度量自身（主线 ${SELF_N}）由 --self-check 元反证承担 = ${metaCount} 条`);
const partial = ONLY.length ? `（--only 子集运行，账面只对全集成立 ⇒ 不作判定）` : '';
console.log(`${(closure === mainlines.length && badGates === 0) || ONLY.length ? '✅' : '❌'} 账面闭合：${mainlines.length} = 自带 --self-test ${selfTested.length} + 本轮反证成立 ${okGates} + 登记为限制 ${probes} + 本度量自身 ${metaCount}${badGates ? ` + 不成立 ${badGates}` : ''}${overlap.length ? ` − 重叠 ${overlap.length}（主线${overlap.join(',')} 既有自测又做了注入，只计一次）` : ''}（无第三态、无未归类）${partial}`);
console.log(`既无 --self-test 也未纳入本轮 = ${residual.length ? residual.join(',') : '（无）'}`);
rmrf(FIXROOT);
process.exit(badGates ? 1 : unusable ? 3 : 0);
