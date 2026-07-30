/* event-center/event-center.js — event stream list skeleton.
   Shows sample events (sensor conflict / high load / low battery / device offline /
   station backlog / forbidden zone / low confidence / schedule proposed) with
   severity + source tag. Clicking an event selects its related spatial entity. */
(function () {
  'use strict';
  var CM = window.CM;

  var SEV_LABEL = { critical: '严重', warning: '告警', info: '提示' };
  function sevBadge(s) {
    var cls = s === 'critical' ? 'cm-badge-danger' : s === 'warning' ? 'cm-badge-warning' : 'cm-badge-info';
    return '<span class="cm-badge ' + cls + '">' + (SEV_LABEL[s] || s) + '</span>';
  }

  CM.eventCenter = {
    selectedEvent: null,

    render: function () {
      var host = document.getElementById('tab-events');
      host.innerHTML =
        '<div class="cm-ev-wrap">' +
          '<div class="cm-ev-list" id="cm-ev-list">' + this._list() + '</div>' +
          '<div class="cm-ev-detail" id="cm-ev-detail">' +
            '<div class="cm-ev-empty">选择一条事件查看触发依据、证据窗与关联实体。</div>' +
          '</div>' +
        '</div>';
      var self = this;
      host.querySelectorAll('.cm-ev-item').forEach(function (it) {
        it.addEventListener('click', function () { self._select(it.dataset.id); });
      });
    },

    _list: function () {
      return CM.DATA.events.map(function (e) {
        return '<div class="cm-ev-item' + (CM.eventCenter.selectedEvent === e.event_id ? ' active' : '') + '" data-id="' + e.event_id + '">' +
          '<div class="cm-ev-item-head">' +
            sevBadge(e.severity) +
            '<span class="cm-ev-title">' + CM.esc(e.title) + '</span>' +
            '<span class="cm-badge cm-badge-muted">' + CM.statusText(e.status) + '</span>' +
          '</div>' +
          '<div class="cm-ev-item-meta">' +
            '<span class="cm-mono">' + e.time + '</span>' +
            CM.srcTag(e.source_type) +
            '<span>' + (e.person_id || e.device_id || e.station_id || '系统') + '</span>' +
          '</div>' +
          '<div class="cm-ev-item-id">' + e.event_id + ' · ' + e.code + '</div>' +
        '</div>';
      }).join('');
    },

    _select: function (id) {
      var e = CM.DATA.events.find(function (x) { return x.event_id === id; });
      if (!e) return;
      this.selectedEvent = id;
      // refresh list active state + detail
      document.querySelectorAll('#cm-ev-list .cm-ev-item').forEach(function (it) {
        it.classList.toggle('active', it.dataset.id === id);
      });
      var det = document.getElementById('cm-ev-detail');
      det.innerHTML =
        '<div class="cm-ev-d-head">' +
          '<div class="cm-ev-d-title">' + CM.esc(e.title) +
          sevBadge(e.severity) +
          '<span class="cm-badge cm-badge-muted">' + CM.statusText(e.status) + '</span>' +
          '</div>' +
          '<div class="cm-ev-d-id cm-mono">' + e.event_id + ' · ' + e.code + '</div>' +
        '</div>' +
        '<div class="cm-ev-d-row"><span>触发时间</span><b class="cm-mono">' + e.time + '</b></div>' +
        '<div class="cm-ev-d-row"><span>关联人员</span><b>' + CM.esc(e.person_id || '--') + '</b></div>' +
        '<div class="cm-ev-d-row"><span>关联设备</span><b>' + CM.esc(e.device_id || '--') + '</b></div>' +
        '<div class="cm-ev-d-row"><span>关联工位</span><b>' + CM.esc(e.station_id || '--') + '</b></div>' +
        '<div class="cm-ev-d-row"><span>数据来源</span><b>' + CM.srcTag(e.source_type) + '</b></div>' +
        '<div class="cm-ev-d-row"><span>置信度</span><b>' + (e.confidence * 100).toFixed(0) + '%</b></div>' +
        '<div class="cm-ev-d-detail">' + CM.esc(e.detail) + '</div>' +
        '<div class="cm-ev-d-actions">' +
          (e.person_id ? '<button class="cm-btn" data-jump="' + e.person_id + '">定位人员</button>' : '') +
          (e.device_id ? '<button class="cm-btn" data-jump="' + e.device_id + '">定位设备</button>' : '') +
          (e.station_id ? '<button class="cm-btn" data-jump="' + e.station_id + '">定位工位</button>' : '') +
          '<button class="cm-btn" disabled>查看证据窗</button>' +
        '</div>';
      det.querySelectorAll('[data-jump]').forEach(function (b) {
        b.addEventListener('click', function () {
          CM.selectEntity(b.dataset.jump);
          CM.setTab('timeline');
        });
      });
    }
  };
})();
