#!/usr/bin/env node
/**
 * 链上权威事实的「写入口扇出」对照（V120）。
 *
 * 为什么做：推广判据①「维护成本下降」至今只有轶事（V79 那句"2 个 CAS 收进 1 个入口"）。
 * 写入口数量是可直接度量的代理指标：**同一张表的同一个权威状态列，今天有几处代码能改它**。
 * 试点的收口工作（run 终态单一写者、plan.status dispatched 单一入口、expired 唯一 writer…）
 * 如果真降了复杂度，这里必须看得见数字下降；看不见就如实说没降。
 *
 * 判据形状沿用 `scripts/audit-state-machine-roles.js` 的写入侧对账（`.update(<表变量>)` +
 * 18 行窗口内出现字面量 `status:`/`state:` ⇒ 记一处写入口；参数化 patch 记 `__dynamic__`），
 * **不另起一套定义**，避免同一事实出现两个互不相通的口径。
 *
 * before/after：before 用 `git show <rev>:<path>` 读同一棵树里的旧内容（默认 HEAD），
 * after 读工作树当前内容 ⇒ 不需要 worktree、不写任何文件、不改任何人的东西。
 * 文件清单取两侧并集：新增文件在旧侧不存在（计数 0），删除文件在新侧不存在。
 *
 * 用法：
 *   node scripts/chain-baseline/write-fanout.cjs              # 默认 HEAD vs 工作树
 *   node scripts/chain-baseline/write-fanout.cjs --against <rev|commit>
 *   node scripts/chain-baseline/write-fanout.cjs --self-test  # 反向控制：判据能不能变
 *   node scripts/chain-baseline/write-fanout.cjs --all-tables  # 全表横向刻度（多写者清单默认全量打印）
 *   node scripts/chain-baseline/write-fanout.cjs --all-tables --top-limit <N>  # 显式收窄清单打印面
 * 退出码：0=度量成功；1=--self-test 未抓到；3=两侧有一侧读不到（不可判，不当成"没变化"）。
 */
'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const ROOT = process.cwd();
const ARGS = process.argv.slice(2);
const SELF_TEST = ARGS.includes('--self-test');
const AGAINST = (ARGS.find((a, i) => ARGS[i - 1] === '--against') || 'HEAD');
const SCAN_ROOT = 'ewoh-spark-app/server';

/** 链上权威事实（表变量 → 业务含义）。列只看 status/state：这是"谁能改这条事实"的载体。
 *  第三项 `unmapped` 表示该物理表由 standalone_001 建、但在 Drizzle schema 里**有意不映射**
 *  （schema.ts NEST-513 标注：当前无 server 服务消费），因此写入口计数必然为 0 —— 这是
 *  显式声明的"不可见"，不是静默的 0。V123 加：每个键都要经 resolveFacts 对着 schema.ts 核一遍。 */
const FACTS = [
  ['ewohSchedulingRun', '调度 run 闭合（终态）'],
  ['ewohSchedulePlan', '方案状态（含 dispatched）'],
  ['ewohSchedulingPlanAssignment', '方案-任务关联状态'],
  ['ewoh_schedule_assignment', '派工行（legacy 物理表）', 'unmapped'],
  ['ewohSchedulingExecution', '执行记录状态'],
  ['ewohProductionTask', '生产任务状态'],
  ['ewohControlRequest', '高危控制请求状态'],
  ['ewohControlCommand', '控制命令状态（sent/delivered/expired）'],
  ['ewohControlResult', '控制结果状态'],
  ['ewohAgentApproval', '审批实例状态'],
];
const COLS = ['status', 'state'];

/** 纯函数（V123）：把 FACTS 的每个键对着 schema.ts 核验，防止"键写错 ⇒ 恒 0 ⇒ 看起来量过了"。
 *  已映射项必须能解析出 `export const <键> = pgTable("<物理表>"`；
 *  标了 unmapped 项必须**解析不到**（映射一旦出现，这条标注就过期，必须让人知道）。
 *  返回错误清单；空清单 = 键位点全部成立。 */
function resolveFacts(facts, schemaSrc) {
  const errors = [];
  for (const [key, what, flag] of facts) {
    let re;
    if (flag === 'unmapped') {
      // 反向核对：物理表名不许出现在任何 pgTable("...") 里（出现 = 有人补了映射，标注过期）
      re = new RegExp(`export const (\\w+)\\s*=\\s*pgTable\\(\\s*['"\`]${key}['"\`]`);
    } else {
      re = new RegExp(`export const ${key}\\s*=\\s*pgTable\\(\\s*['"\`]([\\w]+)`);
    }
    const hit = re.exec(schemaSrc);
    if (flag === 'unmapped') {
      if (hit) errors.push(`${key}（标为 unmapped/legacy）其实已被 ${hit[1]} 映射 ⇒ 标注过期，该项要从 unmapped 改成正常键并重跑度量`);
    } else if (!hit) {
      errors.push(`${key}（「${what}」）在 schema.ts 里解析不到 pgTable ⇒ 该键恒 0 命中，属**幽灵键**，读数会把"没测"当成"测了是 0"`);
    }
  }
  return errors;
}


/** 纯函数：给「相对路径 → 行数组」归纳每张表的写入口文件集合与语句数。 */
/** 参数化 patch 的可见性分级（V121，按实测改过一次形状）。
 *  第一版只分"附近提没提状态列"，实测 4 处被判 opaque 的位点里 **3 处其实是普通列更新**
 *  （decisionRecordsJson / aiNarration / requiredDeviceCapabilities）——标签发大就等于没有标签。
 *  改按 `.set(` 的实参形状分三档，只有 caller-patch 才是真正需要治理的不可见权威写入口：
 *    caller-patch   `.set(变量)`／`.set({ ...展开 })` ⇒ 写哪些列由调用方决定，词表看不见
 *                  （**值里的数组展开不算**：`[...a, ...b]` 更新的是普通列，V121 第二版误判过）
 *    status-nearby  ±40 行内出现状态键 ⇒ 大概率是这个入口在改状态（留可见性提示）
 *    other-columns  `.set({ 其它列: … })` 且附近不提状态 ⇒ 普通列更新，**不算**权威写入口 */
function setArgOf(lines, i) {
  // `.update(t)` 与 `.set(` 常常不在同一行（链式换行），所以从本行往后找 `.set(`
  const joined = lines.slice(i, i + 8).join('\n');
  const at = joined.indexOf('.set(');
  if (at < 0) return null;
  const stack = ['('];   // 已经站在 `.set(` 的左括号内侧
  const start = at + 5;
  let j = start, quote = null;
  for (; j < joined.length; j++) {
    const ch = joined[j];
    if (quote) { if (ch === '\\') j++; else if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '{' || ch === '[') stack.push(ch);
    else if (ch === ')' || ch === '}' || ch === ']') {
      stack.pop();
      if (stack.length === 0) break;      // 弹掉的正是 `.set(` 自己那层
    }
  }
  const text = joined.slice(start, j);
  return { text, head: text.replace(/^\s+/, '') };
}

/** 只取对象字面量的**顶层**成员；非对象字面量（整体传变量）返回 null。
 *  嵌套对象是 jsonb 列的子字段，属于"另一列的内容"，不是这张表的状态列。 */
function topLevelKeys(head) {
  if (!/^\{/.test(head)) return null;
  const segs = [];
  let depth = 0, seg = '', quote = null;
  for (let j = 1; j < head.length; j++) {
    const ch = head[j];
    if (quote) { seg += ch; if (ch === '\\') seg += head[++j]; else if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; seg += ch; continue; }
    if (ch === '{' || ch === '(' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ')' || ch === ']') depth -= 1;
    if (depth < 0) break;   // 外层对象在这里收尾，尾括号不进成员
    if (ch === ',') { if (depth === 0) { segs.push(seg); seg = ''; continue; } }
    seg += ch;
  }
  segs.push(seg);
  return segs.map((raw) => {
    const s = raw.trim();
    if (!s) return null;
    if (/^\.\.\./.test(s)) return { key: null, spread: true, value: s.slice(3).trim() };
    const m = s.match(/^(?:['"]?)([A-Za-z_$][\w$]*)(?:['"]?)\s*:\s*([\s\S]*)$/);
    if (m) return { key: m[1], spread: false, value: m[2].trim() };
    if (/^[A-Za-z_$][\w$]*$/.test(s)) return { key: s, spread: false, value: null };
    return null;   // 计算键 `[x]: v` 等解不开的形状：不算状态键，也不折算（见限度）
  }).filter(Boolean);
}

function scanFromText(entries, facts = FACTS) {
  const out = new Map();
  for (const [table] of facts) {
    out.set(table, { files: new Set(), stmts: 0, words: new Set(), dynamic: new Set(), rawUpdates: 0,
      hidden: new Set(), hiddenKinds: { 'caller-patch': 0, 'other-columns': 0 }, opaqueFiles: new Set(),
      unknownValues: 0, unknownAt: new Set() });
  }
  for (const [rel, lines] of entries) {
    lines.forEach((l, i) => {
      for (const [table] of facts) {
        if (!new RegExp(`\\.update\\(${table}\\)`).test(l)) continue;
        const rec = out.get(table);
        rec.rawUpdates += 1;
        // V292：值归属从"18 行窗口"改成"set 实参的顶层成员"。窗口会把邻近一条
        // `.select({ status })` 的读、以及 jsonb 子字段里的 `status:`，都算成这个 UPDATE 写的状态值；
        // 更糟的是它让 `.set(input.patch)` 因为窗口里有 status: 而**跳过** caller-patch 分类，
        // 把本工具唯一要暴露的"真·不可见权威写入口"读没（实测 control.service.ts:855）。
        const arg = setArgOf(lines, i);
        const keys = arg ? topLevelKeys(arg.head) : null;
        if (!keys) {
          rec.hidden.add(rel);
          rec.hiddenKinds['caller-patch'] += 1;
          rec.opaqueFiles.add(`${rel}:${i + 1}`);
          continue;
        }
        const hits = keys.filter((k) => k.key && COLS.includes(k.key));
        if (hits.length === 0) {
          const kind = keys.some((k) => k.spread) ? 'caller-patch' : 'other-columns';
          rec.hidden.add(rel);
          rec.hiddenKinds[kind] += 1;
          if (kind === 'caller-patch') rec.opaqueFiles.add(`${rel}:${i + 1}`);
          continue;
        }
        rec.files.add(rel);
        rec.stmts += 1;
        for (const k of hits) {
          if (k.value === null) {   // 简写 { status } ⇒ 确实是状态写入，但值看不见
            rec.unknownValues += 1;
            rec.unknownAt.add(`${rel}:${i + 1}`);
            continue;
          }
          const lit = k.value.match(/^(['"])([\w-]+)\1$/);
          if (lit) { rec.words.add(`${k.key}=${lit[2]}`); continue; }
          const v = (k.value.match(/^([A-Za-z_$][\w$.]*)/) || [])[1];
          if (v && !/^(string|number|boolean)$/.test(v)) rec.dynamic.add(`${k.key}:${v}`);
          else { rec.unknownValues += 1; rec.unknownAt.add(`${rel}:${i + 1}`); }
        }
      }
    });
  }
  return out;
}

/** 全表普查用：从 schema.ts 取所有 pgTable 导出变量（`export const X = pgTable("t"`）。 */
function allTableVars(schemaSrc) {
  const out = [];
  for (const m of schemaSrc.matchAll(/export const (\w+)\s*=\s*pgTable\(\s*['"`](\w+)['"`]/g)) {
    out.push([m[1], m[2]]);
  }
  return out;
}

/**
 * 纯函数：把「每张表的状态写入口数」收成可读分布。
 * 为什么不能只报一个均值：多数表根本没有状态写入口（append/日志表），均值会被零拉平；
 * 而且"链上比别的表低"这件事要用**可比子集**（有状态写入的表）说话，否则是自证清白。
 */
function faninCensus(scan, chainSet) {
  const chain = [], rest = [];
  for (const [table, r] of scan.entries()) {
    const rec = { table, stmts: r.stmts, files: r.files.size, hidden: r.rawUpdates - r.stmts, callerPatch: r.hiddenKinds['caller-patch'] };
    (chainSet.has(table) ? chain : rest).push(rec);
  }
  const med = (xs) => (xs.length === 0 ? 0 : xs.length % 2 ? xs[(xs.length - 1) / 2] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2);
  const q = (xs, p) => (xs.length === 0 ? 0 : xs[Math.min(xs.length - 1, Math.max(0, Math.ceil(p * xs.length) - 1))]);
  const stat = (rows) => {
    const withWrite = rows.filter((x) => x.stmts > 0);
    const s = withWrite.map((x) => x.stmts).sort((a, b) => a - b);
    const f = withWrite.map((x) => x.files).sort((a, b) => a - b);
    const multi = withWrite.filter((x) => x.stmts >= 2).sort((a, b) => b.stmts - a.stmts);
    return {
      tables: rows.length, withWrite: withWrite.length, zero: rows.length - withWrite.length,
      medianStmts: med(s), p90Stmts: q(s, 0.9), maxStmts: s.length ? s[s.length - 1] : 0,
      medianFiles: med(f), multiWriter: multi.length,
      multiWriterShare: withWrite.length ? multi.length / withWrite.length : 0,
      // 全量清单，不截断：一个写死的上限会把"没有更多了"与"被截断了"压成同一形状，
      // 读者只能靠 multiWriter 恰好等于清单长度才分得清这两件事（登记册 chain-behavior-baseline.md:7943
      // 记入 V295 的那条限度）。要收窄打印面用 --top-limit（见 --all-tables 分支），默认全量。
      top: multi,
    };
  };
  return { chain: stat(chain), rest: stat(rest), chainRows: chain };
}

function listTsFiles(rootDir) {
  const out = [];
  const walk = (p) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.ts$/.test(e.name) && !/\.(spec|test)\.ts$/.test(e.name)) out.push(path.relative(ROOT, full));
    }
  };
  if (fs.existsSync(rootDir)) walk(rootDir);
  return out.sort();
}

function gitFiles(rev) {
  try {
    const txt = execFileSync('git', ['ls-tree', '-r', '--name-only', rev, '--', SCAN_ROOT],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
    return txt.split('\n').filter((f) => /\.ts$/.test(f) && !/\.(spec|test)\.ts$/.test(f));
  } catch (e) {
    return null;
  }
}

function gitShow(rev, file) {
  try {
    return execFileSync('git', ['show', `${rev}:${file}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 << 20 }).split('\n');
  } catch (e) {
    return null;   // 该侧没有这个文件（新增/删除）
  }
}

function selfTest() {
  const bad = [];
  let CHECKS = 0; // 判据条数由计数器给出，不再手抄（V132：手抄的「12 项」在本轮加夹具后当场过期）
  const ck = (cond, msg) => { CHECKS++; if (!cond) bad.push(msg); };
  const t = (label, entries, table, wantStmts, wantFiles) => {
    CHECKS++;
    const r = scanFromText(entries).get(table);
    if (r.stmts !== wantStmts || (wantFiles != null && r.files.size !== wantFiles)) {
      bad.push(`${label} ⇒ 实得 stmts=${r.stmts} files=${r.files.size}（期望 ${wantStmts}/${wantFiles}）`);
    }
  };
  const one = (file, lines) => [[file, lines]];
  // 正向：两处写入口、两个文件
  t('正向 两文件各写一次', [
    ['a.service.ts', ['x', "  await db.update(ewohSchedulePlan).set({ status: 'dispatched' }).where(y);", 'y']],
    ['b.service.ts', ["  await db.update(ewohSchedulePlan).set({ status: 'cancelled' }).where(z);"]],
  ], 'ewohSchedulePlan', 2, 2);
  // 注入①：新增一处写入口 ⇒ 计数必须上升（判据认得"多了一个写者"）
  t('注入① 第三个写者出现', [
    ['a.service.ts', ["  await db.update(ewohSchedulePlan).set({ status: 'dispatched' }).where(y);"]],
    ['b.service.ts', ["  await db.update(ewohSchedulePlan).set({ status: 'cancelled' }).where(z);"]],
    ['c.service.ts', ["  await db.update(ewohSchedulePlan).set({ status: 'superseded' }).where(w);"]],
  ], 'ewohSchedulePlan', 3, 3);
  // 注入②：收口到一处 ⇒ 计数必须下降（判据认得"少了写者"，这才是要度量的方向）
  t('注入② 收进单一入口', [
    ['lifecycle.ts', ["  await db.update(ewohSchedulePlan).set({ status: to }).where(y);"]],
  ], 'ewohSchedulePlan', 1, 1);
  // 注入③：同文件多条语句 ⇒ 语句数与文件数分开计（只数文件会把 2→1 的收口误判成没变）
  t('注入③ 同文件两处写', [
    ['a.service.ts', [
      "  await db.update(ewohControlCommand).set({ status: 'sent' }).where(y);",
      "  await db.update(ewohControlCommand).set({ status: 'delivered' }).where(z);",
    ]],
  ], 'ewohControlCommand', 2, 1);
  // 注入④：不带 status/state 的更新不算写入口（防把普通字段更新数成权威写入）
  t('注入④ 只改时间戳', [
    ['a.service.ts', ['  await db.update(ewohSchedulePlan).set({ updatedAt: new Date() }).where(y);']],
  ], 'ewohSchedulePlan', 0, 0);
  // 注入⑤：state 列同样要认（control_request 用 state）
  t('注入⑤ state 列', [
    ['r.service.ts', ["  await db.update(ewohControlRequest).set({ state: 'approved' }).where(y);"]],
  ], 'ewohControlRequest', 1, 1);
  // 已知盲区（断言它存在，而不是假装看不见）：`.set(input.patch)` 里没有字面量 status: ⇒
  // 状态写入口计数看不见它（与 audit-state-machine-roles 文档里那条限制同源）。
  // 因此本工具必须另外报「看到过多少次 .update(该表) 却没算成状态写入」，缺口大小可见才算诚实。
  const k3 = (label, lines, wantKind) => {
    const r = scanFromText(one('p.service.ts', lines)).get('ewohSchedulingRun');
    CHECKS++;
    const got = Object.entries(r.hiddenKinds).find(([, n]) => n > 0)?.[0];
    if (!(r.stmts === 0 && r.rawUpdates === 1 && got === wantKind)) {
      bad.push(`${label} ⇒ raw=${r.rawUpdates} stmts=${r.stmts} 档位=${got}（期望 ${wantKind}）`);
    }
  };
  k3('档位① .set(变量) 且附近不提状态 ⇒ 必须算 caller-patch（真不可见写入口）', [
    '  await db.update(ewohSchedulingRun).set(input.patch as never);',
    '  const total = count + 1;'], 'caller-patch');
  // 档位②（V122 新增，取代原 status-nearby 用例）：简写 `.set({ status })` 是真状态写入，
  // 必须进主计数（stmts+1）并单独记"取值非字面量"；只认冒号的旧判据会把它整条漏掉。
  {
    const r = scanFromText(one('s.service.ts', [
      '  const status = nextStatus(row);',
      '  await db.update(ewohSchedulingExecution).set({ status }).where(q);',
    ])).get('ewohSchedulingExecution');
    if (!(r.stmts === 1 && r.unknownValues === 1 && r.hiddenKinds['caller-patch'] === 0)) {
      bad.push(`简写状态写入未被认成写入口（stmts=${r.stmts} 取值未知=${r.unknownValues}）`);
    }
    const v = scanFromText(one('v.service.ts', ['  await db.update(ewohSchedulingExecution).set(values).where(q);']))
      .get('ewohSchedulingExecution');
    if (!(v.stmts === 0 && v.hiddenKinds['caller-patch'] === 1)) {
      bad.push(`整体传变量没落进 caller-patch（stmts=${v.stmts} kinds=${JSON.stringify(v.hiddenKinds)}）`);
    }
  }
  // V292 四件套：值归属必须绑在 set 实参的顶层成员上，不许挂在行窗口上。
  // 每一支都配了极性相反的对照，缺任何一支，"改绑"就可能被写成"少看一条写入口"。
  {
    // 必须开火①：参数化 patch + 18 行内另有一条读 status 的 SELECT ⇒ 仍是 caller-patch，
    // 且那条 SELECT 的值不得进 dynamic/unknown 清单（旧窗口判据两处都错）。
    const a = scanFromText(one('bind1.service.ts', [
      '  await this.db',
      '    .update(ewohControlCommand)',
      '    .set(input.patch as never)',
      '    .where(and(...predicates))',
      '    .returning({ commandId: ewohControlCommand.commandId });',
      '  const [fresh] = await this.db',
      '    .select({ status: ewohControlCommand.status })',
      '    .from(ewohControlCommand)',
      '    .limit(1);',
    ])).get('ewohControlCommand');
    CHECKS++;
    if (!(a.stmts === 0 && a.rawUpdates === 1 && a.hiddenKinds['caller-patch'] === 1
      && a.unknownValues === 0 && [...a.dynamic].length === 0)) {
      bad.push(`V292① 邻近 SELECT 的 status 被算进这个 UPDATE（stmts=${a.stmts} 档=${JSON.stringify(a.hiddenKinds)} 未知=${a.unknownValues} 动态=${[...a.dynamic]}）`);
    }
    // 必须开火②：jsonb 子字段里的 status 不是表列状态 ⇒ 既不算写入口，也不记"取值非字面量"。
    const b = scanFromText(one('bind2.service.ts', [
      '  await this.db',
      '    .update(ewohAgentApproval)',
      '    .set({',
      '      payloadJson: {',
      '        ...baseTaskJson,',
      '        status: result.status,',
      '      },',
      '    })',
      '    .where(and(q));',
    ])).get('ewohAgentApproval');
    CHECKS++;
    if (!(b.stmts === 0 && b.rawUpdates === 1 && b.hiddenKinds['other-columns'] === 1
      && b.unknownValues === 0 && b.words.size === 0)) {
      bad.push(`V292② jsonb 子字段 status 被算成表列写入（stmts=${b.stmts} 档=${JSON.stringify(b.hiddenKinds)} 未知=${b.unknownValues}）`);
    }
    // 不开火①（合规侧）：字面状态写入旁边紧跟一条读 status 的 SELECT ⇒ 值照旧收，档位照旧是写入口。
    const c = scanFromText(one('ok1.service.ts', [
      "  await db.update(ewohSchedulePlan).set({ status: 'dispatched' }).where(y);",
      '  const r = await db.select({ status: ewohSchedulePlan.status }).from(ewohSchedulePlan);',
    ])).get('ewohSchedulePlan');
    CHECKS++;
    if (!(c.stmts === 1 && c.words.has('status=dispatched') && c.hiddenKinds['caller-patch'] === 0)) {
      bad.push(`V292 不开火① 字面写入口被窗口改绑弄丢了（stmts=${c.stmts} words=${[...c.words]}）`);
    }
    // 不开火②（合规侧）：顶层展开 + 顶层字面 status ⇒ 状态列的值是看得见的，按写入口算，
    // 不许因为"有展开"就整条退回不可见档（那会把已收口的写者读成盲区）。
    const d = scanFromText(one('ok2.service.ts', [
      "  await db.update(ewohSchedulePlan).set({ ...base, status: 'cancelled' }).where(y);",
    ])).get('ewohSchedulePlan');
    CHECKS++;
    if (!(d.stmts === 1 && d.words.has('status=cancelled'))) {
      bad.push(`V292 不开火② 展开＋字面 status 被整条判成不可见（stmts=${d.stmts} words=${[...d.words]}）`);
    }
    // 不开火③（合规侧）：顶层展开但**没有**状态键 ⇒ 列清单由调用方决定，必须留在 caller-patch。
    const e = scanFromText(one('ok3.service.ts', [
      '  await db.update(ewohSchedulePlan).set({ ...patch }).where(y);',
    ])).get('ewohSchedulePlan');
    CHECKS++;
    if (!(e.stmts === 0 && e.hiddenKinds['caller-patch'] === 1)) {
      bad.push(`V292 不开火③ 顶层展开未落 caller-patch（stmts=${e.stmts} 档=${JSON.stringify(e.hiddenKinds)}）`);
    }
  }
  k3('档位③ .set({普通列}) 且附近不提状态 ⇒ other-columns，不许算权威写入口', [
    '  await db.update(ewohSchedulingRun).set({ aiNarration: x });'], 'other-columns');
  k3('档位④ 值里带数组展开的多行 set ⇒ 仍是 other-columns（V121 第一版误判成 caller-patch）', [
    '  await db', '    .update(ewohSchedulingRun)', '    .set({', "      decisionRecordsJson: [...existing, ...records] as unknown as Foo,", '    })', '    .where(q);'], 'other-columns');
  k3('档位⑤ 对象位展开 .set({ ...patch }) ⇒ caller-patch（列由调用方决定）', [
    '  await db', '    .update(ewohSchedulingRun)', '    .set({', '      ...patch,', '    })', '    .where(q);'], 'caller-patch');
  const dyn = scanFromText(one('p.service.ts', ['  await db.update(ewohSchedulingRun).set(input.patch as never);'])).get('ewohSchedulingRun');
  if (!(dyn.stmts === 0 && dyn.rawUpdates === 1 && dyn.opaqueFiles.size === 1)) bad.push(`caller-patch 未被单独点名（stmts=${dyn.stmts} raw=${dyn.rawUpdates} 点名=${dyn.opaqueFiles.size}）`);

  // ── V132：全表普查模式（--all-tables）的两条纯函数判据 ────────────────────
  {
    const vars = allTableVars([
      'export const ewohA = pgTable("ewoh_a", { x: t("x") });',
      "export const ewohB = pgTable('ewoh_b', { y: t('y') });",
      'export const notATable = new Map();',
    ].join('\n'));
    const got = vars.map((v) => v.join(':')).sort().join(' ');
    ck(got === 'ewohA:ewoh_a ewohB:ewoh_b', `allTableVars 解析错（${got}，期望两个键、且不把非 pgTable 导出算进来）`);
  }
  const rec = (stmts, files, raw, cp) => ({
    stmts, files: new Set(files), rawUpdates: raw, hiddenKinds: { 'caller-patch': cp, 'other-columns': Math.max(0, raw - stmts - cp) },
  });
  {
    const scan = new Map([
      ['ewohA', rec(2, ['a1.service.ts', 'a2.service.ts'], 2, 0)],
      ['ewohB', rec(5, ['b1.service.ts', 'b2.service.ts', 'b3.service.ts'], 5, 0)],
      ['ewohC', rec(1, ['c1.service.ts'], 1, 0)],
      ['ewohD', rec(0, [], 0, 0)],
      ['ewohE', rec(0, [], 3, 3)],
      ['ewohF', rec(2, ['f1.service.ts', 'f2.service.ts'], 2, 0)],
    ]);
    const cen = faninCensus(scan, new Set(['ewohA']));
    const okChain = cen.chain.tables === 1 && cen.chain.withWrite === 1 && cen.chain.medianStmts === 2 && cen.chain.multiWriter === 1;
    // 奇数样本取中间（[1,2,5] ⇒ 2）、偶数样本取两中标量均（[1,5] 那类），多写者表按写入口数降序进 Top
    const okRest = cen.rest.tables === 5 && cen.rest.withWrite === 3 && cen.rest.zero === 2
      && cen.rest.medianStmts === 2 && cen.rest.maxStmts === 5 && cen.rest.multiWriter === 2
      && cen.rest.top.length === 2 && cen.rest.top[0].table === 'ewohB' && cen.rest.top[1].table === 'ewohF';
    ck(okChain && okRest, `faninCensus 分布算错 chain=${JSON.stringify(cen.chain)} rest=${JSON.stringify(cen.rest)}`);
    // 反向控制：只被 caller-patch 摸过的表（ewohE）不许进"有状态写入"分子，也不许从分母里消失
    ck(!cen.rest.top.some((r) => r.table === 'ewohE') && cen.rest.withWrite === 3,
      '不可见写入口被算成了状态写入（分子虚增）');
    // 分母诚实：普查表数必须含零写入表（否则"其余表本来也多写者"会被小分母放大）
    ck(cen.rest.tables === 5, `零写入表被从分母里丢了（rest.tables=${cen.rest.tables}）`);
    // 偶数样本的中位数单独钉一次（[2,5] ⇒ 3.5）：中位数是这份对照的主读数，不能悄悄取上元素
    const even = faninCensus(new Map([['ewohG', rec(2, ['g'], 2, 0)], ['ewohH', rec(5, ['h1', 'h2'], 5, 0)]]), new Set());
    ck(even.rest.medianStmts === 3.5, `偶数样本中位数取错（${even.rest.medianStmts}，期望 3.5）`);
  }

  // ── V296：清单条数判据（原 `top: multi.slice(0, 15)` 会把"没有更多"与"被截断"压成同一形状）──
  // 上面那支"Top 排序"夹具只有 2 张多写者表，任何 ≤15 的上限都看不出差别 ⇒ 必须有 ≥16 的夹具。
  {
    const wide = new Map();
    for (let i = 0; i < 17; i++) {
      const n = 2 + (i % 4);   // 2..5 处写入口，全部 ≥2 ⇒ 17 张都是多写者
      wide.set(`ewohW${String(i).padStart(2, '0')}`, rec(n, [`w${i}a.service.ts`, `w${i}b.service.ts`], n, 0));
    }
    wide.set('ewohSolo', rec(1, ['solo.service.ts'], 1, 0));   // 单写者：不许进清单
    wide.set('ewohNone', rec(0, [], 4, 4));                    // 零状态写入：留在分母、不进清单
    const c17 = faninCensus(wide, new Set());
    ck(c17.rest.top.length === c17.rest.multiWriter && c17.rest.multiWriter === 17,
      `多写者清单被截断（清单 ${c17.rest.top.length} 条 vs 多写者 ${c17.rest.multiWriter} 张，夹具 17 张）`);
    const desc = c17.rest.top.every((r, i) => i === 0 || c17.rest.top[i - 1].stmts >= r.stmts);
    ck(desc, `全量清单不按写入口数降序（${c17.rest.top.map((r) => `${r.table}:${r.stmts}`).join(' ')}）`);
    // 反向对照：把一张表的写入口降到 1 ⇒ 必须从清单消失、清单长度同步减 1（证明上一支真在数东西，不是恒真）
    const demoted = new Map(wide);
    demoted.set('ewohW00', rec(1, ['w0a.service.ts'], 1, 0));
    const c16 = faninCensus(demoted, new Set());
    ck(c16.rest.top.length === c17.rest.top.length - 1 && c16.rest.multiWriter === 16
      && !c16.rest.top.some((r) => r.table === 'ewohW00'),
      `降为单写者后清单没变短（清单 ${c16.rest.top.length} 条 / 多写者 ${c16.rest.multiWriter} 张，期望 16/16 且不含 ewohW00）`);
    // 分母不跟着动：单写者（ewohSolo 与被降级的 ewohW00）不进清单但留在"有状态写入"里，
    // 零写入表（ewohNone，只被 caller-patch 摸过）留在普查分母里
    ck(c16.rest.tables === 19 && c16.rest.withWrite === 18 && c16.rest.zero === 1,
      `收窄清单把分母也改动了（tables=${c16.rest.tables} withWrite=${c16.rest.withWrite} zero=${c16.rest.zero}，期望 19/18/1）`);
  }

  // V123（GATE-14）：键位点判据。V120–V122 的 FACTS 里有一个不存在的键（恒 0 ⇒ 把"没测"报成"测了是 0"），
  // 这三条自测保证同类错误下次上线即红，而不是靠人再去读一遍表格。
  const SCHEMA_FIX = [
    'export const ewohSchedulingRun = pgTable("ewoh_scheduling_run", {',
    'export const ewohSchedulePlan = pgTable("ewoh_schedule_plan", {',
  ].join('\n');
  const rf = (label, facts, schema, wantErrs) => {
    const n = resolveFacts(facts, schema).length;
    if (n !== wantErrs) bad.push(`${label} ⇒ 报错 ${n} 项（期望 ${wantErrs}）`);
  };
  const F2 = [['ewohSchedulingRun', 'x'], ['ewohSchedulePlan', 'y']];
  rf('键位点正向 全部解析得到', F2, SCHEMA_FIX, 0);
  rf('键位点注入① 幽灵键（schema 里没有）必须报错', [['ewohSchedulingRun', 'x'], ['ewohScheduleAssignment', 'y']], SCHEMA_FIX, 1);
  rf('键位点注入② unmapped 标注过期（其实已映射）必须报错',
    [['ewohSchedulingRun', 'x'], ['ewoh_schedule_plan', 'y', 'unmapped']], SCHEMA_FIX, 1);
  rf('键位点边界③ unmapped 确实没映射 ⇒ 不许报错',
    [['ewohSchedulingRun', 'x'], ['ewoh_schedule_assignment', 'y', 'unmapped']], SCHEMA_FIX, 0);

  for (const b of bad) console.log(`  ✕ ${b}`);
  console.log(bad.length ? `写入口判据自测：不通过（${bad.length} 项失败 / 共 ${CHECKS} 项）`
    : `写入口判据自测：通过（${CHECKS} 项，含 V122 的"简写状态键不许漏数"、V123 的"幽灵键必须报错"、V121 的"数组展开不许冒充不可见写入口"，V132 全表普查的五条：表变量解析、奇偶中位数、caller-patch 不入分子、零写入表留在分母、多写者 Top 排序，以及 V296 的三条：17 张夹具下清单条数必须等于多写者表数（截掉任何一张即红）、全量清单仍按写入口数降序、降为单写者后清单必须同步减一条）`);
  process.exit(bad.length ? 1 : 0);
}
if (SELF_TEST) selfTest();

// V123（GATE-14）：先核键位点，再谈读数。V120–V122 期间 FACTS 里有一个键 `ewohScheduleAssignment`
// 在 schema.ts 里根本不存在 ⇒ 恒 0 命中，看起来"测过了、是 0"，实际是"没测"。
const schemaPath = path.join(ROOT, 'ewoh-spark-app/server/database/schema.ts');
const keyErrors = resolveFacts(FACTS, fs.readFileSync(schemaPath, 'utf8'));
if (keyErrors.length) {
  keyErrors.forEach((e) => console.log(`  ✕ 键位点 ${e}`));
  console.log('写入口度量失败：事实表键位点不成立（幽灵键会把"没测"报成"测了是 0"）');
  process.exit(1);
}
console.log(`键位点核验：${FACTS.length} 项全部对得上 schema.ts（其中 unmapped 标注 ${FACTS.filter((f) => f[2] === 'unmapped').length} 项，反向核对"确实没有映射"）`);

const oldFiles = gitFiles(AGAINST);
if (oldFiles === null) {
  console.error(`不可判：git ls-tree ${AGAINST} 失败（不把"读不到"当成"没有变化"）`);
  process.exit(3);
}
const curFiles = listTsFiles(path.join(ROOT, SCAN_ROOT));
const universe = [...new Set([...oldFiles, ...curFiles])].sort();
const oldEntries = [];
const curEntries = [];
let missingOld = 0, missingCur = 0;
for (const f of universe) {
  const o = gitShow(AGAINST, f);
  if (o === null) missingOld += 1; else oldEntries.push([path.relative(SCAN_ROOT, f), o]);
  const c = fs.existsSync(path.join(ROOT, f)) ? fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n') : null;
  if (c === null) missingCur += 1; else curEntries.push([path.relative(SCAN_ROOT, f), c]);
}
const before = scanFromText(oldEntries);
const after = scanFromText(curEntries);

/**
 * --all-tables（V132）：把同一套判据（不另起定义）推到 schema.ts 里**全部**映射表上，
 * 回答判据①一直缺的那半边——链上扇出降了，可**别的模块本来是多少**？没有横向对照，
 * "32→23" 只能说明试点自己变好了，不能说明这算不算低。
 * 同时对账：本模式扫出来的链上 9 张表，必须与 FACTS 模式逐表同数（两条代码路径不许给出两个数）。
 */
if (ARGS.includes('--all-tables')) {
  // 显式、默认全开的打印面收窄：不带 --top-limit 就是 Infinity（全量）。
  // 参数写坏时拒出数，不折算成"不限量"也不折算成 0——两者都会让读者看到不同的清单而不自知。
  const topAt = ARGS.indexOf('--top-limit');
  let topLimit = Infinity;
  if (topAt >= 0) {
    const n = Number(ARGS[topAt + 1]);
    if (!Number.isInteger(n) || n < 1) {
      console.error(`不可判：--top-limit 需要一个 ≥1 的整数（实得 "${ARGS[topAt + 1]}"）⇒ 不把它当成"不限量"，也不当成 0`);
      process.exit(3);
    }
    topLimit = n;
  }
  const schemaSrc = fs.readFileSync(path.join(ROOT, 'ewoh-spark-app/server/database/schema.ts'), 'utf8');
  const vars = allTableVars(schemaSrc);
  if (vars.length < 80) {
    console.error(`不可判：schema.ts 只解析出 ${vars.length} 个 pgTable 变量 ⇒ 普查分母不成立（不把"没扫到"当成"没有"）`);
    process.exit(3);
  }
  const chainSet = new Set(FACTS.filter((f) => f[2] !== 'unmapped').map((f) => f[0]));
  const full = scanFromText(curEntries, vars);
  const cen = faninCensus(full, chainSet);
  let mismatch = 0;
  for (const t of chainSet) {
    const a = after.get(t), b = full.get(t);
    if (!a || !b || a.stmts !== b.stmts || a.files.size !== b.files.size) mismatch += 1;
  }
  const pr = (s, name) => console.log(`  ${name}：映射表 ${s.tables} 张｜有状态写入 ${s.withWrite}（零写入 ${s.zero}）｜写入口中位 ${s.medianStmts} p90 ${s.p90Stmts} 最大 ${s.maxStmts}`
    + `｜写者文件中位 ${s.medianFiles}｜多写者表 ${s.multiWriter} 张（占有写入的 ${(s.multiWriterShare * 100).toFixed(0)}%）`);
  console.log(`全表写入口普查（同一判据，工作树 ${curEntries.length} 个文件｜schema 映射 ${vars.length} 张表）`);
  pr(cen.chain, '链上 9 张权威表');
  pr(cen.rest, '其余表');
  console.log(`  与 FACTS 模式对账：链上 ${chainSet.size} 张表逐表同数 ${mismatch === 0 ? '✅ 全对' : `❌ ${mismatch} 张不符 ⇒ 两条路径口径漂移，读数作废`}`);
  const listed = cen.rest.top.slice(0, topLimit);
  const tally = listed.length === cen.rest.top.length
    ? `共 ${cen.rest.top.length} 张，已全量打印`
    : `共 ${cen.rest.top.length} 张，此处只列前 ${listed.length} 张（--top-limit ${topLimit} 截断，未打印 ${cen.rest.top.length - listed.length} 张）`;
  console.log(`  其余表里多写者（≥2 处状态写入口）清单 ${tally}：这就是"同一件收口工作在别处还值不值得做"的地图`);
  for (const r of listed) console.log(`    ${r.table}  写入口 ${r.stmts} 处 / 写者文件 ${r.files} 个${r.callerPatch ? `（另有 caller-patch 不可见 ${r.callerPatch} 处）` : ''}`);
  console.log('  口径边界（必须一起读）：①"有状态写入"只认字面量状态列，caller-patch 单列在括号里；'
    + '②表的业务复杂度天然不同，本对照是**同判据的横向刻度**，不是随机分组实验；'
    + '③链上表数少（9），中位数只作方向，不作显著性 claim。');
  fs.writeFileSync(path.join(ROOT, 'tmp/write-fanout-alltables.json'), JSON.stringify(cen, null, 1));
  console.log('机器可读结果：tmp/write-fanout-alltables.json');
  process.exit(mismatch ? 1 : 0);
}

console.log(`写入口扇出对照：before=${AGAINST}（${oldEntries.length} 个文件）→ after=工作树（${curEntries.length} 个文件）`);
console.log(`两侧文件并集 ${universe.length}｜仅旧侧存在 ${missingCur}｜仅新侧存在 ${missingOld}`);
console.log('');
console.log('事实表 | 含义 | 旧:文件/状态写入口 | 新:文件/状态写入口 | Δ | 计数盲区（.update 有但无字面量状态列）');
let totalBefore = 0, totalAfter = 0, down = 0, up = 0, same = 0;
const rows = [];
for (const [table, what, flag] of FACTS) {
  const b = before.get(table), a = after.get(table);
  totalBefore += b.stmts; totalAfter += a.stmts;
  const d = a.stmts - b.stmts;
  if (d < 0) down += 1; else if (d > 0) up += 1; else same += 1;
  const hiddenB = b.rawUpdates - b.stmts, hiddenA = a.rawUpdates - a.stmts;
  const ha = [...a.hidden].sort().join(' ');
  const cls = ['caller-patch', 'other-columns'];
  const ka = cls.map((k) => `${k}=${a.hiddenKinds[k]}`).join(' ');
  const kb = cls.map((k) => `${k}=${b.hiddenKinds[k]}`).join(' ');
  const unk = a.unknownValues ? `；另有 ${a.unknownValues} 处状态取值非字面量：${[...a.unknownAt].sort().join(' ')}` : '';
  rows.push({ table, what, beforeFiles: [...b.files].sort(), beforeStmts: b.stmts, beforeRaw: b.rawUpdates,
    afterFiles: [...a.files].sort(), afterStmts: a.stmts, afterRaw: a.rawUpdates,
    beforeHidden: [...b.hidden].sort(), afterHidden: [...a.hidden].sort(),
    beforeHiddenKinds: b.hiddenKinds, afterHiddenKinds: a.hiddenKinds,
    beforeUnknown: b.unknownValues, afterUnknown: a.unknownValues, unknownAt: [...a.unknownAt].sort(),
    opaqueBefore: [...b.opaqueFiles].sort(), opaqueAfter: [...a.opaqueFiles].sort(),
    words: [...a.words].sort(), dynamic: [...a.dynamic].sort() });
  console.log(`| ${table}${flag === 'unmapped' ? '（unmapped：Drizzle 有意不映射，写入口恒 0 属已声明不可见，非"测了是 0"）' : ''} | ${what} | ${b.files.size}/${b.stmts} | ${a.files.size}/${a.stmts} | ${d > 0 ? '+' : ''}${d} | 参数化 patch ${hiddenB}→${hiddenA}${hiddenA ? `（新侧 ${ka}）` : ''}${unk} |`);
  if (hiddenA) console.log(`      └ 新侧参数化写者文件：${ha}`);
  if (a.opaqueFiles.size) console.log(`      └ ⚠ 真·不可见权威写入口（.set(调用方传入的 patch)，词表看不见写哪些列）：${[...a.opaqueFiles].sort().join(' ')}`);
  if (hiddenB && process.env.EWOH_FANOUT_VERBOSE) console.log(`      （旧侧 ${kb}）`);
}
console.log('');
let wfB = 0, wfA = 0;
for (const [table] of FACTS) {
  const b = before.get(table), a = after.get(table);
  wfB += new Set([...b.files, ...b.hidden]).size;
  wfA += new Set([...a.files, ...a.hidden]).size;
}
console.log(`合计「字面量状态写入口」语句：${totalBefore} → ${totalAfter}（Δ${totalAfter - totalBefore}）｜下降表数 ${down}｜上升 ${up}｜不变 ${same}`);
console.log(`合计「能改这条事实的文件数（含参数化 patch 那一类）」：${wfB} → ${wfA}（Δ${wfA - wfB}）——这条才是"谁能改哪类事实"的口径，不受字面量写法影响`);
fs.mkdirSync(path.join(ROOT, 'tmp'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'tmp/write-fanout.json'), JSON.stringify({ against: AGAINST, universe: universe.length, rows }, null, 1));
console.log('机器可读结果：tmp/write-fanout.json');
