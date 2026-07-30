/* map/map.js — 2D SVG map renderer for spatial entities.
   Renders stations / devices / persons / zones / routes on a factory coordinate plane.
   Re-renders on mode change so only the active dimension is highlighted (single-active rule). */
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

  // Per-mode styling: returns { color, label, dim, ring }.
  // dim makes non-relevant entities fade so the active dimension stands out.
  function styleFor(entity, mode) {
    var t = entity.entity_type;
    switch (mode) {
      case 'production':
        if (t === 'station') {
          var c = entity.status === 'producing' ? '#10b981' : entity.status === 'warning' ? '#f59e0b' : '#6b7280';
          return { color: c, label: '节拍 ' + (entity.station.takt || 0) + 's · 积压 ' + entity.station.backlog };
        }
        return { dim: 0.35 };
      case 'person':
        if (t === 'person') return { color: '#06b6d4', label: entity.name + ' · ' + entity.person.action };
        if (t === 'device') return { dim: 0.55 };
        if (t === 'station') return { dim: 0.45 };
        return { dim: 0.6 };
      case 'exoskeleton':
        if (t === 'device') return { color: '#8b5cf6', label: entity.name + ' · 电量 ' + entity.device.battery + '%' };
        if (t === 'person') return { dim: 0.55 };
        return { dim: 0.35 };
      case 'body_load':
        if (t === 'person') {
          var l = entity.person.load_level;
          var bc = l >= 0.7 ? '#ef4444' : l >= 0.4 ? '#f59e0b' : '#10b981';
          return { color: bc, label: entity.name + ' · 负荷 ' + l.toFixed(2) };
        }
        return { dim: 0.3 };
      case 'safety_risk':
        if (t === 'zone' && entity.zone_type === 'safety') return { color: '#ef4444', label: '安全缓冲区' };
        if (t === 'person') {
          var hasEv = CM.DATA.events.some(function (e) {
            return e.person_id === entity.entity_id && (e.severity === 'critical' || e.severity === 'warning') && e.status === 'open';
          });
          return { color: hasEv ? '#ef4444' : '#6b7280', ring: hasEv, label: hasEv ? '风险事件' : '' };
        }
        if (t === 'zone') return { dim: 0.4 };
        return { dim: 0.6 };
      case 'device':
        if (t === 'device') {
          var dc = entity.status === 'online' ? '#10b981' : '#ef4444';
          return { color: dc, label: entity.name + ' · ' + (entity.status === 'online' ? '在线' : '离线 ' + (entity.device.fault_code || '')) };
        }
        return { dim: 0.35 };
      case 'environment':
        if (t === 'zone') {
          var n = entity.env.noise;
          var ec = n > 70 ? '#ef4444' : n > 60 ? '#f59e0b' : '#10b981';
          return { color: ec, label: entity.name + ' · 噪声 ' + n + 'dB · 温 ' + entity.env.temp + '℃' };
        }
        return { dim: 0.35 };
      case 'scheduling':
        if (t === 'route') return { color: '#a855f7', label: '调度路线' };
        if (t === 'person') {
          var aff = CM.DATA.plans.some(function (p) { return p.metrics.affected_persons.indexOf(entity.entity_id) >= 0; });
          return { color: aff ? '#a855f7' : '#6b7280', ring: aff, label: aff ? '受影响' : '' };
        }
        if (t === 'station') return { dim: 0.5 };
        return { dim: 0.4 };
      case 'data_quality':
        var qc = entity.confidence >= 0.95 ? '#10b981' : entity.confidence >= 0.85 ? '#f59e0b' : '#ef4444';
        return { color: qc, label: entity.name + ' · 置信 ' + Math.round(entity.confidence * 100) + '%' };
      default:
        return {};
    }
  }

  function dimOpacity(s) { return s && typeof s.dim === 'number' ? s.dim : (s && s.dim ? 0.4 : 1); }

  CM.map = {
    render: function () {
      var svg = document.getElementById('map-svg');
      var mode = CM.state.activeMode;
      svg.innerHTML = '';

      // defs: grid pattern + arrow marker
      var defs = el('defs');
      var pat = el('pattern', { id: 'cm-grid', width: 50, height: 50, patternUnits: 'userSpaceOnUse' });
      pat.appendChild(el('path', { d: 'M 50 0 L 0 0 0 50', fill: 'none', stroke: '#1c232d', 'stroke-width': 1 }));
      defs.appendChild(pat);
      var mk = el('marker', { id: 'cm-arrow', viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' });
      mk.appendChild(el('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: '#06b6d4' }));
      defs.appendChild(mk);
      svg.appendChild(defs);

      // background grid
      svg.appendChild(el('rect', { x: 0, y: 0, width: 1000, height: 700, fill: 'url(#cm-grid)' }));

      // workshop boundary
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

      // zones
      CM.DATA.entities.filter(function (e) { return e.entity_type === 'zone'; }).forEach(function (z) {
        svg.appendChild(this._zone(z, mode));
      }, this);

      // routes
      CM.DATA.entities.filter(function (e) { return e.entity_type === 'route'; }).forEach(function (r) {
        svg.appendChild(this._route(r, mode));
      }, this);

      // stations
      CM.DATA.entities.filter(function (e) { return e.entity_type === 'station'; }).forEach(function (s) {
        svg.appendChild(this._station(s, mode));
      }, this);

      // binding lines (person—device—station)
      svg.appendChild(this._bindings(mode));

      // devices
      CM.DATA.entities.filter(function (e) { return e.entity_type === 'device'; }).forEach(function (d) {
        svg.appendChild(this._device(d, mode));
      }, this);

      // persons
      CM.DATA.entities.filter(function (e) { return e.entity_type === 'person'; }).forEach(function (p) {
        svg.appendChild(this._person(p, mode));
      }, this);

      // attach click handler once (svg persists across renders)
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
      // selection ring
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
      // battery bar inside
      var batt = d.device.battery;
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
      // yaw direction arrow
      var rad = (p.pose.yaw || 0) * Math.PI / 180;
      var ax = cx + Math.cos(rad) * 16, ay = cy + Math.sin(rad) * 16;
      if (CM.state.selectedId === p.entity_id) g.appendChild(el('circle', { cx: cx, cy: cy, r: r + 4, fill: 'none', stroke: '#60a5fa', 'stroke-width': 2 }));
      g.appendChild(el('line', { x1: cx, y1: cy, x2: ax, y2: ay, stroke: fill, 'stroke-width': 2, 'marker-end': 'url(#cm-arrow)' }));
      g.appendChild(el('circle', { cx: cx, cy: cy, r: r, fill: fill, stroke: '#0d1117', 'stroke-width': 1.5 }));
      if (st.ring) g.appendChild(el('circle', { cx: cx, cy: cy, r: r + 3, fill: 'none', stroke: fill, 'stroke-width': 1.5, 'stroke-dasharray': '2 2' }));
      g.appendChild(txt(cx, cy + r + 11, p.name, 'cm-map-personlabel'));
      g.appendChild(txt(cx, cy + r + 22, p.entity_id, 'cm-map-idlabel'));
      if (st.label) g.appendChild(txt(cx, cy + r + 33, st.label, 'cm-map-modelabel'));
      return g;
    },

    // Visual binding: person—device—station dashed links (spec requirement #4).
    _bindings: function (mode) {
      var g = el('g', { opacity: mode === 'scheduling' || mode === 'person' || mode === 'exoskeleton' ? 0.9 : 0.5 });
      CM.DATA.entities.filter(function (e) { return e.entity_type === 'person'; }).forEach(function (p) {
        var dev = p.person.device_id ? CM.findEntity(p.person.device_id) : null;
        var stn = p.person.station_id ? CM.findEntity(p.person.station_id) : null;
        if (stn) g.appendChild(el('line', { x1: p.pose.x, y1: p.pose.y, x2: stn.pose.x, y2: stn.pose.y, stroke: '#475569', 'stroke-width': 1, 'stroke-dasharray': '3 3', opacity: 0.5 }));
        if (dev) g.appendChild(el('line', { x1: p.pose.x, y1: p.pose.y, x2: dev.pose.x, y2: dev.pose.y, stroke: '#475569', 'stroke-width': 1, 'stroke-dasharray': '2 2', opacity: 0.6 }));
      });
      return g;
    },

    // Legend reflects the active mode so the operator can decode colors at a glance.
    _legend: function (mode) {
      var el2 = document.getElementById('map-legend');
      var items = [];
      if (mode === 'body_load') items = [['#ef4444', '高负荷 ≥0.7'], ['#f59e0b', '中负荷 0.4–0.7'], ['#10b981', '低负荷 <0.4']];
      else if (mode === 'data_quality') items = [['#10b981', '高置信 ≥95%'], ['#f59e0b', '中置信 85–95%'], ['#ef4444', '低置信 <85%']];
      else if (mode === 'device' || mode === 'exoskeleton') items = [['#10b981', '在线/正常'], ['#ef4444', '离线/故障']];
      else if (mode === 'production') items = [['#10b981', '生产中'], ['#f59e0b', '积压告警'], ['#6b7280', '空闲']];
      else if (mode === 'safety_risk') items = [['#ef4444', '风险事件/禁区'], ['#6b7280', '正常']];
      else if (mode === 'environment') items = [['#ef4444', '噪声>70dB'], ['#f59e0b', '噪声60–70dB'], ['#10b981', '噪声<60dB']];
      else if (mode === 'scheduling') items = [['#a855f7', '调度路线/受影响人员'], ['#475569', '物流通道']];
      else items = [['#06b6d4', '人员'], ['#8b5cf6', '外骨骼设备'], ['#3b82f6', '工位'], ['#475569', '绑定关系']];
      items.push(['#60a5fa', '选中实体']);
      var html = items.map(function (it) {
        return '<span class="cm-legend-item"><span class="cm-legend-swatch" style="background:' + it[0] + '"></span>' + it[1] + '</span>';
      }).join('');
      html += '<span class="cm-legend-item" style="margin-left:auto">● 单击实体查看详情 · 单一主模式：' + CM.modeMeta(mode).name + '</span>';
      el2.innerHTML = html;
    }
  };
})();
