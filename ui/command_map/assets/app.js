/* assets/app.js — bootstrap, API client, sample/demo data fallback, wires panels together.
   Loaded first; defines window.CM namespace so module files can attach renderers.
   V0.2 升级：从 backend 真实 API 拉取数据，失败回退 sample data（保证离线可用）。*/
(function () {
  'use strict';
  window.CM = window.CM || {};

  // 来源标签与后端 server.py SOURCE_LABELS 保持一致
  CM.SRC_LABEL = { real: 'REAL DEVICE', controlled_test: '受控数据', simulated: '模拟数据' };

  // 9 种地图模式（单一主模式由 layers.js 强制），顺序对应 spec 第 7.1 节
  CM.MODES = [
    { id: 'production',   name: '生产',     color: '#3b82f6', desc: '工位节拍与积压' },
    { id: 'person',       name: '人员',     color: '#06b6d4', desc: '人员位置与任务' },
    { id: 'exoskeleton',  name: '外骨骼',   color: '#8b5cf6', desc: '设备状态与电量' },
    { id: 'body_load',    name: '人体负荷', color: '#f59e0b', desc: '按负荷等级着色' },
    { id: 'safety_risk',  name: '安全风险', color: '#ef4444', desc: '风险事件与禁区' },
    { id: 'device',       name: '设备',     color: '#10b981', desc: '在线/故障状态' },
    { id: 'environment',  name: '环境',     color: '#22d3ee', desc: '区域温振噪' },
    { id: 'scheduling',   name: '调度',     color: '#a855f7', desc: '方案路线与受影响人员' },
    { id: 'data_quality', name: '数据质量', color: '#eab308', desc: '按置信度着色' }
  ];
  CM.modeMeta = function (id) {
    for (var i = 0; i < CM.MODES.length; i++) if (CM.MODES[i].id === id) return CM.MODES[i];
    return CM.MODES[0];
  };

  // ===== SAMPLE DATA — V0.1 "看得见" 离线回退样本 =====
  // 真实 backend 不可用时使用此样本，保证演示不白屏。
  // 字段同 spec 空间实体 schema：entity_id/entity_type/parent_id/pose/bbox/status/source_type/confidence/updated_at/version
  // 类型扩展字段在 .device/.person/.station/.zone/.route 下
  CM.SAMPLE_DATA = {
    org: [
      { id: 'G-01',   name: '集团总部',     type: 'group',    parent: null },
      { id: 'F-01',   name: '示范工厂',     type: 'factory',  parent: 'G-01' },
      { id: 'WS-01',  name: '总装车间一',   type: 'workshop', parent: 'F-01' },
      { id: 'LINE-A', name: '装配产线A',    type: 'line',     parent: 'WS-01' },
      { id: 'LINE-B', name: '物流产线B',    type: 'line',     parent: 'WS-01' }
    ],

    entities: [
      // ---- 车间边界 WS-01 ----
      { entity_id: 'WS-01', entity_type: 'workshop', parent_id: 'F-01', name: '总装车间一',
        pose: { x: 500, y: 310, yaw: 0 }, bbox: { w: 920, h: 540 }, status: 'operational',
        source_type: 'real', confidence: 1.0, updated_at: '2026-07-31T08:00:00', version: 3 },

      // ---- 区域（静态底图） ----
      { entity_id: 'ZONE-ASSY', entity_type: 'zone', parent_id: 'WS-01', name: '装配区',
        pose: { x: 290, y: 200, yaw: 0 }, bbox: { w: 420, h: 280 }, status: 'normal',
        source_type: 'real', confidence: 1.0, updated_at: '2026-07-31T08:00:00', version: 2,
        zone_type: 'assembly', env: { temp: 24.5, vibration: 0.3, noise: 62 } },
      { entity_id: 'ZONE-LOGI', entity_type: 'zone', parent_id: 'WS-01', name: '物流月台',
        pose: { x: 730, y: 200, yaw: 0 }, bbox: { w: 400, h: 280 }, status: 'normal',
        source_type: 'real', confidence: 1.0, updated_at: '2026-07-31T08:00:00', version: 2,
        zone_type: 'logistics', env: { temp: 26.1, vibration: 0.5, noise: 71 } },
      { entity_id: 'ZONE-REST', entity_type: 'zone', parent_id: 'WS-01', name: '休息区',
        pose: { x: 190, y: 470, yaw: 0 }, bbox: { w: 220, h: 180 }, status: 'normal',
        source_type: 'real', confidence: 1.0, updated_at: '2026-07-31T08:00:00', version: 2,
        zone_type: 'rest', env: { temp: 23.0, vibration: 0.0, noise: 45 } },
      { entity_id: 'ZONE-SAFE', entity_type: 'zone', parent_id: 'WS-01', name: '安全缓冲通道',
        pose: { x: 640, y: 470, yaw: 0 }, bbox: { w: 360, h: 180 }, status: 'caution',
        source_type: 'real', confidence: 1.0, updated_at: '2026-07-31T08:00:00', version: 2,
        zone_type: 'safety', env: { temp: 25.0, vibration: 0.2, noise: 58 } },

      // ---- 工位（3-5 个，按 spec） ----
      { entity_id: 'ST-101', entity_type: 'station', parent_id: 'ZONE-ASSY', name: '装配工位1',
        pose: { x: 145, y: 170, yaw: 0 }, bbox: { w: 90, h: 46 }, status: 'producing',
        source_type: 'real', confidence: 0.98, updated_at: '2026-07-31T09:30:00', version: 5,
        station: { line: 'LINE-A', takt: 42, occupancy: 1, backlog: 0 } },
      { entity_id: 'ST-102', entity_type: 'station', parent_id: 'ZONE-ASSY', name: '装配工位2',
        pose: { x: 265, y: 170, yaw: 0 }, bbox: { w: 90, h: 46 }, status: 'producing',
        source_type: 'real', confidence: 0.96, updated_at: '2026-07-31T09:30:00', version: 5,
        station: { line: 'LINE-A', takt: 45, occupancy: 1, backlog: 3 } },
      { entity_id: 'ST-103', entity_type: 'station', parent_id: 'ZONE-ASSY', name: '装配工位3',
        pose: { x: 385, y: 170, yaw: 0 }, bbox: { w: 90, h: 46 }, status: 'idle',
        source_type: 'real', confidence: 0.92, updated_at: '2026-07-31T09:30:00', version: 5,
        station: { line: 'LINE-A', takt: 0, occupancy: 0, backlog: 0 } },
      { entity_id: 'ST-104', entity_type: 'station', parent_id: 'ZONE-LOGI', name: '月台A',
        pose: { x: 630, y: 170, yaw: 0 }, bbox: { w: 90, h: 46 }, status: 'producing',
        source_type: 'real', confidence: 0.99, updated_at: '2026-07-31T09:30:00', version: 5,
        station: { line: 'LINE-B', takt: 60, occupancy: 1, backlog: 2 } },
      { entity_id: 'ST-105', entity_type: 'station', parent_id: 'ZONE-LOGI', name: '月台B',
        pose: { x: 810, y: 170, yaw: 0 }, bbox: { w: 90, h: 46 }, status: 'warning',
        source_type: 'real', confidence: 0.88, updated_at: '2026-07-31T09:30:00', version: 5,
        station: { line: 'LINE-B', takt: 75, occupancy: 1, backlog: 8 } },

      // ---- 物流主通道（环线） ----
      { entity_id: 'ROUTE-MAIN', entity_type: 'route', parent_id: 'WS-01', name: '主物流通道',
        pose: { x: 0, y: 0, yaw: 0 }, bbox: { w: 0, h: 0 }, status: 'open',
        source_type: 'real', confidence: 1.0, updated_at: '2026-07-31T08:00:00', version: 1,
        route: { path: [ { x: 100, y: 300 }, { x: 900, y: 300 }, { x: 900, y: 470 }, { x: 100, y: 470 }, { x: 100, y: 300 } ] } },

      // ---- 设备（外骨骼）— 绑定到人员/工位/任务；位置默认与样本对齐 ----
      { entity_id: 'EXO-001', entity_type: 'device', parent_id: 'WS-01', name: '外骨骼-001',
        pose: { x: 130, y: 240, yaw: 0 }, bbox: { w: 22, h: 22 }, status: 'online',
        source_type: 'real', confidence: 0.99, updated_at: '2026-07-31T09:30:00', version: 7,
        device: { model: 'EWOH-L1', firmware: '2.4.1', battery: 78, temp: 38.2, fault_code: null,
          person_id: 'P-001', task_id: 'TASK-101', station_id: 'ST-101', online: true } },
      { entity_id: 'EXO-002', entity_type: 'device', parent_id: 'WS-01', name: '外骨骼-002',
        pose: { x: 250, y: 240, yaw: 0 }, bbox: { w: 22, h: 22 }, status: 'online',
        source_type: 'real', confidence: 0.97, updated_at: '2026-07-31T09:30:00', version: 7,
        device: { model: 'EWOH-L1', firmware: '2.4.1', battery: 45, temp: 40.1, fault_code: null,
          person_id: 'P-002', task_id: 'TASK-102', station_id: 'ST-102', online: true } },
      { entity_id: 'EXO-003', entity_type: 'device', parent_id: 'WS-01', name: '外骨骼-003',
        pose: { x: 615, y: 240, yaw: 0 }, bbox: { w: 22, h: 22 }, status: 'online',
        source_type: 'real', confidence: 0.95, updated_at: '2026-07-31T09:30:00', version: 7,
        device: { model: 'EWOH-L2', firmware: '2.3.0', battery: 18, temp: 39.5, fault_code: null,
          person_id: 'P-003', task_id: 'TASK-104', station_id: 'ST-104', online: true } },
      { entity_id: 'EXO-004', entity_type: 'device', parent_id: 'WS-01', name: '外骨骼-004',
        pose: { x: 370, y: 240, yaw: 0 }, bbox: { w: 22, h: 22 }, status: 'offline',
        source_type: 'real', confidence: 0.90, updated_at: '2026-07-31T09:15:00', version: 7,
        device: { model: 'EWOH-L1', firmware: '2.4.1', battery: 0, temp: 25.0, fault_code: 'COMM_LOSS',
          person_id: 'P-004', task_id: null, station_id: 'ST-103', online: false } },

      // ---- 人员（穿戴外骨骼，绑定关系在地图可见） ----
      { entity_id: 'P-001', entity_type: 'person', parent_id: 'ZONE-ASSY', name: '张师傅',
        pose: { x: 160, y: 240, yaw: 90 }, bbox: { w: 20, h: 20 }, status: 'working',
        source_type: 'real', confidence: 0.97, updated_at: '2026-07-31T09:30:00', version: 12,
        person: { device_id: 'EXO-001', task_id: 'TASK-101', station_id: 'ST-101', skill: '搬运',
          action: '搬运', load_level: 0.42, fatigue_trend: 0.31, work_minutes: 142 } },
      { entity_id: 'P-002', entity_type: 'person', parent_id: 'ZONE-ASSY', name: '李师傅',
        pose: { x: 280, y: 240, yaw: 90 }, bbox: { w: 20, h: 20 }, status: 'working',
        source_type: 'real', confidence: 0.94, updated_at: '2026-07-31T09:30:00', version: 11,
        person: { device_id: 'EXO-002', task_id: 'TASK-102', station_id: 'ST-102', skill: '搬运',
          action: '搬运', load_level: 0.78, fatigue_trend: 0.62, work_minutes: 168 } },
      { entity_id: 'P-003', entity_type: 'person', parent_id: 'ZONE-LOGI', name: '王师傅',
        pose: { x: 645, y: 240, yaw: 90 }, bbox: { w: 20, h: 20 }, status: 'working',
        source_type: 'real', confidence: 0.91, updated_at: '2026-07-31T09:30:00', version: 9,
        person: { device_id: 'EXO-003', task_id: 'TASK-104', station_id: 'ST-104', skill: '拣选',
          action: '拣选', load_level: 0.55, fatigue_trend: 0.45, work_minutes: 95 } },
      { entity_id: 'P-004', entity_type: 'person', parent_id: 'ZONE-ASSY', name: '赵师傅',
        pose: { x: 400, y: 240, yaw: 0 }, bbox: { w: 20, h: 20 }, status: 'idle',
        source_type: 'real', confidence: 0.85, updated_at: '2026-07-31T09:15:00', version: 8,
        person: { device_id: 'EXO-004', task_id: null, station_id: 'ST-103', skill: '装配',
          action: 'idle', load_level: 0.10, fatigue_trend: 0.05, work_minutes: 0 } },
      { entity_id: 'P-005', entity_type: 'person', parent_id: 'ZONE-REST', name: '孙师傅',
        pose: { x: 190, y: 470, yaw: 180 }, bbox: { w: 20, h: 20 }, status: 'resting',
        source_type: 'simulated', confidence: 0.80, updated_at: '2026-07-31T09:25:00', version: 6,
        person: { device_id: null, task_id: null, station_id: null, skill: '搬运',
          action: 'rest', load_level: 0.05, fatigue_trend: 0.10, work_minutes: 0 } }
    ],

    events: [
      { event_id: 'EV-001', code: 'SENSOR_CONFLICT', title: '传感器冲突', severity: 'warning', status: 'open',
        source_type: 'real', person_id: 'P-002', device_id: 'EXO-002', station_id: 'ST-102',
        time: '2026-07-31T09:28:00', confidence: 0.62,
        detail: 'UWB 显示 P-002 在 ST-102，视觉系统显示在 ST-101，置信度均低于 0.7，已记录冲突详情未静默丢弃' },
      { event_id: 'EV-002', code: 'HIGH_LOAD', title: '高人体负荷', severity: 'critical', status: 'open',
        source_type: 'real', person_id: 'P-002', device_id: 'EXO-002', station_id: 'ST-102',
        time: '2026-07-31T09:25:00', confidence: 0.91,
        detail: 'P-002 累计负荷 0.78，连续作业 168 分钟，建议换岗（仅趋势建议非医学诊断）' },
      { event_id: 'EV-003', code: 'LOW_BATTERY', title: '低电量预警', severity: 'warning', status: 'open',
        source_type: 'real', person_id: 'P-003', device_id: 'EXO-003', station_id: 'ST-104',
        time: '2026-07-31T09:22:00', confidence: 0.95,
        detail: 'EXO-003 电量 18%，预计续航 22 分钟，需安排充电或换岗' },
      { event_id: 'EV-004', code: 'DEVICE_OFFLINE', title: '设备失联', severity: 'critical', status: 'confirmed',
        source_type: 'real', person_id: 'P-004', device_id: 'EXO-004', station_id: 'ST-103',
        time: '2026-07-31T09:15:00', confidence: 1.0,
        detail: 'EXO-004 通信中断，故障码 COMM_LOSS，已派员检查并降级到 UWB 推断' },
      { event_id: 'EV-005', code: 'STATION_BACKLOG', title: '工位积压', severity: 'warning', status: 'open',
        source_type: 'real', person_id: null, device_id: null, station_id: 'ST-105',
        time: '2026-07-31T09:20:00', confidence: 0.93,
        detail: 'ST-105 积压 8 个任务，节拍延长至 75 秒，触发调度建议' },
      { event_id: 'EV-006', code: 'FORBIDDEN_ZONE', title: '人员进入禁区', severity: 'critical', status: 'closed',
        source_type: 'real', person_id: 'P-005', device_id: null, station_id: null,
        time: '2026-07-31T08:48:00', confidence: 0.88,
        detail: 'P-005 进入 ZONE-SAFE 安全缓冲区，已自动提醒撤离' },
      { event_id: 'EV-007', code: 'LOW_CONFIDENCE', title: '低置信度融合', severity: 'info', status: 'open',
        source_type: 'real', person_id: 'P-005', device_id: null, station_id: null,
        time: '2026-07-31T09:25:00', confidence: 0.80,
        detail: 'P-005 仅 UWB 数据可用，视觉遮挡，置信度降至 0.80，不生成强建议' },
      { event_id: 'EV-008', code: 'SCHEDULE_PROPOSED', title: '调度建议待确认', severity: 'info', status: 'open',
        source_type: 'simulated', person_id: null, device_id: null, station_id: null,
        time: '2026-07-31T09:18:00', confidence: 1.0,
        detail: '产能优先方案已生成，影子运行仅记录不执行，待班组长人工确认' }
    ],

    // 调度方案 — 分项指标对比（不只显示总分），spec 场景
    plans: [
      { plan_id: 'PLAN-001', name: '产能优先', target: 'production', status: 'shadow', confidence: 0.82,
        assumption: '当前订单准交压力大，优先稳定节拍缓解 ST-105 积压',
        reasoning: '维持现人员配置，将 ST-103 空闲人员调度至 ST-105 缓解积压，P-002 维持高负荷但短期可控',
        metrics: { takt_improvement: '+4.2%', high_load_persons: 3, extra_walking_m: 18, low_battery_risk: 2, delay_risk: '低', affected_persons: ['P-001', 'P-002', 'P-003'] } },
      { plan_id: 'PLAN-002', name: '负荷均衡', target: 'load_balance', status: 'shadow', confidence: 0.88,
        assumption: '当前 P-002 高负荷风险，优先均衡人员负荷与电量',
        reasoning: '将 P-002 部分任务转交 P-004，P-003 提前换岗充电，新增调度步行距离但消除高负荷风险',
        metrics: { takt_improvement: '+1.8%', high_load_persons: 0, extra_walking_m: 42, low_battery_risk: 0, delay_risk: '中', affected_persons: ['P-001', 'P-002', 'P-003', 'P-004'] } }
    ],

    // 模型与规则注册表（admin 骨架）
    models: [
      { model_id: 'M-ACTION-001', name: '搬运动作识别', version: 'v2.1.0', status: 'active',  source_type: 'real',            dataset: 'ds-2026-07',      f1: 0.87, updated: '2026-07-15' },
      { model_id: 'M-LOAD-001',   name: '负荷趋势评分', version: 'v1.3.2', status: 'active',  source_type: 'real',            dataset: 'ds-2026-06',      f1: 0.79, updated: '2026-07-10' },
      { model_id: 'M-ACTION-002', name: '拣选动作识别', version: 'v1.0.0', status: 'shadow',  source_type: 'controlled_test', dataset: 'ds-2026-07-pilot', f1: 0.71, updated: '2026-07-20' }
    ],
    rules: [
      { rule_id: 'R-HIGH-LOAD',       name: '高负荷阈值',   version: 'r3', status: 'active', threshold: 'load>=0.7 持续 5min',          updated: '2026-07-01' },
      { rule_id: 'R-LOW-BATT',        name: '低电量预警',   version: 'r2', status: 'active', threshold: 'battery<20%',                  updated: '2026-07-01' },
      { rule_id: 'R-FORBIDDEN',       name: '禁区进入',     version: 'r1', status: 'active', threshold: 'person in zone:safety',        updated: '2026-06-15' },
      { rule_id: 'R-SENSOR-CONFLICT', name: '传感器冲突',   version: 'r1', status: 'active', threshold: 'uwb_station != vision_station', updated: '2026-06-20' }
    ]
  };

  // 运行时数据：默认深拷贝 sample，启动时被 backend 数据覆盖
  CM.DATA = JSON.parse(JSON.stringify(CM.SAMPLE_DATA));

  // ===== runtime state =====
  CM.state = {
    selectedId: null,
    activeMode: 'production',
    activeOrgId: 'WS-01',
    activeTab: 'timeline',
    timeline: { mode: 'live', speed: 1, cursorSec: 5400, replayDevice: null }, // 5400s = 09:30:00
    // 数据来源标识：'backend' | 'sample'
    dataSource: 'sample',
    // 最近一次拉取的 backend 状态摘要
    backendStatus: null,
    // 调度确认审计记录（前端会话级），与 /api/audit 关联
    confirmations: [],
    // 缓存最新遥测/推理（按 device_id）
    latestByDevice: {},
    // 缓存人员画像（按 person_id）
    profileCache: {},
    // 缓存事件详情（按 event_id）
    eventDetailCache: {},
    // 缓存回放时序数据（按 device_id）
    replayCache: {}
  };

  // ===== CM.api：backend HTTP 客户端 =====
  // 默认 baseURL 取自 localStorage 或 config.py 默认端口（8765）；可用 ?api_base= 覆盖
  CM.api = (function () {
    function getBaseURL() {
      try {
        var q = new URLSearchParams(window.location.search).get('api_base');
        if (q) return q.replace(/\/$/, '');
      } catch (e) {}
      try {
        var ls = window.localStorage && window.localStorage.ewoh_api_base;
        if (ls) return ls.replace(/\/$/, '');
      } catch (e) {}
      // 同源访问（前端由 backend 8765 端口托管时）用相对路径，避免浏览器沙箱跨端口连接问题
      if (window.location.port === '8765' || window.location.port === '') {
        return '';
      }
      return 'http://127.0.0.1:8765'; // 独立前端服务器时回退到 backend 默认端口
    }

    function buildURL(path, params) {
      var base = getBaseURL();
      var url = base + path;
      if (params) {
        var qs = [];
        for (var k in params) {
          if (params[k] == null || params[k] === '') continue;
          qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
        }
        if (qs.length) url += '?' + qs.join('&');
      }
      return url;
    }

    function token() {
      try { return window.localStorage && window.localStorage.ewoh_token || ''; } catch (e) { return ''; }
    }

    async function getJSON(path, params) {
      var url = buildURL(path, params);
      var headers = { 'Accept': 'application/json' };
      var t = token();
      if (t) headers['Authorization'] = 'Bearer ' + t;
      var resp = await fetch(url, { method: 'GET', headers: headers, credentials: 'omit' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status + ' @ ' + path);
      return resp.json();
    }

    async function postJSON(path, body) {
      var url = buildURL(path);
      var headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
      var t = token();
      if (t) headers['Authorization'] = 'Bearer ' + t;
      var resp = await fetch(url, {
        method: 'POST', headers: headers, credentials: 'omit',
        body: JSON.stringify(body || {})
      });
      if (!resp.ok) {
        var errBody = null;
        try { errBody = await resp.json(); } catch (e) {}
        var msg = 'HTTP ' + resp.status + ' @ ' + path;
        if (errBody && errBody.error && errBody.error.message) msg += ': ' + errBody.error.message;
        var e = new Error(msg); e.body = errBody; throw e;
      }
      return resp.json();
    }

    // 把后端 device 记录合并到样本 entity 结构（保留样本空间坐标，更新动态字段）
    function mergeDeviceEntity(dev, existing) {
      // 用最新遥测补全动态字段
      var latest = CM.state.latestByDevice[dev.device_id] || {};
      var tele = (latest.telemetry) || {};
      var inf = latest.inference || {};
      var battery = tele.battery_level != null ? tele.battery_level :
                    (tele.battery_pct != null ? tele.battery_pct :
                    (existing && existing.device ? existing.device.battery : 0));
      var faultCode = tele.fault ? (tele.fault_code || 'FAULT') :
                      (dev.online ? null : (existing && existing.device ? existing.device.fault_code : 'COMM_LOSS'));
      var online = !!dev.online;
      var personId = dev.person_id || (existing && existing.device ? existing.device.person_id : null);
      var stationId = (existing && existing.device ? existing.device.station_id : null);
      var taskId = (existing && existing.device ? existing.device.task_id : null);
      return {
        entity_id: dev.device_id,
        entity_type: 'device',
        parent_id: (existing && existing.parent_id) || 'WS-01',
        name: (existing && existing.name) || dev.device_id,
        pose: (existing && existing.pose) || { x: 0, y: 0, yaw: 0 },
        bbox: (existing && existing.bbox) || { w: 22, h: 22 },
        status: online ? 'online' : 'offline',
        source_type: dev.source_type || (existing && existing.source_type) || 'simulated',
        source_label: dev.source_label,
        confidence: latest.confidence != null ? latest.confidence :
                    (existing && existing.confidence != null ? existing.confidence : 0.9),
        updated_at: dev.last_seen || (latest && latest.timestamp) ||
                    (existing && existing.updated_at) || '',
        version: (existing && existing.version) || 1,
        device: {
          model: dev.model || (existing && existing.device ? existing.device.model : ''),
          firmware: dev.firmware_version || (existing && existing.device ? existing.device.firmware : ''),
          battery: battery,
          temp: tele.device_temp || (existing && existing.device ? existing.device.temp : 0),
          fault_code: faultCode,
          person_id: personId,
          task_id: taskId,
          station_id: stationId,
          online: online,
          last_seen: dev.last_seen,
          quality_status: (latest.quality && latest.quality.status) || 'unknown',
          packet_loss_pct: (latest.quality && latest.quality.packet_loss_pct) || 0,
          model_version: inf.model_version,
          action_label: inf.label,
          action_confidence: inf.confidence,
          inference_id: inf.inference_id
        }
      };
    }

    function mergePersonEntity(person, dev, existing) {
      var latest = dev ? (CM.state.latestByDevice[dev.device_id] || {}) : {};
      var tele = latest.telemetry || {};
      var inf = latest.inference || {};
      var loadLevel = tele.load_score != null ? tele.load_score :
                      (existing && existing.person ? existing.person.load_level : 0);
      var fatigue = tele.fatigue_trend != null ? tele.fatigue_trend :
                    (existing && existing.person ? existing.person.fatigue_trend : 0);
      var skill = '';
      try {
        var skills = typeof person.skills_json === 'string' ? JSON.parse(person.skills_json) :
                     (person.skills || []);
        skill = (skills && skills[0]) || (existing && existing.person ? existing.person.skill : '搬运');
      } catch (e) { skill = (existing && existing.person ? existing.person.skill : '搬运'); }
      var stationId = (existing && existing.person ? existing.person.station_id : null);
      var deviceId = dev ? dev.device_id : (existing && existing.person ? existing.person.device_id : null);
      var taskId = (existing && existing.person ? existing.person.task_id : null);
      var isActive = person.active == null ? 1 : person.active;
      var consent = person.consent_status || 'unknown';
      var status = isActive ? (loadLevel > 0.05 ? 'working' : 'idle') : 'inactive';
      return {
        entity_id: person.person_id,
        entity_type: 'person',
        parent_id: (existing && existing.parent_id) || 'WS-01',
        name: (existing && existing.name) || person.display_name || person.person_id,
        // 隐私保护：默认匿名编号（不展示真实姓名）。当后端 display_name 为占位时也匿名化
        anonymized_name: '人员-' + String(person.person_id).replace(/^(P-|EMP-?)/i, '').padStart(3, '0'),
        pose: (existing && existing.pose) || { x: 0, y: 0, yaw: 0 },
        bbox: (existing && existing.bbox) || { w: 20, h: 20 },
        status: status,
        source_type: (existing && existing.source_type) || 'real',
        confidence: inf.confidence != null ? inf.confidence :
                    (existing && existing.confidence != null ? existing.confidence : 0.85),
        updated_at: latest.timestamp || (existing && existing.updated_at) || '',
        version: (existing && existing.version) || 1,
        consent_status: consent,
        active: !!isActive,
        person: {
          device_id: deviceId,
          task_id: taskId,
          station_id: stationId,
          skill: skill,
          action: inf.label || (existing && existing.person ? existing.person.action : 'unknown'),
          load_level: loadLevel,
          fatigue_trend: fatigue,
          work_minutes: (existing && existing.person ? existing.person.work_minutes : 0),
          assist_level: tele.assist_level,
          pitch_deg: tele.pitch_deg,
          gyro_dps: tele.gyro_dps
        }
      };
    }

    function mergeEvent(ev, existing) {
      // 后端事件字段：event_id/event_code/severity/status/person_id/device_id/task_id/zone_id/
      //   start_time/end_time/trigger{type,condition,rule_version,model_version}/
      //   evidence{...}/handling{...}/source_type
      // 前端展示字段：event_id/code/title/severity/status/source_type/person_id/device_id/station_id/time/confidence/detail
      // severity 后端可能是 L0/L1/L2/L3，前端 critical/warning/info，做映射
      var sevMap = { L0: 'info', L1: 'info', L2: 'warning', L3: 'critical',
                     critical: 'critical', warning: 'warning', info: 'info' };
      var trig = ev.trigger || {};
      var evid = ev.evidence || {};
      var handling = ev.handling || {};
      return {
        event_id: ev.event_id,
        code: ev.event_code,
        title: (existing && existing.title) || ev.event_code,
        severity: sevMap[ev.severity] || 'info',
        raw_severity: ev.severity,
        status: ev.status || 'open',
        source_type: ev.source_type,
        source_label: ev.source_label,
        person_id: ev.person_id,
        device_id: ev.device_id,
        task_id: ev.task_id,
        zone_id: ev.zone_id,
        station_id: (existing && existing.station_id) || null,
        time: ev.start_time,
        end_time: ev.end_time,
        confidence: evid.confidence || trig.confidence ||
                    (existing && existing.confidence != null ? existing.confidence : 0.8),
        detail: evid.summary || trig.condition ||
                (existing && existing.detail) || trig.type || '',
        trigger: trig,
        evidence: evid,
        handling: handling
      };
    }

    function mergeModel(m, existing) {
      // 后端：model_id/model_type/version/status/model_card_uri/registered_at
      return {
        model_id: m.model_id,
        name: (existing && existing.name) || m.model_type || m.model_id,
        version: m.version,
        status: m.status,
        source_type: (existing && existing.source_type) || 'real',
        dataset: (existing && existing.dataset) || (m.model_card_uri || '--'),
        f1: (existing && existing.f1 != null) ? existing.f1 : 0,
        updated: (m.registered_at || (existing && existing.updated) || '').split('T')[0]
      };
    }

    function mergeRule(r, existing) {
      var cfg = r.config || {};
      return {
        rule_id: r.rule_id,
        name: (existing && existing.name) || r.rule_id,
        version: r.rule_version,
        status: r.enabled ? 'active' : 'inactive',
        threshold: (existing && existing.threshold) ||
                   (cfg.threshold != null ? String(cfg.threshold) : JSON.stringify(cfg)) || '--',
        updated: (r.effective_from || r.created_at || (existing && existing.updated) || '').split('T')[0]
      };
    }

    // 用 backend 数据重建 CM.DATA 的动态部分
    function applyBackendData(payload) {
      var sampleById = {};
      CM.SAMPLE_DATA.entities.forEach(function (e) { sampleById[e.entity_id] = e; });

      var newEntities = [];
      // 保留静态空间实体：workshop/zone/station/route（后端不提供）
      CM.SAMPLE_DATA.entities.forEach(function (e) {
        if (e.entity_type === 'workshop' || e.entity_type === 'zone' ||
            e.entity_type === 'station' || e.entity_type === 'route') {
          newEntities.push(e);
        }
      });

      // 设备：以 backend 为准
      (payload.devices || []).forEach(function (d) {
        var existing = sampleById[d.device_id];
        newEntities.push(mergeDeviceEntity(d, existing));
      });

      // 人员：以 backend 为准
      (payload.people || []).forEach(function (p) {
        var existing = sampleById[p.person_id];
        var dev = (payload.devices || []).find(function (d) { return d.person_id === p.person_id; });
        newEntities.push(mergePersonEntity(p, dev, existing));
      });

      CM.DATA.entities = newEntities;

      // 事件：以 backend 为准；用样本事件补 title 映射
      var sampleEvByCode = {};
      CM.SAMPLE_DATA.events.forEach(function (e) { sampleEvByCode[e.code] = e; });
      CM.DATA.events = (payload.events || []).map(function (ev) {
        return mergeEvent(ev, sampleEvByCode[ev.event_code]);
      });
      // 若 backend 无事件，保留样本事件（避免空状态）
      if (CM.DATA.events.length === 0) {
        CM.DATA.events = JSON.parse(JSON.stringify(CM.SAMPLE_DATA.events));
      }

      // 模型与规则
      var sampleModelById = {};
      CM.SAMPLE_DATA.models.forEach(function (m) { sampleModelById[m.model_id] = m; });
      CM.DATA.models = (payload.models || []).map(function (m) {
        return mergeModel(m, sampleModelById[m.model_id]);
      });
      if (CM.DATA.models.length === 0) CM.DATA.models = JSON.parse(JSON.stringify(CM.SAMPLE_DATA.models));

      var sampleRuleById = {};
      CM.SAMPLE_DATA.rules.forEach(function (r) { sampleRuleById[r.rule_id] = r; });
      CM.DATA.rules = (payload.rules || []).map(function (r) {
        return mergeRule(r, sampleRuleById[r.rule_id]);
      });
      if (CM.DATA.rules.length === 0) CM.DATA.rules = JSON.parse(JSON.stringify(CM.SAMPLE_DATA.rules));

      // 派工记录（backend 仅返回会话级 assignments）
      CM.DATA.assignments = payload.assignments || [];

      // plans 保持样本（backend 无对应端点；scenario-panel 会本地生成扩展方案）
      CM.DATA.plans = JSON.parse(JSON.stringify(CM.SAMPLE_DATA.plans));

      CM.state.dataSource = 'backend';
    }

    // 拉取所有静态+动态数据，用于启动或全量刷新
    async function bootstrap() {
      var status = await getJSON('/api/status', {});
      var devicesResp = await getJSON('/api/devices', {});
      var peopleResp = await getJSON('/api/people', {});
      var eventsResp = await getJSON('/api/events', { limit: 200 });
      var modelsResp = await getJSON('/api/models', { limit: 100 });
      var rulesResp = await getJSON('/api/rules', { limit: 100 });
      var assignsResp = await getJSON('/api/tasks/assignments', {});

      var devices = devicesResp.items || [];
      // 拉取每个设备的最新遥测
      var latestMap = {};
      await Promise.all(devices.map(function (d) {
        return getJSON('/api/telemetry', { device_id: d.device_id }).then(function (rec) {
          latestMap[d.device_id] = rec || null;
        }).catch(function () { latestMap[d.device_id] = null; });
      }));
      CM.state.latestByDevice = latestMap;

      applyBackendData({
        status: status, devices: devices, people: peopleResp.items || [],
        events: eventsResp.items || [], models: modelsResp.items || [],
        rules: rulesResp.items || [], assignments: assignsResp.items || []
      });
      CM.state.backendStatus = status;
      return status;
    }

    // 仅刷新动态实体（每 2 秒轮询）
    async function refreshDynamic() {
      var devicesResp = await getJSON('/api/devices', {});
      var eventsResp = await getJSON('/api/events', { limit: 200 });
      var devices = devicesResp.items || [];
      // 只为前 8 个设备拉最新遥测，控制请求数
      var subset = devices.slice(0, 8);
      var latestMap = CM.state.latestByDevice || {};
      await Promise.all(subset.map(function (d) {
        return getJSON('/api/telemetry', { device_id: d.device_id }).then(function (rec) {
          latestMap[d.device_id] = rec || null;
        }).catch(function () {});
      }));
      CM.state.latestByDevice = latestMap;
      // people 是静态主数据，启动已加载；从 CM.DATA 提取当前人员记录传给合并器
      var curPeople = CM.DATA.entities
        .filter(function (e) { return e.entity_type === 'person'; })
        .map(function (e) {
          return { person_id: e.entity_id, display_name: e.name,
                   skills: [e.person && e.person.skill], consent_status: e.consent_status,
                   active: e.active ? 1 : 0 };
        });
      var status = CM.state.backendStatus || {};
      applyBackendData({
        status: status, devices: devices,
        people: curPeople,
        events: eventsResp.items || [],
        models: CM.DATA.models, rules: CM.DATA.rules,
        assignments: CM.DATA.assignments
      });
    }

    // 拉取人员画像详情（按需）
    async function fetchPersonProfile(personId) {
      var p = await getJSON('/api/person/profile', { person_id: personId });
      CM.state.profileCache[personId] = p;
      return p;
    }

    // 拉取事件详情（含证据 + handlings）
    async function fetchEventDetail(eventId) {
      var d = await getJSON('/api/events/' + encodeURIComponent(eventId), {});
      CM.state.eventDetailCache[eventId] = d;
      return d;
    }

    // 拉取历史回放时序（按设备+时间段）
    async function fetchSeries(deviceId, startISO, endISO, limit) {
      return getJSON('/api/telemetry/series', {
        device_id: deviceId, start: startISO, end: endISO, limit: limit || 2000
      });
    }

    // 更新事件状态
    async function updateEventStatus(eventId, status, comment, action) {
      return postJSON('/api/events/' + encodeURIComponent(eventId) + '/status', {
        status: status, comment: comment, action: action || status, handler_id: 'operator'
      });
    }

    // 添加事件评论
    async function addEventComment(eventId, comment, authorId) {
      return postJSON('/api/events/' + encodeURIComponent(eventId) + '/comment', {
        comment: comment, author_id: authorId || 'operator'
      });
    }

    // 任务推荐
    async function recommendTasks(requiredSkill, zoneId, loadLevel) {
      return postJSON('/api/tasks/recommend', {
        required_skill: requiredSkill || '搬运', zone_id: zoneId || '', load_level: loadLevel || 0.5
      });
    }

    // 任务确认
    async function confirmTask(personId, confirmer, reason, taskId) {
      return postJSON('/api/tasks/confirm', {
        person_id: personId, confirmer: confirmer, reason: reason, task_id: taskId || null
      });
    }

    // 本地助手问答
    async function query(question) {
      return postJSON('/api/query', { question: question });
    }

    // 审计日志查询
    async function fetchAudit(action, actorId, limit) {
      return getJSON('/api/audit', { action: action || '', actor_id: actorId || '', limit: limit || 100 });
    }

    // 一键重置
    async function reset() {
      return postJSON('/api/reset', {});
    }

    return {
      getBaseURL: getBaseURL,
      get: getJSON,
      post: postJSON,
      bootstrap: bootstrap,
      refreshDynamic: refreshDynamic,
      fetchPersonProfile: fetchPersonProfile,
      fetchEventDetail: fetchEventDetail,
      fetchSeries: fetchSeries,
      updateEventStatus: updateEventStatus,
      addEventComment: addEventComment,
      recommendTasks: recommendTasks,
      confirmTask: confirmTask,
      query: query,
      fetchAudit: fetchAudit,
      reset: reset
    };
  })();

  // ===== shared helpers =====
  CM.esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
    });
  };
  CM.srcTag = function (s) {
    return '<span class="cm-source cm-src-' + s + '">' + (CM.SRC_LABEL[s] || s) + '</span>';
  };
  CM.findEntity = function (id) {
    for (var i = 0; i < CM.DATA.entities.length; i++) if (CM.DATA.entities[i].entity_id === id) return CM.DATA.entities[i];
    return null;
  };
  CM.parentName = function (id) {
    if (!id) return '--';
    var e = CM.findEntity(id);
    if (e) return e.name || id;
    for (var i = 0; i < CM.DATA.org.length; i++) if (CM.DATA.org[i].id === id) return CM.DATA.org[i].name;
    return id;
  };
  CM.statusText = function (s) {
    return ({ open: '未处置', confirmed: '已确认', closed: '已关闭', dismissed: '已驳回' })[s] || s;
  };
  // 人员匿名化展示名（隐私默认）
  CM.personDisplay = function (entity) {
    if (!entity) return '--';
    // 当来源为真实数据且后端未授权展示真实姓名时，展示匿名编号
    if (entity.anonymized_name && entity.source_type === 'real') return entity.anonymized_name;
    return entity.name || entity.entity_id;
  };

  // ===== shared actions =====
  CM.selectEntity = function (id) {
    CM.state.selectedId = id;
    if (CM.entityPanel) CM.entityPanel.render();
    if (CM.map) CM.map.render();
  };
  CM.setMode = function (modeId) {
    CM.state.activeMode = modeId;
    if (CM.layers) CM.layers.render();
    if (CM.map) CM.map.render();
    if (CM.entityPanel) CM.entityPanel.render();
  };
  CM.setTab = function (tabId) {
    CM.state.activeTab = tabId;
    document.querySelectorAll('.cm-tab').forEach(function (b) {
      b.classList.toggle('active', b.dataset.tab === tabId);
    });
    document.querySelectorAll('.cm-tab-panel').forEach(function (p) {
      p.classList.toggle('active', p.id === 'tab-' + tabId);
    });
    // 切到对应面板时触发渲染（确保拿到最新数据）
    if (tabId === 'events' && CM.eventCenter) CM.eventCenter.render();
    if (tabId === 'scenario' && CM.scenarioPanel) CM.scenarioPanel.render();
    if (tabId === 'admin' && CM.admin) CM.admin.render();
  };

  // 全量重渲（数据刷新后调用）
  CM.rerenderAll = function () {
    CM.renderTopbar();
    if (CM.layers) CM.layers.render();
    if (CM.map) CM.map.render();
    if (CM.entityPanel) CM.entityPanel.render();
    // 时间轴与事件中心仅在当前 tab 可见时刷新，避免无谓 DOM 写入
    if (CM.state.activeTab === 'timeline' && CM.timeline) CM.timeline.render();
    if (CM.state.activeTab === 'events' && CM.eventCenter) CM.eventCenter.render();
    if (CM.state.activeTab === 'scenario' && CM.scenarioPanel) CM.scenarioPanel.render();
    if (CM.state.activeTab === 'admin' && CM.admin) CM.admin.render();
  };

  // ===== top overview bar =====
  CM.renderTopbar = function () {
    var devices = CM.DATA.entities.filter(function (e) { return e.entity_type === 'device'; });
    var persons = CM.DATA.entities.filter(function (e) { return e.entity_type === 'person'; });
    var online = devices.filter(function (d) { return d.status === 'online'; }).length;
    var active = persons.filter(function (p) { return p.status === 'working'; }).length;
    var openEv = CM.DATA.events.filter(function (e) { return e.status === 'open'; }).length;
    document.getElementById('kpi-devices').textContent = online + ' / ' + devices.length;
    document.getElementById('kpi-persons').textContent = active + ' / ' + persons.length;
    var evEl = document.getElementById('kpi-events');
    evEl.textContent = openEv;
    evEl.className = 'cm-kpi-value' + (openEv > 2 ? ' danger' : openEv > 0 ? ' warning' : ' success');
    // 产量：若 backend 提供 db_counts 则用 telemetry 数，否则占位
    var output = '1,284 件';
    var st = CM.state.backendStatus || {};
    if (st && st.db_counts && st.db_counts.telemetry != null) {
      output = st.db_counts.telemetry + ' 条遥测';
    }
    document.getElementById('kpi-output').textContent = output;

    // 数据来源标识：在班次 KPI 后追加来源徽章
    var shiftEl = document.getElementById('kpi-shift');
    if (shiftEl) {
      var dsLabel = CM.state.dataSource === 'backend' ? '· LIVE 后端' : '· 离线样本';
      shiftEl.textContent = '早班 ' + dsLabel;
    }
  };

  CM.tick = function () {
    var d = new Date();
    var p = function (n) { return String(n).padStart(2, '0'); };
    var el = document.getElementById('topbar-clock');
    if (el) el.textContent = p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());

    // 实时态：游标跟随当前时间
    if (CM.state.timeline.mode === 'live') {
      CM.state.timeline.cursorSec = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
      // 仅在时间轴 tab 可见时刷新游标位置，避免重渲整个面板
      if (CM.state.activeTab === 'timeline') {
        var cursor = document.querySelector('.cm-tl-cursor');
        var cursorLbl = document.querySelector('.cm-tl-cursor-label');
        if (cursor && cursorLbl) {
          var SHIFT_START = 8 * 3600, SHIFT_END = 17 * 3600, SHIFT_SPAN = SHIFT_END - SHIFT_START;
          var pct = ((CM.state.timeline.cursorSec - SHIFT_START) / SHIFT_SPAN) * 100;
          cursor.style.left = pct + '%';
          cursorLbl.style.left = pct + '%';
          cursorLbl.textContent = p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
        }
      }
    }
  };

  // ===== assistant popover =====
  CM.initAssistant = function () {
    var fab = document.getElementById('assistant-fab');
    var pop = document.getElementById('assistant-popover');
    fab.addEventListener('click', function () { pop.hidden = false; });
    document.getElementById('assistant-close').addEventListener('click', function () { pop.hidden = true; });

    // 移除 V0.1 占位提示与 disabled
    var noteEl = pop.querySelector('.cm-pop-note');
    if (noteEl) {
      noteEl.textContent = '本地助手：仅承担查询/总结/解释，引用真实记录作答。不直接控制设备，不虚构数据。';
    }
    var input = document.getElementById('assistant-input');
    var sendBtn = document.getElementById('assistant-send');
    var ansEl = document.getElementById('assistant-answer');
    if (input) input.disabled = false;
    if (sendBtn) sendBtn.disabled = false;

    var ask = function (q) {
      if (!q || !q.trim()) return;
      input.value = '';
      ansEl.innerHTML = '<span class="cm-pop-loading">查询中…</span>';
      CM.api.query(q).then(function (r) {
        var html = '<div class="cm-pop-answer-text">' + CM.esc(r.answer || '') + '</div>';
        if (r.refused) {
          html += '<div class="cm-pop-tag cm-pop-refused">拒答 · ' + CM.esc(r.category || '') + '</div>';
        } else {
          html += '<div class="cm-pop-tag cm-pop-ok">已答 · ' + CM.esc(r.category || '') + '</div>';
        }
        if (r.evidence && r.evidence.length) {
          html += '<details class="cm-pop-evidence"><summary>证据记录（' + r.evidence.length + ' 条）</summary><pre>' +
                  CM.esc(JSON.stringify(r.evidence, null, 2)) + '</pre></details>';
        }
        // 数据来源标识
        html += '<div class="cm-pop-source">数据来源：' + (CM.state.dataSource === 'backend' ? '后端真实记录' : '离线样本（不可作为现场结论）') + '</div>';
        ansEl.innerHTML = html;
      }).catch(function (err) {
        ansEl.innerHTML = '<div class="cm-pop-error">查询失败：' + CM.esc(err.message || '') +
          '<br><span class="cm-pop-source">数据来源：' + (CM.state.dataSource === 'backend' ? '后端' : '离线样本') + '</span></div>';
      });
    };

    if (sendBtn) sendBtn.addEventListener('click', function () { ask(input.value); });
    if (input) input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') ask(input.value);
    });
    // 建议项点击直接发送
    pop.querySelectorAll('.cm-pop-suggestions button').forEach(function (b) {
      b.addEventListener('click', function () { ask(b.textContent); });
    });
  };

  // ===== bottom tabs =====
  CM.initTabs = function () {
    document.querySelectorAll('.cm-tab').forEach(function (b) {
      b.addEventListener('click', function () { CM.setTab(b.dataset.tab); });
    });
  };

  // ===== org tree =====
  CM._orgNodeHtml = function (node) {
    var children = CM.DATA.org.filter(function (n) { return n.parent === node.id; });
    var html = '<div class="cm-tree-node" data-id="' + node.id + '">';
    html += '<div class="cm-tree-row" data-id="' + node.id + '">';
    html += '<span class="cm-tree-dot"></span>';
    html += '<span>' + CM.esc(node.name) + '</span>';
    html += '<span class="cm-tree-type">' + CM.esc(node.type) + '</span>';
    html += '</div>';
    if (children.length) {
      html += '<div class="cm-tree-children">';
      children.forEach(function (c) { html += CM._orgNodeHtml(c); });
      html += '</div>';
    }
    html += '</div>';
    return html;
  };
  CM.renderOrgTree = function () {
    var root = CM.DATA.org.find(function (n) { return !n.parent; });
    var el = document.getElementById('org-tree');
    if (!root || !el) return;
    el.innerHTML = CM._orgNodeHtml(root);
    el.querySelectorAll('.cm-tree-row').forEach(function (row) {
      row.addEventListener('click', function () {
        var id = row.dataset.id;
        CM.state.activeOrgId = id;
        el.querySelectorAll('.cm-tree-node').forEach(function (n) {
          n.classList.toggle('selected', n.dataset.id === id);
        });
      });
    });
    var ws = el.querySelector('[data-id="WS-01"]');
    if (ws) ws.parentElement.classList.add('selected');
  };

  // ===== bootstrap =====
  CM.init = function () {
    CM.renderOrgTree();
    CM.initTabs();
    CM.initAssistant();
    CM.renderTopbar();
    CM.layers.render();
    CM.map.render();
    CM.entityPanel.render();
    CM.timeline.render();
    CM.eventCenter.render();
    CM.scenarioPanel.render();
    CM.admin.render();
    CM.tick();
    setInterval(CM.tick, 1000);

    // 尝试连接 backend；失败回退 sample data
    CM.api.bootstrap().then(function () {
      console.log('[CM] backend 数据加载成功');
      CM.rerenderAll();
      // 每 2 秒轮询动态实体（spec：状态端到端更新不超过 2 秒）
      setInterval(function () {
        CM.api.refreshDynamic().then(function () {
          CM.rerenderAll();
        }).catch(function (err) {
          console.warn('[CM] 轮询失败（保留上一次数据）：', err.message);
          // 不立刻回退 sample，保留上一次数据避免闪烁；标记 dataSource
          if (CM.state.dataSource === 'backend') {
            CM.state.dataSource = 'sample';
            CM.renderTopbar();
          }
        });
      }, 2000);
    }).catch(function (err) {
      console.warn('[CM] backend 不可用，使用 sample data：', err.message);
      CM.state.dataSource = 'sample';
      CM.renderTopbar();
      // 离线模式下不轮询
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', CM.init);
  } else {
    CM.init();
  }
})();
