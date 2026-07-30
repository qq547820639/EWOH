/* timeline/timeline.js — 实时/暂停/倍速(1x/2x/4x)/跳转事件 controls.
   V0.1 UI skeleton only; no real playback backend. Cursor sits on the
   current shift (08:00–17:00) and event markers come from CM.DATA.events. */
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

  CM.timeline = {
    render: function () {
      var host = document.getElementById('tab-timeline');
      var t = CM.state.timeline;
      var modeLabel = t.mode === 'live' ? '实时态' : t.mode === 'pause' ? '已暂停' : '回放态';
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
          '<div class="cm-tl-note">V0.1 占位：时间轴控件为界面骨架，未接入真实回放后端。单班次回放加载目标 ≤ 10 秒，支持对比两时间点与查看调度前后变化（后续版本）。</div>' +
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
        var parts = e.time.split('T')[1].split(':');
        var sec = (+parts[0]) * 3600 + (+parts[1]) * 60 + (+parts[2]);
        var sev = e.severity === 'critical' ? 'crit' : e.severity === 'warning' ? 'warn' : 'info';
        html += '<div class="cm-tl-ev cm-tl-ev-' + sev + '" style="left:' + pctOf(sec) + '%" title="' + CM.esc(e.title + ' · ' + e.time) + '"></div>';
      });
      return html;
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
          self.render();
        });
      });
    },

    _toggleJumpList: function () {
      var box = document.getElementById('tl-jump');
      if (!box.hidden) { box.hidden = true; return; }
      box.hidden = false;
      box.innerHTML = '<div class="cm-tl-jump-title">跳转到事件（移动时间游标）</div>' +
        CM.DATA.events.map(function (e) {
          var parts = e.time.split('T')[1].split(':');
          var sec = (+parts[0]) * 3600 + (+parts[1]) * 60 + (+parts[2]);
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
          CM.setTab('events');
          self.render();
        });
      });
    }
  };
})();
