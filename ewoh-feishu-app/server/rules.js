// server/rules.js — 规则引擎
// 4 条规则，每帧遥测到达时评估，维护状态机实现「持续门槛 + 冷却」防抖
// 条件持续达门槛 → 触发事件；条件恢复 → 自动关闭对应开启事件
//
// v1.1.0 加固（设计决策 D5）：
//   - 规则配置（阈值/持续门槛/冷却/标题/描述）以 DB `rules` 表为唯一事实源，
//     rules.js 不再硬编码第二份配置，消除双源漂移；
//   - 每条规则评估前从 DB 读取当前启用状态与最新参数，支持运行时调参。

const events = require('./events');
const dbm = require('./db');
const feishu = require('./feishu');
const sync = require('./sync');

// 兜底默认规则（仅当 DB rules 表为空时使用；seedData 会写入等价的 4 条）
// FS-017：单一事实源为 db.js 的 SEED_RULES —— 本数组由其派生
//（config 字段平铺 + severity 提升），消除两份阈值分别维护的漂移风险。
const DEFAULT_RULES = dbm.SEED_RULES.map((r) => ({
  rule_id: r.rule_id,
  severity: r.severity,
  ...(r.config || {}),
}));

// 状态机：key = `${event_code}::${device_id}`
// value = { condition_met, condition_start_ts, duration_sec, last_trigger_ts }
const stateMap = new Map();

function getState(eventCode, deviceId) {
  const key = `${eventCode}::${deviceId}`;
  let s = stateMap.get(key);
  if (!s) {
    s = { condition_met: false, condition_start_ts: null, duration_sec: 0, last_trigger_ts: null };
    stateMap.set(key, s);
  }
  return s;
}

// 从 DB 加载规则配置（唯一事实源）。DB 空时回退 DEFAULT_RULES。
// 返回规范化数组：[{ rule_id, event_code, event_type, severity, title, description, param, op, value, threshold_sec, cooldown_sec, enabled }]
function loadRules(db) {
  const rows = dbm.listRules(db);
  if (!rows || rows.length === 0) {
    return DEFAULT_RULES.map((r) => ({ ...r, enabled: true }));
  }
  const rules = [];
  for (const r of rows) {
    const cfg = r.config || {};
    const base = DEFAULT_RULES.find((d) => d.event_code === cfg.event_code) || {};
    rules.push({
      rule_id: r.rule_id,
      event_code: cfg.event_code || base.event_code,
      event_type: cfg.event_type || base.event_type || 'L2',
      severity: r.severity || base.severity || 'medium',
      title: cfg.title || base.title || cfg.event_code,
      description: cfg.description || base.description || '',
      param: cfg.param || base.param,
      op: cfg.op || base.op || '>',
      value: cfg.value !== undefined ? cfg.value : base.value,
      threshold_sec: cfg.threshold_sec !== undefined ? cfg.threshold_sec : (base.threshold_sec !== undefined ? base.threshold_sec : 0),
      cooldown_sec: cfg.cooldown_sec !== undefined ? cfg.cooldown_sec : (base.cooldown_sec !== undefined ? base.cooldown_sec : 0),
      enabled: r.enabled !== false,
    });
  }
  return rules;
}

// 通用条件求值（数值比较容错：非数字一律 false；字符串按 === / !== 比较）
function evalCondition(telemetry, rule) {
  const val = telemetry[rule.param];
  if (val === undefined || val === null) return false;
  switch (rule.op) {
    case '>': return typeof val === 'number' && val > rule.value;
    case '<': return typeof val === 'number' && val < rule.value;
    case '>=': return typeof val === 'number' && val >= rule.value;
    case '<=': return typeof val === 'number' && val <= rule.value;
    case '!=': return val !== rule.value;
    case '==': return val === rule.value;
    default: return false;
  }
}

// 评估一帧遥测数据，返回本次新触发的事件数组
function evaluateRules(db, telemetry) {
  const triggered = [];
  if (!telemetry || !telemetry.device_id) return triggered;

  const deviceId = telemetry.device_id;
  const nowMs = Date.now();

  // 从 DB 加载规则（唯一事实源，含启用状态与最新参数）
  const rules = loadRules(db);

  for (const rule of rules) {
    // 禁用则跳过并重置状态
    if (rule.enabled === false) {
      const s = getState(rule.event_code, deviceId);
      s.condition_met = false;
      s.condition_start_ts = null;
      s.duration_sec = 0;
      continue;
    }

    const s = getState(rule.event_code, deviceId);
    const met = evalCondition(telemetry, rule);

    if (met) {
      if (!s.condition_met) {
        // 条件刚开始满足
        s.condition_met = true;
        s.condition_start_ts = nowMs;
        s.duration_sec = 0;
      } else {
        // 条件持续满足，累计持续时间
        s.duration_sec = (nowMs - s.condition_start_ts) / 1000;
      }

      // 达到持续门槛 + 冷却期已过 → 触发事件
      const cooldownOk =
        s.last_trigger_ts === null ||
        nowMs - s.last_trigger_ts >= rule.cooldown_sec * 1000;

      if (s.duration_sec >= rule.threshold_sec && cooldownOk) {
        const ev = events.createEvent(db, {
          device_id: deviceId,
          event_code: rule.event_code,
          event_type: rule.event_type,
          severity: rule.severity,
          title: rule.title,
          description: rule.description,
          trigger_data: {
            rule_id: rule.rule_id,
            event_code: rule.event_code,
            param: rule.param,
            op: rule.op,
            threshold: rule.value,
            observed: telemetry[rule.param],
            threshold_sec: rule.threshold_sec,
            condition_duration_sec: +s.duration_sec.toFixed(1),
            device_id: deviceId,
          },
          evidence: {
            telemetry,
            device_id: deviceId,
            triggered_at: new Date().toISOString(),
          },
        });
        s.last_trigger_ts = nowMs;
        triggered.push(ev);

        // 飞书集成：发送告警卡片 + 同步多维表格（仅在事件触发时调用，失败不阻断主流程）
        try {
          const cfg = feishu.getConfig();
          if (cfg && cfg.chat_id) {
            // 补充 worker_name 供卡片展示（events 表不存该字段）
            const dev = dbm.getDevice(db, deviceId);
            if (dev) ev.worker_name = dev.worker_name;
            // P1-2：sendAlertCard 已异步化；evaluateRules 为同步路径，fire-and-forget
            //（不阻塞模拟器循环），卡片 message_id 回写在 .then 中完成
            Promise.resolve(feishu.sendAlertCard(cfg.chat_id, ev))
              .then((card) => {
                if (card && card.message_id) {
                  // 将 message_id 回写事件 evidence（FS-019：单条 UPDATE 原子化）。
                  // 原先"getEvent 读 → 改 evidence → UPDATE 整字段"的读-改-写会覆盖
                  // 并发写入的其他 evidence 键；json_set 仅设置自身键，天然无竞态。
                  try {
                    db.prepare(
                      `UPDATE events
                       SET evidence = json_set(COALESCE(evidence, '{}'), '$.feishu_message_id', ?),
                           updated_at = ?
                       WHERE event_id = ?`
                    ).run(card.message_id, new Date().toISOString(), ev.event_id);
                    ev.feishu_message_id = card.message_id;
                  } catch (e) {
                    console.error('[rules] 回写 feishu_message_id 失败:', e.message);
                  }
                }
              })
              .catch((e) => console.error('[rules] sendAlertCard 失败:', e.message));
          }
          // 同步事件记录到多维表格（fire-and-forget，不阻塞模拟器循环）
          Promise.resolve(sync.syncEventCreate(ev)).catch((e) =>
            console.error('[rules] syncEventCreate 失败:', e.message)
          );
        } catch (e) {
          console.error('[rules] 飞书告警发送失败:', e.message);
        }
      }
    } else {
      // 条件不满足
      if (s.condition_met) {
        // 条件由满足转为不满足 → 自动关闭该规则在该设备上的开启事件
        const openEvents = events.findOpenEventsByCode(db, deviceId, rule.event_code);
        for (const ev of openEvents) {
          events.closeEvent(db, ev.event_id);
        }
        s.condition_met = false;
        s.condition_start_ts = null;
        s.duration_sec = 0;
      }
    }
  }

  return triggered;
}

// 重置全部状态机（测试用）
function resetState() {
  stateMap.clear();
}

module.exports = {
  DEFAULT_RULES,
  loadRules,
  evaluateRules,
  evalCondition,
  resetState,
};
