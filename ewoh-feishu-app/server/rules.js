// server/rules.js — 规则引擎
// 4 条规则，每帧遥测到达时评估，维护状态机实现「持续门槛 + 冷却」防抖
// 条件持续达门槛 → 触发事件；条件恢复 → 自动关闭对应开启事件

const events = require('./events');
const dbm = require('./db');
const feishu = require('./feishu');
const sync = require('./sync');

// 规则引擎配置（与 db.js 预置规则保持一致，作为评估逻辑的唯一真源）
const RULES = [
  {
    rule_id: 'R001', event_code: 'POSTURE_BEND_LONG', event_type: 'L1', severity: 'high',
    title: '深弯腰持续过久', description: 'pitch > 45° 持续 ≥10s，存在腰部损伤风险',
    param: 'pitch_deg', op: '>', value: 45, threshold_sec: 10, cooldown_sec: 30,
  },
  {
    rule_id: 'R002', event_code: 'LOAD_CONTINUOUS', event_type: 'L2', severity: 'medium',
    title: '持续高负荷', description: 'torque > 20Nm 持续 ≥8s，助力系统负荷过高',
    param: 'torque_nm', op: '>', value: 20, threshold_sec: 8, cooldown_sec: 30,
  },
  {
    rule_id: 'R003', event_code: 'LOW_BATTERY', event_type: 'L1', severity: 'high',
    title: '电量过低', description: 'battery < 15%，设备即将断电',
    param: 'battery_pct', op: '<', value: 15, threshold_sec: 0, cooldown_sec: 60,
  },
  {
    rule_id: 'R004', event_code: 'SENSOR_DEGRADED', event_type: 'L1', severity: 'high',
    title: '传感器降级', description: 'quality_status != good 持续 ≥5s，数据可信度下降',
    param: 'quality_status', op: '!=', value: 'good', threshold_sec: 5, cooldown_sec: 30,
  },
];

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

// 通用条件求值
function evalCondition(telemetry, rule) {
  const val = telemetry[rule.param];
  if (val === undefined || val === null) return false;
  switch (rule.op) {
    case '>': return val > rule.value;
    case '<': return val < rule.value;
    case '>=': return val >= rule.value;
    case '<=': return val <= rule.value;
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

  // 一次性读取规则启用状态，避免每条规则重复查询
  const dbRules = dbm.listRules(db);
  const enabledMap = new Map();
  for (const r of dbRules) {
    if (r.config && r.config.event_code) {
      enabledMap.set(r.config.event_code, r.enabled !== false);
    }
  }

  for (const rule of RULES) {
    // 数据库中标记为禁用则跳过并重置状态
    const enabled = enabledMap.get(rule.event_code);
    if (enabled === false) {
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
            const card = feishu.sendAlertCard(cfg.chat_id, ev);
            if (card.message_id) {
              // 将 message_id 回写事件 evidence，便于卡片回调时定位更新
              const cur = events.getEvent(db, ev.event_id);
              const evidence = (cur && cur.evidence) || {};
              evidence.feishu_message_id = card.message_id;
              db.prepare('UPDATE events SET evidence = ?, updated_at = ? WHERE event_id = ?')
                .run(JSON.stringify(evidence), new Date().toISOString(), ev.event_id);
              ev.feishu_message_id = card.message_id;
            }
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
  RULES,
  evaluateRules,
  evalCondition,
  resetState,
};
