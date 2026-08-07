/* scheduling/scheduling-enhance.js — Command Map 调度增强（Phase 3.3.4/3.3.5/3.3.6）。
   在调度方案 tab 内追加：
   - Plan Diff（当前 vs 候选）：任务维度的人/工位/步行距离/延误变化
   - Explain Panel（可解释）：消费 Assignment.decisionTrace，展示选中理由与未选候选排除原因
   - Manual Override：Lock / Exclude / Change resource / Change time / Replan
     调用后端 Constraint/Override API；后端约束端点不可用时明确标记 FALLBACK 并展示预期请求。
   不重写既有 mapa/scenario 渲染，仅追加增强区块。 */
(function () {
  'use strict';
  var CM = window.CM;

  function esc(s) { return CM.esc(s); }
  function fmt(iso) { return iso ? String(iso).replace('T', ' ').slice(0, 19) : '--'; }
  function fmtEta(sec) {
    sec = Math.round(Number(sec) || 0);
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + String(s).padStart(2, '0');
  }
  function dist(a) {
    var d = a.route_distance_m;
    if (d == null && a.route) d = a.route.distance_m;
    return (d == null) ? null : Number(d);
  }
  function late(a) {
    if (a && a.lateness_min != null) return Number(a.lateness_min);
    if (a && a.late_min != null) return Number(a.late_min);
    return null;
  }

  // 当前已派工 Assignment 按 task 索引
  function currentByTask() {
    var map = {};
    (CM.DATA.assignments || []).forEach(function (a) { if (a && a.task_id) map[a.task_id] = a; });
    return map;
  }

  // ---- Plan Diff：每条候选 Assignment 与当前派工对比 ----
  function planDiffRows(plan) {
    var cur = currentByTask();
    return (plan.assignments || []).map(function (a) {
      var t = CM.DATA.tasks && CM.DATA.tasks.find(function (x) { return x && x.task_id === a.task_id; });
      var c = cur[a.task_id] || null;
      var person = c ? (c.person_id + '→' + a.person_id) : ('—→' + a.person_id);
      var station = [c && c.station_id, a.station_id].filter(Boolean).join('→');
      var dWalk = (dist(a) != null && dist(c) != null) ? (dist(a) - dist(c)) : null;
      var dLate = (late(a) != null && late(c) != null) ? (late(a) - late(c)) : null;
      var parts = [];
      if (station) parts.push('工位 ' + station);
      if (dWalk != null) parts.push('步行 ' + (dWalk >= 0 ? '+' : '') + Math.round(dWalk) + 'm');
      if (dLate != null) parts.push('延误 ' + (dLate >= 0 ? '+' : '') + Math.round(dLate) + 'min');
      return {
        task: a.task_id,
        priority: t ? t.priority : null,
        person: person,
        detail: parts.join(' · ') || '无变化'
      };
    });
  }

  // ---- Explain：消费 decisionTrace / reasons / rejectedAlternatives ----
  function explainHtml(a) {
    var dt = a.decisionTrace || {};
    var rows = [];
    rows.push(['任务', a.task_id || '--']);
    rows.push(['选中人员', a.person_id || '--']);
    rows.push(['选中设备', a.device_id || '--']);
    rows.push(['工位', a.station_id || '--']);
    rows.push(['ETA', fmtEta(a.eta_sec || (a.route && a.route.eta_sec))]);
    if (a.workload != null) rows.push(['人员负荷', Number(a.workload).toFixed(2)]);
    if (a.battery != null) rows.push(['设备电量', a.battery + '%']);
    if (a.score != null) rows.push(['方案分', Number(a.score).toFixed(2)]);

    var reasons = (a.reasons && a.reasons.length) ? a.reasons :
                  (dt.selectedReason && dt.selectedReason.length) ? dt.selectedReason : [];
    var html = '<div class="sce-explain">' +
      '<div class="sce-explain-title">可解释（DecisionTrace）</div>' +
      '<table class="cm-sc-table"><tbody>' +
      rows.map(function (r) { return '<tr><td class="sce-k">' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td></tr>'; }).join('') +
      '</tbody></table>';
    if (reasons.length) {
      html += '<div class="sce-sec-head">选中理由</div><ul class="sce-ul">' +
        reasons.map(function (r) { return '<li>' + esc(typeof r === 'string' ? r : JSON.stringify(r)) + '</li>'; }).join('') + '</ul>';
    }
    // 未选候选与排除原因
    var alts = a.alternatives || dt.rejectedAlternatives || [];
    if (alts.length) {
      html += '<div class="sce-sec-head">未选候选与排除原因</div><ul class="sce-ul">' +
        alts.map(function (alt) {
          var who = [alt.person_id, alt.device_id].filter(Boolean).join('/') || '候选';
          var why = Array.isArray(alt.reason) ? alt.reason.join('；') : (alt.reason || '--');
          return '<li><b>' + esc(who) + '</b>：' + esc(why) + '</li>';
        }).join('') + '</ul>';
    } else {
      html += '<div class="sce-noreason">无被排除候选（该排程无替代竞争）。</div>';
    }
    html += '<div class="sce-meta">' +
      (dt.solverVersion ? 'solver ' + esc(dt.solverVersion) : '') +
      (dt.policyVersion ? ' · policy v' + esc(dt.policyVersion) : '') +
      (dt.snapshotVersion ? ' · snapshot ' + esc(dt.snapshotVersion) : '') + '</div>';
    html += '</div>';
    return html;
  }

  // ---- Manual Override：走后端 Constraint/Override API ----
  function overrideControls(a, planId) {
    return '<div class="sce-ov-actions" data-task="' + esc(a.task_id) + '" data-plan="' + esc(planId || '') + '">' +
      '<button class="cm-btn cm-btn-xs" data-ov="lock">锁定</button>' +
      '<button class="cm-btn cm-btn-xs" data-ov="exclude">排除</button>' +
      '<button class="cm-btn cm-btn-xs" data-ov="change-resource">改派资源</button>' +
      '<button class="cm-btn cm-btn-xs" data-ov="change-time">改时间</button>' +
      '<button class="cm-btn cm-btn-xs" data-ov="replan">重排</button>' +
      '<span class="sce-ov-note">约束/覆盖走后端 API</span>' +
      '</div>';
  }

  // 统一约束提交：优先后端 /api/scheduler/constraints；不可用则明确标记 FALLBACK 并展示预期请求
  function submitConstraint(payload, label) {
    if (CM.state.dataSource !== 'backend') {
      alert('离线样本模式：不调用约束 API。预期请求：POST /api/scheduler/constraints ' + esc(JSON.stringify(payload)));
      return Promise.resolve();
    }
    return CM.api.applyConstraint(payload).then(function (resp) {
      alert('约束已提交（' + label + '）：' + esc(JSON.stringify((resp && resp.result) || resp)));
      if (CM.scenarioPanel) CM.scenarioPanel._reload();
    }).catch(function (err) {
      // 后端约束端点可能尚未提供 → FALLBACK：明确标记，不静默吞掉意图
      alert('[FALLBACK] 后端约束端点不可用（' + (err.message || '') + '）。\n' +
        '预期请求：POST /api/scheduler/constraints\n' + esc(JSON.stringify(payload)));
    });
  }

  CM.schedulingEnhance = {
    _explainOpen: {},
    render: function () {
      var host = document.getElementById('tab-scenario');
      if (!host) return;
      var existing = document.getElementById('schedule-enhance');
      if (existing) existing.parentNode.removeChild(existing);

      var plans = CM.DATA.plans || [];
      if (!plans.length) return;

      var self = this;
      var sec = document.createElement('div');
      sec.id = 'schedule-enhance';
      sec.className = 'sce-wrap';

      // ---- Plan Diff ----
      var diffHtml = '<div class="sce-section"><div class="sce-sec-title">Plan Diff（当前 vs 候选）</div>';
      plans.forEach(function (p) {
        var rows = planDiffRows(p);
        if (!rows.length) return;
        diffHtml += '<div class="sce-plan"><div class="sce-plan-head">' +
          '<span class="cm-sc-card-name">' + esc(p.plan_id) + '</span>' +
          '<span class="cm-badge cm-badge-info">' + esc(p.status || '') + '</span></div>' +
          '<table class="cm-sc-table"><thead><tr><th>任务</th><th>优先级</th><th>人员变化</th><th>差异</th><th>操作</th></tr></thead><tbody>';
        rows.forEach(function (r) {
          diffHtml += '<tr><td class="cm-mono">' + esc(r.task) + '</td>' +
            '<td>' + esc(r.priority || '--') + '</td>' +
            '<td>' + esc(r.person) + '</td>' +
            '<td>' + esc(r.detail) + '</td>' +
            '<td>' + overrideControlsById(r.task) + '</td></tr>';
        });
        diffHtml += '</tbody></table></div>';
      });
      diffHtml += '</div>';

      // ---- Explain（按 assignment）----
      var explainHtmlAll = '<div class="sce-section"><div class="sce-sec-title">Explain Panel（指派原因）</div>';
      var any = false;
      plans.forEach(function (p) {
        (p.assignments || []).forEach(function (a) {
          a._planId = a._planId || p.plan_id;
        });
      });
      var allAssign = [];
      plans.forEach(function (p) {
        (p.assignments || []).forEach(function (a) { allAssign.push(a); });
      });
      allAssign.forEach(function (a) {
        var key = a.task_id;
        var open = self._explainOpen[key];
        any = true;
        explainHtmlAll += '<div class="sce-explain-item">' +
          '<button class="sce-explain-toggle" data-explain="' + esc(key) + '">' +
          (open ? '▾' : '▸') + ' ' + esc(a.task_id) + ' → ' + esc(a.person_id || '--') + '</button>' +
          (open ? explainHtml(a) : '') +
          '</div>';
      });
      if (!any) explainHtmlAll += '<div class="cm-ev-empty">当前方案无排程可解释。</div>';
      explainHtmlAll += '</div>';

      sec.innerHTML = diffHtml + explainHtmlAll;
      host.appendChild(sec);
      this._bind(sec);
    },

    _bind: function (sec) {
      var self = this;
      sec.querySelectorAll('[data-explain]').forEach(function (b) {
        b.addEventListener('click', function () {
          var key = b.dataset.explain;
          self._explainOpen[key] = !self._explainOpen[key];
          self.render();
        });
      });
      sec.querySelectorAll('[data-ov]').forEach(function (b) {
        b.addEventListener('click', function () {
          var row = b.closest('tr') || b.closest('.sce-ov-actions');
          var taskId = b.getAttribute('data-task') || (row && row.getAttribute('data-task'));
          var planId = (row && row.getAttribute('data-plan')) || '';
          var act = b.dataset.ov;
          self._onOverride(act, taskId, planId);
        });
      });
    },

    _onOverride: function (act, taskId, planId) {
      var plan = null;
      (CM.DATA.plans || []).forEach(function (p) {
        if (p && p.plan_id === planId) plan = p;
      });
      var assign = null;
      if (plan) assign = (plan.assignments || []).find(function (a) { return a.task_id === taskId; });
      var actor = prompt('操作人（班组长）：');
      if (!actor) return;
      var reason = prompt('理由：') || '人工覆盖';
      if (act === 'lock') {
        var lockRes = prompt('锁定资源（person/device id，留空=锁定当前人员）：', assign ? assign.person_id : '');
        submitConstraint({ type: 'lock', task_id: taskId, resource_id: lockRes || null, actor_id: actor, reason: reason }, '锁定');
      } else if (act === 'exclude') {
        var exRes = prompt('排除资源（person/device id）：');
        submitConstraint({ type: 'exclude', task_id: taskId, resource_id: exRes || null, actor_id: actor, reason: reason }, '排除');
      } else if (act === 'change-resource') {
        var newPerson = prompt('改派人员 person_id：', assign ? assign.person_id : '');
        var newDevice = prompt('改派设备 device_id：', (assign && assign.device_id) || '');
        this._overrideAssignment(taskId, newPerson, newDevice, actor, reason);
      } else if (act === 'change-time') {
        var start = prompt('新计划开始（ISO 或空）：');
        var end = prompt('新计划结束（ISO 或空）：');
        submitConstraint({ type: 'change_time', task_id: taskId, planned_start: start, planned_end: end, actor_id: actor, reason: reason }, '改时间');
      } else if (act === 'replan') {
        if (CM.state.dataSource !== 'backend') { alert('离线样本模式：不调用 replan。'); return; }
        CM.api.replanPlan(planId, actor, reason).then(function () {
          alert('已触发重排。');
          if (CM.scenarioPanel) CM.scenarioPanel._reload();
        }).catch(function (err) { alert('重排失败：' + (err.message || '')); });
      }
    },

    // 改派资源 → 走后端 override 端点（作用于正式派工记录）
    _overrideAssignment: function (taskId, newPerson, newDevice, actor, reason) {
      if (CM.state.dataSource !== 'backend') { alert('离线样本模式：不调用 override。'); return; }
      var asn = null;
      (CM.DATA.assignments || []).forEach(function (a) { if (a && a.task_id === taskId) asn = a; });
      if (!asn) { alert('该排程尚未派工，无法覆盖。请先确认方案生成派工记录。'); return; }
      CM.api.updateAssignmentStatus(asn.assignment_id, 'override', {
        actor_id: actor, reason: reason, status: 'executing',
        person_id: newPerson, device_id: newDevice
      }).then(function () {
        alert('覆盖完成（将触发约束重求解）。');
        if (CM.scenarioPanel) CM.scenarioPanel._reload();
      }).catch(function (err) { alert('覆盖失败：' + (err.message || '')); });
    }
  };

  // 供 Plan Diff 行内调用（保持 overrideControls 语义）
  function overrideControlsById(taskId) {
    return '<div class="sce-ov-actions" data-task="' + esc(taskId) + '">' +
      '<button class="cm-btn cm-btn-xs" data-ov="lock">锁定</button>' +
      '<button class="cm-btn cm-btn-xs" data-ov="exclude">排除</button>' +
      '<button class="cm-btn cm-btn-xs" data-ov="change-resource">改派</button>' +
      '<button class="cm-btn cm-btn-xs" data-ov="change-time">改时间</button>' +
      '<button class="cm-btn cm-btn-xs" data-ov="replan">重排</button>' +
      '</div>';
  }
})();