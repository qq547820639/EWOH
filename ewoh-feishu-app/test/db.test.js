// server/db.test.js — v1.1.0 D2/D3：SQLite 文件持久化 + webhook 幂等表测试（node:test）
// 覆盖：
//   - 文件库默认路径与 WAL 模式
//   - 数据写入 → 关闭 → 重开 → 数据仍在（进程重启模拟）
//   - webhook_dedup 幂等键（重复登记返回 duplicated）
//   - events 状态转换边界（closed 事件不可再处置）
// 运行：node --test test/db.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dbm = require('../server/db');
const events = require('../server/events');

// 临时目录，测试结束清理
function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewoh-test-'));
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  });
  return dir;
}

test('resolveDbPath: 默认文件库为 data/ewoh-feishu.db（相对应用根）', () => {
  const r = dbm.resolveDbPath();
  assert.strictEqual(r.isMemory, false);
  assert.ok(path.isAbsolute(r.dbPath), '应解析为绝对路径');
  assert.ok(r.dbPath.endsWith(path.join('data', 'ewoh-feishu.db')));
});

test('resolveDbPath: :memory: 显式保留内存模式', () => {
  const r = dbm.resolveDbPath(':memory:');
  assert.strictEqual(r.isMemory, true);
  assert.strictEqual(r.dbPath, ':memory:');
});

test('D2: 文件库写入后重开数据仍在（持久化）', (t) => {
  const dir = tmpDir(t);
  const dbPath = path.join(dir, 'feishu.db');

  // 第一次打开：建表 + 写入一条设备 + 一条事件
  const db1 = dbm.initDatabase(dbPath);
  const journal = db1.pragma('journal_mode', { simple: true });
  assert.ok(String(journal).toLowerCase().includes('wal'), '文件库应启用 WAL');
  dbm.updateDeviceTelemetry(db1, 'EXO-001', { battery_pct: 42, online: 1, last_telemetry_at: new Date().toISOString() });
  events.createEvent(db1, {
    device_id: 'EXO-001', event_code: 'TEST_EVENT', event_type: 'L1', severity: 'high',
    title: '持久化测试', description: '', trigger_data: {}, evidence: {},
  });
  const evId1 = db1.prepare('SELECT event_id FROM events ORDER BY id DESC LIMIT 1').get().event_id;
  db1.close();

  // 第二次打开（模拟进程重启）：数据必须仍在
  const db2 = dbm.initDatabase(dbPath);
  const dev = dbm.getDevice(db2, 'EXO-001');
  assert.strictEqual(dev.battery_pct, 42, '设备电量应持久化');
  const ev = events.getEvent(db2, evId1);
  assert.ok(ev, '事件应持久化');
  assert.strictEqual(ev.event_code, 'TEST_EVENT');
  const count = db2.prepare('SELECT COUNT(*) AS c FROM events').get().c;
  assert.strictEqual(count, 1, '不应重复 seed 或重复插入');
  db2.close();
});

test('D3: webhook_dedup 幂等 —— 首次登记成功，重复登记返回 duplicated', (t) => {
  const dir = tmpDir(t);
  const db = dbm.initDatabase(path.join(dir, 'feishu.db'));

  const r1 = dbm.tryAcquireWebhookDedup(db, { event_id: 'EVT-100', action_type: 'resolve', actor_id: 'ou_test' });
  assert.strictEqual(r1.duplicated, false, '首次登记应成功');
  assert.ok(r1.row);

  const r2 = dbm.tryAcquireWebhookDedup(db, { event_id: 'EVT-100', action_type: 'resolve', actor_id: 'ou_test' });
  assert.strictEqual(r2.duplicated, true, '重复登记应命中幂等');
  assert.ok(r2.row);

  // 不同 action_type 不冲突
  const r3 = dbm.tryAcquireWebhookDedup(db, { event_id: 'EVT-100', action_type: 'acknowledge' });
  assert.strictEqual(r3.duplicated, false, '不同动作不冲突');

  // 缺少 event_id / action_type → error
  const r4 = dbm.tryAcquireWebhookDedup(db, { event_id: '', action_type: 'resolve' });
  assert.ok(r4.error);

  // 查询辅助函数
  assert.strictEqual(dbm.hasWebhookProcessed(db, 'EVT-100', 'resolve'), true);
  assert.strictEqual(dbm.hasWebhookProcessed(db, 'EVT-100', 'comment'), false);

  // 删除后可重试
  dbm.deleteWebhookDedup(db, 'EVT-100', 'resolve');
  assert.strictEqual(dbm.hasWebhookProcessed(db, 'EVT-100', 'resolve'), false);
  db.close();
});

test('D3: 幂等记录跨进程持久化（重启后仍防重放）', (t) => {
  const dir = tmpDir(t);
  const dbPath = path.join(dir, 'feishu.db');

  const db1 = dbm.initDatabase(dbPath);
  dbm.tryAcquireWebhookDedup(db1, { event_id: 'EVT-200', action_type: 'escalate' });
  db1.close();

  const db2 = dbm.initDatabase(dbPath);
  assert.strictEqual(dbm.hasWebhookProcessed(db2, 'EVT-200', 'escalate'), true, '重启后幂等记录仍在');
  const r = dbm.tryAcquireWebhookDedup(db2, { event_id: 'EVT-200', action_type: 'escalate' });
  assert.strictEqual(r.duplicated, true, '重启后重复投递仍被拦截');
  db2.close();
});

test('状态转换边界：closed 事件不可再 acknowledge/resolve/escalate', (t) => {
  const dir = tmpDir(t);
  const db = dbm.initDatabase(path.join(dir, 'feishu.db'));

  const ev = events.createEvent(db, {
    device_id: 'EXO-001', event_code: 'TEST_EVENT', event_type: 'L1', severity: 'high',
    title: '边界测试', description: '', trigger_data: {}, evidence: {},
  });

  // resolve → closed
  events.handleEvent(db, ev.event_id, { handler_id: 'u1', action: 'resolve' });
  assert.strictEqual(events.getEvent(db, ev.event_id).status, 'closed');

  // closed 后 acknowledge → 抛错
  assert.throws(() => events.handleEvent(db, ev.event_id, { handler_id: 'u2', action: 'acknowledge' }), /already closed/);
  assert.throws(() => events.handleEvent(db, ev.event_id, { handler_id: 'u2', action: 'resolve' }), /already closed/);
  assert.throws(() => events.handleEvent(db, ev.event_id, { handler_id: 'u2', action: 'escalate' }), /already closed/);

  // comment 始终允许
  const after = events.handleEvent(db, ev.event_id, { handler_id: 'u2', action: 'comment', comment: '追加备注' });
  assert.strictEqual(after.status, 'closed', 'comment 不改状态');
  assert.strictEqual(after.handler_comment, '追加备注');

  // 非法 action
  assert.throws(() => events.handleEvent(db, ev.event_id, { handler_id: 'u2', action: 'bogus' }), /invalid action/);
  db.close();
});

test('D5: 规则从 DB 加载（唯一事实源），DB 空时回退默认', (t) => {
  const dir = tmpDir(t);
  const db = dbm.initDatabase(path.join(dir, 'feishu.db'));

  const rules = require('../server/rules');
  const loaded = rules.loadRules(db);
  assert.strictEqual(loaded.length, 4, 'seed 后应从 DB 加载 4 条规则');
  const r001 = loaded.find((r) => r.event_code === 'POSTURE_BEND_LONG');
  assert.ok(r001, '应找到 POSTURE_BEND_LONG');
  assert.strictEqual(r001.value, 45, '阈值应从 DB config 读取');
  assert.strictEqual(r001.threshold_sec, 10);
  assert.strictEqual(r001.enabled, true);

  // 修改 DB 中的阈值 → 下次加载生效（运行时调参）
  const cfg = r001;
  db.prepare("UPDATE rules SET config = ? WHERE rule_id = 'R001'")
    .run(JSON.stringify({ ...cfg, value: 50, threshold_sec: 12 }));
  const reloaded = rules.loadRules(db);
  const r001b = reloaded.find((r) => r.event_code === 'POSTURE_BEND_LONG');
  assert.strictEqual(r001b.value, 50, 'DB 参数变更应即时生效');
  assert.strictEqual(r001b.threshold_sec, 12);
  db.close();
});
