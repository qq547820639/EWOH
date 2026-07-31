// server/feishu.js — 飞书集成模块
// 通过 lark-cli 子进程调用飞书 OpenAPI，封装消息卡片 / 多维表格 / 审批 / 文档四类能力
// 所有调用 try/catch 容错，失败只 console.error 不抛出（不阻断主流程）

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'feishu-config.json');
const LARK_BIN = process.env.LARK_CLI || 'lark-cli';

// 模块级配置（从 feishu-config.json 读取）
let config = null;

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    config = JSON.parse(raw);
    return config;
  } catch (e) {
    console.error('[feishu] 加载 feishu-config.json 失败:', e.message);
    config = null;
    return null;
  }
}

function getConfig() {
  if (!config) loadConfig();
  return config;
}

// ============ 核心 lark-cli 封装 ============

// 用 spawnSync 调用 lark-cli，args 是字符串数组；自动追加 --as user|bot
// input 为 stdin 字符串（可选）；返回 { ok, data, error }，解析 JSON 输出
function larkCli(args, { input, asBot = false } = {}) {
  const fullArgs = args.concat(['--as', asBot ? 'bot' : 'user']);
  try {
    const res = spawnSync(LARK_BIN, fullArgs, {
      input: input != null ? input : undefined,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    if (res.error) {
      console.error('[feishu] lark-cli 启动失败:', res.error.message);
      return { ok: false, data: null, error: res.error.message };
    }
    const stdout = (res.stdout || '').trim();
    const stderr = (res.stderr || '').trim();

    // 优先尝试解析 stdout 中的 JSON 信封 {ok, data, error}
    let parsed = null;
    if (stdout) {
      try { parsed = JSON.parse(stdout); } catch (_) { parsed = null; }
    }

    if (res.status !== 0) {
      if (parsed && parsed.ok === false) {
        console.error('[feishu] lark-cli 调用失败:', JSON.stringify(parsed.error));
        return { ok: false, data: null, error: parsed.error || `exit ${res.status}` };
      }
      console.error(`[feishu] lark-cli 退出码 ${res.status}: ${(stderr || stdout).slice(0, 300)}`);
      return { ok: false, data: null, error: stderr || `exit ${res.status}` };
    }

    if (!parsed) {
      // 非 JSON 输出（理论上加 --json 不会出现，兜底处理）
      console.error('[feishu] lark-cli 输出非 JSON:', stdout.slice(0, 200));
      return { ok: false, data: null, error: 'non-json output' };
    }

    if (typeof parsed === 'object' && 'ok' in parsed) {
      if (parsed.ok) {
        return { ok: true, data: parsed.data != null ? parsed.data : parsed, error: null };
      }
      console.error('[feishu] lark-cli 返回错误:', JSON.stringify(parsed.error));
      return { ok: false, data: null, error: parsed.error || 'unknown' };
    }
    // 直接返回原始数据
    return { ok: true, data: parsed, error: null };
  } catch (e) {
    console.error('[feishu] larkCli 异常:', e.message);
    return { ok: false, data: null, error: e.message };
  }
}

// identity 默认 user，失败时尝试 bot 重试一次
function larkCliRetry(args, opts = {}) {
  let r = larkCli(args, { ...opts, asBot: false });
  if (!r.ok) {
    r = larkCli(args, { ...opts, asBot: true });
  }
  return r;
}

// ============ 工具函数 ============

// ISO 时间 → 飞书 datetime 字段接受的 "YYYY-MM-DD HH:mm:ss" 字符串
function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// 防御性提取嵌套字段
function deepFind(obj, keys) {
  let cur = obj;
  for (const k of keys) {
    if (cur && typeof cur === 'object' && k in cur) cur = cur[k];
    else return undefined;
  }
  return cur;
}

// 归一化 record-search 结果为 [{ record_id, fields }] 数组
function normalizeRecords(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data.filter((r) => r && r.record_id);
  const arr = data.items || data.records || data.data || (data.data && (data.data.items || data.data.records));
  if (Array.isArray(arr)) return arr.filter((r) => r && r.record_id);
  if (data.record_id) return [data];
  return [];
}

// 取记录中某字段值（fields 可能是 {value} 或直接值）
function getRecordField(rec, fieldName) {
  if (!rec || !rec.fields) return undefined;
  const v = rec.fields[fieldName];
  if (v && typeof v === 'object' && 'text' in v) return v.text;
  if (Array.isArray(v) && v[0] && typeof v[0] === 'object' && 'text' in v[0]) return v[0].text;
  return v;
}

// ============ 告警卡片构建 ============

function buildAlertCard(event) {
  const sev = (event && event.severity) || 'high';
  const template = sev === 'high' ? 'red' : 'orange';
  const evType = (event && event.event_type) || '-';
  const eventId = (event && event.event_id) || '-';
  const deviceId = (event && event.device_id) || '-';
  const worker = (event && event.worker_name) || '-';
  const title = (event && event.title) || 'EWOH 告警';
  const trigger = event && event.trigger_data
    ? JSON.stringify(event.trigger_data, null, 2)
    : '-';

  // 仪表盘 URL：优先从 config.dashboards.event_risk.url 读取，失败用默认 URL
  const DEFAULT_DASHBOARD_URL = 'https://xqjyctsd.feishu.cn/base/WQmbbeplMaGffVsjtW0cTgAMn5c/dashboard/blkbdfYoQACu9MU7';
  const cfg = getConfig();
  const dashboardUrl =
    (cfg && cfg.dashboards && cfg.dashboards.event_risk && cfg.dashboards.event_risk.url) ||
    DEFAULT_DASHBOARD_URL;

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `[EWOH告警] ${title}` },
      template,
    },
    elements: [
      {
        tag: 'div',
        fields: [
          { is_short: true, text: { tag: 'lark_md', content: `**设备ID**\n${deviceId}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**工人**\n${worker}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**事件类型**\n${evType}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**严重程度**\n${sev}` } },
        ],
      },
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: `**事件ID**\n${eventId}` } },
      { tag: 'div', text: { tag: 'lark_md', content: `**触发数据**\n\`\`\`json\n${trigger}\n\`\`\`` } },
      { tag: 'hr' },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '确认' },
            type: 'primary',
            value: { action_type: 'acknowledge', event_id: eventId },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '解决' },
            type: 'success',
            value: { action_type: 'resolve', event_id: eventId },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '上报' },
            type: 'danger',
            value: { action_type: 'escalate', event_id: eventId },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '查看仪表盘' },
            type: 'primary',
            url: dashboardUrl,
          },
        ],
      },
    ],
  };
}

// 处置后更新卡片为"已处置"状态
function buildHandledCard(event, actionLabel) {
  const sev = (event && event.severity) || 'high';
  const template = actionLabel === '已解决' ? 'green' : 'blue';
  const eventId = (event && event.event_id) || '-';
  const deviceId = (event && event.device_id) || '-';
  const worker = (event && event.worker_name) || '-';
  const title = (event && event.title) || 'EWOH 告警';
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `[已处置] ${title}` },
      template,
    },
    elements: [
      {
        tag: 'div',
        fields: [
          { is_short: true, text: { tag: 'lark_md', content: `**设备ID**\n${deviceId}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**工人**\n${worker}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**事件ID**\n${eventId}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**处置结果**\n${actionLabel}` } },
        ],
      },
      { tag: 'div', text: { tag: 'lark_md', content: `> 本事件已于 ${fmtDateTime(new Date().toISOString())} 处置完毕。` } },
    ],
  };
}

// ============ IM 消息 ============

// 发送告警卡片到群聊，返回 { message_id, error }
function sendAlertCard(chatId, event) {
  const cfg = getConfig();
  if (!cfg || !chatId || !event) {
    return { message_id: null, error: 'invalid args' };
  }
  const card = buildAlertCard(event);
  // im +messages-send 的 --content 不支持 stdin，直接作为参数传入（卡片 JSON 较小）
  const r = larkCliRetry(
    ['im', '+messages-send', '--chat-id', chatId, '--msg-type', 'interactive', '--content', JSON.stringify(card), '--json']
  );
  if (!r.ok) return { message_id: null, error: r.error };
  const messageId =
    deepFind(r.data, ['message_id']) ||
    deepFind(r.data, ['data', 'message_id']) ||
    deepFind(r.data, ['message', 'message_id']);
  return { message_id: messageId || null, error: null };
}

// 更新已发送卡片（best-effort：lark-cli 无原生消息更新命令，走 api 逃生口；失败由跟进消息兜底）
function updateCardMessage(messageId, card) {
  if (!messageId || !card) return { ok: false, error: 'invalid args' };
  const body = { content: JSON.stringify(card), msg_type: 'interactive' };
  const r = larkCliRetry(
    ['api', 'PATCH', `/open-apis/im/v1/messages/${messageId}`, '--data', '-', '--json'],
    { input: JSON.stringify(body) }
  );
  if (!r.ok) {
    console.error('[feishu] 更新卡片失败（将依赖跟进消息）:', r.error);
  }
  return { ok: r.ok, error: r.error };
}

// 发送跟进文本消息，返回 { message_id, error }
function sendFollowupMessage(chatId, text) {
  const cfg = getConfig();
  if (!cfg || !chatId || !text) {
    return { message_id: null, error: 'invalid args' };
  }
  const r = larkCliRetry(
    ['im', '+messages-send', '--chat-id', chatId, '--msg-type', 'text', '--content', JSON.stringify({ text }), '--json']
  );
  if (!r.ok) return { message_id: null, error: r.error };
  const messageId =
    deepFind(r.data, ['message_id']) ||
    deepFind(r.data, ['data', 'message_id']);
  return { message_id: messageId || null, error: null };
}

// ============ 多维表格记录 ============

// 创建记录（upsert 无 record-id 即创建），fields 为 {字段名: CellValue}
// 注意：base 命令的 --json 不支持 stdin，直接作为参数值传入（字段映射较小，无 argv 长度问题）
function baseRecordCreate(tableId, fields) {
  const cfg = getConfig();
  if (!cfg || !tableId || !fields) return { ok: false, error: 'invalid args' };
  const r = larkCliRetry(
    ['base', '+record-upsert', '--base-token', cfg.base_token, '--table-id', tableId, '--json', JSON.stringify(fields)]
  );
  const recordId = deepFind(r.data, ['record_id']) || deepFind(r.data, ['record', 'record_id']) || deepFind(r.data, ['data', 'record', 'record_id']);
  return { ok: r.ok, record_id: recordId || null, error: r.error };
}

// 更新记录（upsert 带 record-id 即更新）
function baseRecordUpdate(tableId, recordId, fields) {
  const cfg = getConfig();
  if (!cfg || !tableId || !recordId || !fields) return { ok: false, error: 'invalid args' };
  const r = larkCliRetry(
    ['base', '+record-upsert', '--base-token', cfg.base_token, '--table-id', tableId, '--record-id', recordId, '--json', JSON.stringify(fields)]
  );
  return { ok: r.ok, record_id: recordId, error: r.error };
}

// 按字段查记录：filter = { field, value }，返回 [{ record_id, fields }]
function baseRecordSearch(tableId, { filter, limit } = {}) {
  const cfg = getConfig();
  if (!cfg || !tableId || !filter || !filter.field) return [];
  const r = larkCliRetry(
    ['base', '+record-search', '--base-token', cfg.base_token, '--table-id', tableId,
     '--keyword', String(filter.value), '--search-field', filter.field,
     '--limit', String(limit || 10), '--format', 'json']
  );
  if (!r.ok) return [];
  return normalizeRecords(r.data);
}

// 批量创建记录：fieldsList 为字段名数组，rows 为 [[v1,v2,...], ...]
function baseRecordBatchCreate(tableId, fieldsList, rows) {
  const cfg = getConfig();
  if (!cfg || !tableId || !Array.isArray(fieldsList) || !Array.isArray(rows) || rows.length === 0) {
    return { ok: false, error: 'invalid args' };
  }
  const body = { fields: fieldsList, rows };
  // base --json 不支持 stdin，直接传参；遥测批量 JSON 较小（每 5s ~15 行），无长度问题
  const r = larkCliRetry(
    ['base', '+record-batch-create', '--base-token', cfg.base_token, '--table-id', tableId, '--json', JSON.stringify(body)]
  );
  return { ok: r.ok, count: rows.length, error: r.error };
}

// ============ 审批 ============

// 创建飞书审批实例（简化版：原生审批需要 approval_code，本地未配置时降级为群聊消息）
// 返回 { approval_id, status }
function createApproval(event) {
  const cfg = getConfig();
  const chatId = cfg && cfg.chat_id;
  const eventId = (event && event.event_id) || '-';
  const title = (event && event.title) || 'EWOH 事件';

  // 尝试原生审批实例创建（需要预置 approval_code，本地通常无配置 → 会失败降级）
  const body = {
    approval_code: (cfg && cfg.approval_code) || 'EWOH_EVENT_ESCALATION',
    form: {
      name: `[EWOH上报] ${title}`,
      content: JSON.stringify({
        event_id: eventId,
        device_id: event && event.device_id,
        title,
        severity: event && event.severity,
      }),
    },
  };
  const r = larkCliRetry(
    ['approval', 'instances', 'create', '--data', '-', '--yes', '--json'],
    { input: JSON.stringify(body) }
  );
  if (r.ok && r.data) {
    const instId = deepFind(r.data, ['instance_id']) || deepFind(r.data, ['data', 'instance_id']);
    if (instId) return { approval_id: instId, status: 'pending' };
  }

  // 降级：发送"待审批"消息到群聊
  console.error('[feishu] 原生审批创建失败，降级为群聊消息通知');
  if (chatId) {
    sendFollowupMessage(
      chatId,
      `⚠️ 事件上报审批（降级为消息通知）\n` +
      `事件ID: ${eventId}\n` +
      `设备: ${(event && event.device_id) || '-'}\n` +
      `标题: ${title}\n` +
      `严重度: ${(event && event.severity) || '-'}\n` +
      `请主管跟进处置。`
    );
  }
  return { approval_id: null, status: 'pending_manual' };
}

// ============ 班次报告文档 ============

function buildReportMarkdown(stats, eventList, ts) {
  const dev = (stats && stats.devices) || {};
  const ev = (stats && stats.events) || {};
  const total = ev.total || 0;
  const handled = (ev.handled || 0) + (ev.closed || 0);
  const rate = total > 0 ? Math.round((handled / total) * 100) : 0;

  let md = `# EWOH 班次报告\n\n生成时间：${ts}\n\n`;
  md += `## 一、设备统计\n\n`;
  md += `- 设备总数：${dev.total || 0}\n`;
  md += `- 在线：${dev.online || 0}\n`;
  md += `- 离线：${dev.offline || 0}\n\n`;
  md += `## 二、事件统计\n\n`;
  md += `- 事件总数：${total}\n`;
  md += `- 待处置（open）：${ev.open || 0}\n`;
  md += `- 已处置（handled）：${ev.handled || 0}\n`;
  md += `- 已关闭（closed）：${ev.closed || 0}\n`;
  md += `- 处置率：${rate}%\n\n`;
  md += `## 三、详细事件列表\n\n`;
  if (Array.isArray(eventList) && eventList.length > 0) {
    md += `| 事件ID | 设备 | 编码 | 类型 | 严重度 | 状态 | 创建时间 |\n`;
    md += `|--------|------|------|------|--------|------|----------|\n`;
    for (const e of eventList) {
      const eid = (e.event_id || '').slice(0, 8);
      md += `| ${eid} | ${e.device_id || '-'} | ${e.event_code || '-'} | ${e.event_type || '-'} | ${e.severity || '-'} | ${e.status || '-'} | ${fmtDateTime(e.created_at)} |\n`;
    }
  } else {
    md += `> 本班次无事件记录。\n`;
  }
  md += `\n---\n*由 EWOH 外骨骼监督平台自动生成*\n`;
  return md;
}

// 创建飞书文档（班次报告），返回 { url, doc_token, error }
function createReportDoc(stats, eventList) {
  const cfg = getConfig();
  if (!cfg) return { url: null, doc_token: null, error: 'no config' };
  const ts = fmtDateTime(new Date().toISOString());
  const title = `EWOH班次报告 ${ts}`;
  const md = buildReportMarkdown(stats, eventList, ts);
  // docs +create 支持 --content - 从 stdin 读取 markdown，一次性创建带正文文档
  const r = larkCliRetry(
    ['docs', '+create', '--title', title, '--doc-format', 'markdown', '--content', '-', '--json'],
    { input: md }
  );
  if (!r.ok) {
    console.error('[feishu] 创建报告文档失败:', r.error);
    return { url: null, doc_token: null, error: r.error };
  }
  const docToken =
    deepFind(r.data, ['document_id']) ||
    deepFind(r.data, ['document', 'document_id']) ||
    deepFind(r.data, ['data', 'document', 'document_id']);
  const url =
    deepFind(r.data, ['url']) ||
    deepFind(r.data, ['data', 'url']) ||
    (docToken ? `https://feishu.cn/doc/${docToken}` : null);
  return { url, doc_token: docToken || null, error: null };
}

module.exports = {
  larkCli,
  larkCliRetry,
  loadConfig,
  getConfig,
  fmtDateTime,
  // IM
  sendAlertCard,
  updateCardMessage,
  sendFollowupMessage,
  buildAlertCard,
  buildHandledCard,
  // Base
  baseRecordCreate,
  baseRecordUpdate,
  baseRecordSearch,
  baseRecordBatchCreate,
  normalizeRecords,
  getRecordField,
  // 审批 / 文档
  createApproval,
  createReportDoc,
};
