/* assets/app.js — bootstrap, sample/demo data (V0.1 "看得见"), wires panels together.
   Loaded first; defines window.CM namespace so module files can attach renderers. */
(function () {
  'use strict';
  window.CM = window.CM || {};

  // Source-type labels follow existing repo convention.
  CM.SRC_LABEL = { real: 'REAL DEVICE', controlled_test: '受控数据', simulated: '模拟数据' };

  // 9 map modes (single-active rule enforced by layers.js). Order matches spec section 7.1.
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

  // ===== SAMPLE DATA — V0.1 "看得见" demo =====
  // Every spatial entity follows the spec schema:
  //   entity_id, entity_type, parent_id, pose{x,y,yaw}, bbox{w,h}, status,
  //   source_type, confidence, updated_at, version
  // Type-specific extras live under .device / .person / .station / .zone / .route.
  CM.DATA = {
    org: [
      { id: 'G-01',   name: '集团总部',     type: 'group',    parent: null },
      { id: 'F-01',   name: '示范工厂',     type: 'factory',  parent: 'G-01' },
      { id: 'WS-01',  name: '总装车间一',   type: 'workshop', parent: 'F-01' },
      { id: 'LINE-A', name: '装配产线A',    type: 'line',     parent: 'WS-01' },
      { id: 'LINE-B', name: '物流产线B',    type: 'line',     parent: 'WS-01' }
    ],

    entities: [
      // ---- Workshop boundary (WS-01) ----
      { entity_id: 'WS-01', entity_type: 'workshop', parent_id: 'F-01', name: '总装车间一',
        pose: { x: 500, y: 310, yaw: 0 }, bbox: { w: 920, h: 540 }, status: 'operational',
        source_type: 'real', confidence: 1.0, updated_at: '2026-07-31T08:00:00', version: 3 },

      // ---- Zones (static base map) ----
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

      // ---- Stations (3-5 per spec) ----
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

      // ---- Logistics route (main aisle perimeter loop) ----
      { entity_id: 'ROUTE-MAIN', entity_type: 'route', parent_id: 'WS-01', name: '主物流通道',
        pose: { x: 0, y: 0, yaw: 0 }, bbox: { w: 0, h: 0 }, status: 'open',
        source_type: 'real', confidence: 1.0, updated_at: '2026-07-31T08:00:00', version: 1,
        route: { path: [ { x: 100, y: 300 }, { x: 900, y: 300 }, { x: 900, y: 470 }, { x: 100, y: 470 }, { x: 100, y: 300 } ] } },

      // ---- Devices (exoskeletons) — bound to persons / stations / tasks ----
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

      // ---- Persons (workers wearing exoskeletons; binding visible on map) ----
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

    // Scheduling plans — per-metric comparison (NOT just total score), per spec scenario.
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

    // Model & rule registry (admin skeleton).
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

  // ===== runtime state =====
  CM.state = {
    selectedId: null,
    activeMode: 'production',
    activeOrgId: 'WS-01',
    activeTab: 'timeline',
    timeline: { mode: 'live', speed: 1, cursorSec: 5400 } // 5400s = 09:30:00 within 08:00–17:00 shift
  };

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

  // ===== shared actions (called by modules) =====
  CM.selectEntity = function (id) {
    CM.state.selectedId = id;
    if (CM.entityPanel) CM.entityPanel.render();
    if (CM.map) CM.map.render();
  };
  CM.setMode = function (modeId) {
    // Single-active-mode rule: setting a mode replaces the previous one.
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
  };

  // ===== top overview bar (counts: online devices / active persons / open events / shift) =====
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
    document.getElementById('kpi-output').textContent = '1,284 件';
  };

  CM.tick = function () {
    var d = new Date();
    var p = function (n) { return String(n).padStart(2, '0'); };
    document.getElementById('topbar-clock').textContent = p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  };

  // ===== assistant popover (V0.1 stub) =====
  CM.initAssistant = function () {
    var fab = document.getElementById('assistant-fab');
    var pop = document.getElementById('assistant-popover');
    fab.addEventListener('click', function () { pop.hidden = false; });
    document.getElementById('assistant-close').addEventListener('click', function () { pop.hidden = true; });
    pop.querySelectorAll('.cm-pop-suggestions button').forEach(function (b) {
      b.addEventListener('click', function () {
        document.getElementById('assistant-answer').textContent =
          '【V0.1 占位】该能力将在本地大模型接入后启用。当前指挥地图仅展示空间实体与事件流，不进行自然语言推理，不虚构传感器数据或调度结果。';
      });
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
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', CM.init);
  } else {
    CM.init();
  }
})();
