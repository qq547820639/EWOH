/* map/map.js — 2D SVG 地图渲染器（Task 16/22 前端）。
   渲染车间 / 区域 / 工位 / 设备 / 人员 / 路线，按 9 种模式突出单一维度。
   V0.2：动态字段来自 backend 合并后的 CM.DATA；新增环境热力图与调度预测层。*/
(function () {
  'use strict';
  var CM = window.CM;
  var NS = 'http://www.w3.org/2000/svg';

  function el(tag, attrs, text) {
    var e = document.createElementNS(NS, tag);
    if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    return e;
  }
  function txt(x, y, content, cls) {
    return el('text', { x: x, y: y, class: cls || '' }, content);
  }

  // 取人员当前负荷（来自 backend telemetry.load_score，回退样本 load_level）
  function personLoad(p) {
    return (p.person && p.person.load_level != null) ? p.person.load_level : 0;
  }
  // 取设备电量
  function deviceBattery(d) {
    return (d.device && d.device.battery != null) ? d.device.battery : 0;
  }
  // 取实体置信度
  function entityConf(e) {
    return e.confidence != null ? e.confidence : 0.85;
  }
  // 取人员当前动作（来自 backend inference.label）
  function personAction(p) {
    return (p.person && p.person.action) || 'unknown';
  }

  // 按模式返回 {color, label, dim, ring}
  function styleFor(entity, mode) {
    var t = entity.entity_type;
    switch (mode) {
      case 'production':
        if (t === 'station') {
          var c = entity.status === 'producing' ? '#10b981' : entity.status === 'warning' ? '#f59e0b' : '#6b7280';
          var st = entity.station || {};
          return { color: c, label: '节拍 ' + (st.takt || 0) + 's · 积压 ' + (st.backlog || 0) };
        }
        return { dim: 0.35 };
      case 'person':
        if (t === 'person') return { color: '#06b6d4', label: CM.personDisplay(entity) + ' · ' + personAction(entity) };
        if (t === 'device') return { dim: 0.55 };
        if (t === 'station') return { dim: 0.45 };
        return { dim: 0.6 };
      case 'exoskeleton':
        if (t === 'device') return { color: '#8b5cf6', label: entity.name + ' · 电量 ' + deviceBattery(entity) + '%' };
        if (t === 'person') return { dim: 0.55 };
        return { dim: 0.35 };
      case 'body_load':
        if (t === 'person') {
          var l = personLoad(entity);
          var bc = l >= 0.7 ? '#ef4444' : l >= 0.4 ? '#f59e0b' : '#10b981';
          return { color: bc, label: CM.personDisplay(entity) + ' · 负荷 ' + l.toFixed(2) };
        }
        return { dim: 0.3 };
      case 'safety_risk':
        if (t === 'zone' && entity.zone_type === 'safety') return { color: '#ef4444', label: '安全缓冲区' };
        if (t === 'person') {
          // 是否有未处置风险事件
          var hasEv = CM.DATA.events.some(function (e) {
            return e.person_id === entity.entity_id &&
                   (e.severity === 'critical' || e.severity === 'warning') &&
                   e.status === 'open';
          });
          // 是否有传感器冲突事件（Task 22：数据冲突可视化）
          var hasConflict = CM.DATA.events.some(function (e) {
            return e.person_id === entity.entity_id &&
                   e.code === 'SENSOR_CONFLICT' && e.status === 'open';
          });
          // 是否累计负荷过高
          var highLoad = personLoad(entity) >= 0.7;
          var label = hasConflict ? '传感器冲突' : (hasEv ? '风险事件' : (highLoad ? '高负荷' : ''));
          // 冲突用紫色环，其他风险用红色
          return { color: (hasEv || highLoad || hasConflict) ? (hasConflict ? '#8b5cf6' : '#ef4444') : '#6b7280',
                   ring: hasEv || highLoad || hasConflict, label: label };
        }
        if (t === 'zone') return { dim: 0.4 };
        return { dim: 0.6 };
      case 'device':
        if (t === 'device') {
          var online = entity.status === 'online';
          var fault = entity.device && entity.device.fault_code;
          var dc = online ? '#10b981' : '#ef4444';
          return { color: dc, label: entity.name + ' · ' + (online ? '在线' : '离线 ' + (fault || '')) };
        }
        return { dim: 0.35 };
      case 'environment':
        if (t === 'zone') {
          var env = entity.env || {};
          var n = env.noise != null ? env.noise : 60;
          var ec = n > 70 ? '#ef4444' : n > 60 ? '#f59e0b' : '#10b981';
          return { color: ec, label: entity.name + ' · 噪声 ' + n + 'dB · 温 ' + (env.temp || '--') + '℃' };
        }
        return { dim: 0.35 };
      case 'scheduling':
        if (t === 'route') return { color: '#a855f7', label: '调度路线' };
        if (t === 'person') {
          var aff = CM.DATA.plans.some(function (p) {
            return p.metrics && p.metrics.affected_persons &&
                   p.metrics.affected_persons.indexOf(entity.entity_id) >= 0;
          });
          return { color: aff ? '#a855f7' : '#6b7280', ring: aff, label: aff ? '受影响' : '' };
        }
        if (t === 'station') return { dim: 0.5 };
        return { dim: 0.4 };
      case 'data_quality':
        // 按置信度着色：>=0.95 绿、>=0.85 黄、<0.85 红
        var q = entityConf(entity);
        var qc = q >= 0.95 ? '#10b981' : q >= 0.85 ? '#f59e0b' : '#ef4444';
        // 设备额外考虑 quality_status
        if (t === 'device' && entity.device) {
          var qs = entity.device.quality_status;
          if (qs === 'poor' || qs === 'bad') qc = '#ef4444';
          else if (qs === 'degraded') qc = '#f59e0b';
        }
        return { color: qc, label: entity.name + ' · 置信 ' + Math.round(q * 100) + '%' };
      default:
        return {};
    }
  }

  function dimOpacity(s) { return s && typeof s.dim === 'number' ? s.dim : (s && s.dim ? 0.4 : 1); }

  CM.map = {
    render: function () {
      var svg = document.getElementById('map-svg');
      if (!svg) return;
      var mode = CM.state.activeMode;
      // 更新地图元信息以反映当前视图等级（L0/L1）
      var metaEl = document.getElementById('map-meta');
      if (metaEl) {
        var modeM = CM.modeMeta(mode);
        var levelLbl = CM.state.mapLevel === 'L2' ? 'L2 轻量三维（待GLB资产）' : CM.state.mapLevel === 'L1' ? 'L1 2.5D 地图' : 'L0 二维地图';
        var dsTag = CM.state.dataSource === 'backend' ? 'LIVE 后端' : '离线样本';
        metaEl.textContent = '来源 ' + dsTag + ' · 坐标系 工厂局部（米）· 维度：' + modeM.name + ' · ' + levelLbl;
      }
      svg.innerHTML = '';

      // defs：网格 + 箭头 + 热力图径向渐变
      var defs = el('defs');
      var pat = el('pattern', { id: 'cm-grid', width: 50, height: 50, patternUnits: 'userSpaceOnUse' });
      pat.appendChild(el('path', { d: 'M 50 0 L 0 0 0 50', fill: 'none', stroke: '#1c232d', 'stroke-width': 1 }));
      defs.appendChild(pat);
      var mk = el('marker', { id: 'cm-arrow', viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' });
      mk.appendChild(el('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: '#06b6d4' }));
      defs.appendChild(mk);
      // 环境热力图径向渐变（红橙黄绿）
      ['hm-red', 'hm-orange', 'hm-yellow', 'hm-green'].forEach(function (id, i) {
        var stops = [['#ef4444', 0], ['#ef4444', 0.5], ['transparent', 1]];
        if (id === 'hm-orange') stops = [['#f59e0b', 0], ['#f59e0b', 0.5], ['transparent', 1]];
        if (id === 'hm-yellow') stops = [['#eab308', 0], ['#eab308', 0.5], ['transparent', 1]];
        if (id === 'hm-green') stops = [['#10b981', 0], ['#10b981', 0.5], ['transparent', 1]];
        var rad = el('radialGradient', { id: id });
        stops.forEach(function (s) {
          rad.appendChild(el('stop', { offset: s[1] * 100 + '%', 'stop-color': s[0], 'stop-opacity': s[1] === 0 ? 0.55 : 0.25 }));
        });
        defs.appendChild(rad);
      });
      svg.appendChild(defs);

      // 背景网格
      svg.appendChild(el('rect', { x: 0, y: 0, width: 1000, height: 700, fill: 'url(#cm-grid)' }));

      // 车间边界
      var ws = CM.findEntity('WS-01');
      if (ws) {
        var w = el('g');
        w.appendChild(el('rect', {
          x: ws.pose.x - ws.bbox.w / 2, y: ws.pose.y - ws.bbox.h / 2,
          width: ws.bbox.w, height: ws.bbox.h,
          fill: 'none', stroke: '#38414f', 'stroke-width': 1.5, 'stroke-dasharray': '6 4', rx: 6
        }));
        w.appendChild(txt(ws.pose.x - ws.bbox.w / 2 + 10, ws.pose.y - ws.bbox.h / 2 + 16, ws.name + ' (' + ws.entity_id + ')', 'cm-map-zonelabel'));
        svg.appendChild(w);
      }

      // 区域
      CM.DATA.entities.filter(function (e) { return e.entity_type === 'zone'; }).forEach(function (z) {
        svg.appendChild(this._zone(z, mode));
      }, this);

      // 路线
      CM.DATA.entities.filter(function (e) { return e.entity_type === 'route'; }).forEach(function (r) {
        svg.appendChild(this._route(r, mode));
      }, this);

      // 工位
      CM.DATA.entities.filter(function (e) { return e.entity_type === 'station'; }).forEach(function (s) {
        svg.appendChild(this._station(s, mode));
      }, this);

      // 绑定连线（人—设备—工位）
      svg.appendChild(this._bindings(mode));

      // L1 2.5D: UWB 覆盖圆（位于实体下方）
      if (CM.state.mapLevel === 'L1') {
        CM.DATA.entities.filter(function (e) { return e.entity_type === 'uwb_station'; }).forEach(function (u) {
          svg.appendChild(this._uwbCoverage(u, mode));
        }, this);
      }
      // L1 2.5D: 摄像头视锥
      if (CM.state.mapLevel === 'L1') {
        CM.DATA.entities.filter(function (e) { return e.entity_type === 'camera'; }).forEach(function (c) {
          svg.appendChild(this._cameraCone(c, mode));
        }, this);
      }

      // 设备
      CM.DATA.entities.filter(function (e) { return e.entity_type === 'device'; }).forEach(function (d) {
        svg.appendChild(this._device(d, mode));
      }, this);

      // 人员
      CM.DATA.entities.filter(function (e) { return e.entity_type === 'person'; }).forEach(function (p) {
        svg.appendChild(this._person(p, mode));
      }, this);

      // 环境模式下额外叠加热力图（Task 22）
      if (mode === 'environment') svg.appendChild(this._envHeatmap());

      // 调度模式下叠加预测轨迹层（Task 22）
      if (mode === 'scheduling') svg.appendChild(this._predictionLayer());

      // 点击委托（仅绑定一次）
      if (!svg._cmBound) {
        svg.addEventListener('click', function (ev) {
          var g = ev.target.closest('[data-entity-id]');
          if (g) CM.selectEntity(g.getAttribute('data-entity-id'));
        });
        svg._cmBound = true;
      }

      this._legend(mode);
    },

    _zone: function (z, mode) {
      var s = styleFor(z, mode);
      var op = dimOpacity(s);
      var fill = s.color || (z.zone_type === 'safety' ? '#ef4444' : '#3b82f6');
      var g = el('g', { opacity: op });
      g.appendChild(el('rect', {
        x: z.pose.x - z.bbox.w / 2, y: z.pose.y - z.bbox.h / 2,
        width: z.bbox.w, height: z.bbox.h,
        fill: fill, 'fill-opacity': 0.10, stroke: fill, 'stroke-width': 1, 'stroke-dasharray': '4 3', rx: 4
      }));
      g.appendChild(txt(z.pose.x - z.bbox.w / 2 + 8, z.pose.y - z.bbox.h / 2 + 16, z.name, 'cm-map-zonelabel'));
      if (s.label) g.appendChild(txt(z.pose.x, z.pose.y + 4, s.label, 'cm-map-modelabel'));
      return g;
    },

    _route: function (r, mode) {
      var s = styleFor(r, mode);
      var op = dimOpacity(s);
      var pts = r.route.path.map(function (p) { return p.x + ',' + p.y; }).join(' ');
      var g = el('g', { opacity: op });
      g.appendChild(el('polyline', {
        points: pts, fill: 'none', stroke: s.color || '#475569',
        'stroke-width': 2, 'stroke-dasharray': '8 4', 'stroke-linejoin': 'round'
      }));
      if (s.label) g.appendChild(txt(r.route.path[0].x + 8, r.route.path[0].y - 6, r.name + ' · ' + s.label, 'cm-map-modelabel'));
      return g;
    },

    _station: function (s, mode) {
      var st = styleFor(s, mode);
      var op = dimOpacity(st);
      var fill = st.color || '#1c232d';
      var x = s.pose.x - s.bbox.w / 2, y = s.pose.y - s.bbox.h / 2;
      var g = el('g', { 'data-entity-id': s.entity_id, opacity: op, style: 'cursor:pointer' });
      if (CM.state.selectedId === s.entity_id) g.appendChild(el('rect', { x: x - 3, y: y - 3, width: s.bbox.w + 6, height: s.bbox.h + 6, fill: 'none', stroke: '#60a5fa', 'stroke-width': 2, rx: 6 }));
      g.appendChild(el('rect', { x: x, y: y, width: s.bbox.w, height: s.bbox.h, fill: fill, 'fill-opacity': 0.85, stroke: '#9ca3af', 'stroke-width': 1, rx: 4 }));
      g.appendChild(txt(s.pose.x, s.pose.y - 4, s.name, 'cm-map-stationlabel'));
      g.appendChild(txt(s.pose.x, s.pose.y + 10, s.entity_id, 'cm-map-idlabel'));
      if (st.label) g.appendChild(txt(s.pose.x, s.pose.y + s.bbox.h / 2 + 12, st.label, 'cm-map-modelabel'));
      return g;
    },

    _device: function (d, mode) {
      var st = styleFor(d, mode);
      var op = dimOpacity(st);
      var fill = st.color || (d.status === 'online' ? '#10b981' : '#ef4444');
      var w = d.bbox.w, h = d.bbox.h;
      var x = d.pose.x - w / 2, y = d.pose.y - h / 2;
      var g = el('g', { 'data-entity-id': d.entity_id, opacity: op, style: 'cursor:pointer' });
      if (CM.state.selectedId === d.entity_id) g.appendChild(el('rect', { x: x - 3, y: y - 3, width: w + 6, height: h + 6, fill: 'none', stroke: '#60a5fa', 'stroke-width': 2, rx: 4 }));
      g.appendChild(el('rect', { x: x, y: y, width: w, height: h, fill: fill, stroke: '#0d1117', 'stroke-width': 1, rx: 3 }));
      // 电量条
      var batt = deviceBattery(d);
      var bw = (w - 4) * (batt / 100);
      g.appendChild(el('rect', { x: x + 2, y: y + h - 5, width: Math.max(2, bw), height: 3, fill: batt > 30 ? '#e6edf3' : '#f59e0b', rx: 1 }));
      g.appendChild(txt(d.pose.x, y - 4, d.entity_id, 'cm-map-idlabel'));
      if (st.label) g.appendChild(txt(d.pose.x, y + h + 11, st.label, 'cm-map-modelabel'));
      return g;
    },

    _person: function (p, mode) {
      var st = styleFor(p, mode);
      var op = dimOpacity(st);
      var fill = st.color || '#06b6d4';
      var g = el('g', { 'data-entity-id': p.entity_id, opacity: op, style: 'cursor:pointer' });
      var cx = p.pose.x, cy = p.pose.y, r = 9;
      var rad = (p.pose.yaw || 0) * Math.PI / 180;
      var ax = cx + Math.cos(rad) * 16, ay = cy + Math.sin(rad) * 16;
      if (CM.state.selectedId === p.entity_id) g.appendChild(el('circle', { cx: cx, cy: cy, r: r + 4, fill: 'none', stroke: '#60a5fa', 'stroke-width': 2 }));
      g.appendChild(el('line', { x1: cx, y1: cy, x2: ax, y2: ay, stroke: fill, 'stroke-width': 2, 'marker-end': 'url(#cm-arrow)' }));
      g.appendChild(el('circle', { cx: cx, cy: cy, r: r, fill: fill, stroke: '#0d1117', 'stroke-width': 1.5 }));
      if (st.ring) g.appendChild(el('circle', { cx: cx, cy: cy, r: r + 3, fill: 'none', stroke: fill, 'stroke-width': 1.5, 'stroke-dasharray': '2 2' }));
      // 隐私：默认匿名编号
      g.appendChild(txt(cx, cy + r + 11, CM.personDisplay(p), 'cm-map-personlabel'));
      g.appendChild(txt(cx, cy + r + 22, p.entity_id, 'cm-map-idlabel'));
      if (st.label) g.appendChild(txt(cx, cy + r + 33, st.label, 'cm-map-modelabel'));
      return g;
    },

    // 人—设备—工位 绑定连线（spec 要求 #4）
    _bindings: function (mode) {
      var g = el('g', { opacity: mode === 'scheduling' || mode === 'person' || mode === 'exoskeleton' ? 0.9 : 0.5 });
      CM.DATA.entities.filter(function (e) { return e.entity_type === 'person'; }).forEach(function (p) {
        var dev = (p.person && p.person.device_id) ? CM.findEntity(p.person.device_id) : null;
        var stn = (p.person && p.person.station_id) ? CM.findEntity(p.person.station_id) : null;
        if (stn) g.appendChild(el('line', { x1: p.pose.x, y1: p.pose.y, x2: stn.pose.x, y2: stn.pose.y, stroke: '#475569', 'stroke-width': 1, 'stroke-dasharray': '3 3', opacity: 0.5 }));
        if (dev) g.appendChild(el('line', { x1: p.pose.x, y1: p.pose.y, x2: dev.pose.x, y2: dev.pose.y, stroke: '#475569', 'stroke-width': 1, 'stroke-dasharray': '2 2', opacity: 0.6 }));
      });
      return g;
    },

    // 环境热力图（Task 22）：在每个区域中心叠加重色径向渐变，按噪声强度选色
    _envHeatmap: function () {
      var g = el('g', { opacity: 0.55, 'pointer-events': 'none' });
      CM.DATA.entities.filter(function (e) { return e.entity_type === 'zone' && e.env; }).forEach(function (z) {
        var n = z.env.noise != null ? z.env.noise : 60;
        var fill = n > 70 ? 'url(#hm-red)' : n > 60 ? 'url(#hm-orange)' : n > 50 ? 'url(#hm-yellow)' : 'url(#hm-green)';
        var rad = Math.min(z.bbox.w, z.bbox.h) * 0.55;
        g.appendChild(el('circle', { cx: z.pose.x, cy: z.pose.y, r: rad, fill: fill }));
      });
      // 设备温度也作为一个热源点
      CM.DATA.entities.filter(function (e) { return e.entity_type === 'device' && e.device && e.device.temp; }).forEach(function (d) {
        var t = d.device.temp;
        if (t > 42) g.appendChild(el('circle', { cx: d.pose.x, cy: d.pose.y, r: 30, fill: 'url(#hm-red)' }));
        else if (t > 38) g.appendChild(el('circle', { cx: d.pose.x, cy: d.pose.y, r: 22, fill: 'url(#hm-orange)' }));
      });
      return g;
    },

    // 预测轨迹层（Task 22）：按人员朝向 yaw 延伸出 30px 虚线作为短期预测路径
    // 仅在调度模式下显示，标明"预测"而非真实轨迹
    _predictionLayer: function () {
      var g = el('g', { 'pointer-events': 'none' });
      CM.DATA.entities.filter(function (e) { return e.entity_type === 'person'; }).forEach(function (p) {
        var rad = (p.pose.yaw || 0) * Math.PI / 180;
        var x1 = p.pose.x, y1 = p.pose.y;
        var x2 = x1 + Math.cos(rad) * 30, y2 = y1 + Math.sin(rad) * 30;
        g.appendChild(el('line', { x1: x1, y1: y1, x2: x2, y2: y2,
          stroke: '#a855f7', 'stroke-width': 1.5, 'stroke-dasharray': '2 3', opacity: 0.7 }));
        g.appendChild(el('circle', { cx: x2, cy: y2, r: 2.5, fill: '#a855f7', opacity: 0.7 }));
      });
      // 标注
      g.appendChild(txt(8, 14, '预测轨迹（基于朝向，仅短期推断，不作为控制依据）', 'cm-map-modelabel'));
      return g;
    },

    // L1 2.5D：摄像头视锥（半透明三角形 + 摄像头图标 + 高度标识）
    _cameraCone: function (cam, mode) {
      var c = cam.camera || {};
      var fov = (c.fov_deg || 75) * Math.PI / 180;
      var range = (c.range_m || 12) * 10; // range_m 为米，地图坐标按 0.1m/单位缩放
      var yawRad = (cam.pose.yaw || 0) * Math.PI / 180;
      var cx = cam.pose.x, cy = cam.pose.y;
      // 罗盘约定：yaw 0=上, 90=右, 180=下, 270=左（俯视摄像头朝向）
      var dir = function (a) { return { x: Math.sin(a), y: -Math.cos(a) }; };
      var left = dir(yawRad - fov / 2);
      var right = dir(yawRad + fov / 2);
      var lx = cx + left.x * range, ly = cy + left.y * range;
      var rx = cx + right.x * range, ry = cy + right.y * range;
      var g = el('g', { 'data-entity-id': cam.entity_id, style: 'cursor:pointer' });
      // 视锥多边形
      g.appendChild(el('polygon', {
        points: cx + ',' + cy + ' ' + lx + ',' + ly + ' ' + rx + ',' + ry,
        class: 'cm-camera-cone'
      }));
      // 摄像头图标
      var w = cam.bbox.w, h = cam.bbox.h;
      var fill = cam.status === 'online' ? '#22d3ee' : '#6b7280';
      g.appendChild(el('rect', {
        x: cx - w / 2, y: cy - h / 2, width: w, height: h,
        fill: fill, stroke: '#0d1117', 'stroke-width': 1, rx: 2
      }));
      g.appendChild(txt(cx, cy - h / 2 - 4, cam.entity_id, 'cm-map-idlabel'));
      // 高度/楼层标识
      var badge = this._heightIndicator(cam, mode);
      if (badge) g.appendChild(badge);
      return g;
    },

    // L1 2.5D：UWB 覆盖圆（半透明圆 + 基站图标 + 高度标识）
    _uwbCoverage: function (uwb, mode) {
      var u = uwb.uwb || {};
      var r = u.coverage_r || 150;
      var cx = uwb.pose.x, cy = uwb.pose.y;
      var g = el('g', { 'data-entity-id': uwb.entity_id, style: 'cursor:pointer' });
      // 覆盖圆
      g.appendChild(el('circle', { cx: cx, cy: cy, r: r, class: 'cm-uwb-coverage' }));
      // 基站图标
      var w = uwb.bbox.w, h = uwb.bbox.h;
      var fill = uwb.status === 'online' ? '#3b82f6' : '#6b7280';
      g.appendChild(el('rect', {
        x: cx - w / 2, y: cy - h / 2, width: w, height: h,
        fill: fill, stroke: '#0d1117', 'stroke-width': 1, rx: 2
      }));
      g.appendChild(txt(cx, cy - h / 2 - 4, uwb.entity_id, 'cm-map-idlabel'));
      // 高度/楼层标识
      var badge = this._heightIndicator(uwb, mode);
      if (badge) g.appendChild(badge);
      return g;
    },

    // L1 2.5D：高度/楼层标识（摄像头与 UWB 基站）
    _heightIndicator: function (entity, mode) {
      var info = entity.camera || entity.uwb;
      if (!info) return null;
      var h = info.height_m != null ? info.height_m : '--';
      var f = info.floor != null ? info.floor : '--';
      var label = 'H' + h + 'm F' + f;
      var yOff = (entity.bbox.h / 2) + 10;
      return txt(entity.pose.x, entity.pose.y + yOff, label, 'cm-height-badge');
    },

    // 图例随主模式变化
    _legend: function (mode) {
      var el2 = document.getElementById('map-legend');
      if (!el2) return;
      var items = [];
      if (mode === 'body_load') items = [['#ef4444', '高负荷 ≥0.7'], ['#f59e0b', '中负荷 0.4–0.7'], ['#10b981', '低负荷 <0.4']];
      else if (mode === 'data_quality') items = [['#10b981', '高置信 ≥95%'], ['#f59e0b', '中置信 85–95%'], ['#ef4444', '低置信 <85%']];
      else if (mode === 'device' || mode === 'exoskeleton') items = [['#10b981', '在线/正常'], ['#ef4444', '离线/故障']];
      else if (mode === 'production') items = [['#10b981', '生产中'], ['#f59e0b', '积压告警'], ['#6b7280', '空闲']];
      else if (mode === 'safety_risk') items = [['#ef4444', '风险事件/禁区/高负荷'], ['#8b5cf6', '传感器冲突（可标记现场事实）'], ['#6b7280', '正常']];
      else if (mode === 'environment') items = [['#ef4444', '噪声>70dB/高温'], ['#f59e0b', '噪声60–70dB'], ['#10b981', '噪声<60dB']];
      else if (mode === 'scheduling') items = [['#a855f7', '调度路线/受影响人员/预测轨迹'], ['#475569', '物流通道']];
      else items = [['#06b6d4', '人员'], ['#8b5cf6', '外骨骼设备'], ['#3b82f6', '工位'], ['#475569', '绑定关系']];
      items.push(['#60a5fa', '选中实体']);
      if (CM.state.mapLevel === 'L1') {
        items.push(['#22d3ee', '摄像头视锥']);
        items.push(['#3b82f6', 'UWB 覆盖范围']);
      }
      var html = items.map(function (it) {
        return '<span class="cm-legend-item"><span class="cm-legend-swatch" style="background:' + it[0] + '"></span>' + it[1] + '</span>';
      }).join('');
      var dsTag = CM.state.dataSource === 'backend' ? 'LIVE 后端' : '离线样本';
      var levelLabel = CM.state.mapLevel === 'L1' ? 'L1 2.5D' : 'L0 二维';
      html += '<span class="cm-legend-item" style="margin-left:auto">● 单击实体查看详情 · 单一主模式：' + CM.modeMeta(mode).name + ' · 视图等级：' + levelLabel + ' · 数据来源：' + dsTag + '</span>';
      el2.innerHTML = html;
    }
  };
})();
