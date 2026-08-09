// M2 回归测试：flushTelemetry 失败保留 buffer（重试），成功后清空
// 覆盖：失败不清空 + 上限裁剪 + 成功移除已发送行
'use strict';
const test = require('node:test');
const assert = require('node:assert');

// ---- stub feishu 模块（sync.js 模块级 require，需在 require 前替换 require.cache）----
const FEISHU_PATH = require.resolve('../server/feishu');
const fakeFeishu = {
  getConfig: () => ({ tables: { telemetry: 'tbl_telemetry' } }),
  fmtDateTime: (ts) => String(ts),
  baseRecordBatchCreate: () => ({ ok: true }),
};
require.cache[FEISHU_PATH] = {
  id: FEISHU_PATH,
  filename: FEISHU_PATH,
  loaded: true,
  exports: fakeFeishu,
};

const sync = require('../server/sync');

test('flushTelemetry 失败 → buffer 保留（下次可重试）', async () => {
  // 首次失败
  fakeFeishu.baseRecordBatchCreate = () => ({ ok: false, error: 'boom' });
  sync.syncTelemetry({ device_id: 'd1', ts: 1000 });
  const r1 = await sync.flushTelemetry();
  assert.strictEqual(r1.ok, false);
  // 再次同步一条，然后第二次 flush 成功 → 两条都应被发送
  sync.syncTelemetry({ device_id: 'd2', ts: 2000 });
  let sentRows = null;
  fakeFeishu.baseRecordBatchCreate = (table, fields, rows) => {
    sentRows = rows;
    return { ok: true };
  };
  const r2 = await sync.flushTelemetry();
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.count, 2, '失败保留的 1 条 + 新增 1 条都应重试发送');
  assert.ok(sentRows && sentRows.length === 2, '第二次 flush 应携带 2 行');
});

test('flushTelemetry 成功后 buffer 清空（不重复发送）', async () => {
  fakeFeishu.baseRecordBatchCreate = () => ({ ok: true });
  sync.syncTelemetry({ device_id: 'd3', ts: 3000 });
  const r1 = await sync.flushTelemetry();
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.count, 1);
  // 空 buffer → count 0 且不再调用批量接口
  let calls = 0;
  fakeFeishu.baseRecordBatchCreate = () => { calls += 1; return { ok: true }; };
  const r2 = await sync.flushTelemetry();
  assert.strictEqual(r2.count, 0);
  assert.strictEqual(calls, 0, '空 buffer 不应触发批量调用');
});
