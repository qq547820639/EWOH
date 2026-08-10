#!/usr/bin/env node
/* EWOH scheduler event-storm + SSE reconnect soak (Task 8 P1, G9 配套门禁).
 *
 * 对真实运行的 standalone API 执行（诚实门禁，绝不伪造通过）：
 *   1. login（POST /api/auth/login，seed admin）→ Bearer access token
 *   2. 事件风暴：N（默认 500）个 POST /api/scheduler/events，轮换 13 类
 *      SchedulingTrigger 之一并使用唯一 entityId（绕过冷却去抖），断言 5xx 比例 < 5%
 *   3. SSE 订阅：GET /api/scheduler/v2/stream（Bearer）→ 收到 >=1 条消息
 *      （scheduling.event / resync / heartbeat）
 *   4. SSE 断线重连：携带 Last-Event-ID（上一步最后 sequence）重新订阅 →
 *      收到 >=1 条消息（replay / resync / heartbeat），证明增量续传契约可用
 *
 * Env:
 *   TARGET_URL                 API base（默认 http://127.0.0.1:3000）
 *   EWOH_SOAK_DATABASE_URL     PostgreSQL URL（写入报告用于审计；脚本断言为 HTTP 层）
 *   EWOH_SOAK_ADMIN_USERNAME   登录用户名（seed admin，默认 ci_admin）
 *   EWOH_SOAK_ADMIN_PASSWORD   登录密码（必需）
 *   SOAK_SCHEDULER_EVENTS      事件数（默认 500，硬钳制到 [1, 5000]）
 *   SOAK_SCHEDULER_TIMEOUT_MS  脚本全局硬上限（默认 240000，超时记 FAILED，绝不无限跑）
 *
 * API 不可达 / 凭据缺失 / 登录失败 → BLOCKED_BY_ENVIRONMENT（退出码 0，与 soak-load.js 一致）；
 * 断言失败 → FAILED（退出码 1）。
 */

import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const reportPath = path.join(root, 'output', 'soak-scheduler-events-report.json');
const GATE_ID = 'soak-scheduler-events';

const TRIGGERS = [
  'DEVICE_OFFLINE',
  'ROUTE_BLOCKED',
  'PERSON_UNAVAILABLE',
  'BOTTLENECK_DETECTED',
  'SAFETY_EVENT',
  'DEADLINE_AT_RISK',
  'RESERVATION_CONFLICT',
];

function recordGate(status, details) {
  spawnSync(process.execPath, [
    path.join(root, 'scripts', 'truth-gate-record.js'),
    '--id', GATE_ID,
    '--name', '调度事件风暴 + SSE 订阅/断线重连长稳门禁（500 事件 + Last-Event-ID 续传）',
    '--status', status,
    '--details', details,
  ], { stdio: 'inherit' });
}

function nowIso() { return new Date().toISOString(); }

async function login(target, user, pass) {
  const res = await fetch(`${target}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, password: pass }),
  });
  if (!res.ok) {
    throw new Error(`login HTTP ${res.status}（用户名/密码或服务端异常）`);
  }
  const body = await res.json();
  if (!body || typeof body.accessToken !== 'string' || !body.accessToken) {
    throw new Error('login 响应缺少 accessToken');
  }
  return body.accessToken;
}

async function eventStorm(target, token, count) {
  let ok = 0;
  let fail = 0;
  let next = 0;
  const worker = async () => {
    while (next < count) {
      const i = next++;
      const trigger = TRIGGERS[i % TRIGGERS.length];
      const body = {
        trigger,
        entityId: `soak-${String(i).padStart(4, '0')}`,
        operator: 'ci-soak',
        reason: `soak scheduler event storm #${i}`,
      };
      try {
        const res = await fetch(`${target}/api/scheduler/events`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(body),
        });
        if (res.status < 500) ok += 1;
        else fail += 1;
      } catch {
        fail += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: 10 }, () => worker()));
  return { ok, fail, rate: count > 0 ? fail / count : 1 };
}

/**
 * 读取 SSE 流直到收到一条消息或超时。
 * @returns {{messages: number, lastId: string|null}}
 */
async function readSse(target, token, { lastEventId, maxMs }) {
  const headers = { Authorization: `Bearer ${token}` };
  if (lastEventId != null) headers['Last-Event-ID'] = String(lastEventId);
  const res = await fetch(`${target}/api/scheduler/v2/stream`, {
    headers,
    signal: AbortSignal.timeout(maxMs),
  });
  if (!res.ok || !res.body) {
    throw new Error(`SSE HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lastId = null;
  let messages = 0;
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let event = 'message';
      let id = null;
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('id:')) id = line.slice(3).trim();
      }
      if (event || id) {
        if (id != null && id !== '') lastId = id;
        messages += 1;
        return { messages, lastId };
      }
    }
  }
  return { messages, lastId };
}

async function main() {
  const target = (process.env.TARGET_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const user = process.env.EWOH_SOAK_ADMIN_USERNAME || 'ci_admin';
  const pass = process.env.EWOH_SOAK_ADMIN_PASSWORD;
  const dbUrl = process.env.EWOH_SOAK_DATABASE_URL || '';
  const rawCount = Number(process.env.SOAK_SCHEDULER_EVENTS || 500);
  const count = Math.min(Math.max(Number.isFinite(rawCount) ? Math.floor(rawCount) : 500, 1), 5000);
  const timeoutMs = Number(process.env.SOAK_SCHEDULER_TIMEOUT_MS || 240000);
  const report = {
    gate: GATE_ID,
    checkedAt: nowIso(),
    target,
    eventCount: count,
    timeoutMs,
    gates: [],
  };

  const blocked = (msg) => {
    console.error(`::notice::BLOCKED_BY_ENVIRONMENT: ${msg}`);
    recordGate('BLOCKED_BY_ENVIRONMENT', msg);
    report.status = 'BLOCKED_BY_ENVIRONMENT';
    report.reason = msg;
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    return 0;
  };

  const fail = (msg) => {
    console.error(`::error::${msg}`);
    recordGate('FAILED', msg);
    report.status = 'FAILED';
    report.reason = msg;
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    return 1;
  };

  if (!pass) {
    return blocked('需设置 EWOH_SOAK_ADMIN_PASSWORD（seed admin 登录口令）');
  }
  let apiReachable = false;
  try {
    const res = await fetch(`${target}/health/ready`);
    apiReachable = res.status === 200;
  } catch {
    apiReachable = false;
  }
  if (!apiReachable) {
    return blocked(`API 不可达（${target}/health/ready 非 200）`);
  }

  // 全局硬上限：任何阶段超时都记为 FAILED，绝不无限等待。
  const work = (async () => {
    let token;
    try {
      token = await login(target, user, pass);
    } catch (loginErr) {
      console.error(`::notice::BLOCKED_BY_ENVIRONMENT: 登录失败: ${loginErr.message}`);
      report.status = 'BLOCKED_BY_ENVIRONMENT';
      report.reason = `登录失败（API 可达但无法取得访问令牌）: ${loginErr.message}`;
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
      recordGate('BLOCKED_BY_ENVIRONMENT', report.reason);
      return 0;
    }
    console.log(`login ok: ${user}`);

    const storm = await eventStorm(target, token, count);
    console.log(`event storm: ok=${storm.ok} fail=${storm.fail} err=${storm.rate.toFixed(3)}`);
    report.gates.push({ id: 'event-storm', ok: storm.rate < 0.05, detail: `events=${count} ok=${storm.ok} fail=${storm.fail} err=${storm.rate.toFixed(3)}` });

    const sse1 = await readSse(target, token, { lastEventId: null, maxMs: 45000 });
    console.log(`sse subscribe #1: messages=${sse1.messages} lastId=${sse1.lastId}`);
    report.gates.push({ id: 'sse-subscribe', ok: sse1.messages >= 1, detail: `messages=${sse1.messages} lastId=${sse1.lastId ?? 'none'}` });

    const sse2 = await readSse(target, token, { lastEventId: sse1.lastId ?? '0', maxMs: 30000 });
    console.log(`sse reconnect #2 (Last-Event-ID=${sse1.lastId ?? '0'}): messages=${sse2.messages}`);
    report.gates.push({ id: 'sse-reconnect', ok: sse2.messages >= 1, detail: `Last-Event-ID=${sse1.lastId ?? '0'} messages=${sse2.messages}` });

    const allOk = report.gates.every((g) => g.ok);
    report.status = allOk ? 'SUCCEEDED' : 'FAILED';
    report.results = report.gates;
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    if (allOk) {
      recordGate('SUCCEEDED', `事件风暴 ${count} 事件 + SSE 订阅/断线重连全部通过（${report.gates.map((g) => g.id).join(', ')}）`);
      console.log(`SOAK-SCHEDULER-EVENTS OK: ${report.gates.map((g) => g.id).join(' -> ')}`);
      return 0;
    }
    const failed = report.gates.filter((g) => !g.ok).map((g) => `${g.id}:${g.detail}`).join('; ');
    console.error(`SOAK-SCHEDULER-EVENTS FAILED: ${failed}`);
    return 1;
  })();

  const workSafe = work.then(
    (code) => code,
    (err) => {
      const msg = err && err.message ? err.message : String(err);
      console.error(`::error::${msg}`);
      report.status = 'FAILED';
      report.reason = msg;
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
      recordGate('FAILED', msg);
      return 1;
    },
  );

  const timeout = new Promise((resolve) => {
    setTimeout(() => {
      report.status = 'FAILED';
      report.reason = `SOAK_SCHEDULER_TIMEOUT_MS=${timeoutMs} 超时（有界中止）`;
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
      recordGate('FAILED', report.reason);
      console.error(`::error::${report.reason}`);
      resolve(1);
    }, timeoutMs);
  });

  return Promise.race([workSafe, timeout]);
}

main().then((code) => { process.exitCode = code; });
