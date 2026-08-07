/* workbench/workbench.js — 班组长工作台（Phase 7.4：真实后端调度数据工作台）。
   - 班次概览：班次/在线设备/在岗人员/未结事件/平均负荷 + 调度 KPI（待确认/冲突/未派/异常）
   - 高优先级未派任务：后端 /api/tasks 中未进入任何 Assignment 的高优先/安全关键任务
   - 待确认方案：/api/scheduling/plans 中 pending_review/shadow/simulating 的真实方案
   - 冲突 / 过期方案：constraint_summary.violations>0 或 status=expired 的方案
   - 异常派工：Assignment 或关联任务状态为 exception 的派工记录
   - 需人工重排：汇总 异常派工/过期方案/冲突方案/高优未派 项
   - 需关注事件：严重/告警且未处置事件，跳转事件中心处置
   - 快速操作：跳转各功能 tab + 安全控制红线提示
   安全控制不进入平台 · 调度需人工确认 · 未经授权自动调度为 0。 */
(function () {
  'use strict';
  var CM = window.CM;

  var SEV_LABEL = { critical: '严重', warning: '告警', info: '提示' };
  var SEV_RANK = { critical: 0, warning: 1, info: 2 };

  // 任务未进入派工/方案的待处理状态集合
  var UNASSIGNED_TASK_STATUS = ['draft', 'pending_confirm', 'pending_approval', 'pending_dispatch'];
  var PLAN_STATUS_LABEL = {
    shadow: '影子', simulating: '仿真', pending_review: '待审批', approved: '已批准',
    dispatched: '已派工', expired: '已过期', archived: '已归档'
  };
  var TASK_STATUS_LABEL = {
    draft: '草稿', pending_confirm: '待确认', pending_approval: '待审批',
    pending_dispatch: '待派工', dispatched: '已派工', received: '已接收',
    executing: '执行中', paused: '已暂停', exception: '异常',
    completed: '已完成', cancelled: '已取消'
  };

  function sevBadge(s) {
    var cls = s === 'critical' ? 'cm-badge-danger' : s === 'warning' ? 'cm-badge-warning' : 'cm-badge-info';
    return '<span class="cm-badge ' + cls + '">' + (SEV_LABEL[s] || s) + '</span>';
  }
  function planBadge(status) {
    var cls = status === 'approved' || status === 'dispatched' ? 'cm-badge-success' :
              status === 'pending_review' ? 'cm-badge-warning' :
              status === 'expired' ? 'cm-badge-muted' : 'cm-badge-info';
    return '<span class="cm-badge ' + cls + '">' + (PLAN_STATUS_LABEL[status] || status) + '</span>';
  }
  function taskBadge(status) {
    var cls = status === 'exception' ? 'cm-badge-danger' :
              status === 'executing' ? 'cm-badge-success' :
              status === 'completed' ? 'cm-badge-muted' : 'cm-badge-info';
    return '<span class="cm-badge ' + cls + '">' + (TASK_STATUS_LABEL[status] || status) + '</span>';
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
  function fmt(iso) {
    if (!iso) return '--';
    return String(iso).replace('T', ' ').slice(0, 19);
  }
  function nameOf(id) {
    if (!id) return '--';
    var e = CM.findEntity(id);
    return e ? (e.entity_type === 'person' ? CM.personDisplay(e) : e.name || id) : id;
  }
  // 约束违反数：violations 可能是数组（后端）或数字，统一取数量
  function violationCount(cs) {
    if (!cs) return 0;
    var v = cs.violations;
    if (v == null) return 0;
    if (Array.isArray(v)) return v.length;
    return Number(v) || 0;
  }

  // ===== 调度数据派生 helpers =====
  // 已进入任一正式 Assignment 或方案排程的任务 id 集合
  function assignedTaskIds() {
    var set = {};
    (CM.DATA.assignments || []).forEach(function (a) { if (a.task_id) set[a.task_id] = true; });
    (CM.DATA.plans || []).forEach(function (p) {
      (p.assignments || []).forEach(function (a) { if (a.task_id) set[a.task_id] = true; });
    });
    return set;
  }
  // 高优先级未派任务：待处理状态 + (priority 高 或 安全关键) + 未被任何方案/派工占用
  function highPriorityUnassigned() {
    var assigned = assignedTaskIds();
    var out = (CM.DATA.tasks || []).filter(function (t) {
      if (!t || UNASSIGNED_TASK_STATUS.indexOf(t.status) < 0) return false;
      if (assigned[t.task_id]) return false;
      return (t.priority != null && t.priority >= 2) || !!t.safety_critical;
    });
    out.sort(function (a, b) {
      var pa = a.priority != null ? a.priority : 0, pb = b.priority != null ? b.priority : 0;
      if (pa !== pb) return pb - pa;
      return String(a.due_at || '').localeCompare(String(b.due_at || ''));
    });
    return out;
  }
  function pendingPlans() {
    return (CM.DATA.plans || []).filter(function (p) {
      return p && ['pending_review', 'shadow', 'simulating'].indexOf(p.status) >= 0;
    });
  }
  function conflictPlans() {
    return (CM.DATA.plans || []).filter(function (p) {
      return p && p.status !== 'expired' && p.status !== 'archived' && violationCount(p.constraint_summary) > 0;
    });
  }
  function expiredPlans() {
    return (CM.DATA.plans || []).filter(function (p) { return p && p.status === 'expired'; });
  }
  function exceptionAssignments() {
    var taskStatus = {};
    (CM.DATA.tasks || []).forEach(function (t) { if (t) taskStatus[t.task_id] = t.status; });
    return (CM.DATA.assignments || []).filter(function (a) {
      return a && (a.status === 'exception' || taskStatus[a.task_id] === 'exception');
    });
  }

  CM.workbench = {
    render: function () {
      var container = document.getElementById('tab-workbench');
      if (!container) return;
      var html =
        this._sectionOverview() +
        this._sectionUnassigned() +
        this._sectionPendingPlans() +
        this._sectionProblemPlans() +
        this._sectionException() +
        this._sectionReplan() +
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

      // 调度 KPI：待确认 / 冲突 / 过期 / 高优未派 / 异常
      var pPending = pendingPlans().length;
      var pConflict = conflictPlans().length;
      var pExpired = expiredPlans().length;
      var nUnassigned = highPriorityUnassigned().length;
      var nException = exceptionAssignments().length;
      var prob = nUnassigned + nException + pConflict + pExpired;
      var probCls = prob > 0 ? 'cm-wb-kpi-danger' : 'cm-wb-kpi-good';

      function kpi(label, value, sub, cls) {
        return '<div class="cm-wb-kpi' + (cls ? ' ' + cls : '') + '">' +
          '<span class="cm-wb-kpi-label">' + CM.esc(label) + '</span>' +
          '<span class="cm-wb-kpi-value">' + CM.esc(value) + '</span>' +
          (sub ? '<span class="cm-wb-kpi-sub">' + CM.esc(sub) + '</span>' : '') +
          '</div>';
      }

      return '<div class="cm-wb-section">' +
          '<div class="cm-wb-title">班次概览' +
            '<span class="cm-wb-note">' + (CM.state.dataSource === 'backend' ? '调度数据来自 /api/tasks · /api/scheduling/plans · /api/assignments' : '离线样本：不含真实调度数据') + '</span>' +
          '</div>' +
          '<div class="cm-wb-grid">' +
            kpi('当前班次', shiftName(), dsLabel) +
            kpi('在线设备', onlineDev + ' / ' + devices.length) +
            kpi('在岗人员', activePersons.length + ' / ' + persons.length) +
            kpi('未结事件', String(openEvents.length),
                '严重 ' + crit + ' · 告警 ' + warn + ' · 提示 ' + info, evCls) +
            kpi('平均负荷', (avgLoad * 100).toFixed(0) + '%', '在岗人员负荷均值', loadCls) +
            kpi('待确认方案', String(pPending), 'pending_review / shadow') +
            kpi('冲突 / 过期', (pConflict + pExpired) + ' 项',
                '冲突 ' + pConflict + ' · 过期 ' + pExpired,
                (pConflict + pExpired) > 0 ? 'cm-wb-kpi-danger' : 'cm-wb-kpi-good') +
            kpi('高优未派', String(nUnassigned), 'priority≥2 或安全关键',
                nUnassigned > 0 ? 'cm-wb-kpi-warning' : 'cm-wb-kpi-good') +
            kpi('异常派工', String(nException), '需人工重排',
                nException > 0 ? 'cm-wb-kpi-danger' : 'cm-wb-kpi-good') +
            kpi('需处理项', String(prob), '未派+异常+冲突+过期', probCls) +
          '</div>' +
        '</div>';
    },

    // ===== Section B: 高优先级未派任务 =====
    _sectionUnassigned: function () {
      var list = highPriorityUnassigned();
      var html = '<div class="cm-wb-section">' +
        '<div class="cm-wb-title">高优先级未派任务' +
          '<span class="cm-wb-note">priority≥2 或安全关键 且未进入任何方案/派工，需发起调度或人工处理</span>' +
        '</div>';
      if (list.length === 0) {
        html += '<div class="cm-wb-empty">暂无高优先级未派任务。</div>';
      } else {
        html += '<div class="cm-wb-plans">';
        list.forEach(function (t) {
          var pri = t.priority != null ? t.priority : '--';
          var due = t.due_at ? fmtTime(t.due_at) : '--';
          var dur = t.estimated_duration_sec != null ? Math.round(t.estimated_duration_sec / 60) + ' 分' : '--';
          var skills = (t.required_skills || []).join('、') || '--';
          html += '<div class="cm-wb-plan-item">' +
            '<div class="cm-wb-plan-head">' +
              '<span class="cm-wb-plan-name">' + CM.esc(t.task_id) + '</span>' +
              taskBadge(t.status) +
              (t.safety_critical ? '<span class="cm-badge cm-badge-danger">安全关键</span>' : '') +
            '</div>' +
            '<div class="cm-wb-plan-target">类型 ' + CM.esc(t.task_type || '--') +
              ' · 优先级 <b>P' + pri + '</b> · 工位 ' + CM.esc(nameOf(t.station_id)) + '</div>' +
            '<div class="cm-wb-plan-metrics">' +
              '<span>时限 <b>' + CM.esc(due) + '</b></span>' +
              '<span>时长 <b>' + CM.esc(dur) + '</b></span>' +
              '<span>技能 <b>' + CM.esc(skills) + '</b></span>' +
              '<span>负荷 <b>' + CM.esc(t.load_level != null ? t.load_level.toFixed(2) : '--') + '</b></span>' +
            '</div>' +
            '<div class="cm-wb-plan-actions">' +
              '<button class="cm-btn" data-goto="scenario">去调度方案</button>' +
            '</div>' +
          '</div>';
        });
        html += '</div>';
      }
      html += '</div>';
      return html;
    },

    // ===== Section C: 待确认方案 =====
    _sectionPendingPlans: function () {
      var plans = pendingPlans();
      var html = '<div class="cm-wb-section">' +
        '<div class="cm-wb-title">待确认调度方案' +
          '<span class="cm-wb-note">影子/仿真/待审批方案，需班组长人工确认（确认需 actor + reason）</span>' +
        '</div>';
      if (plans.length === 0) {
        html += '<div class="cm-wb-empty">暂无待确认方案。</div>';
      } else {
        html += '<div class="cm-wb-plans">';
        plans.forEach(function (p) {
          var cs = p.constraint_summary || {};
          var ob = p.objective_breakdown || {};
          var assigns = (p.assignments || []).length;
          html += '<div class="cm-wb-plan-item">' +
            '<div class="cm-wb-plan-head">' +
              '<span class="cm-wb-plan-name">' + CM.esc(p.plan_id) + '</span>' +
              planBadge(p.status) +
            '</div>' +
            '<div class="cm-wb-plan-target">目标分 <b>' + CM.esc(p.objective_score != null ? Number(p.objective_score).toFixed(2) : '--') +
              '</b> · 版本 v' + CM.esc(p.version != null ? p.version : '--') +
              ' · 世界状态 ' + CM.esc(p.world_state_version || '--') + '</div>' +
            '<div class="cm-wb-plan-metrics">' +
              '<span>排程 <b>' + assigns + ' 项</b></span>' +
              '<span>任务/已派 <b>' + CM.esc(cs.total_tasks != null ? cs.total_tasks : '--') + '/' + CM.esc(cs.assigned != null ? cs.assigned : '--') + '</b></span>' +
              '<span>违反 <b>' + CM.esc(violationCount(cs)) + '</b></span>' +
              '<span>准时 <b>' + CM.esc(ob.on_time_score != null ? Number(ob.on_time_score).toFixed(2) : '--') + '</b></span>' +
            '</div>' +
            '<div class="cm-wb-plan-target">有效期 ' + CM.esc(fmt(p.valid_until)) + '</div>' +
            '<div class="cm-wb-plan-actions">' +
              '<button class="cm-btn cm-btn-primary" data-act="goto-scenario">审批</button>' +
            '</div>' +
          '</div>';
        });
        html += '</div>';
      }
      html += '</div>';
      return html;
    },

    // ===== Section D: 冲突 / 过期方案 =====
    _sectionProblemPlans: function () {
      var conflict = conflictPlans();
      var expired = expiredPlans();
      var html = '<div class="cm-wb-section">' +
        '<div class="cm-wb-title">冲突 / 过期方案' +
          '<span class="cm-wb-note">约束违反>0 或已过期，需 replan 或人工处理</span>' +
        '</div>';
      var items = [];
      conflict.forEach(function (p) {
        var cs = p.constraint_summary || {};
        items.push({ key: p.plan_id, badge: planBadge('pending_review'), label: '冲突',
          line: '违反 ' + violationCount(cs) + ' 项 · 排程 ' + (p.assignments || []).length + ' 项' });
      });
      expired.forEach(function (p) {
        items.push({ key: p.plan_id, badge: planBadge('expired'), label: '过期',
          line: '已过期 · 世界状态 ' + CM.esc(p.world_state_version || '--') });
      });
      if (items.length === 0) {
        html += '<div class="cm-wb-empty">暂无冲突或过期方案。</div>';
      } else {
        html += '<div class="cm-wb-events">';
        items.forEach(function (it) {
          html += '<div class="cm-wb-event-item">' +
            '<div class="cm-wb-event-main">' +
              '<div class="cm-wb-event-row">' +
                '<span class="cm-wb-event-title cm-mono">' + CM.esc(it.key) + '</span>' +
                it.badge +
                '<span class="cm-badge cm-badge-warning">' + CM.esc(it.label) + '</span>' +
              '</div>' +
              '<div class="cm-wb-event-meta"><span>' + it.line + '</span></div>' +
            '</div>' +
            '<div class="cm-wb-event-actions">' +
              '<button class="cm-btn" data-act="goto-scenario">处理</button>' +
            '</div>' +
          '</div>';
        });
        html += '</div>';
      }
      html += '</div>';
      return html;
    },

    // ===== Section E: 异常派工 =====
    _sectionException: function () {
      var list = exceptionAssignments();
      var html = '<div class="cm-wb-section">' +
        '<div class="cm-wb-title">异常派工' +
          '<span class="cm-wb-note">Assignment 或关联任务异常，需人工介入</span>' +
        '</div>';
      if (list.length === 0) {
        html += '<div class="cm-wb-empty">暂无异常派工。</div>';
      } else {
        html += '<div class="cm-wb-events">';
        list.forEach(function (a) {
          html += '<div class="cm-wb-event-item cm-wb-sev-critical">' +
            '<div class="cm-wb-event-main">' +
              '<div class="cm-wb-event-row">' +
                '<span class="cm-wb-event-title cm-mono">' + CM.esc(a.assignment_id) + '</span>' +
                taskBadge(a.status) +
              '</div>' +
              '<div class="cm-wb-event-meta">' +
                '<span>任务 ' + CM.esc(nameOf(a.task_id)) + '</span>' +
                '<span>人 ' + CM.esc(nameOf(a.person_id)) + '</span>' +
                '<span>设备 ' + CM.esc(nameOf(a.device_id)) + '</span>' +
                '<span>方案 ' + CM.esc(a.plan_id || '--') + '</span>' +
              '</div>' +
            '</div>' +
            '<div class="cm-wb-event-actions">' +
              '<button class="cm-btn" data-act="goto-scenario">处理</button>' +
            '</div>' +
          '</div>';
        });
        html += '</div>';
      }
      html += '</div>';
      return html;
    },

    // ===== Section F: 需人工重排汇总 =====
    _sectionReplan: function () {
      var nUnassigned = highPriorityUnassigned().length;
      var nException = exceptionAssignments().length;
      var nConflict = conflictPlans().length;
      var nExpired = expiredPlans().length;
      var total = nUnassigned + nException + nConflict + nExpired;
      var html = '<div class="cm-wb-section">' +
        '<div class="cm-wb-title">需人工重排 / 处理' +
          '<span class="cm-wb-note">汇总需人工介入的调度项，平台不自动执行</span>' +
        '</div>';
      if (total === 0) {
        html += '<div class="cm-wb-empty">当前调度状态良好，无需人工重排。</div>';
      } else {
        html += '<div class="cm-wb-replan">' +
          '<div class="cm-wb-replan-line">高优先级未派任务 <b>' + nUnassigned + '</b> 项</div>' +
          '<div class="cm-wb-replan-line">异常派工 <b>' + nException + '</b> 项</div>' +
          '<div class="cm-wb-replan-line">冲突方案 <b>' + nConflict + '</b> 项</div>' +
          '<div class="cm-wb-replan-line">过期方案 <b>' + nExpired + '</b> 项</div>' +
          '</div>' +
          '<div class="cm-wb-plan-actions">' +
            '<button class="cm-btn cm-btn-primary" data-act="goto-scenario">前往调度方案处理</button>' +
          '</div>';
      }
      html += '</div>';
      return html;
    },

    // ===== Section G: 需关注事件 =====
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
          html += '<div class="cm-wb-event-item cm-wb-sev-' + (ev.severity || 'info') + '">' +
            '<div class="cm-wb-event-main">' +
              '<div class="cm-wb-event-row">' +
                sevBadge(ev.severity) +
                '<span class="cm-wb-event-title">' + CM.esc(ev.title || ev.code || ev.event_id) + '</span>' +
                '<span class="cm-wb-event-status">' + CM.esc(CM.statusText(ev.status)) + '</span>' +
              '</div>' +
              '<div class="cm-wb-event-meta">' +
                '<span>人员 ' + CM.esc(CM.personDisplay(CM.findEntity(ev.person_id))) + '</span>' +
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

    // ===== Section H: 快速操作 =====
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