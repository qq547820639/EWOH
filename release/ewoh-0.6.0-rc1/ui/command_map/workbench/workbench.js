/* workbench/workbench.js — 班组长工作台（Task 16.4：能建议 + 人在回路入口）。
   - 班次概览：班次/在线设备/在岗人员/未结事件/平均负荷 的 KPI 网格
   - 待审批调度方案：影子运行方案列表，跳转调度方案比较面板进行人工确认
   - 需关注事件：严重/告警且未处置事件，跳转事件中心处置
   - 快速操作：跳转各功能 tab + 安全控制红线提示
   安全控制不进入平台 · 调度需人工确认 · 未经授权自动调度为 0。 */
(function () {
  'use strict';
  var CM = window.CM;

  var SEV_LABEL = { critical: '严重', warning: '告警', info: '提示' };
  var SEV_RANK = { critical: 0, warning: 1, info: 2 };

  function sevBadge(s) {
    var cls = s === 'critical' ? 'cm-badge-danger' : s === 'warning' ? 'cm-badge-warning' : 'cm-badge-info';
    return '<span class="cm-badge ' + cls + '">' + (SEV_LABEL[s] || s) + '</span>';
  }

  // 从 timeline.cursorSec 推导班次名（与 topbar 时间窗一致：08:00-17:00 为早班）
  function shiftName() {
    var sec = CM.state.timeline && CM.state.timeline.cursorSec;
    if (sec == null || isNaN(sec)) return '早班';
    if (sec >= 8 * 3600 && sec < 17 * 3600) return '早班';
    return '晚班';
  }

  // 仅取 HH:MM:SS 部分，便于紧凑展示
  function fmtTime(t) {
    if (!t) return '--';
    var m = String(t).match(/T(\d{2}:\d{2}:\d{2})/);
    return m ? m[1] : String(t);
  }

  CM.workbench = {
    render: function () {
      var container = document.getElementById('tab-workbench');
      if (!container) return;
      var html =
        this._sectionOverview() +
        this._sectionPlans() +
        this._sectionEvents() +
        this._sectionActions();
      container.innerHTML = html;
      this._bind(container);
    },

    _bind: function (host) {
      host.querySelectorAll('[data-act="goto-scenario"]').forEach(function (b) {
        b.addEventListener('click', function () { CM.setTab('scenario'); });
      });
      host.querySelectorAll('[data-act="goto-events"]').forEach(function (b) {
        b.addEventListener('click', function () { CM.setTab('events'); });
      });
      host.querySelectorAll('[data-goto]').forEach(function (b) {
        b.addEventListener('click', function () { CM.setTab(b.dataset.goto); });
      });
    },

    // ===== Section A: 班次概览 =====
    _sectionOverview: function () {
      var devices = CM.DATA.entities.filter(function (e) { return e.entity_type === 'device'; });
      var persons = CM.DATA.entities.filter(function (e) { return e.entity_type === 'person'; });
      var onlineDev = devices.filter(function (d) { return d.status === 'online'; }).length;
      var activePersons = persons.filter(function (p) { return p.status === 'working'; });
      var openEvents = CM.DATA.events.filter(function (e) { return e.status === 'open'; });
      var crit = openEvents.filter(function (e) { return e.severity === 'critical'; }).length;
      var warn = openEvents.filter(function (e) { return e.severity === 'warning'; }).length;
      var info = openEvents.filter(function (e) { return e.severity === 'info'; }).length;

      var loadSum = 0, loadCnt = 0;
      activePersons.forEach(function (p) {
        var lv = p.person && p.person.load_level;
        if (lv != null && !isNaN(lv)) { loadSum += lv; loadCnt++; }
      });
      var avgLoad = loadCnt > 0 ? loadSum / loadCnt : 0;
      var loadCls = avgLoad >= 0.7 ? 'cm-wb-kpi-danger' : avgLoad >= 0.4 ? 'cm-wb-kpi-warning' : 'cm-wb-kpi-good';

      var dsLabel = CM.state.dataSource === 'backend' ? 'LIVE 后端' : '离线样本';
      var evCls = crit > 0 ? 'cm-wb-kpi-danger' : warn > 0 ? 'cm-wb-kpi-warning' : 'cm-wb-kpi-good';

      function kpi(label, value, sub, cls) {
        return '<div class="cm-wb-kpi' + (cls ? ' ' + cls : '') + '">' +
          '<span class="cm-wb-kpi-label">' + CM.esc(label) + '</span>' +
          '<span class="cm-wb-kpi-value">' + CM.esc(value) + '</span>' +
          (sub ? '<span class="cm-wb-kpi-sub">' + CM.esc(sub) + '</span>' : '') +
          '</div>';
      }

      return '<div class="cm-wb-section">' +
          '<div class="cm-wb-title">班次概览</div>' +
          '<div class="cm-wb-grid">' +
            kpi('当前班次', shiftName(), dsLabel) +
            kpi('在线设备', onlineDev + ' / ' + devices.length) +
            kpi('在岗人员', activePersons.length + ' / ' + persons.length) +
            kpi('未结事件', String(openEvents.length),
                '严重 ' + crit + ' · 告警 ' + warn + ' · 提示 ' + info, evCls) +
            kpi('平均负荷', (avgLoad * 100).toFixed(0) + '%', '在岗人员负荷均值', loadCls) +
          '</div>' +
        '</div>';
    },

    // ===== Section B: 待审批调度方案 =====
    _sectionPlans: function () {
      var plans = CM.DATA.plans.filter(function (p) { return p.status === 'shadow'; });
      var html = '<div class="cm-wb-section">' +
        '<div class="cm-wb-title">待审批调度方案' +
          '<span class="cm-wb-note">影子运行 · 仅记录不执行，待班组长人工确认</span>' +
        '</div>';
      if (plans.length === 0) {
        html += '<div class="cm-wb-empty">暂无待审批方案。</div>';
      } else {
        html += '<div class="cm-wb-plans">';
        plans.forEach(function (p) {
          var m = p.metrics || {};
          var targetLabel = p.target === 'production' ? '产能优先' :
                            p.target === 'load_balance' ? '负荷均衡' : (p.target || '--');
          var affected = m.affected_persons ? m.affected_persons.length : 0;
          html += '<div class="cm-wb-plan-item">' +
            '<div class="cm-wb-plan-head">' +
              '<span class="cm-wb-plan-name">' + CM.esc(p.name) + '</span>' +
              '<span class="cm-badge cm-badge-info">' + CM.esc(p.status) + '</span>' +
              (p.source_type ? CM.srcTag(p.source_type) : '') +
            '</div>' +
            '<div class="cm-wb-plan-target">目标：' + CM.esc(targetLabel) + '</div>' +
            '<div class="cm-wb-plan-metrics">' +
              '<span>节拍提升 <b>' + CM.esc(m.takt_improvement != null ? m.takt_improvement : '--') + '</b></span>' +
              '<span>高负荷人员 <b>' + (m.high_load_persons != null ? m.high_load_persons + ' 人' : '--') + '</b></span>' +
              '<span>低电量风险 <b>' + (m.low_battery_risk != null ? m.low_battery_risk + ' 台' : '--') + '</b></span>' +
              '<span>受影响人员 <b>' + affected + ' 人</b></span>' +
            '</div>' +
            '<div class="cm-wb-plan-actions">' +
              '<button class="cm-btn cm-btn-primary" data-act="goto-scenario">查看详情</button>' +
            '</div>' +
          '</div>';
        });
        html += '</div>';
      }
      html += '</div>';
      return html;
    },

    // ===== Section C: 需关注事件 =====
    _sectionEvents: function () {
      var list = CM.DATA.events.filter(function (e) {
        return e.status === 'open' && (e.severity === 'critical' || e.severity === 'warning');
      });
      list.sort(function (a, b) {
        var ra = SEV_RANK[a.severity] != null ? SEV_RANK[a.severity] : 9;
        var rb = SEV_RANK[b.severity] != null ? SEV_RANK[b.severity] : 9;
        if (ra !== rb) return ra - rb;
        var ta = a.time ? new Date(a.time).getTime() : 0;
        var tb = b.time ? new Date(b.time).getTime() : 0;
        if (isNaN(ta)) ta = 0;
        if (isNaN(tb)) tb = 0;
        return tb - ta;
      });

      var html = '<div class="cm-wb-section">' +
        '<div class="cm-wb-title">需关注事件' +
          '<span class="cm-wb-note">仅展示严重/告警且未处置事件，点击处置进入事件中心</span>' +
        '</div>';
      if (list.length === 0) {
        html += '<div class="cm-wb-empty">暂无需要关注的事件。</div>';
      } else {
        html += '<div class="cm-wb-events">';
        list.forEach(function (ev) {
          var personEntity = ev.person_id ? CM.findEntity(ev.person_id) : null;
          var personName = personEntity ? CM.personDisplay(personEntity) : '--';
          html += '<div class="cm-wb-event-item cm-wb-sev-' + (ev.severity || 'info') + '">' +
            '<div class="cm-wb-event-main">' +
              '<div class="cm-wb-event-row">' +
                sevBadge(ev.severity) +
                '<span class="cm-wb-event-title">' + CM.esc(ev.title || ev.code || ev.event_id) + '</span>' +
                '<span class="cm-wb-event-status">' + CM.esc(CM.statusText(ev.status)) + '</span>' +
              '</div>' +
              '<div class="cm-wb-event-meta">' +
                '<span>人员 ' + CM.esc(personName) + '</span>' +
                '<span>时间 ' + CM.esc(fmtTime(ev.time)) + '</span>' +
                (ev.source_type ? CM.srcTag(ev.source_type) : '') +
              '</div>' +
              '<div class="cm-wb-event-detail">' + CM.esc(ev.detail || '') + '</div>' +
            '</div>' +
            '<div class="cm-wb-event-actions">' +
              '<button class="cm-btn" data-act="goto-events">处置</button>' +
            '</div>' +
          '</div>';
        });
        html += '</div>';
      }
      html += '</div>';
      return html;
    },

    // ===== Section D: 快速操作 =====
    _sectionActions: function () {
      return '<div class="cm-wb-section">' +
          '<div class="cm-wb-title">快速操作</div>' +
          '<div class="cm-wb-actions">' +
            '<button class="cm-btn" data-goto="scenario">查看调度方案</button>' +
            '<button class="cm-btn" data-goto="events">查看全部事件</button>' +
            '<button class="cm-btn" data-goto="timeline">查看时间轴回放</button>' +
            '<button class="cm-btn" data-goto="admin">模型与规则管理</button>' +
          '</div>' +
          '<div class="cm-wb-safety">' +
            '<div class="cm-wb-safety-line">安全控制不进入平台</div>' +
            '<div class="cm-wb-safety-line">调度需人工确认</div>' +
            '<div class="cm-wb-safety-line">未经授权自动调度为 0</div>' +
          '</div>' +
        '</div>';
    }
  };
})();
