// server/events.js — 事件管理
// 提供事件 CRUD + 处置 + 自动关闭，处置/关闭时写审计日志

const crypto = require('crypto');
const dbm = require('./db');
const sync = require('./sync');

// 飞书多维表格同步（fire-and-forget，失败只 console.error 不阻断主流程）
function syncEventUpdateSafe(eventId, status, handlerAction) {
  try {
    Promise.resolve(sync.syncEventUpdate(eventId, status, handlerAction)).catch((e) =>
      console.error('[events] syncEventUpdate 失败:', e.message)
    );
  } catch (e) {
    console.error('[events] syncEventUpdate 异常:', e.message);
  }
}

// 解析事件行的 JSON 字段
function parseEventRow(row) {
  if (!row) return row;
  return {
    ...row,
    trigger_data: dbm.safeParse(row.trigger_data),
    evidence: dbm.safeParse(row.evidence),
  };
}

// 创建事件（由规则引擎调用）
function createEvent(db, payload) {
  const event_id = crypto.randomUUID();
  const now = new Date().toISOString();
  const {
    device_id, event_code, event_type, severity, title, description,
    trigger_data, evidence,
  } = payload;
  db.prepare(
    `INSERT INTO events
     (event_id, device_id, event_code, event_type, severity, title, description, status, trigger_data, evidence, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`
  ).run(
    event_id, device_id, event_code, event_type, severity || 'high',
    title || '', description || '',
    JSON.stringify(trigger_data || {}), JSON.stringify(evidence || {}),
    now, now
  );
  // 写审计
  dbm.insertAudit(db, {
    action: 'event_created',
    actor_id: 'system',
    target_type: 'event',
    target_id: event_id,
    detail: { event_code, device_id, event_type, severity },
  });
  return getEvent(db, event_id);
}

// 列表查询：支持 status / device_id 过滤 + 分页，返回 { rows, total }
function listEvents(db, { status, device_id, limit = 100, offset = 0 } = {}) {
  let where = [];
  let params = [];
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  if (device_id) {
    where.push('device_id = ?');
    params.push(device_id);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) AS c FROM events ${whereSql}`).get(...params).c;
  const rows = db.prepare(
    `SELECT * FROM events ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset).map(parseEventRow);
  return { rows, total };
}

// 单事件详情（含 evidence JSON）
function getEvent(db, event_id) {
  const row = db.prepare('SELECT * FROM events WHERE event_id = ?').get(event_id);
  return parseEventRow(row);
}

// 处置事件：action ∈ acknowledge / resolve / escalate / comment
function handleEvent(db, event_id, { handler_id, action, comment }) {
  const event = getEvent(db, event_id);
  if (!event) return null;
  const now = new Date().toISOString();
  const validActions = ['acknowledge', 'resolve', 'escalate', 'comment'];
  if (!validActions.includes(action)) {
    throw new Error(`invalid action: ${action}`);
  }

  let status = event.status;
  let closed_at = event.closed_at;
  let handled_at = event.handled_at;

  if (action === 'acknowledge') {
    status = 'handled';
    handled_at = now;
  } else if (action === 'resolve') {
    status = 'closed';
    closed_at = now;
    handled_at = now;
  } else if (action === 'escalate') {
    // 升级：保持 open（仍需处置），但记录处置人
    status = 'open';
    handled_at = now;
  } else if (action === 'comment') {
    // 仅评论，不改状态
  }

  db.prepare(
    `UPDATE events
     SET status = ?, handler_id = ?, handler_action = ?, handler_comment = ?, handled_at = ?, closed_at = ?, updated_at = ?
     WHERE event_id = ?`
  ).run(status, handler_id || null, action, comment || null, handled_at || null, closed_at || null, now, event_id);

  // 写审计
  dbm.insertAudit(db, {
    action: 'event_handled',
    actor_id: handler_id || 'unknown',
    target_type: 'event',
    target_id: event_id,
    detail: { action, comment, prev_status: event.status, new_status: status },
  });

  // 同步事件状态变更到飞书多维表格（失败不阻断）
  syncEventUpdateSafe(event_id, status, action);

  return getEvent(db, event_id);
}

// 自动关闭（规则恢复时调用）
function closeEvent(db, event_id) {
  const event = getEvent(db, event_id);
  if (!event) return null;
  if (event.status === 'closed') return event;
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE events SET status = 'closed', closed_at = ?, updated_at = ? WHERE event_id = ?`
  ).run(now, now, event_id);
  dbm.insertAudit(db, {
    action: 'event_auto_closed',
    actor_id: 'system',
    target_type: 'event',
    target_id: event_id,
    detail: { event_code: event.event_code, device_id: event.device_id },
  });

  // 同步自动关闭状态到飞书多维表格（失败不阻断）
  syncEventUpdateSafe(event_id, 'closed', 'auto_closed');

  return getEvent(db, event_id);
}

// 查询某设备某规则代码下仍开启的事件（用于规则恢复时自动关闭）
function findOpenEventsByCode(db, device_id, event_code) {
  const rows = db.prepare(
    `SELECT * FROM events WHERE device_id = ? AND event_code = ? AND status = 'open' ORDER BY created_at DESC`
  ).all(device_id, event_code);
  return rows.map(parseEventRow);
}

module.exports = {
  parseEventRow,
  createEvent,
  listEvents,
  getEvent,
  handleEvent,
  closeEvent,
  findOpenEventsByCode,
};
