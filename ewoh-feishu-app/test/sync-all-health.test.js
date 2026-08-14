// sync-all-health.test.js — 全量同步健康探针如实性回归测试
// 覆盖：syncAllToFeishu 任一子项失败时 recordFeishuSync(false, 首错)，
// 全部成功时 recordFeishuSync(true, null)（此前恒报 true → /health/ready 撒谎）。
'use strict';
const test = require('node:test');
const assert = require('node:assert');

// ---- stub feishu 模块（sync.js 模块级 require，需在 require 前替换 require.cache）----
const FEISHU_PATH = require.resolve('../server/feishu');
const fakeFeishu = {
  getConfig: () => ({ tables: { devices: 'tbl_dev', events: 'tbl_evt', telemetry: 'tbl_tel' } }),
  fmtDateTime: (ts) => String(ts),
  baseRecordSearch: () => [],
  baseRecordCreate: () => ({ ok: true }),
  baseRecordUpdate: () => ({ ok: true }),
  baseRecordBatchCreate: () => ({ ok: true }),
};
require.cache[FEISHU_PATH] = {
  id: FEISHU_PATH,
  filename: FEISHU_PATH,
  loaded: true,
  exports: fakeFeishu,
};

const sync = require('../server/sync');
const health = require('../server/health');

// 记录 recordFeishuSync 调用
const recorded = [];
const origRecord = health.recordFeishuSync;
health.recordFeishuSync = (ok, err) => {
  recorded.push({ ok, err });
  origRecord(ok, err);
};

// 内存假 db：只实现 syncAllToFeishu 用到的 prepare().all()
function fakeDb(devices = [], events = [], telemetry = []) {
  const tables = { devices, events, telemetry };
  return {
    prepare: (sql) => ({
      all: () => {
        if (sql.includes('FROM devices')) return tables.devices;
        if (sql.includes('FROM events')) return tables.events;
        if (sql.includes('FROM telemetry')) return tables.telemetry;
        return [];
      },
    }),
  };
}

test('全量同步全部成功 → recordFeishuSync(true, null)', async () => {
  recorded.length = 0;
  fakeFeishu.baseRecordBatchCreate = () => ({ ok: true });
  const r = await sync.syncAllToFeishu(
    fakeDb([{ device_id: 'd1' }], [], [{ device_id: 'd1', ts: 1 }])
  );
  assert.strictEqual(r.ok, true);
  assert.strictEqual(recorded.length, 1);
  assert.deepStrictEqual(recorded[0], { ok: true, err: null });
});

test('设备/遥测同步失败 → recordFeishuSync(false, 首错)，探针不再撒谎', async () => {
  recorded.length = 0;
  // syncDevice 内部走 feishu.baseRecordSearch/baseRecordCreate；设备 upsert 失败由 search 失败触发
  fakeFeishu.baseRecordSearch = () => {
    throw new Error('lark down');
  };
  fakeFeishu.baseRecordBatchCreate = () => ({ ok: false, error: 'telemetry batch failed' });
  const r = await sync.syncAllToFeishu(
    fakeDb(
      [{ device_id: 'd1' }, { device_id: 'd2' }],
      [{ event_id: 'e1', device_id: 'd1' }],
      [{ device_id: 'd1', ts: 1 }]
    )
  );
  assert.strictEqual(r.ok, false, '任一子项失败 → 整体 ok=false');
  assert.ok(recorded.length >= 1);
  assert.strictEqual(recorded[recorded.length - 1].ok, false);
  assert.ok(recorded[recorded.length - 1].err, '必须携带首错信息');
  assert.ok(r.failures.length > 0);
});

test('未配置飞书 → recordFeishuSync(false, no config)（既有行为保持）', async () => {
  recorded.length = 0;
  const oldConfig = fakeFeishu.getConfig;
  fakeFeishu.getConfig = () => null;
  const r = await sync.syncAllToFeishu(fakeDb());
  fakeFeishu.getConfig = oldConfig;
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'no config');
  assert.strictEqual(recorded[recorded.length - 1].ok, false);
});
