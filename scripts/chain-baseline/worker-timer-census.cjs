#!/usr/bin/env node
/**
 * 一问：服务端每个 `setInterval` 站点的**清场代码写在哪个成员上**，那个成员是框架真会调用的钩子吗？
 *
 * 为什么只问这一个：`worker-shutdown-probe.cjs` 已经量出——`app.close()` 会调用 5 个真钩子，
 * 而没调 `enableShutdownHooks()` 时 SIGTERM 一个收尾钩子都不调用（全仓 `enableShutdownHooks` 0 处）。
 * 于是"有没有 clearInterval"这个问题被拆成两问，本量具只答第一问（名字对不对），
 * 第二问（停止路径通不通）由那条探针答，两问的读数不合并。
 *
 * 判据（棘轮：只许缩小，不许变大）：
 *   R1 死钩子清理：clearInterval 写在**不在权威名单里**的成员上（如 `onApplicationDestroy`）⇒ 任何路径都不会执行；
 *   R2 无清理：站点存了句柄却找不到任何 clearInterval；
 *   R3 非法间隔无守卫：间隔来自 env 且该文件没有 `Number.isFinite`/显式解析守卫
 *      （Node 把 `setInterval(fn, NaN)` 当 1ms，实测 120ms 窗口 96 次，见探针 D 案）。
 * 禁用开关的**词形**（`='1'` vs `='true'`）只打印不判——统一哪一个属口径，不由量具代断。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const SERVER = path.join(ROOT, 'ewoh-spark-app/server');
const PROBE = path.join(__dirname, 'worker-shutdown-probe.cjs');

/** 权威钩子名单：复用同一条探针导出的解析（不再抄第二份名单，避免两处漂移）。 */
function authorityHooks() {
  const { readAuthorityHooks } = require(PROBE);
  return readAuthorityHooks().names;
}

/** 语料：server 下全部非 spec 的 .ts（自己走目录，不起 shell）。 */
function scanFiles(dir = SERVER) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      out.push(...scanFiles(full));
    } else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out.sort();
}

/** 类成员行范围（顶层缩进 2 空格的方法名），用于把 clearInterval 归到"写在哪个成员上"。 */
function members(lines) {
  const starts = [];
  lines.forEach((l, i) => {
    const m = /^ {2}(?:private |public |protected |async |\* )*(?:get |set )?([A-Za-z_][A-Za-z0-9_]*)\s*(?:\([^)]*\)|\(\))\s*[:{]/.exec(l);
    if (m) starts.push({ name: m[1], line: i });
  });
  return starts.map((s, i) => ({ name: s.name, from: s.line, to: i + 1 < starts.length ? starts[i + 1].line : lines.length }));
}

function ownerOf(members_, lineIdx) {
  const hit = members_.filter((m) => lineIdx >= m.from && lineIdx < m.to);
  return hit.length ? hit[hit.length - 1].name : null;
}

/**
 * 从真钩子出发，沿 `this.某方法()` 做闭包（深度上限 3）。
 * 不做这一跳就会把 `stop()` / `clearIntervals()` 这类"钩子调用的普通收尾方法"误判成死代码——
 * 与量具纪律里的"执行器要做闭包"同一条教训。
 */
function reachableMembers(lines, mems, authority) {
  const calledBy = new Map();
  lines.forEach((l, i) => {
    const owner = ownerOf(mems, i);
    for (const m of l.matchAll(/this\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
      if (!owner || m[1] === owner) continue;
      if (!calledBy.has(m[1])) calledBy.set(m[1], new Set());
      calledBy.get(m[1]).add(owner);
    }
  });
  const reach = new Set(authority);
  for (let depth = 0; depth < 3; depth += 1) {
    const add = [];
    for (const [name, callers] of calledBy) {
      if (!reach.has(name) && [...callers].some((c) => reach.has(c))) add.push(name);
    }
    if (!add.length) break;
    add.forEach((n) => reach.add(n));
  }
  return reach;
}

/** 纯函数（可被 --self-test 直接喂语料）：从 (文件 → 行) 归纳站点清单与三条判据。 */
function analyzeFromText(entries, authority) {
  const sites = [];
  for (const [rel, lines] of entries) {
    const timerLines = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => /setInterval\(/.test(l) && !/^\s*(\*|\/\/)/.test(l));
    if (!timerLines.length) continue;
    const mem = members(lines);
    const reach = reachableMembers(lines, mem, authority);
    const clears = [];
    lines.forEach((l, i) => {
      if (!/clearInterval\(/.test(l) || /^\s*(\*|\/\/)/.test(l)) return;
      clears.push({ owner: ownerOf(mem, i), line: i + 1 });
    });
    const stored = lines.some((l) => /this\.(?:\w*[tT]imer\w*|\w*[iI]nterval\w*)\s*=\s*setInterval\(/.test(l));
    const envVar = (lines.find((l) => /_WORKER_DISABLED\b/.exec(l)) || '').match(/([A-Z0-9_]+_WORKER_DISABLED)/);
    // 判据读"表达式"而不是"行"：workbench 的比较跨三行，按行匹配会把它误标成"其他写法"。
    const code = lines.filter((l) => !/^\s*(\*|\/\/)/.test(l)).join(' ').replace(/\s+/g, ' ');
    const disabledForm = (() => {
      if (!/_WORKER_DISABLED/.test(code)) return '无禁用开关';
      if (/===\s*'1'/.test(code)) return "==='1'";
      if (/===\s*'true'/.test(code)) return "==='true'（大小写不敏感）";
      return '其他写法';
    })();
    /**
     * 判据必须落在**调用点**，不能落在"这个文件里出现过 isFinite"。
     * V147 变异对照抓到的假绿：把 `onModuleInit` 的守卫退回裸 `Number(env)` 后，文件里
     * 仍留着（没人调的）`overdueIntervalMs` 函数体 containing isFinite ⇒ 文件级判据照绿。
     * 现在：取 setInterval 的间隔实参；若它是同一成员里由裸 `Number(env)` 赋来的局部变量，
     * 且**该成员体内**没有 isFinite ⇒ 判"无守卫"。实参是具名解析函数调用的，算有守卫
     * （投递积压 worker 把守卫写在文件内 helper 里，正是这一形）。
     */
    const intervalFromEnv = /setInterval\(/.test(code) && /_INTERVAL_MS/.test(code);
    let hasFiniteGuard = true;
    for (const { l, i } of timerLines) {
      const arg = (l.slice(l.indexOf('setInterval(')).match(/,\s*([A-Za-z0-9_.$]+)\s*\)/) || [])[1];
      if (!arg) continue;                       // 字面量/表达式实参：不在本判据的问题域内
      const member = mem.find((m) => i >= m.from && i < m.to);
      const body = member ? lines.slice(member.from, member.to).join('\n') : lines.join('\n');
      const assigned = new RegExp(`(?:const|let)\\s+${arg}\\s*=\\s*Number\\(`).test(body);
      const fromHelperCall = new RegExp(`(?:const|let)\\s+${arg}\\s*=\\s*[A-Za-z0-9_]*[iI]nterval[A-Za-z0-9_]*\\s*\\(`).test(body);
      if (assigned && !fromHelperCall && !/Number\.isFinite/.test(body)) hasFiniteGuard = false;
    }
    const deadClears = clears.filter((c) => c.owner && !reach.has(c.owner));
    const liveClears = clears.filter((c) => c.owner && reach.has(c.owner));
    sites.push({
      rel,
      timers: timerLines.length,
      stored,
      clears,
      deadClears: [...new Set(deadClears.map((c) => c.owner))],
      liveClears: liveClears.length,
      disabledVar: envVar ? envVar[1] : null,
      disabledForm,
      intervalFromEnv,
      hasFiniteGuard,
      reentrancy: /\b(this\.)?(running|ticking)\b/.test(lines.join('\n')),
      tickCatch: lines.some((l) => /catch\s*\(/.test(l)),
    });
  }
  return sites;
}

function judge(sites, authority, baseline) {
  const problems = [];
  const dead = sites.filter((s) => s.deadClears.length).map((s) => `${s.rel} → ${s.deadClears.join(',')}`);
  const noClear = sites.filter((s) => s.stored && !s.clears.length).map((s) => s.rel);
  const noGuard = sites.filter((s) => s.intervalFromEnv && !s.hasFiniteGuard).map((s) => s.rel);
  // R3 **实测并拒绝当判据**（V147）：夹具 S4c 证明调用点版判据在自己的语料上开火不稳定
  // （同一份行数据经不同入口得到相反读数）——量具不能自证的绿灯不是证据，故只作观察打印。
  const grow = (name, list, base) => {
    const extra = list.filter((x) => !base.includes(x));
    if (extra.length) problems.push(`${name} 变多（棘轮只许缩小）：${extra.join(' ; ')}`);
  };
  grow('R1 死钩子清理', dead, baseline.dead);
  grow('R2 存了句柄却无清理', noClear, baseline.noClear);
  if (!sites.length) problems.push('站点清单为空 ⇒ 扫描没吃到语料，本轮不出数');
  if (authority.length < 5) problems.push(`权威钩子名单只 ${authority.length} 个，分母不成立`);
  const stale = (name, list, base) => {
    const gone = base.filter((x) => !list.includes(x));
    if (gone.length) console.log(`  · ${name} 基线里的 ${gone.length} 项已不在观测中（应收窄基线）：${gone.join(' ; ')}`);
  };
  stale('R1', dead, baseline.dead);
  stale('R2', noClear, baseline.noClear);
  return {
    ok: problems.length === 0,
    problems,
    dead,
    noClear,
    noGuard,
    forms: [...new Set(sites.map((s) => `${s.disabledVar || '-'}=${s.disabledForm}`))].sort(),
  };
}

/**
 * 现状基线（V147 实测登记）：死钩子 1 处、无清理 0 处、env 间隔无守卫 0 处——**只许缩小**。
 * noGuard 当期已空：`improvement-action-overdue.worker.ts` 的裸 `Number(env)` 在 V147 补成
 * `overdueIntervalMs`（同族 `backlogIntervalMs` 的既有纪律），常驻单测 4 例 + 变异对照已钉。
 * dead 仍是 1：`workbench-export.worker.ts#onApplicationDestroy` 不是 Nest 钩子，
 * 该行 clearInterval 任何路径都到不了；该文件当前有他人未提交改动 ⇒ 只登记不代改。
 */
const BASELINE = {
  dead: ['ewoh-spark-app/server/modules/operations/workbench-export.worker.ts → onApplicationDestroy'],
  noClear: [],
  noGuard: [],
};

function print(sites, verdict, authority) {
  console.log(`权威钩子名单（${authority.length} 个，解析自 @nestjs/core）：${authority.join(', ')}`);
  console.log(`原始观测（${sites.length} 个文件 / ${sites.reduce((n, s) => n + s.timers, 0)} 个 setInterval 站点）：`);
  for (const s of sites) {
    console.log(
      `  ${s.rel}  站点=${s.timers} 句柄存字段=${s.stored} 清理=${s.clears.length}`
      + `（真钩子 ${s.liveClears}，死钩子 ${s.deadClears.length ? s.deadClears.join('/') : '-'}）`
      + ` 禁用=${s.disabledVar || '-'}[${s.disabledForm}] env 间隔=${s.intervalFromEnv ? '有' : '无'}`
      + ` 非法值守卫=${s.hasFiniteGuard ? '有' : '无'} 重入守卫=${s.reentrancy ? '有' : '无'} tick try/catch=${s.tickCatch ? '有' : '无'}`,
    );
  }
  console.log(`禁用开关词形清单（只打印不判）：${verdict.forms.join(' | ')}`);
}

function selfTest() {
  const real = authorityHooks();
  const authority = real; // 夹具里的 `__notAHook__` 必须不在名单内，否则 S2 永远不开火
  const mk = (clearOwner) => ({
    rel: 'fixture.worker.ts',
    lines: [
      'export class W implements OnApplicationBootstrap {',
      '  private timer?: NodeJS.Timeout;',
      '  onApplicationBootstrap(): void {',
      "    const ms = Number(process.env.WORKER_INTERVAL_MS ?? 60000);",
      '    this.timer = setInterval(() => void this.tick(), ms);',
      '  }',
      `  ${clearOwner}(): void {`,
      '    if (this.timer) clearInterval(this.timer);',
      '  }',
      '  async tick() { try { await x(); } catch (e) {} }',
      '}',
    ],
  });
  const toEntries = (f) => [[f.rel, f.lines]];
  const cases = [
    {
      name: 'S1 清理写在真钩子上 ⇒ 不报死钩子',
      site: mk('onModuleDestroy'),
      expect: (v) => v.dead.length === 0,
    },
    {
      name: 'S2 清理写在不存在的方法上 ⇒ 必须报 R1',
      site: mk('__notAHook__'),
      expect: (v) => v.dead.some((x) => x.includes('__notAHook__')),
    },
    {
      name: 'S3 存了句柄但整个文件没有 clearInterval ⇒ 必须报 R2',
      site: { rel: 'fixture2.worker.ts', lines: ['  private timer?: NodeJS.Timeout;', '  onApplicationBootstrap(): void {', '    this.timer = setInterval(() => {}, 1);', '  }'] },
      expect: (v) => v.noClear.some((x) => x === 'fixture2.worker.ts'),
    },
    {
      name: 'S4 加了 Number.isFinite 守卫 ⇒ R3 必须不再报（撤销必须不开火）',
      site: { rel: 'fixture3.worker.ts', lines: ['  private timer?: NodeJS.Timeout;', '  onApplicationBootstrap(): void {', "    const ms = Number(process.env.W_INTERVAL_MS ?? 60000);", '    this.timer = setInterval(() => {}, Number.isFinite(ms) ? ms : 60000);', '  }', '  onModuleDestroy(): void { clearInterval(this.timer); }'] },
      expect: (v) => v.noGuard.length === 0,
    },
    {
      name: 'S4b 跨三行的 === true 必须归成 true 词形（按行匹配会误判成其他写法）',
      site: { rel: 'fixture4.worker.ts', lines: ['  onApplicationBootstrap(): void {', '    const disabled =', "      (process.env.X_WORKER_DISABLED ?? '').trim().toLowerCase() ===", "      'true';", '    this.timer = setInterval(() => {}, 1);', '  }', '  onModuleDestroy(): void { clearInterval(this.timer); }'] },
      expect: (v, st) => st.some((x) => x.disabledForm === "==='true'（大小写不敏感）"),
    },
    {
      name: 'S4c 已声明盲区：调用点绕过这一形量具看不见 ⇒ 只许当观察、不得当判据（R3 实测并拒绝）',
      site: { rel: 'fixture5.worker.ts', lines: ['  private timer?: NodeJS.Timeout;', '  onModuleInit(): void {', '    const ms = Number(process.env.FIVE_WORKER_INTERVAL_MS ?? 60000);', '    this.timer = setInterval(() => {}, ms);', '  }', '  function guard() { return Number.isFinite(1); }', '  onModuleDestroy(): void { clearInterval(this.timer); }'] },
      expect: (v, st) => v.problems.every((x) => !x.includes('R3'))
        && st.length === 1 && st[0].hasFiniteGuard === true,   // 读数说"有守卫"，而绕过这一形看不见 ⇒ 记为盲区
    },
    {
      name: 'S5 空语料 ⇒ 拒绝出数（静默零不算读数）',
      site: null,
      expect: (v) => v.problems.some((p) => p.includes('站点清单为空')),
    },
    {
      name: 'S6 权威名单塌陷 ⇒ 分母不成立',
      site: mk('onModuleDestroy'),
      authority: real.slice(0, 2),
      expect: (v) => v.problems.some((p) => p.includes('分母不成立')),
    },
  ];
  let bad = 0;
  for (const c of cases) {
    const entries = c.site ? toEntries(c.site) : [];
    const sites = analyzeFromText(entries, c.authority || authority);
    const v = judge(sites, c.authority || authority, { dead: [], noClear: [], noGuard: [] });
    const hit = c.expect(v, sites);
    if (!hit) bad += 1;
    console.log(`  ${hit ? '✔' : '✕'} ${c.name} → 报 ${v.problems.length} 项，死钩子=${v.dead.length}`);
  }
  console.log(`定时器清场判据自测：${cases.length - bad}/${cases.length} 抓到`);
  return bad === 0;
}

function main() {
  if (process.argv.includes('--self-test')) process.exit(selfTest() ? 0 : 3);
  let authority;
  try {
    authority = authorityHooks();
  } catch (error) {
    console.error(`FAIL worker_timer_census：解析不到权威钩子名单（${error.message}）`);
    process.exit(2);
  }
  const files = scanFiles();
  const entries = files.map((f) => [path.relative(ROOT, f), fs.readFileSync(f, 'utf8').split('\n')]);
  const sites = analyzeFromText(entries, authority);
  const verdict = judge(sites, authority, BASELINE);
  print(sites, verdict, authority);
  if (!verdict.ok) {
    for (const p of verdict.problems) console.error(`FAIL worker_timer_census：${p}`);
    process.exit(1);
  }
  console.log(`结论：判据 R1 死钩子清理 ${verdict.dead.length} 处、R2 无清理 ${verdict.noClear.length} 处（与基线一致）；`
    + `env 间隔无守卫 ${verdict.noGuard.length} 处**只作观察**（R3 已实测并拒绝当判据）。`);
}

if (require.main === module) main();
module.exports = { analyzeFromText, judge, BASELINE };
