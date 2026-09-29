#!/usr/bin/env node
/*
 * V182 量具（FLAKE-04 普查）：常驻链级用例里，哪些**断言的成立与否取决于跑了多少墙上时间**，
 * 而不是取决于语义。FLAKE-03 已证实一处这种形状（AV-01 断 |approvedAt−createdAt| ≤ 2ms，
 * 而观测分布是 −1/−3/−2/−2 ms ⇒ 阈值落在自身分布里，红不红取决于机器快慢）。本尺回答 FLAKE-04
 * 登记的那句"未数过就登记等于没登记"：同一族在 22 个常驻 spec 里到底有多少条，逐条摆出来给人读码。
 *
 * 只答一问：把"随墙上时间而变"的判据形状分两轴数出来，每条给出 file:行 + 代码 + 所属用例块 + 一个
 * **启发式分桶**；分桶不是裁决——「运气常数／语义必需」由人工逐条读码决定（本尺不冒充语义判断）。
 *
 * 轴 A：对"时间量"的比较断言。判据（三个条件全满足才算命中，缺一即不计）：
 *   1) 形状是 expect(<subj>).toBe{LessThan,LessThanOrEqual,GreaterThan,GreaterThanOrEqual,CloseTo}(<arg>)；
 *   2) <subj> 或 <arg> 带**时间信号**（Date.now/getTime/Date.parse/…Ms/…_ms/…timestamp/expires/expiry/
 *      span/elapsed/remaining/duration/deadline/两个 *Ms 相减）；
 *   3) <arg> 里有数字字面量。
 *   ——时间信号这一道是关键鉴别：`status).toBeLessThan(400/500)`（HTTP 码）、`length).toBeGreaterThan(0)`
 *   （计数）都因主语无时间信号被排除（GATE-22 教训：纯文本签名会过匹配，必须把判据收到"同一族"上）。
 *   <arg> 分桶：
 *     · sign-zero   ：阈值就是 0（≥0/>0 的符号不变量，语义，不是门限）；
 *     · bare-literal：阈值是裸数字字面量（1_500/1_000/2）⇒ **运气常数候选**，逐条读；
 *     · derived     ：阈值由变量算出（Math.floor(span/4)、span*3/4）⇒ 尺度与观测同源于用例自造窗口（FLAKE-03 修法形状）；
 *     · named-bound ：阈值引用具名常量（VALIDITY_MS − 1_000）⇒ 语义窗口（若带小偏移仍打印）。
 *
 * 轴 B：固定 sleep 沉降窗。找 setTimeout/delay/sleep(<数字字面量>)，按**所在块是否有 deadline 轮询**分：
 *     · bounded-poll：块内有 deadline/Date.now 界 + 循环 ⇒ sleep 只是轮询间隔（正确形状，不计风险）；
 *     · fixed-settle：sleep 不在 deadline 轮询里 ⇒ 一次睡够再读/断，沉降时长写死（运气窗口候选）。
 *   与 V170 convergence-sites 的 waitOnly 档相邻但不等价（那个问"等待是否绑到终态"，本轴问"沉降时长是否写死且无界守卫"）。
 *   **范围边界（必须如实，勿过度信任 bounded-poll=0）**：判定单位是 it()/test() 用例块，沿用 convergence-sites 的
 *   blocks() 枚举器 ⇒ 它() 之前的**顶层 helper 函数**（如 pg-temporary-failure 的 startStandalone、
 *   agent-task-cas-window 的 waitLockedUpdate 里的 `while(Date.now()<deadline){…await delay(200)}` 轮询）
 *   整体落在首块之前的前区、被枚举器丢弃 ⇒ 既不算 fixed-settle 也不算 bounded-poll。故 fixed-settle 计数是
 *   **测试体内**裸沉降 sleep 的上界，且"bounded-poll=0"只代表"没有与这些 sleep 同块出现的 deadline 轮询"，
 *   不代表"全仓无正确形状的轮询"（helper 里的那些看不见）。要覆盖 helper 需函数边界解析，超出本尺范围。
 *
 * 轴 C（V198·FLAKE-06）：把轴 B 的 `fixed-settle` 再切一刀——**同块内在该 sleep 命中之后**出现"把外部东西打断"
 * 的动作（窄档词形 `pg_terminate_backend`／`SIGKILL`／`SIGTERM`／`.kill(`）⇒ 该命中改判 `bet-window`
 * （押注重叠：sleep 的长度就是在赌"注入发生时那个东西还在飞"），否则维持原桶。
 *   与 FLAKE-05 的对应：改前的 S-00 `delay(30)` 后紧跟 terminate ⇒ 应落 bet-window；改后的 S-00
 *   （先 deadline 轮询确证 `state='active'` 再 terminate）⇒ **不得**落 bet-window（轴 C 命中它即读数作废）。
 *   四条边界（勿把"看得见"读成"归对类"）：① 方向只看命中**之后**的块体文本——注入在 sleep 之前属"等效果沉降"，
 *   不在本轴这一问里；② 只有 `fixed-settle` 参与改判，`bounded-poll` 块不改判（确证式轮询正是修法形状）；
 *   ③ 宽词形 `.close(`／`.end(` **只观察不改判**（记为 `weakTrigger`）：连接池与子进程收尾在 e2e 里几乎每块尾部
 *   都有，把它们算进判决等于把整张清单判成命中——实测宽档 15 处 fixed-settle 有 10 处仅因这两个词翻桶
 *   （取证 `tmp/v198-timing-wide-arm.log`），而其中不含任何 terminate／kill（GATE-22 同族教训：判据必须收到同一族）；
 *   ④ 分桶仍是启发式：bet-window 的触发词只证明"之后确实有打断动作"，是否真在重叠要逐条读码；
 *   ⑤ 每条命中另打 `inLoop`（该 sleep 是否在 while/for 体内）**只作观察**：V198 试过把它当豁免，被自家
 *   控制实验证伪——改前那条 `delay(30)` 正写在 `for (let attempt…)` 重试循环里，"在循环里"与"确证式轮询"
 *   不等价（不看结果的循环本身就是押注），豁免会把唯一真阳性放走 ⇒ 已撤销，只留读数。
 *
 * 分母来自 harness 自身：CHAIN_SPECS 从 verify.sh 现抽（解析 <5 个即拒绝出数——matrix-check 教训），
 * 逐个解析到 test/e2e/<name>.e2e.spec.ts；文件缺失即报错退出，绝不把"看不见"折算成"干净"。
 *
 * 反证（--self-test）：先跑判据自测再出裁决（instrument-validation 纪律）。正向必开火：
 *   A-POS 裸毫秒常数、A-POS2 两个 *Ms 相减比裸常数、A-POS3 具名窗口带偏移、A-POS4 尺度同源；
 *   反向必不开火：A-NEG HTTP 码 toBeLessThan(400)、A-NEG2 length>0、A-NEG3 符号 sign-zero、A-NEG4 jest 超时实参；
 *   B-POS 无守卫固定 sleep；B-NEG deadline 轮询里的 sleep(25)、B-NEG2 纯 delay 轮询；
 *   C-POS 固定 sleep 之后紧跟 pg_terminate_backend、C-POS2 之后紧跟 child.kill( ⇒ 必判 bet-window（并核触发词）；
 *   C-NEG 确证式轮询后才 terminate（必**不**判 bet-window，走的是轴 B 的 deadline 轮询豁免）、C-NEG2 同一枚
 *   sleep 去掉 terminate（必回落 fixed-settle）、C-NEG3 注入在 sleep 之前（钉住方向）、C-NEG4 之后只有收尾
 *   close()/end()（维持 fixed-settle 且必须记下 weakTrigger，钉住"宽词形只观察不改判"）、
 *   C-边界1（按次数有界的循环＋注入写在循环之后 ⇒ 现判据**会**误判押注，钉住已知误判面）与它的对照
 *   （摘掉循环外壳仍判押注 ⇒ 证明 inLoop 观察档不参与判决）。
 *   任一不过 ⇒ 退出码非零、本轮不出数。已知边界：轴 A 的 <arg> 在第一个右括号处截断（`Math.floor((x*3)/4)`
 *   只读到 `Math.floor((x*3`），分桶不受影响但阈值原文可能不完整——需要精确门限值时以行为准读码。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { blocks } = require('./convergence-sites.cjs');

const ROOT = path.resolve(__dirname, '../..');
const APP = path.join(ROOT, 'ewoh-spark-app');
const VERIFY = path.join(__dirname, 'verify.sh');
const E2E_DIR = path.join(APP, 'test', 'e2e');

/** 时间信号：主语或阈值携带其一，才可能属"时间量比较"族。 */
const TIME_SIGNAL = /(Date\.now|getTime|Date\.parse|\b\w*[Mm]s\b|_ms\b|timestamp|expires|expiry|\bspan\b|elapsed|remaining|duration|deadline)/i;
/** 比较断言：两种捕获——`.not.toBe…(`（无门限，跳过）与 `.toBe{Lt,Lte,Gt,Gte,CloseTo}(<arg>)`。 */
const CMP_RE = /expect\s*\(([\s\S]*?)\)\s*\.not\s*\.toBe\w*\(|expect\s*\(([\s\S]*?)\)\.toBe(?:LessThan|LessThanOrEqual|GreaterThan|GreaterThanOrEqual|CloseTo)\(([^)]*?)\)/g;
/** 数字字面量（含 JS 下划线分隔：1_500）。 */
const NUM = /(^|[^\w.])\d[\d_]*(\.\d+)?/;
/** 纯数字阈值。 */
const PURE_NUM = /^[\d_]+(\.\d+)?$/;

/** 从 verify.sh 现抽 CHAIN_SPECS（跨反斜杠续行拼接；解析 <5 个即拒绝，防空清单误报）。 */
function chainSpecs() {
  const text = fs.readFileSync(VERIFY, 'utf8');
  const i = text.indexOf('CHAIN_SPECS=');
  let seg = '';
  if (i !== -1) {
    let j = i + 'CHAIN_SPECS='.length;
    while (j <= text.length) {
      const nl = text.indexOf('\n', j);
      const line = text.slice(j, nl === -1 ? text.length : nl);
      seg += ' ' + line.replace(/\\$/, '');
      if (!/\\\s*$/.test(line) || nl === -1) break;
      j = nl + 1;
    }
  }
  const names = [...new Set((seg.match(/[a-z0-9][a-z0-9-]*-[a-z0-9-]*/g) || []))];
  if (names.length < 5) {
    console.error(`✕ 从 verify.sh 解析到 ${names.length} 个 CHAIN_SPECS（<5）⇒ 分母不可信，拒绝出数`);
    process.exit(1);
  }
  return names;
}

function strip(line) {
  return line.replace(/\/\/.*$/, '');
}

/** 判 <arg> 的分桶。arg 已去掉两侧空白。 */
function bucketArg(arg) {
  const a = arg.trim();
  if (a === '0') return 'sign-zero';
  if (PURE_NUM.test(a)) return 'bare-literal';
  const hasIdent = /[A-Za-z_$]/.test(a);
  const arithmeticDerived = /Math\.|[/*%]|\bspan\b|\bspan05\b/.test(a);
  if (hasIdent && arithmeticDerived) return 'derived';
  if (hasIdent && NUM.test(a)) return 'named-bound';
  if (hasIdent) return 'derived';
  return 'bare-literal';
}

/** 轴 A：扫描一份文件的时间量比较断言。 */
function axisA(rel, text) {
  const out = [];
  for (const b of blocks(text)) {
    const lines = b.body.split('\n');
    for (let k = 0; k < lines.length; k += 1) {
      const raw = lines[k];
      const line = strip(raw);
      let m;
      CMP_RE.lastIndex = 0;
      while ((m = CMP_RE.exec(line)) !== null) {
        const subj = m[1] !== undefined ? m[1] : m[2]; // 第2捕获=比较分支的主语
        const arg = m[3];
        if (subj === undefined || arg === undefined) continue; // .not.toBe 分支无门限
        if (!(TIME_SIGNAL.test(subj) || TIME_SIGNAL.test(arg))) continue;
        if (!NUM.test(arg)) continue; // 阈值里必须有数字才谈"常数"
        out.push({
          rel,
          label: b.label,
          bucket: bucketArg(arg),
          subj: subj.trim().slice(0, 80),
          arg: arg.trim(),
          code: raw.trim().slice(0, 140),
        });
      }
    }
  }
  return out;
}

/** 轴 C 注入动作词形·窄档（改变判决）：把外部东西"打断"的调用／信号。 */
const INJECT_RE = /pg_terminate_backend|\bSIGKILL\b|\bSIGTERM\b|\.kill\(/;
/**
 * 该 sleep 命中点是否落在循环体（`while`／`for` 的花括号）内——**只作观察，不参与判决**。
 * 为什么不参与：V198 实测把它当豁免时被自家控制实验证伪——改前那条 `delay(30)` 本来就写在
 * `for (let attempt = 0; …)` 重试循环里（HEAD 版字节复算即 bet-window，加了豁免就变成漏判），
 * 而"循环"与"确证式轮询"并不等价：不观察结果的循环正是押注本身。区分二者要数据流（注入是否被
 * 循环内的观察结果所门控），超出本尺一问的范围 ⇒ 只把 inLoop 打出来给人读码。
 * 实现：逐字符走到命中点，`{` 处回看紧邻前文是否是 `while(...)`／`for(...)` 头并压栈，`}` 出栈。
 */
function insideLoopBody(text, index) {
  const stack = [];
  for (let i = 0; i < index && i < text.length; i += 1) {
    const c = text[i];
    if (c === '}') { stack.pop(); continue; }
    if (c !== '{') continue;
    const back = text.slice(Math.max(0, i - 160), i).replace(/\s+$/, '');
    stack.push(/\b(?:while|for)\s*\((?:[^()]|\([^()]*\))*\)$/.test(back));
  }
  return stack.some((isLoop) => isLoop);
}
/**
 * V204 平行档（**只读数，不改判、不参与轴 C**）：这条 sleep 命中点**自己**是否写在某个循环体内，
 * 以及那个循环头有没有上界。与 insideLoopBody 的差别：那个只答"在不在任一循环里"，这里取回
 * **最近一层循环的头文本**，因为只有带上界（计数式 for／Date.now() deadline／due／attempt）的循环
 * 才把固定 sleep 变成"轮询间隔"。轴 B 现行判据是**块级**的（同块有循环＋同块有 deadline ⇒ 整块算轮询），
 * 两个方向都会错：块里没有 deadline 时会把"写在重试循环里的间隔"读成等静默；块里有 deadline 轮询时
 * 会把尾部那次"一次性读"洗成轮询间隔。本档逐条求值，把这两个分歧面打印出来。
 */
/** do/while 的循环头在**体后**（`do { … } while (cond);`），单向前扫栈看不见 ⇒ 先扫一遍区间。 */
function doWhileRanges(text) {
  const out = [];
  const re = /\bdo\s*\{/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < text.length && depth > 0) {
      if (text[i] === '{') depth += 1;
      else if (text[i] === '}') depth -= 1;
      i += 1;
    }
    if (depth !== 0) continue;
    const tail = text.slice(i, i + 200);
    const wm = /^\s*while\s*\(([^)]*)\)/.exec(tail);
    if (!wm) continue;
    const bounded = /\bdue\b|deadline|Date\.now\(\)|attempt|\w+\s*[<>]=?\s*\w/.test(wm[1]);
    out.push({ open: m.index, close: i, bounded });
    re.lastIndex = i;
  }
  return out;
}
function sleepLoopScope(text, index) {
  const stack = [];
  for (let i = 0; i < index && i < text.length; i += 1) {
    const c = text[i];
    if (c === '}') { stack.pop(); continue; }
    if (c !== '{') continue;
    const back = text.slice(Math.max(0, i - 160), i).replace(/\s+$/, '');
    const hm = /\b(?:while|for)\s*\((?:[^()]|\([^()]*\))*\)$/.exec(back);
    stack.push(hm ? hm[0] : null);
  }
  for (let k = stack.length - 1; k >= 0; k -= 1) {
    const head = stack[k];
    if (!head) continue;
    const bounded = /;\s*[^;()]*[<>!=]\s*[^;()]*/.test(head) || /Date\.now\(\)\s*[<>]|\bdue\b|deadline|attempt/.test(head);
    return bounded ? 'in-bounded-loop' : 'in-unbounded-loop';
  }
  // 栈里没有循环头时，再问一次 do/while 区间（它的头写在体后，栈那条路走不到）。
  for (const r of doWhileRanges(text)) {
    if (index > r.open && index < r.close) return r.bounded ? 'in-bounded-loop' : 'in-unbounded-loop';
  }
  return 'not-in-loop';
}

/** 轴 C 宽词形·只观察不改判：连接池／子进程收尾（`close()`／`end()`）在 e2e 里几乎每块尾部都有，
 *  算进判决会把整张 fixed-settle 清单判成命中（实测 15 处里 9 处只因它翻桶）——GATE-22 同族教训。 */
const WEAK_INJECT_RE = /\.close\(|\.end\(/;

/** 轴 B：固定 sleep 沉降窗（含 V198 轴 C 的 bet-window 改判）。 */
function axisB(rel, text) {
  const out = [];
  for (const b of blocks(text)) {
    const body = strip(b.body).split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    const boundedPoll = /(while\s*\(|for\s*\(|expect\.poll|\.poll\s*\()/.test(body)
      && /(Date\.now\(\)\s*[<>]|\bdue\b|deadline)/.test(body);
    const re = /setTimeout\s*\([^,]+,\s*([\d_]+)\s*\)|\bdelay\s*\(\s*([\d_]+)\s*\)|\bsleep\s*\(\s*([\d_]+)\s*\)/g;
    let m;
    while ((m = re.exec(body)) !== null) {
      const ms = Number((m[1] || m[2] || m[3]).replace(/_/g, ''));
      if (!Number.isFinite(ms) || ms <= 0) continue;
      let bucket = boundedPoll ? 'bounded-poll' : 'fixed-settle';
      let trigger = null;
      let weakTrigger = null;
      const inLoop = insideLoopBody(body, m.index);
      const sleepScope = sleepLoopScope(body, m.index);
      const rest = body.slice(m.index + m[0].length);
      const im = INJECT_RE.exec(rest);
      const wm = WEAK_INJECT_RE.exec(rest);
      if (bucket === 'fixed-settle' && im) { bucket = 'bet-window'; trigger = im[0]; }
      else if (bucket === 'fixed-settle' && wm) weakTrigger = wm[0];
      out.push({ rel, label: b.label, bucket, ms, code: m[0].slice(0, 80), trigger, weakTrigger, inLoop, sleepScope });
    }
  }
  return out;
}

function scanFiles(files) {
  const a = [];
  const b = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f);
    const text = fs.readFileSync(f, 'utf8');
    a.push(...axisA(rel, text));
    b.push(...axisB(rel, text));
  }
  return { a, b };
}

function countBy(rows) {
  const o = {};
  for (const r of rows) o[r.bucket] = (o[r.bucket] || 0) + 1;
  return o;
}

function selfTestCases() {
  return [
    ['A-POS 裸毫秒常数', "it('x',()=>{expect(Math.abs(aMs-bMs)).toBeLessThanOrEqual(2);});", 'axisA', ['bare-literal']],
    ['A-POS2 两Ms相减比裸常数', "it('y',()=>{expect(Math.abs(approveCallMs - approvedMs)).toBeGreaterThanOrEqual(1_500);});", 'axisA', ['bare-literal']],
    ['A-POS3 具名窗口带偏移', "it('z',()=>{expect(expiresMs - approveCallMs).toBeLessThan(VALIDITY_MS - 1_000);});", 'axisA', ['named-bound']],
    ['A-POS4 尺度同源', "it('w',()=>{expect(Math.abs(approvedMs - createdMs)).toBeLessThanOrEqual(Math.floor(span / 4));});", 'axisA', ['derived']],
    ['A-NEG HTTP码', "it('s',()=>{expect(receipt.status).toBeLessThan(400);});", 'axisA', []],
    ['A-NEG2 计数', "it('c',()=>{expect(plan.assignments.length).toBeGreaterThan(0);});", 'axisA', []],
    ['A-NEG3 符号零', "it('g',()=>{expect(Number(i.remainingMs ?? 0)).toBeGreaterThanOrEqual(0);});", 'axisA', ['sign-zero']],
    ['A-NEG4 jest超时实参', "it('t',()=>{expect(1).toBe(1);}, 180_000);", 'axisA', []],
    ['B-POS 无守卫固定sleep', "it('f',async()=>{await new Promise((r)=>setTimeout(r,10000));const v=await read();expect(v).toBe(1);});", 'axisB', ['fixed-settle']],
    ['B-NEG deadline轮询里的sleep', "it('p',async()=>{const dl=Date.now()+30000;while(Date.now()<dl){const r=await read();if(r)break;await new Promise((x)=>setTimeout(x,25));}});", 'axisB', ['bounded-poll']],
    ['B-NEG2 纯delay轮询', "it('q',async()=>{const due=Date.now()+5000;while(Date.now()<due){await delay(1000);if(await done())break;}});", 'axisB', ['bounded-poll']],
    ['C-POS 固定sleep后terminate', "it('c1',async()=>{await delay(30);await sql`select pg_terminate_backend(pid) from x`;});", 'axisB', ['bet-window'], ['pg_terminate_backend'], [null]],
    ['C-POS2 固定sleep后kill子进程', "it('c1b',async()=>{await delay(500);child.kill('SIGKILL');});", 'axisB', ['bet-window'], ['.kill('], [null]],
    ['C-NEG2 同sleep去掉terminate', "it('c2',async()=>{await delay(30);const v=await read();expect(v).toBe(1);});", 'axisB', ['fixed-settle'], [null], [null]],
    ['C-NEG4 只有收尾close（宽词形不改判）', "it('c2b',async()=>{await pool.end();await delay(3000);await db.close();});", 'axisB', ['fixed-settle'], [null], ['.close(']],
    ['C-NEG 确证式轮询后才terminate', "it('c3',async()=>{const dl=Date.now()+3000;let ok=false;while(Date.now()<dl){const r=await activeBackends();if(r.length>=2){ok=true;break;}await delay(2);}if(!ok)throw new Error('窗口没构造出来');await sql`select pg_terminate_backend(pid) from x`;});", 'axisB', ['bounded-poll'], [null], [null]],
    ['C-NEG3 注入在sleep之前', "it('c4',async()=>{await sql`select pg_terminate_backend(pid) from x`;await delay(30);const v=await read();expect(v).toBe(1);});", 'axisB', ['fixed-settle'], [null], [null]],
    ['C-边界1 确证循环但注入在循环之后(现判据误判为押注)', "it('c5',async()=>{async function killActive(){for(let i=0;i<600;i+=1){const pids=await activeBackends();if(pids.length>0){return pids[0];}await delay(2);}}const pid=await killActive();await sql`select pg_terminate_backend(pid)`;});", 'axisB', ['bet-window'], ['pg_terminate_backend'], [null]],
    ['C-边界1对照 摘掉循环外壳判决不变(证明inLoop不参与判决)', "it('c6',async()=>{const pids=await activeBackends();if(pids.length>0){await delay(2);await sql`select pg_terminate_backend(pid)`;}});", 'axisB', ['bet-window'], ['pg_terminate_backend'], [null]],
    ['V204-POS1 sleep自己在计数循环里(块级判据读成等静默)', "it('v1',async()=>{for(let attempt=0;attempt<12;attempt+=1){if(await settled())break;await delay(800);}});", 'axisB', ['fixed-settle'], [null], [null], ['in-bounded-loop']],
    ['V204-NEG1 块里有deadline轮询⇒块级判据把循环外那次一次性读也洗成轮询间隔', "it('v2',async()=>{const dl=Date.now()+3000;while(Date.now()<dl){if(await q())break;await delay(5);}await delay(900);});", 'axisB', ['bounded-poll','bounded-poll'], [null,null], [null,null], ['in-bounded-loop','not-in-loop']],
    ['V204-POS2 do/while 带 deadline ⇒ 循环头在体后也必须认到有界循环', "it('v3',async()=>{const due=Date.now()+20000;let s=null;do{await new Promise((r)=>setTimeout(r,500));s=await probe();}while(s&&s.status>=500&&Date.now()<due);expect(s.status).toBeLessThan(500);});", 'axisB', ['bounded-poll'], [null], [null], ['in-bounded-loop']],
    ['V204-NEG2 do/while(true) 无上界 ⇒ 不得算有界', "it('v4',async()=>{do{await delay(400);}while(!(await q()));});", 'axisB', ['fixed-settle'], [null], [null], ['in-unbounded-loop']],
  ];
}

function runSelfTest(quiet) {
  const cases = selfTestCases();
  let ok = true;
  const log = quiet ? () => {} : console.log.bind(console);
  for (const [name, src, axis, want, wantTrig, wantWeak, wantScope] of cases) {
    const rows = (axis === 'axisA' ? axisA('self', src) : axisB('self', src));
    const got = rows.map((r) => r.bucket);
    const gotTrig = rows.map((r) => r.trigger || null);
    const gotWeak = rows.map((r) => r.weakTrigger || null);
    let pass = JSON.stringify(got) === JSON.stringify(want);
    if (pass && wantTrig !== undefined) pass = JSON.stringify(gotTrig) === JSON.stringify(wantTrig);
    if (pass && wantWeak !== undefined) pass = JSON.stringify(gotWeak) === JSON.stringify(wantWeak);
    const gotScope = rows.map((r) => r.sleepScope || null);
    if (pass && wantScope !== undefined) pass = JSON.stringify(gotScope) === JSON.stringify(wantScope);
    if (!pass) ok = false;
    const extra = wantTrig || wantWeak
      ? `（触发 ${JSON.stringify(gotTrig)}／弱触发 ${JSON.stringify(gotWeak)}）` : '';
    const scopeNote = wantScope !== undefined ? `＋sleep 归属 ${JSON.stringify(gotScope)}（期望 ${JSON.stringify(wantScope)}）` : '';
    log(`  ${pass ? '✔' : '✕'} ${name} → ${JSON.stringify(got)}${extra}（期望 ${JSON.stringify(want)}${wantTrig ? '＋触发 ' + JSON.stringify(wantTrig) : ''}${wantWeak ? '＋弱触发 ' + JSON.stringify(wantWeak) : ''}${scopeNote}）`);
  }
  log(ok ? `结论：尺子可用（${cases.length} 项判据自测全过）` : '结论：尺子不可用，本轮不出数');
  return { ok, n: cases.length };
}

function main() {
  const names = chainSpecs();
  const files = [];
  const missing = [];
  for (const n of names) {
    const f = path.join(E2E_DIR, `${n}.e2e.spec.ts`);
    if (fs.existsSync(f)) files.push(f); else missing.push(n);
  }
  if (missing.length) {
    console.error(`✕ CHAIN_SPECS 里 ${missing.length} 个 spec 在磁盘上缺失：${missing.join(', ')} ⇒ 分母不全，拒绝出数`);
    process.exit(1);
  }
  const { a, b } = scanFiles(files);
  const aBuckets = countBy(a);
  const bBuckets = countBy(b);
  console.log(`分母：${names.length} 个 CHAIN_SPECS（verify.sh 现抽）全部在磁盘解析成功。`);
  console.log('');
  console.log(`轴 A（时间量比较断言）共 ${a.length} 条：`
    + `bare-literal(运气常数候选) ${aBuckets['bare-literal'] || 0} · derived(尺度同源) ${aBuckets.derived || 0}`
    + ` · named-bound(具名窗口) ${aBuckets['named-bound'] || 0} · sign-zero(符号不变量) ${aBuckets['sign-zero'] || 0}`);
  for (const r of a) console.log(`  [${r.bucket.padEnd(11)}] ${r.rel} · 块「${r.label}」 · ${r.code}`);
  console.log('');
  const bet = b.filter((x) => x.bucket === 'bet-window');
  const weak = b.filter((x) => x.weakTrigger);
  const inLoopRows = b.filter((x) => x.inLoop);
  console.log(`轴 B（固定 sleep 沉降窗）共 ${b.length} 处：`
    + `fixed-settle(等静默·运气窗口候选) ${bBuckets['fixed-settle'] || 0} · bounded-poll(轮询间隔=正确形状) ${bBuckets['bounded-poll'] || 0}`
    + ` · bet-window(轴 C 改判·押注重叠) ${bet.length}`);
  {
    const scopeCount = {};
    for (const r of b) { const k = r.sleepScope || 'not-in-loop'; scopeCount[k] = (scopeCount[k] || 0) + 1; }
    const washIn = b.filter((r) => r.bucket === 'fixed-settle' && r.sleepScope === 'in-bounded-loop');
    const washOut = b.filter((r) => r.bucket === 'bounded-poll' && r.sleepScope !== 'in-bounded-loop');
    console.log('V204 平行档（只读数：不改 bucket、不参与轴 C）逐条问「这条 sleep 自己在不在有界循环里」⇒ '
      + Object.entries(scopeCount).map(([k, v]) => k + ' ' + v).join(' · '));
    console.log('  块级判据的两个分歧面：被读成等静默、其实写在有界循环里的间隔 ' + washIn.length + ' 处；'
      + '被读成轮询间隔、其实不在（有界）循环里的一次性读 ' + washOut.length + ' 处。');
    for (const r of washIn) console.log('    · [间隔被读成等静默] ' + r.rel + ' · 块「' + r.label + '」 · sleep=' + r.ms + 'ms · ' + r.code);
    for (const r of washOut) console.log('    · [一次性读被洗成间隔] ' + r.rel + ' · 块「' + r.label + '」 · sleep=' + r.ms + 'ms · ' + r.code);
    console.log('  两档都不构成改判依据：V198 已用控制实验否决\u201c把循环归属当豁免\u201d（不观察结果的循环正是押注本身），'
      + '本档只用来把 FLAKE-04 的\u201c运气常数 vs 语义必需\u201d逐条读码时少看错对象。');
  }

  for (const r of b.filter((x) => x.bucket === 'fixed-settle')) console.log(`  [fixed-settle] ${r.rel} · 块「${r.label}」 · sleep=${r.ms}ms${r.inLoop ? ' · inLoop=有(只观察)' : ''}${r.weakTrigger ? ` · 弱触发「${r.weakTrigger}」（收尾词形，只观察不改判）` : ''} · ${r.code}`);
  for (const r of bet) console.log(`  [bet-window  ] ${r.rel} · 块「${r.label}」 · sleep=${r.ms}ms · 触发词「${r.trigger}」${r.inLoop ? ' · inLoop=有（在循环里，仍判押注：不观察结果的循环正是押注本身）' : ''} · ${r.code}`);
  for (const r of b.filter((x) => x.bucket === 'bounded-poll')) console.log(`  [bounded-poll ] ${r.rel} · ${r.code}（不计风险）`);
  console.log('');
  console.log(`轴 C 差集（V198）：轴 B 命中面 ${b.length} − 轴 C 命中面 ${bet.length} = ${b.length - bet.length}`
    + `，其中 ${bBuckets['bounded-poll'] || 0} 处因"同块有 deadline 轮询"落在 bounded-poll（不参与改判）、`
    + `${bBuckets['fixed-settle'] || 0} 处维持 fixed-settle（该 sleep 之后块内无窄档打断动作）。`);
  console.log(`  inLoop 观察档（该 sleep 落在 while/for 体内，**不参与判决**）：${inLoopRows.length} 处——"在循环里"既可能是确证式轮询也可能是重试押注，逐条读码才分得开。`);
  console.log(`  弱触发观察档（宽词形 .close(／.end(，**未参与判决**）：${weak.length} 处${weak.length ? ` ⇒ ${[...new Set(weak.map((r) => r.rel))].join('、')}` : ''}；`);
  console.log('  若把它们计入判决，本轴命中面会从 ' + bet.length + ' 涨到 ' + (bet.length + weak.length) + `（宽档实测读数见 tmp/v198-timing-wide-arm.log）⇒ 已按 GATE-22 同族教训排除。`);
  console.log('  两轴问的不是同一件事：轴 B 数"时长有没有写死"，轴 C 只问"写死的时长是不是在赌与注入重叠"⇒ bet-window 少不等于"归对类"。');
  console.log('');
  console.log('说明：分桶是启发式，不是裁决。bare-literal 与 fixed-settle 是"读码优先"清单，须逐条判运气常数／语义必需；bet-window 的触发词只证明"之后有改变世界的动作"，不证明二者真在重叠。');
  fs.mkdirSync(path.join(ROOT, 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'tmp', 'timing-assertion-census.json'), JSON.stringify({
    denominator: names.length, axisA: a, axisB: b, axisABuckets: aBuckets, axisBBuckets: bBuckets,
    axisCBetWindow: bet.length, axisCWeakOnly: weak.length, axisCInLoopObserved: inLoopRows.length,
  }, null, 2) + '\n');
  console.log('机器可读：tmp/timing-assertion-census.json');
}

if (require.main === module) {
  if (process.argv.includes('--self-test')) {
    process.exit(runSelfTest(false).ok ? 0 : 1);
  }
  const st = runSelfTest(true);
  if (!st.ok) { console.error('✕ 判据自测未过 ⇒ 本轮不出数'); process.exit(1); }
  main();
}

module.exports = { axisA, axisB, chainSpecs, bucketArg, runSelfTest };
