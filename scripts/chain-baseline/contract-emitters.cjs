#!/usr/bin/env node
/**
 * 契约事件「声明 ↔ 发射方」普查（V133，试点第 20 号量具；复算 `make chain-baseline-contract-emitters`）。
 *
 * 读数纪律（本轮用三次翻车换来的，别绕过）：
 *  1) 一个事件在目录里有三种身份：通道名 `plan.approved`、消息类名 `PlanApproved`（锁定投影存这一形）、
 *     类型串 `com.ewoh.plan.approved`。只按一种匹配，同一份语料的「有构造点」在 18/70 → 39/70 → 50/70 之间跳；
 *  2) 匹配必须带词边界：`TaskCreated` 是 `AgentTaskCreated` 的子串，includes() 会把别人的事件算成它的发射方；
 *  3) emit 侧仍可能含「在比较/注释里提到名字」的假阳性（`eventType === 'AndonRaised'` 是消费不是构造）；
 *     validate-only 侧必须逐条人工复核（已抽查三条：其「投影外命中」全是 __pycache__ 里投影自身的 .pyc）。
 *
 * 为什么做：判据②「业务语义没有丢失」的自陈里挂着一条没法回答的保留——
 * "契约声明但发射方为 0 的分支（V62 实测）说明契约与实现的锁步是逐条挣来的"。
 * 这句话到今天只有一个样本（`replan_debounce_window`）。有全表计数才能知道
 * 锁步到底覆盖了百分之几，也才知道 F-07 那一族（`published` 无发布者）是个例还是常态。
 *
 * 分桶（每个声明必须落进且只落进一桶；两数对不上即读数作废）：
 *   emit         非投影、非测试文件里出现字面量，且上下文是"构造/发布"形状
 *   emit-alias   字面量只出现在常量定义里，但那个常量在别处被用 ⇒ 发射方存在，只是不用字面量
 *                （单列一桶而不是并到 emit：并档就是把"我换了个写法"当成"我证明了"）
 *   validate-only 只在锁定投影（YAML/event_catalog.py/event-catalog.ts）或校验上下文里出现 ⇒ **没有人构造它**
 *   test-only    只有测试/夹具提到
 *   none         全仓零命中
 *
 * 用法：node scripts/chain-baseline/contract-emitters.cjs [--self-test] [--verbose]
 * 退出码：0 正常；1 对账不成立或自测未抓到。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.cwd();
const SELF = process.argv.includes('--self-test');
const VERBOSE = process.argv.includes('--verbose');
const CATALOG = 'contracts/events/event-catalog.yaml';
const CORPUS = ['ewoh-spark-app/server', 'ewoh-spark-app/shared', 'ewoh-spark-app/client/src', 'src'];
const PROJECTION_RE = /(event-catalog\.yaml|event_catalog\.py|event-catalog\.ts)$/;
const TEST_RE = /(\.spec\.|\.test\.|__tests__|[/\\]tests?[/\\]|conftest\.py|[/\\]fixtures?[/\\])/;
const EMIT_SHAPE = /(type|event_type|eventType|name)\s*[:=]|publish|emit|new\s+\w*Event\(|outbox/i;
const ALIAS_DEF = /(?:const|let|var|}\s*\w+\s*[:=]|[A-Z_]{3,}\s*[:=])\s*['"`]([^'"`]+)['"`]/;

/** 纯函数：目录文本 → 声明的事件类型 + 通道名。 */
function parseCatalog(text) {
  // 目录是 AsyncAPI 形状：channels.<通道>.publish.message.$ref → components.messages.<名>.x-cloud-events.type
  // 必须两跳都解出来成对：代码发射时用的是**通道名**（`_publish("task.created", …)`），
  // 而 `com.ewoh.task.state_changed` 这类类型串在全仓（含锁定投影）出现 0 次。
  const chBlock = (text.split(/^channels:\s*$/m)[1] || '').split(/^components:\s*$/m)[0];
  // messages: 在 components: 之下再缩进两级，所以切段时不能要求它顶格（真实目录与夹具同形）
  const msgBlock = ((text.split(/^components:\s*$/m)[1] || '').split(/^ *messages:\s*$/m)[1] || '');
  const channels = [];
  let cur = null;
  for (const line of chBlock.split('\n')) {
    const cm = line.match(/^ {2}([\w.-]+):\s*$/);
    if (cm) { cur = cm[1]; continue; }
    const rm = line.match(/\$ref:\s*['"]#\/components\/messages\/(\w+)['"]/);
    if (rm && cur) { channels.push({ channel: cur, msg: rm[1] }); cur = null; }
  }
  const msgType = new Map();
  let mname = null;
  for (const line of msgBlock.split('\n')) {
    const mm = line.match(/^ {2,4}(\w+):\s*$/);
    if (mm) { mname = mm[1]; continue; }
    const tm = line.match(/^ +type:\s*(com\.ewoh\.[\w.]+)\s*$/);
    if (tm && mname && !msgType.has(mname)) msgType.set(mname, tm[1]);
  }
  const pairs = channels.filter((c) => msgType.has(c.msg))
    .map((c) => ({ channel: c.channel, msg: c.msg, type: msgType.get(c.msg) }));  // 三种身份见下
  return {
    pairs,
    types: [...new Set(pairs.map((x) => x.type))],
    channels: [...new Set(pairs.map((x) => x.channel))],
    dangling: channels.filter((c) => !msgType.has(c.msg)).map((c) => c.channel),
  };
}

function walkTsPy(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (['node_modules', 'dist', 'coverage', '__pycache__'].includes(e.name)) continue;
      walkTsPy(path.join(dir, e.name), out);
    } else if (/\.(ts|tsx|js|py)$/.test(e.name)) out.push(path.relative(ROOT, dir) === '.' ? e.name : path.join(path.relative(ROOT, dir), e.name));
  }
  return out;
}

/**
 * 一个事件的全部命中。
 * 匹配必须带**词边界**：`TaskCreated` 是 `AgentTaskCreated` 的子串，
 * 用 includes() 会把别人的事件认成它的发射方（V133 实测：52/70 这个数就是这么虚出来的）。
 * 点与下划线视作同一分隔（通道用点、类型串用下划线），因此不再另生成下划线变体。
 */
// 转义与"点/下划线等价"必须在一次扫描里做：先转义会把 `.` 变成 `\.`，
// 之后再替换 `.` 就得到字面量 `\[._\]`，任何行都匹配不上（V133 实测：全体掉进弱命中桶）。
function esc(v) { return v.replace(/[.*+?^${}()|[\]\\]/g, (m) => (m === '.' ? '[._]' : '\\' + m)); }
function findHits(needle, files, read, extra = []) {
  const dep = (x) => x.replace(/^com[._]ewoh[._]/, '');
  const strongNames = [...new Set([needle, dep(needle), ...extra.filter(Boolean).map(String)])].filter((v) => v.length > 3);
  const tail = needle.split('.').filter((x) => x !== 'com' && x !== 'ewoh').pop();
  const strongRe = strongNames.map((v) => new RegExp(`(?<![\\w])${esc(v)}(?![\\w])`));
  const anyRe = strongRe.concat(tail && tail.length > 3 ? [new RegExp(`(?<![\\w])${esc(tail)}(?![\\w])`)] : []);
  if (!anyRe.length) return [];
  const hits = [];
  for (const f of files) {
    const lines = read(f);
    for (let i = 0; i < lines.length; i++) {
      if (!anyRe.some((re) => re.test(lines[i]))) continue;
      const isStrong = strongRe.some((re) => re.test(lines[i]));
      hits.push({ file: f, line: i + 1, text: lines[i].trim(), strong: isStrong, win: lines.slice(Math.max(0, i - 2), i + 3).join('\n') });
    }
  }
  return hits;
}

/** 纯函数：一个事件 → 桶 + 证据。files/read 注入，自测用合成语料。 */
function classify(name, files, read, extra = []) {
  const hits0 = findHits(name, files, read, extra);
  const hits = hits0.filter((h) => h.strong);
  if (hits.length === 0) return { bucket: hits0.length ? 'none-strong-only-tail' : 'none', hits: hits0.slice(0, 3) };
  const real = hits.filter((h) => !PROJECTION_RE.test(h.file));
  if (real.length === 0) return { bucket: 'validate-only', hits: hits.slice(0, 3) };
  const prod = real.filter((h) => !TEST_RE.test(h.file));
  if (prod.length === 0) return { bucket: 'test-only', hits: real.slice(0, 3) };
  const direct = prod.filter((h) => EMIT_SHAPE.test(h.win));
  if (direct.length) {
    // 发射行本身不含字面量（值经常量传入）⇒ 记 alias=true 而不是另开一桶。
    // 原先这里有个 emit-alias 桶，实测它和 emit 只差"定义行在不在发布行的 ±2 窗口里"——
    // 靠行相邻性区分的桶必然误标 ⇒ 合并成 emit + alias 标志，headline 仍是"有没有构造点"。
    const alias = !prod.filter((h) => EMIT_SHAPE.test(h.text)).some((h) => h.text.includes(name));
    return { bucket: 'emit', alias, hits: direct.slice(0, 3) };
  }
  // 字面量只出现在常量定义里？看那个常量名是否在别处被引用
  for (const h of prod) {
    const m = ALIAS_DEF.exec(h.text);
    if (!m) continue;
    const constName = (h.text.match(/([A-Za-z_$][\w$.]*)\s*[:=]\s*['"`]/) || [])[1];
    if (!constName) continue;
    const useRe = new RegExp(`\\b${constName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    const uses = findHits(constName, files, read).filter((o) => o.strong
      && o.text.includes(constName) && !(o.file === h.file && o.line === h.line));
    const usedElsewhere = uses.some((o) => !PROJECTION_RE.test(o.file) && !TEST_RE.test(o.file));
    if (usedElsewhere) return { bucket: 'emit', alias: true, hits: [h].concat(prod.slice(0, 2)) };
  }
  return { bucket: 'mention-only', hits: prod.slice(0, 3) };
}

function bucketsOf(res) {
  const b = {};
  for (const v of Object.values(res)) b[v.bucket] = (b[v.bucket] || 0) + 1;
  return b;
}

if (SELF) {
  const FILES = [
    'contracts/events/event-catalog.yaml', 'contracts/event_catalog.py', 'shared/event-catalog.ts',
    'srv/a.service.ts', 'srv/b.service.ts', 'srv/c.service.ts',
    'edge/up.py', 'x/__tests__/d.spec.ts', 'edge/alias.py', 'srv/ment.ts', 'srv/mclass.ts',
  ];
  const TXT = {
    'contracts/events/event-catalog.yaml': ['channels:', '  task.created:', "      publish:", "        message:", "          $ref: '#/components/messages/TaskCreated'",
      '  no.emitter:', "      publish:", "        message:", "          $ref: '#/components/messages/NoEmitter'",
      'components:', '  messages:', '    TaskCreated:', '      x-cloud-events:', '        type: com.ewoh.task.created', '        payload:', '          type: object',
      '    NoEmitter:', '      x-cloud-events:', '        type: com.ewoh.no.emitter'],
    'contracts/event_catalog.py': ["EVENT_CATALOG_TYPES = frozenset(['com.ewoh.device.birth'])"],
    'shared/event-catalog.ts': ["export const EVENT_CATALOG_TYPES = ['com.ewoh.device.birth'];"],
    'srv/a.service.ts': ["  await this.outbox.insert({ type: 'task.created', payload });"],
    'srv/b.service.ts': ["  this.logger.log('com.ewoh.task.state.changed 已在本迭代停用');"],
    'srv/c.service.ts': ["  const T_ORDER = 'com.ewoh.order.received';", "  await this.bus.publish({ type: T_ORDER, body });"],
    'edge/up.py': ["await uplink.publish(event_type='com.ewoh.telemetry.observed', data=d)"],
    'x/__tests__/d.spec.ts': ["expect(rows).toContain('com.ewoh.asset.conformance.failed')"],
    'edge/alias.py': ["BIRTH = 'com.ewoh.device.state_changed'", "    await uplink.publish_frame(BIRTH)"],
    'srv/ment.ts': ["  // 见 com.ewoh.only.mentioned 的工单"],
    // 只经消息类名构造（锁定投影用的就是这一形）——接上第三种身份后必须认成 emit
    'srv/mclass.ts': ["  await this.bus.publish(new TaskCreated({ taskId }));"],
    'p2.py': [],
  };
  const files = FILES.filter((f) => TXT[f]);
  const read = (f) => (TXT[f] || []).join('\n').split('\n');
  const names = [
    ['task.created', 'emit', false],   // 通道名字面量就在发射行上（真实代码形状）
    ['com.ewoh.device.birth', 'validate-only', null],
    ['com.ewoh.telemetry.observed', 'emit', false],
    ['com.ewoh.asset.conformance.failed', 'test-only', null],
    ['com.ewoh.order.received', 'emit', true],   // 发射行里只有常量名 ⇒ alias=true
    ['com.ewoh.device.state_changed', 'emit', true],
    ['com.ewoh.only.mentioned', 'mention-only', null],
    ['com.ewoh.never.used', 'none', null],
  ];
  let bad = 0;
  for (const [n, want, wantAlias] of names) {
    const r0 = classify(n, files, read);
    const aliasTxt = r0.alias === undefined ? '' : r0.alias ? '（经别名）' : '（字面量）';
    const ok = r0.bucket === want && (wantAlias === undefined || wantAlias === null || r0.alias === wantAlias);
    if (!ok) bad++;
    console.log(`${ok ? '✅' : '❌'} 分桶 ${n} ⇒ ${r0.bucket}${aliasTxt}${ok ? '' : `（期望 ${want}${wantAlias === true ? '+经别名' : wantAlias === false ? '+字面量' : ''}）`}`);
  }
  // 反向控制：把发射点拔掉，同一判据必须从 emit 退到 validate-only / none —— 否则"发射方存在"是白给的
  // 第三种身份的专用反证：拔掉字面量发射点、只留 `new TaskCreated(...)` ⇒ 仍必须判 emit
  const dCls = classify('task.created', files.filter((f) => f !== 'srv/a.service.ts'), read,
    ['TaskCreated', 'com.ewoh.task.created', 'task.created']).bucket;
  console.log(`${dCls === 'emit' ? '✅' : '❌'} 只经消息类名构造也认成 emit（实得 ${dCls}）`);
  if (dCls !== 'emit') bad++;
  const noEmit = files.filter((f) => f !== 'srv/a.service.ts');
  const d1 = classify('task.created', noEmit, read).bucket;
  console.log(`${d1 !== 'emit' ? '✅' : '❌'} 拔掉发射文件后 task.created ⇒ ${d1}（必须不再是 emit）`);
  if (d1 === 'emit') bad++;
  const noAny = files.filter((f) => f !== 'edge/up.py' && f !== 'x/__tests__/d.spec.ts');
  const d2 = classify('com.ewoh.telemetry.observed', noAny, read).bucket;
  console.log(`${d2 === 'none' ? '✅' : '❌'} 全仓无命中 ⇒ none（实得 ${d2}）`);
  if (d2 !== 'none') bad++;
  // 对账：每个声明必落一桶，桶计数之和 = 声明数（不允许"没归类"）
  const cat = parseCatalog(TXT['contracts/events/event-catalog.yaml'].join('\n'));
  const res = {};
  for (const x of cat.pairs) res[x.channel] = classify(x.channel, files, read, [x.msg, x.type, x.type.replace(/^com\.ewoh\./, '')]);
  const sum = Object.values(bucketsOf(res)).reduce((a, b2) => a + b2, 0);
  const okRecon = cat.pairs.length === 2 && sum === 2 && cat.channels.length === 2 && cat.dangling.length === 0;
  console.log(`${okRecon ? '✅' : '❌'} 对账：两跳解析出 ${cat.pairs.length} 对（悬空 ${cat.dangling.length}），落桶合计 ${sum}`);
  if (!okRecon) bad++;
  console.log(bad ? `发射方普查判据自测：不通过（${bad} 项失败 / 共 11 项）` : '发射方普查判据自测：通过（11 项：8 个分桶真值含字面量/别名之分 + 拔发射点必须退桶 + 全仓无命中⇒none + 落桶对账）');
  process.exit(bad ? 1 : 0);
}

const catText = fs.readFileSync(path.join(ROOT, CATALOG), 'utf8');
const { pairs, types, channels } = parseCatalog(catText);
if (pairs.length < 10) {
  console.error(`不可判：目录只解析出 ${pairs.length} 个 (通道,类型) 对 ⇒ 分母不成立（不把"没解析到"当成"没有"）`);
  process.exit(1);
}
const files = [];
for (const d of CORPUS) for (const f of walkTsPy(path.join(ROOT, d))) files.push(f);
const cache = new Map();
const read = (f) => {
  if (!cache.has(f)) cache.set(f, fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n'));
  return cache.get(f);
};
const res = {};
for (const x of pairs) res[x.channel] = classify(x.channel, files, read, [x.msg, x.type, x.type.replace(/^com\.ewoh\./, '')]);
const keys = pairs.map((x) => x.channel);
const bk = {};
for (const t of keys) bk[res[t].bucket] = (bk[res[t].bucket] || 0) + 1;
const buckets = ['emit', 'validate-only', 'test-only', 'mention-only', 'none', 'none-strong-only-tail'];
const missing = buckets.filter((b) => bk[b] === undefined);
const sum = Object.values(bk).reduce((a, b) => a + b, 0);
console.log(`事件目录声明 ${types.length} 个类型 / ${pairs.length} 个通道（普查按通道，代码用的就是这个名字）｜语料 ${files.length} 个 .ts/.js/.py 文件（含测试，测试命中单列一桶）`);
console.log(`分桶 ${JSON.stringify(bk)}`);
console.log(sum === pairs.length ? `  ✅ 对账：落桶合计 ${sum} = 通道数 ${pairs.length}（无未归类）` : `  ❌ 对账不成立：${sum} ≠ ${types.length}`);
const covered = bk['emit'] || 0;
const aliasN = keys.filter((t) => res[t].bucket === 'emit' && res[t].alias).length;
console.log(`  有构造点 = ${covered}/${pairs.length} = ${(covered * 100 / pairs.length).toFixed(0)}%（其中经常量别名发射 ${aliasN} 个）｜只在契约/锁定投影里出现（= 没人构造它）= ${bk['validate-only'] || 0}｜全仓零命中 = ${bk['none'] || 0}｜未归类 = ${sum - pairs.length}`);
console.log('  读法边界：桶按"构造形状"分，不是按"运行期真发过"分——静态普查证明不了某条事件今天确实在被投递，只能证明有没有代码在构造它。');
for (const b of buckets.filter((x) => bk[x])) {
  console.log(`\n【${b}】${bk[b]} 个`);
  for (const t of keys.filter((x) => res[x].bucket === b)) {
    const ev = res[t].hits.map((h) => `${h.file}:${h.line}`).slice(0, VERBOSE ? 9 : 1).join(' ');
    console.log(`  ${t}${ev ? `  ← ${ev}` : ''}`);
  }
}
fs.writeFileSync(path.join(ROOT, 'tmp/contract-emitters.json'), JSON.stringify({ channels: res, bk, pairs }, null, 1));
console.log('\n机器可读结果：tmp/contract-emitters.json');
process.exit(sum === types.length ? 0 : 1);
