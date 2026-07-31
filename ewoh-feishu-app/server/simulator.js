// server/simulator.js — 设备模拟器
// 3 台虚拟外骨骼设备，每秒生成一帧遥测数据并写入 telemetry / devices 表
// 场景：EXO-001 正常作业 / EXO-002 高风险（周期性深弯腰+高负荷）/ EXO-003 设备异常（低电量+传感器降级）

const dbm = require('./db');

// 每台设备的运行时状态（tick 为已生成帧数）
const deviceState = {
  'EXO-001': { tick: 0 },
  'EXO-002': { tick: 0 },
  'EXO-003': { tick: 0 },
};

let intervalHandle = null;

// 工具：[-amp, amp] 的随机噪声
function noise(amp) {
  return (Math.random() * 2 - 1) * amp;
}

// 工具：将值约束在 [min, max]
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// ============ EXO-001 / 工人张三 — 正常作业 ============
function simEXO001(tick) {
  // 电量在 71-85 之间缓慢波动（不会触发低电量）
  const battery = clamp(78 + 7 * Math.sin(tick / 100), 0, 100);
  // 姿态角 10-30°，正常弯腰作业
  const pitch = clamp(18 + 8 * Math.sin(tick / 8) + noise(3), 5, 30);
  const roll = clamp(3 + 3 * Math.sin(tick / 6) + noise(2), -10, 10);
  // 扭矩 5-15Nm，正常助力
  const torque = clamp(9 + 4 * Math.sin(tick / 5) + noise(2), 3, 15);
  const assist = clamp(35 + 15 * Math.sin(tick / 5), 10, 60);
  return {
    pitch_deg: +pitch.toFixed(2),
    roll_deg: +roll.toFixed(2),
    torque_nm: +torque.toFixed(2),
    assist_pct: +assist.toFixed(1),
    battery_pct: +battery.toFixed(2),
    gyro_dps: [+(noise(2)).toFixed(2), +(noise(2)).toFixed(2), +(noise(1.5)).toFixed(2)],
    quality_status: 'good',
    confidence: +clamp(0.95 + noise(0.02), 0.8, 1).toFixed(3),
  };
}

// ============ EXO-002 / 工人李四 — 高风险场景 ============
// 周期 40s：0-14s 深弯腰（pitch>45°，持续 15s 触发 POSTURE_BEND_LONG）
//          15-29s 高负荷（torque>20Nm，持续 15s 触发 LOAD_CONTINUOUS）
//          30-39s 短暂休息
function simEXO002(tick) {
  const phase = tick % 40;
  let pitch, torque, assist, roll;
  if (phase < 15) {
    // 深弯腰阶段：pitch 42-64°，多数 >45°
    pitch = clamp(53 + 8 * Math.sin(tick / 3) + noise(3), 40, 70);
    torque = clamp(10 + noise(3), 4, 16);
    assist = clamp(40 + 10 * Math.sin(tick / 3), 20, 60);
    roll = clamp(6 + noise(4), -8, 12);
  } else if (phase < 30) {
    // 高负荷阶段：torque 20-32Nm，持续 >20Nm
    pitch = clamp(18 + noise(4), 5, 30);
    torque = clamp(26 + 4 * Math.sin(tick / 3) + noise(2), 18, 34);
    assist = clamp(75 + 10 * Math.sin(tick / 3), 60, 95);
    roll = clamp(4 + noise(3), -8, 10);
  } else {
    // 休息阶段
    pitch = clamp(12 + noise(3), 5, 25);
    torque = clamp(8 + noise(2), 3, 14);
    assist = clamp(30 + noise(5), 15, 50);
    roll = clamp(3 + noise(2), -8, 8);
  }
  // 电量 55-65 缓慢波动，不会触发低电量
  const battery = clamp(60 + 5 * Math.sin(tick / 150), 0, 100);
  return {
    pitch_deg: +pitch.toFixed(2),
    roll_deg: +roll.toFixed(2),
    torque_nm: +torque.toFixed(2),
    assist_pct: +assist.toFixed(1),
    battery_pct: +battery.toFixed(2),
    gyro_dps: [+(noise(2)).toFixed(2), +(noise(2)).toFixed(2), +(noise(1.5)).toFixed(2)],
    quality_status: 'good',
    confidence: +clamp(0.93 + noise(0.02), 0.8, 1).toFixed(3),
  };
}

// ============ EXO-003 / 工人王五 — 设备异常 ============
// 电量在 9-17 间波动（周期性穿越 15% 触发 LOW_BATTERY）
// 传感器质量周期性降级（good 5s → degraded 10s → invalid 5s → good 20s）
function simEXO003(tick) {
  const phase = tick % 40;
  let quality_status, confidence, gyroAmp;
  if (phase < 5) {
    quality_status = 'good';
    confidence = clamp(0.95 + noise(0.02), 0.8, 1);
    gyroAmp = 2;
  } else if (phase < 15) {
    quality_status = 'degraded';
    confidence = clamp(0.6 + noise(0.05), 0.4, 0.75);
    gyroAmp = 6;
  } else if (phase < 20) {
    quality_status = 'invalid';
    confidence = clamp(0.3 + noise(0.05), 0.1, 0.45);
    gyroAmp = 12;
  } else {
    quality_status = 'good';
    confidence = clamp(0.95 + noise(0.02), 0.8, 1);
    gyroAmp = 2;
  }
  // 电量 9-17 周期性波动，会穿越 15% 阈值
  const battery = clamp(13 + 4 * Math.sin(tick / 60), 0, 100);
  const pitch = clamp(15 + 5 * Math.sin(tick / 7) + noise(3), 5, 28);
  const roll = clamp(3 + noise(2), -8, 8);
  const torque = clamp(8 + 3 * Math.sin(tick / 5) + noise(2), 3, 13);
  const assist = clamp(30 + 10 * Math.sin(tick / 5), 10, 50);
  return {
    pitch_deg: +pitch.toFixed(2),
    roll_deg: +roll.toFixed(2),
    torque_nm: +torque.toFixed(2),
    assist_pct: +assist.toFixed(1),
    battery_pct: +battery.toFixed(2),
    gyro_dps: [+(noise(gyroAmp)).toFixed(2), +(noise(gyroAmp)).toFixed(2), +(noise(gyroAmp * 0.8)).toFixed(2)],
    quality_status,
    confidence: +confidence.toFixed(3),
  };
}

const SIMULATORS = {
  'EXO-001': simEXO001,
  'EXO-002': simEXO002,
  'EXO-003': simEXO003,
};

// 生成单台设备的一帧并写入数据库，返回遥测帧（含 device_id / ts）
function generateFrame(db, deviceId) {
  const state = deviceState[deviceId];
  if (!state) return null;
  const tick = state.tick++;
  const sim = SIMULATORS[deviceId];
  const ts = new Date().toISOString();
  const frame = { device_id: deviceId, ts, ...sim(tick) };

  // 写入 telemetry 表
  dbm.insertTelemetry(db, frame);
  // 更新 devices 表电量、在线状态、最后通信时间
  dbm.updateDeviceTelemetry(db, deviceId, {
    battery_pct: frame.battery_pct,
    online: 1,
    last_telemetry_at: ts,
  });

  return frame;
}

// 启动模拟器：每秒为每台设备生成一帧，可选 onFrame 回调（用于规则评估）
function startSimulator(db, onFrame) {
  if (intervalHandle) return;
  const deviceIds = Object.keys(deviceState);
  intervalHandle = setInterval(() => {
    try {
      for (const deviceId of deviceIds) {
        const frame = generateFrame(db, deviceId);
        if (frame && typeof onFrame === 'function') {
          onFrame(frame);
        }
      }
    } catch (e) {
      // 模拟器异常不应中断定时器
      console.error('[simulator] 生成帧出错:', e.message);
    }
  }, 1000);
  console.log(`[simulator] 已启动，监控 ${deviceIds.length} 台设备（每秒 1 帧）`);
}

// 停止模拟器
function stopSimulator() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[simulator] 已停止');
  }
}

module.exports = {
  startSimulator,
  stopSimulator,
  generateFrame,
  SIMULATORS,
};
