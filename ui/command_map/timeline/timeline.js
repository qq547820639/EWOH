/* timeline/timeline.js — 时间轴回放控制（Task 16 前端：看得懂）。
   - 实时 / 暂停 / 倍速 (1x/2x/4x) / 跳转事件
   - V0.2：接入 backend /api/telemetry/series 拉历史回放时序，展示负荷与电量迷你图
   - 设备选择 + 时间窗游标（基于班次 08:00–17:00）
   - 单班次回放加载目标 ≤ 10 秒；离线样本模式仅展示事件标记，不调用 series API */
(function () {
  'use strict';
  var CM = window.CM;
  var SHIFT_START = 8 * 3600;   // 08:00:00 in seconds
  var SHIFT_END = 17 * 3600;    // 17:00:00 in seconds
  var SHIFT_SPAN = SHIFT_END - SHIFT_START;

  function fmt(sec) {
    var p = function (n) { return String(n).padStart(2, '0'); };
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return p(h) + ':' + p(m) + ':' + p(s);
  }
  function pctOf(sec) { return ((sec - SHIFT_START) / SHIFT_SPAN) * 100; }
  // 把 ISO 时间转成当日班次内秒数
  function isoToShiftSec(iso) {
    if (!iso) return null;
    var parts = String(iso).split('T');
    if (parts.length < 2) return null;
    var t = parts[1].split(':');
    var sec = (+t[0]) * 3600 + (+t[1]) * 60 + Math.floor(+t[2]);
    if (sec < SHIFT_START || sec > SHIFT_END) return null;
    return sec;
  }

  CM.timeline = {
    // 回放时序缓存：{ deviceId: { items, inference, startSec, endSec } }
    _replayCache: null,
    _loadingSeries: false,

    render: function () {
      var host = document.getElementById('tab-timeline');
      var t = CM.state.timeline;
      var modeLabel = t.mode === 'live' ? '实时态' : t.mode === 'pause' ? '已暂停' : '回放态';
      // 设备下拉：从 CM.DATA.entities 取 device 列表
      var devices = CM.DATA.entities.filter(function (e) { return e.entity_type === 'device'; });
      var devOpts = devices.map(function (d) {
        return '<option value="' + d.entity_id + '"' + (t.replayDevice === d.entity_id ? ' selected' : '') + '>' +
          CM.esc(d.entity_id) + ' · ' + CM.esc(d.name) + '</option>';
      }).join('');
      host.innerHTML =
        '<div class="cm-tl-wrap">' +
          '<div class="cm-tl-controls">' +
            '<button class="cm-btn' + (t.mode === 'live' ? ' cm-btn-primary' : '') + '" data-act="live">实时</button>' +
            '<button class="cm-btn' + (t.mode === 'pause' ? ' cm-btn-primary' : '') + '" data-act="pause">暂停</button>' +
            '<span class="cm-tl-sep"></span>' +
            '<span class="cm-tl-speed-label">倍速</span>' +
            [1, 2, 4].map(function (s) {
              return '<button class="cm-btn' + (t.speed === s ? ' cm-btn-primary' : '') + '" data-act="speed" data-speed="' + s + '">' + s + 'x</button>';
            }).join('') +
            '<span class="cm-tl-sep"></span>' +
            '<span class="cm-tl-speed-label">回放设备</span>' +
            '<select id="tl-device" class="cm-ev-select">' + devOpts + '</select>' +
            '<button class="cm-btn" data-act="load">加载班次回放</button>' +
            '<button class="cm-btn" data-act="jump">跳转事件</button>' +
            '<span class="cm-tl-status"><span class="cm-tl-mode-dot"></span>' + modeLabel + ' · ' + t.speed + 'x · ' + fmt(t.cursorSec) + '</span>' +
          '</div>' +
          '<div class="cm-tl-track">' +
            '<div class="cm-tl-axis"></div>' +
            this._hourTicks() +
            this._eventMarkers() +
            '<div class="cm-tl-cursor" style="left:' + pctOf(t.cursorSec) + '%"></div>' +
            '<div class="cm-tl-cursor-label" style="left:' + pctOf(t.cursorSec) + '%">' + fmt(t.cursorSec) + '</div>' +
          '</div>' +
          '<div class="cm-tl-jump" id="tl-jump" hidden></div>' +
          '<div class="cm-tl-replay" id="tl-replay">' + this._replayPane() + '</div>' +
          '<div class="cm-tl-note">单班次回放加载目标 ≤ 10 秒。回放态游标停止推进，可拖动或跳转事件；实时态游标跟随当前时间。数据来源：' +
            (CM.state.dataSource === 'backend' ? '后端 /api/telemetry/series' : '离线样本（不拉历史）') + '。</div>' +
        '</div>';
      this._bind(host);
    },

    _hourTicks: function () {
      var html = '';
      for (var h = 8; h <= 17; h++) {
        var sec = h * 3600;
        html += '<div class="cm-tl-tick" style="left:' + pctOf(sec) + '%"></div>';
        html += '<div class="cm-tl-ticklabel" style="left:' + pctOf(sec) + '%">' + String(h).padStart(2, '0') + ':00</div>';
      }
      return html;
    },

    _eventMarkers: function () {
      var html = '';
      CM.DATA.events.forEach(function (e) {
        var sec = isoToShiftSec(e.time);
        if (sec == null) return;
        var sev = e.severity === 'critical' ? 'crit' : e.severity === 'warning' ? 'warn' : 'info';
        html += '<div class="cm-tl-ev cm-tl-ev-' + sev + '" style="left:' + pctOf(sec) + '%" title="' + CM.esc(e.title + ' · ' + e.time) + '"></div>';
      });
      return html;
    },

    // 回放数据面板：迷你图 + 时间点对比
    _replayPane: function () {
      var t = CM.state.timeline;
      if (this._loadingSeries) {
        return '<div class="cm-tl-replay-loading">回放数据加载中…</div>';
      }
      if (!this._replayCache || !this._replayCache.items || !this._replayCache.items.length) {
        return '<div class="cm-tl-replay-empty">选择设备并点击"加载班次回放"查看该班次负荷与电量曲线。回放数据来自 backend /api/telemetry/series。</div>';
      }
      var cache = this._replayCache;
      var html = '<div class="cm-tl-replay-head">' +
        '<span>设备 <b class="cm-mono">' + CM.esc(cache.device_id) + '</b></span>' +
        '<span>记录数 <b class="cm-mono">' + cache.items.length + '</b></span>' +
        '<span>时间窗 <b class="cm-mono">' + (cache.start || '--') + ' → ' + (cache.end || '--') + '</b></span>' +
        '<span>来源 ' + CM.srcTag(cache.items[0].source_type) + '</span>' +
        '</div>';
      html += '<div class="cm-tl-replay-chart">' + this._miniChart(cache.items) + '</div>';
      // 游标时间点的最近一条记录
      var cursorISO = this._cursorISO();
      var near = this._nearestRecord(cache.items, cursorISO);
      if (near) {
        var tele = near.telemetry || {};
        html += '<div class="cm-tl-replay-cursor">' +
          '<span>游标时间 <b class="cm-mono">' + (near.timestamp || '').replace('T', ' ') + '</b></span>' +
          '<span>负荷 <b>' + (tele.load_score != null ? tele.load_score.toFixed(2) : '--') + '</b></span>' +
          '<span>电量 <b>' + (tele.battery_level != null ? tele.battery_level + '%' : (tele.battery_pct != null ? tele.battery_pct + '%' : '--')) + '</b></span>' +
          '<span>动作 <b>' + CM.esc(tele.action_label || near.inference_label || '--') + '</b></span>' +
          '</div>';
      }
      return html;
    },

    // 迷你图：负荷折线（红橙绿三色），横轴为班次秒数
    _miniChart: function (items) {
      var w = 980, h = 90, pad = 6;
      var NS = 'http://www.w3.org/2000/svg';
      function el(tag, attrs, text) {
        var e = document.createElementNS(NS, tag);
        if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]);
        if (text != null) e.textContent = text;
        return e;
      }
      var svg = el('svg', { width: '100%', height: h, viewBox: '0 0 ' + w + ' ' + h, preserveAspectRatio: 'none' });
      // 背景网格
      for (var hh = 8; hh <= 17; hh++) {
        var x = pad + ((hh * 3600 - SHIFT_START) / SHIFT_SPAN) * (w - 2 * pad);
        svg.appendChild(el('line', { x1: x, y1: pad, x2: x, y2: h - pad, stroke: '#1c232d', 'stroke-width': 1 }));
        svg.appendChild(el('text', { x: x + 2, y: h - 2, fill: '#6b7280', 'font-size': 9 }, String(hh).padStart(2, '0')));
      }
      // 负荷折线
      var pts = [];
      items.forEach(function (r) {
        var sec = isoToShiftSec(r.timestamp);
        if (sec == null) return;
        var load = (r.telemetry && r.telemetry.load_score != null) ? r.telemetry.load_score : null;
        if (load == null) return;
        var x = pad + ((sec - SHIFT_START) / SHIFT_SPAN) * (w - 2 * pad);
        var y = (h - pad) - load * (h - 2 * pad);
        pts.push([x, y, load]);
      });
      if (pts.length >= 2) {
        var path = pts.map(function (p, i) { return (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ');
        svg.appendChild(el('path', { d: path, fill: 'none', stroke: '#f59e0b', 'stroke-width': 1.5 }));
        // 阈值线 0.7
        var y7 = (h - pad) - 0.7 * (h - 2 * pad);
        svg.appendChild(el('line', { x1: pad, y1: y7, x2: w - pad, y2: y7, stroke: '#ef4444', 'stroke-width': 1, 'stroke-dasharray': '3 3', opacity: 0.5 }));
        svg.appendChild(el('text', { x: w - pad - 50, y: y7 - 2, fill: '#ef4444', 'font-size': 9 }, '负荷阈值 0.7'));
      }
      // 游标竖线
      var cursorSec = CM.state.timeline.cursorSec;
      var cx = pad + ((cursorSec - SHIFT_START) / SHIFT_SPAN) * (w - 2 * pad);
      svg.appendChild(el('line', { x1: cx, y1: pad, x2: cx, y2: h - pad, stroke: '#60a5fa', 'stroke-width': 1.5, opacity: 0.8 }));
      // 图例
      svg.appendChild(el('text', { x: 8, y: 12, fill: '#f59e0b', 'font-size': 10 }, '负荷 load_score'));
      return new XMLSerializer().serializeToString(svg);
    },

    // 找到游标时间点最近的一条记录
    _nearestRecord: function (items, iso) {
      if (!items.length || !iso) return null;
      var target = new Date(iso).getTime();
      if (isNaN(target)) return null;
      var best = null, bestDelta = Infinity;
      items.forEach(function (r) {
        var ts = new Date(r.timestamp).getTime();
        if (isNaN(ts)) return;
        var d = Math.abs(ts - target);
        if (d < bestDelta) { bestDelta = d; best = r; }
      });
      return best;
    },

    // 把游标秒数转成今日 ISO（用于最近记录匹配）
    _cursorISO: function () {
      var sec = CM.state.timeline.cursorSec;
      var d = new Date();
      d.setHours(Math.floor(sec / 3600));
      d.setMinutes(Math.floor((sec % 3600) / 60));
      d.setSeconds(sec % 60);
      d.setMilliseconds(0);
      return d.toISOString();
    },

    _bind: function (host) {
      var self = this;
      host.querySelectorAll('[data-act]').forEach(function (b) {
        b.addEventListener('click', function () {
          var act = b.dataset.act;
          var t = CM.state.timeline;
          if (act === 'live') { t.mode = 'live'; t.speed = 1; }
          else if (act === 'pause') { t.mode = 'pause'; }
          else if (act === 'speed') { t.speed = +b.dataset.speed; if (t.mode === 'live' || t.mode === 'pause') t.mode = 'replay'; }
          else if (act === 'jump') { self._toggleJumpList(); return; }
          else if (act === 'load') { self._loadSeries(); return; }
          self.render();
        });
      });
      var devSel = document.getElementById('tl-device');
      if (devSel) devSel.addEventListener('change', function () {
        CM.state.timeline.replayDevice = devSel.value;
      });
      // 拖动游标（点击轨道跳转）
      var track = host.querySelector('.cm-tl-track');
      if (track) track.addEventListener('click', function (ev) {
        var rect = track.getBoundingClientRect();
        var pct = (ev.clientX - rect.left) / rect.width;
        var sec = SHIFT_START + pct * SHIFT_SPAN;
        if (sec < SHIFT_START) sec = SHIFT_START;
        if (sec > SHIFT_END) sec = SHIFT_END;
        CM.state.timeline.cursorSec = Math.floor(sec);
        CM.state.timeline.mode = 'replay';
        self.render();
      });
    },

    // 加载班次回放数据
    _loadSeries: function () {
      var t = CM.state.timeline;
      var devId = t.replayDevice;
      if (!devId) {
        var sel = document.getElementById('tl-device');
        devId = sel ? sel.value : '';
      }
      if (!devId) { alert('请先选择回放设备'); return; }
      if (CM.state.dataSource !== 'backend') {
        alert('离线样本模式：不调用 /api/telemetry/series。请启动 backend 后再加载回放。');
        return;
      }
      // 以今日班次为时间窗
      var now = new Date();
      var startD = new Date(now); startD.setHours(8, 0, 0, 0);
      var endD = new Date(now); endD.setHours(17, 0, 0, 0);
      var startISO = startD.toISOString();
      var endISO = endD.toISOString();
      this._loadingSeries = true;
      this.render();
      var self = this;
      CM.api.fetchSeries(devId, startISO, endISO, 5000).then(function (resp) {
        self._replayCache = {
          device_id: devId,
          items: (resp && resp.items) || [],
          inference: (resp && resp.inference) || [],
          start: startISO, end: endISO
        };
        self._loadingSeries = false;
        // 加载完后自动切回放态
        CM.state.timeline.mode = 'replay';
        self.render();
      }).catch(function (err) {
        self._loadingSeries = false;
        self._replayCache = null;
        self.render();
        alert('回放数据加载失败：' + (err.message || ''));
      });
    },

    _toggleJumpList: function () {
      var box = document.getElementById('tl-jump');
      if (!box.hidden) { box.hidden = true; return; }
      box.hidden = false;
      box.innerHTML = '<div class="cm-tl-jump-title">跳转到事件（移动时间游标）</div>' +
        CM.DATA.events.map(function (e) {
          var sec = isoToShiftSec(e.time);
          if (sec == null) return '';
          return '<button class="cm-tl-jump-item" data-sec="' + sec + '">' +
            '<span class="cm-tl-jump-time">' + e.time.split('T')[1] + '</span>' +
            '<span class="cm-badge cm-badge-' + (e.severity === 'critical' ? 'danger' : e.severity === 'warning' ? 'warning' : 'info') + '">' + e.severity + '</span>' +
            '<span>' + CM.esc(e.title) + '</span>' +
            '<span class="cm-tl-jump-id">' + e.event_id + '</span>' +
            '</button>';
        }).join('');
      var self = this;
      box.querySelectorAll('.cm-tl-jump-item').forEach(function (it) {
        it.addEventListener('click', function () {
          CM.state.timeline.cursorSec = +it.dataset.sec;
          CM.state.timeline.mode = 'replay';
          self.render();
        });
      });
    }
  };
})();
