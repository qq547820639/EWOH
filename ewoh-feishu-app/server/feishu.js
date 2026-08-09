// server/feishu.js — 飞书集成模块
// 通过 lark-cli 子进程调用飞书 OpenAPI，封装消息卡片 / 多维表格 / 审批 / 文档四类能力
// 所有调用 try/catch 容错，失败只 console.error 不抛出（不阻断主流程）
//
// P1-2（2026-08-09）：larkCli 由 spawnSync 改为异步 execFile（20s 超时 + SIGTERM 回收，
// maxBuffer 16MB 语义不变），调用链全部 async 化，消除请求路径对事件循环的同步阻塞；
// 增加并发上限（MAX_CONCURRENT=4，手写信号量）与熔断（连续失败 ≥5 次暂停 30s）。

const { execFile } = require('child_process');
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

// ============ 核心 lark-cli 封装（P1-2 异步化）============

// 并发上限：同一时刻最多 MAX_CONCURRENT 个 lark-cli 子进程
// 熔断：连续失败 ≥ BREAKER_THRESHOLD 次后暂停 BREAKER_COOLDOWN_MS
// 说明：以下三项用 let 而非 const，仅为 node --test 测试钩子（__test）可注入
// 配置（如缩短冷却期），生产路径默认值不变。
let MAX_CONCURRENT = 4;
let BREAKER_THRESHOLD = 5;
let BREAKER_COOLDOWN_MS = 30000;

let activeCliCalls = 0;
const cliWaitQueue = [];
let consecutiveCliFailures = 0;
let breakerOpenUntil = 0;

// 获取并发槽位（满时排队等待，不阻塞事件循环）
function acquireCliSlot() {
  if (activeCliCalls < MAX_CONCURRENT) {
    activeCliCalls += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    cliWaitQueue.push(resolve);
  });
}

// 释放并发槽位并唤醒下一个等待者
function releaseCliSlot() {
  activeCliCalls -= 1;
  const next = cliWaitQueue.shift();
  if (next) next();
}

// 记录一次调用结果并驱动熔断状态机
function recordCliResult(ok) {
  if (ok) {
    consecutiveCliFailures = 0;
    return;
  }
  consecutiveCliFailures += 1;
  if (consecutiveCliFailures >= BREAKER_THRESHOLD) {
    breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
    console.error(
      `[feishu] lark-cli 连续失败 ${consecutiveCliFailures} 次，熔断 ${BREAKER_COOLDOWN_MS / 1000}s`
    );
  }
}

// 解析 stdout JSON 信封（失败返回 null）
function parseCliJson(stdout) {
  if (!stdout) return null;
  try {
    return JSON.parse(stdout);
  } catch (_) {
    return null;
  }
}

// 执行一次 lark-cli 子进程（异步；20s 超时由 execFile timeout 触发 SIGTERM 回收）
function runLarkCliProcess(args, { input, asBot }) {
  const fullArgs = args.concat(['--as', asBot ? 'bot' : 'user']);
  return new Promise((resolve) => {
    execFile(
      LARK_BIN,
      fullArgs,
      {
        input: input != null ? input : undefined,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        // P1-2：保留 20s 硬超时语义，超时后 execFile 以 SIGTERM 回收子进程
        timeout: 20000,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        // 超时：execFile 以 err.signal === 'SIGTERM' 表示（进程已被回收）
        if (err && err.signal === 'SIGTERM') {
          console.error(`[feishu] lark-cli 超时（>20s）: ${fullArgs.slice(0, 3).join(' ')}`);
          resolve({ ok: false, data: null, error: 'lark-cli timeout (>20s)' });
          return;
        }
        // maxBuffer 超限（ENOBUFS）：与"启动失败"区分，输出准确文案
        if (err && err.code === 'ENOBUFS') {
          console.error('[feishu] lark-cli 输出超过 maxBuffer（16MB）:', err.message);
          resolve({ ok: false, data: null, error: 'lark-cli output exceeded maxBuffer (16MB)' });
          return;
        }
        // 启动失败（找不到二进制/无权限等）：err.code 为非数字字符串（ENOENT/EACCES/...）
        if (err && typeof err.code !== 'number') {
          console.error('[feishu] lark-cli 启动失败:', err.message);
          resolve({ ok: false, data: null, error: err.message });
          return;
        }
        // 非零退出码：err.code 为数字
        if (err && typeof err.code === 'number') {
          const parsed = parseCliJson(stdout);
          if (parsed && parsed.ok === false) {
            console.error('[feishu] lark-cli 调用失败:', JSON.stringify(parsed.error));
            resolve({ ok: false, data: null, error: parsed.error || `exit ${err.code}` });
            return;
          }
          console.error(
            `[feishu] lark-cli 退出码 ${err.code}: ${(stderr || stdout || '').slice(0, 300)}`
          );
          resolve({ ok: false, data: null, error: (stderr || '').trim() || `exit ${err.code}` });
          return;
        }
        if (err) {
          console.error('[feishu] lark-cli 异常:', err.message);
          resolve({ ok: false, data: null, error: err.message });
          return;
        }
        const out = (stdout || '').trim();
        const parsed = parseCliJson(out);
        if (!parsed) {
          // 非 JSON 输出（理论上加 --json 不会出现，兜底处理）
          console.error('[feishu] lark-cli 输出非 JSON:', out.slice(0, 200));
          resolve({ ok: false, data: null, error: 'non-json output' });
          return;
        }
        if (typeof parsed === 'object' && 'ok' in parsed) {
          if (parsed.ok) {
            resolve({ ok: true, data: parsed.data != null ? parsed.data : parsed, error: null });
            return;
          }
          console.error('[feishu] lark-cli 返回错误:', JSON.stringify(parsed.error));
          resolve({ ok: false, data: null, error: parsed.error || 'unknown' });
          return;
        }
        // 直接返回原始数据
        resolve({ ok: true, data: parsed, error: null });
      }
    );
  });
}

// 用异步 execFile 调用 lark-cli，args 是字符串数组；自动追加 --as user|bot
// input 为 stdin 字符串（可选）；返回 Promise<{ ok, data, error }>，解析 JSON 输出
async function larkCli(args, { input, asBot = false } = {}) {
  // 熔断打开：直接快速失败，不再启动子进程
  const now = Date.now();
  if (breakerOpenUntil > now) {
    const waitSec = Math.ceil((breakerOpenUntil - now) / 1000);
    console.error(
      `[feishu] lark-cli 熔断中（连续失败 ${consecutiveCliFailures} 次，${waitSec}s 后重试）`
    );
    return { ok: false, data: null, error: `circuit breaker open (retry in ${waitSec}s)` };
  }
  await acquireCliSlot();
  try {
    const r = await runLarkCliProcess(args, { input, asBot });
    recordCliResult(r.ok);
    return r;
  } finally {
    releaseCliSlot();
  }
}

// identity 默认 user，失败时尝试 bot 重试一次（异步）
async function larkCliRetry(args, opts = {}) {
  let r = await larkCli(args, { ...opts, asBot: false });
  if (!r.ok) {
    r = await larkCli(args, { ...opts, asBot: true });
  }
  return r;
}

// ============ 测试钩子（node --test 用；生产路径不受影响）============
// 允许测试重置/注入并发与熔断配置（如缩短 30s 冷却期），避免真实时间拖慢测试。
const __test = {
  reset() {
    activeCliCalls = 0;
    cliWaitQueue.length = 0;
    consecutiveCliFailures = 0;
    breakerOpenUntil = 0;
    MAX_CONCURRENT = 4;
    BREAKER_THRESHOLD = 5;
    BREAKER_COOLDOWN_MS = 30000;
  },
  setMaxConcurrent(n) {
    MAX_CONCURRENT = n;
  },
  setBreakerThreshold(n) {
    BREAKER_THRESHOLD = n;
  },
  setBreakerCooldownMs(n) {
    BREAKER_COOLDOWN_MS = n;
  },
  getState() {
    return {
      activeCliCalls,
      consecutiveCliFailures,
      breakerOpenUntil,
      MAX_CONCURRENT,
      BREAKER_THRESHOLD,
      BREAKER_COOLDOWN_MS,
    };
  },
};

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

  // 仪表盘 URL：优先从 config.dashboards.event_risk.url 读取；缺失时由
  // config.base_url + dashboard id 拼装。禁止在源码中硬编码真实 base_token。
  // 配置未就绪（无 base_url）时返回空串，不泄露任何凭据。
  const cfg = getConfig();
  const dash = cfg && cfg.dashboards && cfg.dashboards.event_risk;
  const dashboardUrl =
    (dash && dash.url) ||
    (cfg && cfg.base_url
      ? `${cfg.base_url.replace(/\/+$/, '')}/dashboard/${(dash && dash.id) || ''}`
      : '');

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

// 发送告警卡片到群聊，返回 Promise<{ message_id, error }>
async function sendAlertCard(chatId, event) {
  const cfg = getConfig();
  if (!cfg || !chatId || !event) {
    return { message_id: null, error: 'invalid args' };
  }
  const card = buildAlertCard(event);
  // im +messages-send 的 --content 不支持 stdin，直接作为参数传入（卡片 JSON 较小）
  const r = await larkCliRetry(
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
async function updateCardMessage(messageId, card) {
  if (!messageId || !card) return { ok: false, error: 'invalid args' };
  const body = { content: JSON.stringify(card), msg_type: 'interactive' };
  const r = await larkCliRetry(
    ['api', 'PATCH', `/open-apis/im/v1/messages/${messageId}`, '--data', '-', '--json'],
    { input: JSON.stringify(body) }
  );
  if (!r.ok) {
    console.error('[feishu] 更新卡片失败（将依赖跟进消息）:', r.error);
  }
  return { ok: r.ok, error: r.error };
}

// 发送跟进文本消息，返回 Promise<{ message_id, error }>
async function sendFollowupMessage(chatId, text) {
  const cfg = getConfig();
  if (!cfg || !chatId || !text) {
    return { message_id: null, error: 'invalid args' };
  }
  const r = await larkCliRetry(
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
// C1 修复：base_token 优先从环境变量 FEISHU_BASE_TOKEN 注入（避免凭据落入配置文件与命令行参数）；
// 为空时直接失败（不传空参数）。
async function baseRecordCreate(tableId, fields) {
  const cfg = getConfig();
  const baseToken = process.env.FEISHU_BASE_TOKEN || (cfg && cfg.base_token);
  if (!baseToken || !tableId || !fields) return { ok: false, error: 'invalid args' };
  const r = await larkCliRetry(
    ['base', '+record-upsert', '--base-token', baseToken, '--table-id', tableId, '--json', JSON.stringify(fields)]
  );
  const recordId = deepFind(r.data, ['record_id']) || deepFind(r.data, ['record', 'record_id']) || deepFind(r.data, ['data', 'record', 'record_id']);
  return { ok: r.ok, record_id: recordId || null, error: r.error };
}

// 更新记录（upsert 带 record-id 即更新）
async function baseRecordUpdate(tableId, recordId, fields) {
  const cfg = getConfig();
  const baseToken = process.env.FEISHU_BASE_TOKEN || (cfg && cfg.base_token);
  if (!baseToken || !tableId || !recordId || !fields) return { ok: false, error: 'invalid args' };
  const r = await larkCliRetry(
    ['base', '+record-upsert', '--base-token', baseToken, '--table-id', tableId, '--record-id', recordId, '--json', JSON.stringify(fields)]
  );
  return { ok: r.ok, record_id: recordId, error: r.error };
}

// 按字段查记录：filter = { field, value }，返回 Promise<[{ record_id, fields }]>
async function baseRecordSearch(tableId, { filter, limit } = {}) {
  const cfg = getConfig();
  const baseToken = process.env.FEISHU_BASE_TOKEN || (cfg && cfg.base_token);
  if (!baseToken || !tableId || !filter || !filter.field) return [];
  const r = await larkCliRetry(
    ['base', '+record-search', '--base-token', baseToken, '--table-id', tableId,
     '--keyword', String(filter.value), '--search-field', filter.field,
     '--limit', String(limit || 10), '--format', 'json']
  );
  if (!r.ok) return [];
  return normalizeRecords(r.data);
}

// 批量创建记录：fieldsList 为字段名数组，rows 为 [[v1,v2,...], ...]
async function baseRecordBatchCreate(tableId, fieldsList, rows) {
  const cfg = getConfig();
  const baseToken = process.env.FEISHU_BASE_TOKEN || (cfg && cfg.base_token);
  if (!baseToken || !tableId || !Array.isArray(fieldsList) || !Array.isArray(rows) || rows.length === 0) {
    return { ok: false, error: 'invalid args' };
  }
  const body = { fields: fieldsList, rows };
  // base --json 不支持 stdin，直接传参；遥测批量 JSON 较小（每 5s ~15 行），无长度问题
  const r = await larkCliRetry(
    ['base', '+record-batch-create', '--base-token', baseToken, '--table-id', tableId, '--json', JSON.stringify(body)]
  );
  return { ok: r.ok, count: rows.length, error: r.error };
}

// ============ 审批 ============

// 创建飞书审批实例（简化版：原生审批需要 approval_code，本地未配置时降级为群聊消息）
// 返回 Promise<{ approval_id, status }>
async function createApproval(event) {
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
  const r = await larkCliRetry(
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
    await sendFollowupMessage(
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

// 创建飞书文档（班次报告），返回 Promise<{ url, doc_token, error }>
async function createReportDoc(stats, eventList) {
  const cfg = getConfig();
  if (!cfg) return { url: null, doc_token: null, error: 'no config' };
  const ts = fmtDateTime(new Date().toISOString());
  const title = `EWOH班次报告 ${ts}`;
  const md = buildReportMarkdown(stats, eventList, ts);
  // docs +create 支持 --content - 从 stdin 读取 markdown，一次性创建带正文文档
  const r = await larkCliRetry(
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
  __test,
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
