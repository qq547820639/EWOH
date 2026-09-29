#!/usr/bin/env node
/**
 * 一问：Nest 在「有人调 app.close()」与「进程收到 SIGTERM」这两条停止路径上，**分别**调用了哪些钩子？
 *
 * 为什么要问这个：链上后台权威（投递积压巡检=expired 的唯一写者、SSE 泵、到期提醒）的清场代码
 * 全都写成 Nest 生命周期方法。方法名写错或停止路径根本不触发，`clearInterval` 就是死代码——
 * 静态读代码看不出差别，只有框架自己的分发能判。
 *
 * 四组观测 + 三组反向对照（缺任何一条，本轮不出数）：
 *   A close() 路径：真名单全开火、拼错的名不开火；
 *   B 无 enableShutdownHooks 的 SIGTERM：收尾钩子**不开火**（否定读数）；
 *   C 有 enableShutdownHooks 的 SIGTERM：收尾钩子**开火**（B 的"必须开火"对照）；
 *   D Node 侧：`setInterval(fn, NaN)` 的真实节奏 vs 合法间隔（热循环是否成立）。
 *
 * 钩子名单不靠记忆：从本机 `node_modules/@nestjs/core/hooks/utils` 里解析。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createRequire } = require('module');

const ROOT = path.resolve(__dirname, '../..');
const APP_DIR = path.join(ROOT, 'ewoh-spark-app');
const TYPO_HOOK = 'onApplicationDestroy';
const START_HOOKS = ['onModuleInit', 'onApplicationBootstrap'];
const STOP_HOOKS = ['onModuleDestroy', 'beforeApplicationShutdown', 'onApplicationShutdown'];

/** 权威钩子名单：解析本机 @nestjs/core 的分发源码里 `instance.xxx` 到底访问了哪些属性名。 */
function readAuthorityHooks() {
  const req = createRequire(path.join(APP_DIR, 'package.json'));
  const coreIndex = req.resolve('@nestjs/core');
  const hooksDir = path.join(path.dirname(coreIndex), 'hooks');
  const names = new Set();
  for (const f of fs.readdirSync(hooksDir)) {
    if (!f.endsWith('.hook.js')) continue;
    const text = fs.readFileSync(path.join(hooksDir, f), 'utf8');
    // 只认框架自己访问的属性位（`instance.onApplicationShutdown(...)` / `isFunction(instance.onX)`），
    // 注释里的名字不算——否则名单会含进文档字符串，A 案就会把"框架没调"误判成量具坏。
    for (const m of text.matchAll(/\binstance\.((?:on|before)[A-Za-z]+)\b/g)) names.add(m[1]);
  }
  return { names: [...names].sort(), hooksDir };
}

/** 子进程：装配一个只有 worker 的最小 Nest 应用，钩子一开火就往 fd1 同步写一行。 */
function child(hooks, opts) {
  const req = createRequire(path.join(APP_DIR, 'package.json'));
  req('reflect-metadata');
  const { Injectable, Module } = req('@nestjs/common');
  const { NestFactory } = req('@nestjs/core');
  const write = (line) => process.stdout.write(line + '\n');

  class TimerWorker {}
  for (const h of hooks) {
    TimerWorker.prototype[h] = function () {
      write(`HOOK:${h}`);
    };
  }
  Injectable()(TimerWorker);
  class Fixture {}
  Module({ providers: [TimerWorker] })(Fixture);

  (async () => {
    const app = await NestFactory.create(Fixture, { logger: false });
    if (opts.enableShutdownHooks) app.enableShutdownHooks();
    await app.listen(0, '127.0.0.1');
    write('READY');
    if (opts.via === 'close') {
      await app.close();
      write('CLOSED');
      process.exit(0);
    }
    // SIGTERM 路径：自己给自己发信号（与容器停止同一入口——默认动作 vs Nest 绑定的处理器），
    // 钩子由 Nest（或未由任何人）触发。
    if (opts.via === 'signal') setTimeout(() => process.kill(process.pid, 'SIGTERM'), 30).unref();
  })().catch((error) => {
    write(`CHILD-ERROR:${error && error.message}`);
    process.exit(1);
  });
}

function runChild(args) {
  const res = spawnSync(process.execPath, [__filename, ...args], { encoding: 'utf8', timeout: 20_000 });
  const out = String(res.stdout || '');
  return {
    fired: out.split('\n').filter((l) => l.startsWith('HOOK:')).map((l) => l.slice(5)),
    ready: out.includes('READY'),
    childError: (out.match(/CHILD-ERROR:.*/) || [null])[0],
    signal: res.signal || null,
    status: res.status,
    timedOut: res.error && /ETIMEDOUT|timed out/i.test(String(res.error.message || res.error)),
  };
}

function observe(authority) {
  const all = [...authority.hooks, TYPO_HOOK];
  const a = runChild(['--child', `--via=close`, `--hooks=${all.join(',')}`]);
  const b = runChild(['--child', `--via=signal`, `--hooks=${all.join(',')}`]);
  const c = runChild(['--child', `--via=signal`, `--shutdown-hooks=1`, `--hooks=${all.join(',')}`]);
  const d = nanCadence();
  return { a, b, c, d };
}

/** Node 侧事实：非法间隔交给 setInterval 后是什么节奏（worker 里 NaN 守卫缺失的代价）。 */
function nanCadence() {
  const windowMs = 120;
  const count = (delayExpr) => {
    const src = `let c=0;const t=setInterval(()=>{c+=1},${delayExpr});`
      + `setTimeout(()=>{clearInterval(t);process.stdout.write(String(c))},${windowMs});`;
    const r = spawnSync(process.execPath, ['-e', src], { encoding: 'utf8' });
    return Number(String(r.stdout || '').trim()) || 0;
  };
  const warn = (() => {
    const r = spawnSync(process.execPath, ['-e', 'clearInterval(setInterval(() => {}, NaN))'], { encoding: 'utf8' });
    return /TimeoutNaNWarning/.test(String(r.stderr || '')) ? 'stderr 有 TimeoutNaNWarning' : 'stderr 无 TimeoutNaNWarning';
  })();
  return { nanCalls: count('NaN'), okCalls: count('5000'), warn, windowMs };
}

/** 纯判据：观测 → 判决。三组对照缺一不可。 */
function judge(obs, authority) {
  const problems = [];
  const stops = (r) => r.fired.filter((h) => authority.stopHooks.includes(h));
  const starts = (r) => r.fired.filter((h) => authority.startHooks.includes(h));

  for (const [name, r] of [['A close()', obs.a], ['B SIGTERM 无开关', obs.b], ['C SIGTERM 有开关', obs.c]]) {
    if (r.timedOut) problems.push(`${name} 子进程 20s 未退出（被强杀）⇒ 该案的停止语义不成立，不予采信`);
    else if (r.childError) problems.push(`${name} 子进程报错：${r.childError}`);
    else if (!r.ready) problems.push(`${name} 子进程没到 READY（观测不成立，判据自测失效）`);
  }
  if (problems.length) return { ok: false, problems };

  // A：close() 路径必须把真名单全部叫到，且拼错的名必须不被叫
  const missingA = authority.hooks.filter((h) => !obs.a.fired.includes(h));
  if (missingA.length) problems.push(`A：app.close()/init() 未触发权威名单里的钩子 ${missingA.join(',')} ⇒ 本机 Nest 分发与名单不符，量具失效`);
  if (obs.a.fired.includes(TYPO_HOOK)) problems.push(`A：拼错的钩子名 ${TYPO_HOOK} 竟然被触发 ⇒ 该框架版本确有此钩子，判据需改`);

  // B/C：一对必须反向的对照
  if (stops(obs.b).length) problems.push(`B：未开 enableShutdownHooks 的 SIGTERM 仍跑到收尾钩子 ${stops(obs.b).join(',')} ⇒ 反向对照失效`);
  if (obs.b.signal !== 'SIGTERM') problems.push(`B：子进程不是被 SIGTERM 直接打死（signal=${obs.b.signal}）⇒ 前提不成立`);
  if (!stops(obs.c).length) problems.push(`C：开了 enableShutdownHooks 却没跑到任何收尾钩子 ⇒ "必须开火"对照失败，B 的否定读数作废`);

  // D：热循环成立与否
  if (obs.d.nanCalls <= obs.d.okCalls) {
    problems.push(`D：NaN 间隔的调用数(${obs.d.nanCalls}) 不大于合法间隔(${obs.d.okCalls}) ⇒ 热循环判据不开火，静态"缺守卫即热循环"的说法不予采信`);
  }
  if (authority.hooks.length < 5) problems.push(`权威钩子名单只解析到 ${authority.hooks.length} 个，分母不成立 ⇒ 不出数`);
  return { ok: problems.length === 0, problems, startsA: starts(obs.a), stopsA: stops(obs.a) };
}

function print(obs, authority) {
  console.log(`@nestjs/core 权威钩子名单（解析自 ${authority.hooksDir}）：${authority.hooks.join(', ')}`);
  console.log(`本次同时探测的拼错名（Nest 无此钩子）：${TYPO_HOOK}`);
  const fmt = (n, r) => console.log(`  ${n} fired=[${r.fired.join(',')}] signal=${r.signal ?? '-'} status=${r.status ?? '-'} rc=${r.fired.length}`);
  console.log('原始观测：');
  fmt('A close() 路径       ', obs.a);
  fmt('B SIGTERM（无开关）  ', obs.b);
  fmt('C SIGTERM（有开关）  ', obs.c);
  console.log(`  D setInterval 节奏（${obs.d.windowMs}ms 窗口）：NaN → ${obs.d.nanCalls} 次，5000ms → ${obs.d.okCalls} 次；${obs.d.warn}`);
}

function selfTest() {
  const authority = (() => {
    const hooks = [...START_HOOKS, ...STOP_HOOKS];
    return { hooks, startHooks: START_HOOKS, stopHooks: STOP_HOOKS, utilsDir: '(夹具)' };
  })();
  const good = {
    a: { fired: [...authority.hooks], ready: true, childError: null, signal: null, status: 0 },
    b: { fired: [...authority.startHooks], ready: true, childError: null, signal: 'SIGTERM', status: null },
    c: { fired: [...authority.startHooks, ...authority.stopHooks], ready: true, childError: null, signal: null, status: 0 },
    d: { nanCalls: 90, okCalls: 0, warn: 'stderr 有告警', windowMs: 120 },
  };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const inject = [
    { name: 'N1 拼错的钩子名被触发（框架其实有该钩子）', run: (o) => { o.a.fired.push(TYPO_HOOK); }, expect: /竟然被触发/ },
    { name: 'N2 反向对照塌了：B 也跑到收尾钩子', run: (o) => { o.b.fired.push('onModuleDestroy'); }, expect: /B：未开 enableShutdownHooks/ },
    { name: 'N3 "必须开火"失败：C 一个收尾钩子都没有', run: (o) => { o.c.fired = [...authority.startHooks]; }, expect: /C：开了 enableShutdownHooks/ },
    { name: 'N4 前提不成立：B 不是被 SIGTERM 打死', run: (o) => { o.b.signal = 'SIGKILL'; }, expect: /前提不成立/ },
    { name: 'N5 热循环判据不开火（NaN 与合法同数）', run: (o) => { o.d.nanCalls = o.d.okCalls; }, expect: /D：NaN 间隔/ },
    { name: 'N6 权威名单塌陷（分母不成立）', run: (o) => o, expect: null, hooks: 2 },
    { name: 'N7 子进程没到 READY（静默零不算读数）', run: (o) => { o.c.ready = false; o.c.fired = []; }, expect: /没到 READY/ },
  ];
  let bad = 0;
  for (const inj of inject) {
    const mutated = clone(good);
    inj.run(mutated);
    const auth = inj.hooks
      ? { ...authority, hooks: authority.hooks.slice(0, inj.hooks) }
      : authority;
    if (JSON.stringify(mutated) === JSON.stringify(good) && !inj.hooks) {
      console.log(`  ✕ ${inj.name} → 注入根本没改变输入（判据自测本身失效）`);
      bad += 1;
      continue;
    }
    const r = judge(mutated, auth);
    const hit = inj.expect ? r.problems.some((p) => inj.expect.test(p)) : !r.ok;
    if (!hit) bad += 1;
    console.log(`  ${hit ? '✔' : '✕'} ${inj.name} → 报 ${r.problems.length} 项`);
  }
  const clean = judge(clone(good), authority);
  console.log(`对照（未注入的干净观测）：ok=${clean.ok}，${clean.problems.length} 项`);
  for (const p of clean.problems) console.log('   · ' + p);
  if (!clean.ok) bad += 1;
  console.log(`停止路径判据自测：${inject.length - bad}/${inject.length} 抓到`);
  return bad === 0;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) process.exit(selfTest() ? 0 : 3);
  const childFlag = argv.find((a) => a === '--child');
  if (childFlag) {
    const hooks = (argv.find((a) => a.startsWith('--hooks=')) || '').slice(8).split(',').filter(Boolean);
    const opts = {
      via: (argv.find((a) => a.startsWith('--via=')) || '--via=signal').slice(6),
      enableShutdownHooks: (argv.find((a) => a.startsWith('--shutdown-hooks=')) || '').endsWith('1'),
    };
    child(hooks, opts);
    return;
  }
  let authority;
  try {
    const names = readAuthorityHooks();
    authority = {
      hooks: names.names,
      startHooks: names.names.filter((h) => START_HOOKS.includes(h)),
      stopHooks: names.names.filter((h) => !START_HOOKS.includes(h)),
      hooksDir: names.hooksDir,
    };
  } catch (error) {
    console.error(`FAIL worker_shutdown_probe：解析不到 @nestjs/core 钩子名单（${error.message}）`);
    process.exit(2);
  }
  const obs = observe(authority);
  print(obs, authority);
  const verdict = judge(obs, authority);
  if (!verdict.ok) {
    for (const p of verdict.problems) console.error(`FAIL worker_shutdown_probe：${p}`);
    process.exit(1);
  }
  console.log('结论：close() 与 SIGTERM 是两条不同的停止路径；未调 enableShutdownHooks 时，写进生命周期方法的清场代码在真实停止路径上到不了。');
}

if (require.main === module) main();
module.exports = { judge, readAuthorityHooks, START_HOOKS, STOP_HOOKS, TYPO_HOOK };
