// server/sync.js — 数据同步模块
// 本地 SQLite → 飞书多维表格单向同步（设备/遥测/事件三表）
// 所有方法 try/catch 容错，失败只 console.error 不阻断主流程

const feishu = require('./feishu');
const dbm = require('./db');

// 本地英文字段名 → 飞书 Base 中文字段名映射（Base 表结构由 Task 1 创建）
const DEVICE_FIELDS = {
  device_id: '设备ID',
  worker_name: '工人姓名',
  device_model: '设备型号',
  battery_pct: '电量',
  online: '在线',
  last_telemetry_at: '最后通信',
};

const EVENT_FIELDS = {
  event_id: '事件ID',
  device_id: '设备ID',
  event_code: '事件编码',
  event_type: '事件类型',
  severity: '严重度',
  title: '标题',
  status: '状态',
  created_at: '创建时间',
  handler_action: '处置动作',
};

// 遥测表批量写入的字段顺序（Base 遥测表仅有这 6 列）
const TELEMETRY_BATCH_FIELDS = ['设备ID', '时间戳', '俯仰角', '扭矩', '电量', '质量状态'];

const TELEMETRY_FLUSH_INTERVAL_MS = 5000;

// 读取配置
function loadFeishuConfig() {
  return feishu.loadConfig();
}

// ============ 设备同步 ============

// 设备状态同步到多维表格（upsert by device_id：先 search，存在则 update，不存在则 create）
async function syncDevice(device) {
  try {
    const cfg = feishu.getConfig();
    if (!cfg || !cfg.tables || !device || !device.device_id) {
      return { ok: false, error: 'invalid args or config' };
    }
    const tableId = cfg.tables.devices;
    const fields = {
      [DEVICE_FIELDS.device_id]: device.device_id,
      [DEVICE_FIELDS.worker_name]: device.worker_name || '',
      [DEVICE_FIELDS.device_model]: device.device_model || '',
      [DEVICE_FIELDS.battery_pct]: device.battery_pct != null ? Number(device.battery_pct) : null,
      [DEVICE_FIELDS.online]: !!device.online,
      [DEVICE_FIELDS.last_telemetry_at]: feishu.fmtDateTime(device.last_telemetry_at),
    };

    // 先按 device_id 查找已有记录
    const existing = feishu.baseRecordSearch(tableId, {
      filter: { field: DEVICE_FIELDS.device_id, value: device.device_id },
      limit: 5,
    });
    const match = existing.find(
      (r) => feishu.getRecordField(r, DEVICE_FIELDS.device_id) === device.device_id
    );

    if (match) {
      const r = feishu.baseRecordUpdate(tableId, match.record_id, fields);
      return { ok: r.ok, action: 'update', record_id: match.record_id, error: r.error };
    }
    const r = feishu.baseRecordCreate(tableId, fields);
    return { ok: r.ok, action: 'create', record_id: r.record_id, error: r.error };
  } catch (e) {
    console.error('[sync] syncDevice 失败:', e.message);
    return { ok: false, error: e.message };
  }
}

// ============ 事件同步 ============

// 事件创建同步：追加一条记录到事件表
async function syncEventCreate(event) {
  try {
    const cfg = feishu.getConfig();
    if (!cfg || !cfg.tables || !event || !event.event_id) {
      return { ok: false, error: 'invalid args or config' };
    }
    const tableId = cfg.tables.events;
    const fields = {
      [EVENT_FIELDS.event_id]: event.event_id,
      [EVENT_FIELDS.device_id]: event.device_id || '',
      [EVENT_FIELDS.event_code]: event.event_code || '',
      [EVENT_FIELDS.event_type]: event.event_type || '',
      [EVENT_FIELDS.severity]: event.severity || '',
      [EVENT_FIELDS.title]: event.title || '',
      [EVENT_FIELDS.status]: event.status || 'open',
      [EVENT_FIELDS.created_at]: feishu.fmtDateTime(event.created_at),
    };
    if (event.handler_action) {
      fields[EVENT_FIELDS.handler_action] = event.handler_action;
    }
    const r = feishu.baseRecordCreate(tableId, fields);
    return { ok: r.ok, record_id: r.record_id, error: r.error };
  } catch (e) {
    console.error('[sync] syncEventCreate 失败:', e.message);
    return { ok: false, error: e.message };
  }
}

// 事件状态更新同步：先 search by event_id 拿到 record_id，再 update status / handler_action
async function syncEventUpdate(eventId, status, handlerAction) {
  try {
    const cfg = feishu.getConfig();
    if (!cfg || !cfg.tables || !eventId) {
      return { ok: false, error: 'invalid args or config' };
    }
    const tableId = cfg.tables.events;
    const existing = feishu.baseRecordSearch(tableId, {
      filter: { field: EVENT_FIELDS.event_id, value: eventId },
      limit: 5,
    });
    const match = existing.find(
      (r) => feishu.getRecordField(r, EVENT_FIELDS.event_id) === eventId
    );
    if (!match) {
      // 未找到对应记录（可能同步延迟或创建失败），跳过
      return { ok: false, error: 'event record not found in base' };
    }
    const fields = {};
    if (status) fields[EVENT_FIELDS.status] = status;
    if (handlerAction) fields[EVENT_FIELDS.handler_action] = handlerAction;
    const r = feishu.baseRecordUpdate(tableId, match.record_id, fields);
    return { ok: r.ok, record_id: match.record_id, error: r.error };
  } catch (e) {
    console.error('[sync] syncEventUpdate 失败:', e.message);
    return { ok: false, error: e.message };
  }
}

// ============ 遥测批量缓冲（5 秒刷一次）============

const telemetryBuffer = [];
let telemetryFlushTimer = null;

// 将单帧遥测推入缓冲区；满 5 秒后批量写入多维表格
function syncTelemetry(telemetry) {
  if (!telemetry || !telemetry.device_id) return;
  try {
    // 按遥测表字段顺序构造一行
    telemetryBuffer.push([
      telemetry.device_id,
      feishu.fmtDateTime(telemetry.ts),
      telemetry.pitch_deg != null ? Number(telemetry.pitch_deg) : null,
      telemetry.torque_nm != null ? Number(telemetry.torque_nm) : null,
      telemetry.battery_pct != null ? Number(telemetry.battery_pct) : null,
      telemetry.quality_status || '',
    ]);
  } catch (e) {
    console.error('[sync] syncTelemetry 入队失败:', e.message);
    return;
  }

  if (telemetryFlushTimer) return;
  telemetryFlushTimer = setTimeout(() => {
    flushTelemetry().catch((e) => console.error('[sync] 定时 flush 异常:', e.message));
  }, TELEMETRY_FLUSH_INTERVAL_MS);
  if (telemetryFlushTimer.unref) telemetryFlushTimer.unref();
}

// 主动 flush（用于退出时或定时触发）：批量 base +record-batch-create，清空 buffer
async function flushTelemetry() {
  if (telemetryFlushTimer) {
    clearTimeout(telemetryFlushTimer);
    telemetryFlushTimer = null;
  }
  if (telemetryBuffer.length === 0) return { ok: true, count: 0 };
  const rows = telemetryBuffer.slice();
  telemetryBuffer.length = 0;
  try {
    const cfg = feishu.getConfig();
    if (!cfg || !cfg.tables) return { ok: false, error: 'no config' };
    const r = feishu.baseRecordBatchCreate(cfg.tables.telemetry, TELEMETRY_BATCH_FIELDS, rows);
    if (!r.ok) {
      console.error('[sync] 遥测批量写入失败:', r.error);
    }
    return { ok: r.ok, count: rows.length, error: r.error };
  } catch (e) {
    console.error('[sync] flushTelemetry 异常:', e.message);
    return { ok: false, error: e.message, count: rows.length };
  }
}

// ============ 飞书侧事件状态变更轮询 ============

// 轮询间隔：60 秒
const EVENT_STATUS_POLL_INTERVAL_MS = 60 * 1000;
let pollTimer = null;

// 归一化 select 字段值：record-search 返回的 select 字段可能是 string / [string] / {name} / [{name}]
function normalizeSelectValue(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    if (v.length === 0) return null;
    return normalizeSelectValue(v[0]);
  }
  if (typeof v === 'object') {
    if (typeof v.name === 'string') return v.name;
    if (typeof v.text === 'string') return v.text;
  }
  return null;
}

// 解析 record-search 的列式响应：{data: [[...]], fields: [...], record_id_list: [...]}
// 转为 [{record_id, fields: {字段名: 值}}] 对象数组，兼容已有的 getRecordField
function parseRecordSearchRows(data) {
  if (!data || !Array.isArray(data.data) || !Array.isArray(data.fields) || !Array.isArray(data.record_id_list)) {
    return [];
  }
  const fields = data.fields;
  return data.data.map((row, i) => ({
    record_id: data.record_id_list[i],
    fields: Object.fromEntries(fields.map((name, j) => [name, row[j]])),
  }));
}

// 单次轮询：拉取飞书事件表中状态为 handled/closed 的记录，
// 与本地 SQLite events 表对比，发现飞书侧状态变更就回写本地
async function pollFeishuEventStatusChanges(db) {
  try {
    const cfg = feishu.getConfig();
    if (!cfg || !cfg.tables || !cfg.tables.events) {
      return { ok: false, error: 'no config or events table' };
    }
    const tableId = cfg.tables.events;

    // record-search 强制要求 keyword；用 "-" 匹配所有 UUID（事件ID 均含连字符）
    // --filter-json 实现 状态 intersects [handled, closed] 筛选
    const filterJson = JSON.stringify({
      logic: 'and',
      conditions: [['状态', 'intersects', ['handled', 'closed']]],
    });
    const r = feishu.larkCli([
      'base', '+record-search',
      '--base-token', cfg.base_token,
      '--table-id', tableId,
      '--keyword', '-',
      '--search-field', '事件ID',
      '--filter-json', filterJson,
      '--limit', '100',
      '--format', 'json',
    ]);
    if (!r.ok) {
      console.error('[sync] pollFeishuEventStatusChanges 查询失败:', r.error);
      return { ok: false, error: r.error };
    }

    const records = parseRecordSearchRows(r.data);
    if (!Array.isArray(records) || records.length === 0) {
      return { ok: true, count: 0, applied: 0 };
    }

    // 懒加载 events 模块，避免与 events.js 形成循环依赖
    const events = require('./events');

    let applied = 0;
    for (const rec of records) {
      try {
        const eventId = feishu.getRecordField(rec, '事件ID');
        const feishuStatus = normalizeSelectValue(feishu.getRecordField(rec, '状态'));
        if (!eventId || !feishuStatus) continue;

        const localEvent = events.getEvent(db, eventId);
        if (!localEvent) continue; // 本地无此事件，跳过
        if (localEvent.status === feishuStatus) continue; // 状态一致，跳过
        if (localEvent.status === 'closed') continue; // 本地已关闭，不重开

        // 飞书侧状态变更回写本地：open→handled / open|handled→closed
        if (feishuStatus === 'handled' && localEvent.status === 'open') {
          events.handleEvent(db, eventId, { handler_id: 'feishu_poll', action: 'acknowledge' });
          applied++;
          console.log(`[sync] 轮询回写: ${eventId} open→handled`);
        } else if (feishuStatus === 'closed' && (localEvent.status === 'open' || localEvent.status === 'handled')) {
          events.closeEvent(db, eventId);
          applied++;
          console.log(`[sync] 轮询回写: ${eventId} ${localEvent.status}→closed`);
        }
      } catch (e) {
        // 单条失败不阻断其他记录
        console.error('[sync] 轮询回写单条失败:', e.message);
      }
    }
    return { ok: true, count: records.length, applied };
  } catch (e) {
    console.error('[sync] pollFeishuEventStatusChanges 异常:', e.message);
    return { ok: false, error: e.message };
  }
}

// 启动轮询定时器：立即跑一次，之后每 60s 跑一次
function startEventStatusPolling(db) {
  if (pollTimer) return pollTimer;
  Promise.resolve(pollFeishuEventStatusChanges(db)).catch((e) =>
    console.error('[sync] 首次事件状态轮询异常:', e.message)
  );
  pollTimer = setInterval(() => {
    Promise.resolve(pollFeishuEventStatusChanges(db)).catch((e) =>
      console.error('[sync] 事件状态轮询异常:', e.message)
    );
  }, EVENT_STATUS_POLL_INTERVAL_MS);
  if (pollTimer.unref) pollTimer.unref();
  console.log(`[sync] 事件状态轮询已启动，间隔 ${EVENT_STATUS_POLL_INTERVAL_MS}ms`);
  return pollTimer;
}

// 停止轮询定时器
function stopEventStatusPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    console.log('[sync] 事件状态轮询已停止');
  }
}

// ============ 全量同步（定时触发）============

// 将本地 SQLite 全量数据同步到飞书多维表格：
// - 设备：全部 upsert（search + update/create 复用 syncDevice 的按 device_id 去重逻辑）
// - 事件：最近 50 条 upsert（复用 syncEventCreate / syncEventUpdate 的按 event_id 去重逻辑）
// - 遥测：最近 100 条走批量 batch-create（复用 baseRecordBatchCreate，一次 API 调用）
// v1.1.0 加固（D6）：v1.0 对设备/事件逐条 baseRecordCreate 会无限追加重复记录，
// 且遥测逐条 create 高频调用。现全部收敛为 upsert/批量语义，降低 API 频率与数据漂移。
async function syncAllToFeishu(db) {
  const synced = { devices: 0, events: 0, telemetry: 0 };
  const cfg = feishu.getConfig();
  if (!cfg || !cfg.tables) {
    console.error('[sync] syncAllToFeishu: 未加载到飞书配置，跳过');
    return { ok: false, error: 'no config', synced };
  }

  // ---- 设备：全部 upsert ----
  try {
    const devices = db.prepare('SELECT * FROM devices').all();
    for (const dev of devices || []) {
      try {
        const r = await syncDevice(dev);
        if (r && r.ok) synced.devices++;
        else console.error(`[sync] 全量同步-设备失败 ${dev.device_id}:`, r && r.error);
      } catch (e) {
        console.error(`[sync] 全量同步-设备异常 ${dev.device_id}:`, e.message);
      }
    }
  } catch (e) {
    console.error('[sync] 全量同步-读取设备失败:', e.message);
  }

  // ---- 事件：最近 50 条 upsert（先查飞书是否已有 → 有则 update，无则 create）----
  try {
    const evs = db.prepare('SELECT * FROM events ORDER BY created_at DESC LIMIT 50').all();
    for (const ev of evs || []) {
      try {
        const tableId = cfg.tables.events;
        const existing = feishu.baseRecordSearch(tableId, {
          filter: { field: EVENT_FIELDS.event_id, value: ev.event_id },
          limit: 5,
        });
        const match = existing.find(
          (r) => feishu.getRecordField(r, EVENT_FIELDS.event_id) === ev.event_id
        );
        const fields = {
          [EVENT_FIELDS.event_id]: ev.event_id,
          [EVENT_FIELDS.device_id]: ev.device_id || '',
          [EVENT_FIELDS.event_code]: ev.event_code || '',
          [EVENT_FIELDS.event_type]: ev.event_type || '',
          [EVENT_FIELDS.severity]: ev.severity || '',
          [EVENT_FIELDS.title]: ev.title || '',
          [EVENT_FIELDS.status]: ev.status || 'open',
          [EVENT_FIELDS.created_at]: feishu.fmtDateTime(ev.created_at),
        };
        if (ev.handler_action) fields[EVENT_FIELDS.handler_action] = ev.handler_action;
        const r = match
          ? feishu.baseRecordUpdate(tableId, match.record_id, fields)
          : feishu.baseRecordCreate(tableId, fields);
        if (r && r.ok) synced.events++;
        else console.error(`[sync] 全量同步-事件失败 ${ev.event_id}:`, r && r.error);
      } catch (e) {
        console.error(`[sync] 全量同步-事件异常 ${ev.event_id}:`, e.message);
      }
    }
  } catch (e) {
    console.error('[sync] 全量同步-读取事件失败:', e.message);
  }

  // ---- 遥测：最近 100 条批量写入（一次 batch-create API 调用）----
  try {
    const rows = db.prepare('SELECT * FROM telemetry ORDER BY ts DESC LIMIT 100').all();
    if (rows && rows.length > 0) {
      const batchRows = rows.map((t) => [
        t.device_id,
        feishu.fmtDateTime(t.ts),
        t.pitch_deg != null ? Number(t.pitch_deg) : null,
        t.torque_nm != null ? Number(t.torque_nm) : null,
        t.battery_pct != null ? Number(t.battery_pct) : null,
        t.quality_status || '',
      ]);
      const r = feishu.baseRecordBatchCreate(cfg.tables.telemetry, TELEMETRY_BATCH_FIELDS, batchRows);
      if (r && r.ok) synced.telemetry = batchRows.length;
      else console.error('[sync] 全量同步-遥测批量失败:', r && r.error);
    }
  } catch (e) {
    console.error('[sync] 全量同步-读取遥测失败:', e.message);
  }

  console.log(
    `[sync] 全量同步完成: 设备=${synced.devices}, 事件=${synced.events}, 遥测=${synced.telemetry}`
  );
  return { ok: true, synced };
}

module.exports = {
  loadFeishuConfig,
  syncDevice,
  syncEventCreate,
  syncEventUpdate,
  syncTelemetry,
  flushTelemetry,
  pollFeishuEventStatusChanges,
  startEventStatusPolling,
  stopEventStatusPolling,
  syncAllToFeishu,
  DEVICE_FIELDS,
  EVENT_FIELDS,
};
