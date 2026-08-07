/* scenario-panel/scenario-panel.js — 真实 SchedulePlan 审批（Phase 7.2）。
   - 展示后端 /api/scheduling/plans 返回的真实方案：状态/版本/world_state_version/有效期/objective
   - 完整排程明细：task/person/device/station/planned start-end/route distance/ETA/score/explanation
   - 方案分项对比（objective_breakdown + constraint_summary）
   - 人工操作：Confirm / Reject / Replan / Override / Pin(Freeze)
   - 语义修复：确认调用 confirmPlan(planId, actor, reason, world_state_version)，绝不再把 planId 当 taskId 调 confirmTask
   - 派工记录：/api/assignments 正式 Assignment + start/pause/complete/cancel 操作
   - 人在回路：确认必填 actor + reason，平台不自动执行 */
(function () {
  'use strict';
  var CM = window.CM;

  // 预设备选理由（spec：高风险建议必须附带理由；权重/阈值调整需记录原因）
  var REASON_PRESETS = [
    '产能压力：当前订单准交率低于目标，需缓解积压',
    '负荷均衡：存在高负荷人员，需分散作业避免疲劳风险',
    '设备应急：低电量/故障设备需换岗或充电',
    '技能匹配：受影响人员具备所需技能且授权有效',
    '现场观察：班组长现场确认人员状态可执行',
    '其他（请补充说明）'
  ];

  var PLAN_STATUS_LABEL = {
    shadow: '影子', simulating: '仿真', pending_review: '待审批', approved: '已批准',
    dispatched: '已派工', expired: '已过期', archived: '已归档'
  };

  function planStatusBadge(status) {
    var cls = status === 'approved' || status === 'dispatched' ? 'cm-badge-success' :
              status === 'pending_review' ? 'cm-badge-warning' :
              status === 'expired' ? 'cm-badge-muted' : 'cm-badge-info';
    return '<span class="cm-badge ' + cls + '">' + (PLAN_STATUS_LABEL[status] || status) + '</span>';
  }
  function fmt(iso) {
    if (!iso) return '--';
    return String(iso).replace('T', ' ').slice(0, 19);
  }
  function fmtEta(sec) {
    sec = Math.round(Number(sec) || 0);
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + String(s).padStart(2, '0');
  }
  // 约束违反数：violations 可能是数组（后端）或数字，统一取数量
  function violationCount(cs) {
    if (!cs) return 0;
    var v = cs.violations;
    if (v == null) return 0;
    if (Array.isArray(v)) return v.length;
    return Number(v) || 0;
  }

  CM.scenarioPanel = {
    _confirmingPlan: null,
    _rejectingPlan: null,
    _overridingTask: null,
    _auditItems: null,
    _loadingAudit: false,
    // 前端冻结标记：assignment_key(task_id 或 person_id) -> true（用于 replan 提示）
    _frozen: {},

    render: function () {
      var host = document.getElementById('tab-scenario');
      if (!host) return;
      var plans = CM.DATA.plans || [];
      var planCards = plans.length
        ? plans.map(this._planCard, this).join('')
        : '<div class="cm-ev-empty">暂无调度方案。可在班组长工作台或通过 /api/scheduling/requests 生成方案。</div>';
      host.innerHTML =
        '<div class="cm-sc-wrap">' +
          '<div class="cm-sc-header">' +
            '<h3>调度方案审批（真实 SchedulePlan）</h3>' +
            '<span class="cm-sc-note">确认需班组长 actor_id + 理由，平台不自动执行。方案来自 /api/scheduling/plans。</span>' +
          '</div>' +
          '<div class="cm-sc-plans">' + planCards + '</div>' +
          (plans.length ? '<div class="cm-sc-compare"><h4>方案分项指标对比</h4>' + this._compareTable(plans) + '</div>' : '') +
          this._assignmentsSection() +
          this._auditSection() +
          '<div class="cm-sc-actions">' +
            '<button class="cm-btn" id="sc-refresh">刷新方案</button>' +
            '<button class="cm-btn" id="sc-refresh-audit">刷新审计</button>' +
            '<button class="cm-btn" id="sc-reset">重置派工（清空会话级确认）</button>' +
            '<span class="cm-sc-meta">确认审计需填写理由形成审计记录，未确认不得自动执行；未经授权自动调度为 0。</span>' +
          '</div>' +
        '</div>';
      this._bind(host);
      if (CM.state.dataSource === 'backend' && !this._auditItems && !this._loadingAudit) {
        this._loadAudit();
      }
    },

    _planCard: function (p) {
      var confirmHtml = this._confirmingPlan === p.plan_id ? this._confirmForm(p) : '';
      var rejectHtml = this._rejectingPlan === p.plan_id ? this._rejectForm(p) : '';
      var ob = p.objective_breakdown || {};
      var cs = p.constraint_summary || {};
      var meta = [
        ['版本', 'v' + (p.version != null ? p.version : '--')],
        ['世界状态', p.world_state_version || '--'],
        ['有效期', fmt(p.valid_until)],
        ['目标分', p.objective_score != null ? Number(p.objective_score).toFixed(2) : '--'],
        ['任务/已派', ((cs.total_tasks != null ? cs.total_tasks : '--') + ' / ' + (cs.assigned != null ? cs.assigned : '--'))],
        ['违反数', violationCount(cs)]
      ].map(function (r) { return this._metricRow(r[0], r[1], 'neutral'); }, this).join('');
      var assignBlocks = (p.assignments || []).map(this._assignmentBlock, this).join('') ||
        '<div class="cm-ev-empty">本方案无排程。</div>';
      return '<div class="cm-sc-card">' +
        '<div class="cm-sc-card-head">' +
          '<span class="cm-sc-card-name">' + CM.esc(p.plan_id) + '</span>' +
          planStatusBadge(p.status) +
        '</div>' +
        '<div class="cm-sc-card-goal">请求 ' + CM.esc(p.request_id || '--') + '</div>' +
        '<div class="cm-sc-card-metrics">' + meta + '</div>' +
        '<div class="cm-sc-card-reason">约束摘要：' + CM.esc(JSON.stringify(cs)) + '</div>' +
        '<div class="cm-sc-assign-head">排程明细（' + (p.assignments || []).length + '）</div>' +
        assignBlocks +
        '<div class="cm-sc-card-actions">' + this._actionButtons(p) + '</div>' +
        confirmHtml + rejectHtml +
      '</div>';
    },

    _actionButtons: function (p) {
      var canConfirm = p.status === 'pending_review' || p.status === 'shadow' || p.status === 'simulating';
      var b = '';
      if (canConfirm) b += '<button class="cm-btn cm-btn-primary" data-act="confirm" data-plan="' + p.plan_id + '">确认</button>';
      b += '<button class="cm-btn" data-act="reject" data-plan="' + p.plan_id + '">驳回</button>';
      b += '<button class="cm-btn" data-act="replan" data-plan="' + p.plan_id + '">重排</button>';
      return b;
    },

    // 确认表单：必填 actor_id（班组长）+ 理由（预设 + 自由文本）
    _confirmForm: function (p) {
      var reasonOpts = REASON_PRESETS.map(function (r) { return '<option value="' + CM.esc(r) + '">' + CM.esc(r) + '</option>'; }).join('');
      return '<div class="cm-sc-confirm-form">' +
        '<div class="cm-sc-confirm-title">人工确认方案（人在回路，必填 actor + reason）</div>' +
        '<div class="cm-sc-field"><label>确认人（班组长）</label>' +
          '<input type="text" id="sc-cf-actor" class="cm-ev-input" placeholder="必填：班组长工号或姓名">' +
        '</div>' +
        '<div class="cm-sc-field"><label>理由（必填）</label>' +
          '<select id="sc-cf-reason-sel" class="cm-ev-select">' + reasonOpts + '</select>' +
          '<textarea id="sc-cf-reason" class="cm-ev-textarea" placeholder="补充说明"></textarea>' +
        '</div>' +
        '<div class="cm-sc-confirm-actions">' +
          '<button class="cm-btn cm-btn-primary" data-act="submit-confirm" data-plan="' + p.plan_id + '">提交确认</button>' +
          '<button class="cm-btn" data-act="cancel-confirm">取消</button>' +
        '</div>' +
        '<div class="cm-sc-warn">提交调用 confirmPlan(planId, actor, reason, world_state_version)，后端校验方案与版本一致性。</div>' +
      '</div>';
    },

    _rejectForm: function (p) {
      return '<div class="cm-sc-confirm-form">' +
        '<div class="cm-sc-confirm-title">驳回方案</div>' +
        '<div class="cm-sc-field"><label>操作人</label>' +
          '<input type="text" id="sc-rj-actor" class="cm-ev-input" placeholder="必填：班组长工号或姓名">' +
        '</div>' +
        '<div class="cm-sc-field"><label>理由</label>' +
          '<textarea id="sc-rj-reason" class="cm-ev-textarea" placeholder="驳回原因"></textarea>' +
        '</div>' +
        '<div class="cm-sc-confirm-actions">' +
          '<button class="cm-btn cm-btn-primary" data-act="submit-reject" data-plan="' + p.plan_id + '">提交驳回</button>' +
          '<button class="cm-btn" data-act="cancel-reject">取消</button>' +
        '</div>' +
      '</div>';
    },

    // 单条排程明细 + 冻结/覆盖
    _assignmentBlock: function (a) {
      var route = a.route || {};
      var dist = a.route_distance_m != null ? a.route_distance_m : (route.distance_m != null ? route.distance_m : '--');
      var eta = a.eta_sec != null ? fmtEta(a.eta_sec) : (route.eta_sec != null ? fmtEta(route.eta_sec) : '--');
      var frozen = this._frozen[a.task_id] || this._frozen[a.person_id];
      var exp = a.explanation
        ? '<details class="cm-sc-exp"><summary>解释</summary><pre>' + CM.esc(JSON.stringify(a.explanation, null, 2)) + '</pre></details>' : '';
      var hc = (a.hard_constraint_results || []).length;
      var overrideHtml = this._overridingTask === a.task_id ? this._overrideForm(a) : '';
      return '<div class="cm-sc-assign' + (frozen ? ' cm-sc-frozen' : '') + '">' +
        '<div class="cm-sc-assign-row">' +
          '<span class="cm-mono">' + CM.esc(a.task_id || '--') + '</span>' +
          '<span>人 ' + CM.esc(a.person_id || '--') + '</span>' +
          '<span>设 ' + CM.esc(a.device_id || '--') + '</span>' +
          '<span>工位 ' + CM.esc(a.station_id || '--') + '</span>' +
        '</div>' +
        '<div class="cm-sc-assign-row cm-sc-assign-sub">' +
          '<span>开始 ' + fmt(a.planned_start) + '</span>' +
          '<span>结束 ' + fmt(a.planned_end) + '</span>' +
          '<span>距离 ' + dist + 'm</span>' +
          '<span>ETA ' + eta + '</span>' +
          '<span>分 ' + (a.score != null ? Number(a.score).toFixed(2) : '--') + '</span>' +
          (hc ? '<span>硬约束 ' + hc + '</span>' : '') +
        '</div>' +
        exp +
        '<div class="cm-sc-assign-actions">' +
          '<button class="cm-btn" data-act="pin" data-task="' + a.task_id + '" data-person="' + a.person_id + '">' + (frozen ? '解除冻结' : '冻结') + '</button>' +
          '<button class="cm-btn" data-act="override" data-task="' + a.task_id + '">覆盖</button>' +
        '</div>' +
        overrideHtml +
      '</div>';
    },

    _overrideForm: function (a) {
      return '<div class="cm-sc-confirm-form">' +
        '<div class="cm-sc-confirm-title">覆盖派工（将触发约束重求解）</div>' +
        '<div class="cm-sc-field"><label>覆盖人员 person_id</label>' +
          '<input type="text" id="sc-ov-person" class="cm-ev-input" value="' + CM.esc(a.person_id || '') + '">' +
        '</div>' +
        '<div class="cm-sc-field"><label>覆盖设备 device_id</label>' +
          '<input type="text" id="sc-ov-device" class="cm-ev-input" value="' + CM.esc(a.device_id || '') + '">' +
        '</div>' +
        '<div class="cm-sc-field"><label>操作人</label>' +
          '<input type="text" id="sc-ov-actor" class="cm-ev-input" placeholder="必填：班组长">' +
        '</div>' +
        '<div class="cm-sc-field"><label>理由</label>' +
          '<textarea id="sc-ov-reason" class="cm-ev-textarea"></textarea>' +
        '</div>' +
        '<div class="cm-sc-confirm-actions">' +
          '<button class="cm-btn cm-btn-primary" data-act="submit-override" data-task="' + a.task_id + '">提交覆盖</button>' +
          '<button class="cm-btn" data-act="cancel-override">取消</button>' +
        '</div>' +
        '<div class="cm-sc-warn">覆盖将触发约束重求解；后端 override 端点作用于正式派工记录。</div>' +
      '</div>';
    },

    _metricRow: function (label, value, kind) {
      var cls = kind === 'good' ? 'cm-sc-good' : kind === 'warn' ? 'cm-sc-warn' : '';
      return '<div class="cm-sc-metric ' + cls + '"><span>' + label + '</span><b>' + value + '</b></div>';
    },

    // 方案分项对比：objective_breakdown 各维度 + constraint_summary（未派/冲突）
    _compareTable: function (plans) {
      var dims = [
        ['准时率', 'on_time', 'on_time_score'],
        ['晚期', 'late', null],
        ['移动距离', 'travel', 'travel_distance'],
        ['高负荷暴露', 'high_load', 'body_load'],
        ['换岗成本', 'changeover', 'changeover_cost'],
        ['资源利用率', 'utilization', null],
        ['未派任务', 'unassigned', null],
        ['冲突', 'conflicts', null],
        ['计划稳定性', 'stability', null]
      ];
      var head = '<tr><th>分项指标</th>' + plans.map(function (p) {
        return '<th>' + CM.esc(p.plan_id) + '</th>';
      }).join('') + '</tr>';
      var body = dims.map(function (d) {
        var label = d[0], key = d[2];
        var cells = plans.map(function (p) {
          var ob = p.objective_breakdown || {};
          var v = key ? ob[key] : null;
          if (label === '未派任务') {
            var cs = p.constraint_summary || {};
            if (cs.total_tasks != null) v = (cs.total_tasks - (cs.assigned != null ? cs.assigned : 0));
          } else if (label === '冲突') {
            var cs2 = p.constraint_summary || {};
            v = violationCount(cs2);
          }
          var txt = (v == null) ? '--' : (typeof v === 'number' ? Number(v).toFixed(2) : String(v));
          return '<td>' + CM.esc(txt) + '</td>';
        }).join('');
        return '<tr><td class="cm-sc-rowlabel">' + label + '</td>' + cells + '</tr>';
      }).join('');
      return '<table class="cm-sc-table"><thead>' + head + '</thead><tbody>' + body + '</tbody></table>';
    },

    // 派工记录（正式 Assignment）+ 状态操作
    _assignmentsSection: function () {
      var items = CM.DATA.assignments || [];
      var html = '<div class="cm-sc-section"><div class="cm-sc-sec-title">派工记录（/api/assignments · 正式 Assignment）</div>';
      if (items.length) {
        html += '<table class="cm-sc-table"><thead><tr>' +
          '<th>派工ID</th><th>任务</th><th>方案</th><th>人员</th><th>设备</th><th>工位</th><th>状态</th><th>计划开始</th><th>计划结束</th><th>实际开始</th><th>操作</th>' +
          '</tr></thead><tbody>';
        items.forEach(function (a) {
          html += '<tr>' +
            '<td class="cm-mono">' + CM.esc(a.assignment_id || '--') + '</td>' +
            '<td class="cm-mono">' + CM.esc(a.task_id || '--') + '</td>' +
            '<td class="cm-mono">' + CM.esc(a.plan_id || '--') + '</td>' +
            '<td>' + CM.esc(a.person_id || '--') + '</td>' +
            '<td>' + CM.esc(a.device_id || '--') + '</td>' +
            '<td>' + CM.esc(a.station_id || '--') + '</td>' +
            '<td><span class="cm-badge cm-badge-info">' + CM.esc(a.status || '--') + '</span></td>' +
            '<td>' + fmt(a.planned_start) + '</td>' +
            '<td>' + fmt(a.planned_end) + '</td>' +
            '<td>' + fmt(a.actual_start) + '</td>' +
            '<td>' + this._assignmentOps(a) + '</td>' +
          '</tr>';
        }, this);
        html += '</tbody></table>';
      } else {
        html += '<div class="cm-ev-empty">尚无派工记录（确认方案后生成）。</div>';
      }
      html += '</div>';
      return html;
    },

    _assignmentOps: function (a) {
      var acts = ['start', 'pause', 'complete', 'cancel'];
      var b = '';
      acts.forEach(function (act) {
        b += '<button class="cm-btn cm-btn-xs" data-act="assign-op" data-assignment="' + a.assignment_id + '" data-op="' + act + '">' + act + '</button>';
      });
      return b;
    },

    // 审计链路
    _auditSection: function () {
      var html = '<div class="cm-sc-section"><div class="cm-sc-sec-title">审计链路（/api/audit · 调度确认与事件处置）</div>';
      if (this._loadingAudit) {
        html += '<div class="cm-ev-empty">审计记录加载中…</div>';
      } else if (this._auditItems && this._auditItems.length) {
        html += '<table class="cm-sc-table"><thead><tr>' +
          '<th>审计 ID</th><th>动作</th><th>操作人</th><th>目标</th><th>结果</th><th>时间</th>' +
          '</tr></thead><tbody>';
        this._auditItems.slice(0, 50).forEach(function (a) {
          html += '<tr>' +
            '<td class="cm-mono">' + CM.esc(a.audit_id || '--') + '</td>' +
            '<td>' + CM.esc(a.action || '--') + '</td>' +
            '<td>' + CM.esc(a.actor_id || '--') + '</td>' +
            '<td class="cm-mono">' + CM.esc((a.target_type || '') + '/' + (a.target_id || '')) + '</td>' +
            '<td><span class="cm-badge ' + (a.result === 'success' ? 'cm-badge-success' : 'cm-badge-danger') + '">' + CM.esc(a.result || '--') + '</span></td>' +
            '<td class="cm-mono">' + CM.esc((a.ts || '').replace('T', ' ')) + '</td>' +
          '</tr>';
        });
        html += '</tbody></table>';
      } else {
        html += '<div class="cm-ev-empty">无审计记录（backend 不可用或无操作）。</div>';
      }
      html += '</div>';
      return html;
    },

    _bind: function (host) {
      var self = this;
      host.querySelectorAll('[data-act]').forEach(function (b) {
        b.addEventListener('click', function () {
          var act = b.dataset.act;
          var planId = b.dataset.plan;
          var taskId = b.dataset.task;
          var assignmentId = b.dataset.assignment;
          var op = b.dataset.op;
          if (act === 'confirm') {
            self._confirmingPlan = (self._confirmingPlan === planId) ? null : planId;
            self._rejectingPlan = null; self.render();
          } else if (act === 'reject') {
            self._rejectingPlan = (self._rejectingPlan === planId) ? null : planId;
            self._confirmingPlan = null; self.render();
          } else if (act === 'replan') { self._replan(planId); }
          else if (act === 'submit-confirm') { self._submitConfirm(planId); }
          else if (act === 'cancel-confirm') { self._confirmingPlan = null; self.render(); }
          else if (act === 'submit-reject') { self._submitReject(planId); }
          else if (act === 'cancel-reject') { self._rejectingPlan = null; self.render(); }
          else if (act === 'pin') { self._togglePin(taskId, b.dataset.person); }
          else if (act === 'override') { self._overridingTask = (self._overridingTask === taskId) ? null : taskId; self.render(); }
          else if (act === 'submit-override') { self._submitOverride(taskId); }
          else if (act === 'cancel-override') { self._overridingTask = null; self.render(); }
          else if (act === 'assign-op') { self._updateAssignmentAction(assignmentId, op); }
        });
      });
      var refBtn = document.getElementById('sc-refresh');
      if (refBtn) refBtn.addEventListener('click', function () { self._reload(); });
      var refreshBtn = document.getElementById('sc-refresh-audit');
      if (refreshBtn) refreshBtn.addEventListener('click', function () { self._loadAudit(); });
      var resetBtn = document.getElementById('sc-reset');
      if (resetBtn) resetBtn.addEventListener('click', function () { self._resetAssignments(); });
      // 理由预设联动
      var reasonSel = document.getElementById('sc-cf-reason-sel');
      var reasonTa = document.getElementById('sc-cf-reason');
      if (reasonSel && reasonTa) {
        reasonSel.addEventListener('change', function () {
          if (reasonSel.value.indexOf('其他') < 0) reasonTa.value = reasonSel.value;
          else reasonTa.value = '';
        });
      }
    },

    _reload: function () {
      if (CM.state.dataSource !== 'backend') { this.render(); return; }
      CM.api.refreshScheduling().then(function () {
        CM.scenarioPanel.render();
      }).catch(function () { CM.scenarioPanel.render(); });
    },

    _submitConfirm: function (planId) {
      var plan = null;
      for (var i = 0; i < CM.DATA.plans.length; i++) {
        if (CM.DATA.plans[i] && CM.DATA.plans[i].plan_id === planId) { plan = CM.DATA.plans[i]; break; }
      }
      if (!plan) return;
      var actor = ((document.getElementById('sc-cf-actor') || {}).value || '').trim();
      var reasonPreset = (document.getElementById('sc-cf-reason-sel') || {}).value || '';
      var reasonFree = ((document.getElementById('sc-cf-reason') || {}).value || '').trim();
      if (!actor) { alert('请填写确认人（班组长），禁止自动派工'); return; }
      var reason = reasonFree || reasonPreset;
      if (!reason) { alert('请选择或填写理由（人在回路审计要求）'); return; }
      if (CM.state.dataSource !== 'backend') { alert('离线样本模式：不调用 confirmPlan。请启动 backend 后再确认。'); return; }
      var btn = document.querySelector('[data-act="submit-confirm"]');
      if (btn) btn.disabled = true;
      // 语义修复：确认调用 confirmPlan(planId, actor, reason, world_state_version)
      CM.api.confirmPlan(planId, actor, reason, plan.world_state_version).then(function (resp) {
        if (resp && resp.ok) {
          alert('方案已确认并派工。平台不自动执行设备控制；硬约束拦截的排程无法确认。');
          CM.scenarioPanel._confirmingPlan = null;
          CM.scenarioPanel._reload();
          CM.scenarioPanel._loadAudit();
        } else {
          alert('确认失败：' + ((resp && resp.error) ? resp.error : '未知错误（可能硬约束拦截）'));
          if (btn) btn.disabled = false;
        }
      }).catch(function (err) {
        // 409 冲突：把 error.code 展示给用户
        var code = '';
        if (err.body && err.body.error && err.body.error.code) code = err.body.error.code;
        var hint = '';
        if (code === 'PLAN_STALE') hint = '\n方案已过期，请重新生成或 replan。';
        else if (code === 'PLAN_EXPIRED') hint = '\n方案已过期，请重新生成或 replan。';
        else if (code === 'WORLD_STATE_CHANGED') hint = '\n世界状态已变化，当前方案不再适配，请 replan。';
        else if (code === 'RESOURCE_CONFLICT') hint = '\n资源冲突，请 replan 或人工覆盖。';
        else if (code === 'ILLEGAL_STATE') hint = '\n当前状态不允许确认。';
        alert('确认失败' + (code ? '（' + code + '）' : '') + '：' + (err.message || '') + hint);
        if (btn) btn.disabled = false;
      });
    },

    _submitReject: function (planId) {
      var actor = ((document.getElementById('sc-rj-actor') || {}).value || '').trim();
      var reason = ((document.getElementById('sc-rj-reason') || {}).value || '').trim();
      if (!actor) { alert('请填写操作人'); return; }
      if (CM.state.dataSource !== 'backend') { alert('离线样本模式：不调用 rejectPlan。'); return; }
      CM.api.rejectPlan(planId, actor, reason).then(function () {
        alert('方案已驳回。');
        CM.scenarioPanel._rejectingPlan = null;
        CM.scenarioPanel._reload();
      }).catch(function (err) { alert('驳回失败：' + (err.message || '')); });
    },

    _replan: function (planId) {
      if (CM.state.dataSource !== 'backend') { alert('离线样本模式：不调用 replanPlan。'); return; }
      var frozenCount = Object.keys(this._frozen).length;
      var frozenNote = frozenCount ? '（已冻结 ' + frozenCount + ' 项，重排时提示保留）' : '';
      var actor = prompt('操作人（班组长）：');
      if (!actor) return;
      var reason = prompt('重排理由：') || '人工重排';
      CM.api.replanPlan(planId, actor, reason).then(function () {
        alert('已触发重排' + frozenNote + '。');
        CM.scenarioPanel._reload();
      }).catch(function (err) { alert('重排失败：' + (err.message || '')); });
    },

    _togglePin: function (taskId, personId) {
      var key = taskId || personId;
      if (!key) return;
      this._frozen[key] = !this._frozen[key];
      this.render();
    },

    _submitOverride: function (taskId) {
      if (CM.state.dataSource !== 'backend') { alert('离线样本模式：不调用 override。'); return; }
      var personId = ((document.getElementById('sc-ov-person') || {}).value || '').trim();
      var deviceId = ((document.getElementById('sc-ov-device') || {}).value || '').trim();
      var actor = ((document.getElementById('sc-ov-actor') || {}).value || '').trim();
      var reason = ((document.getElementById('sc-ov-reason') || {}).value || '').trim();
      if (!actor) { alert('请填写操作人'); return; }
      // 找到该 task 对应的正式派工记录（override 作用于正式 Assignment）
      var asn = null;
      for (var i = 0; i < (CM.DATA.assignments || []).length; i++) {
        if (CM.DATA.assignments[i].task_id === taskId) { asn = CM.DATA.assignments[i]; break; }
      }
      if (!asn) { alert('该排程尚未派工，无法覆盖。请先确认方案生成派工记录。'); return; }
      CM.api.updateAssignmentStatus(asn.assignment_id, 'override', {
        actor_id: actor, reason: reason, status: 'executing',
        person_id: personId, device_id: deviceId
      }).then(function () {
        alert('覆盖完成（将触发约束重求解）。');
        CM.scenarioPanel._overridingTask = null;
        CM.scenarioPanel._reload();
      }).catch(function (err) { alert('覆盖失败：' + (err.message || '')); });
    },

    _updateAssignmentAction: function (assignmentId, op) {
      if (CM.state.dataSource !== 'backend') { alert('离线样本模式：不调用 /api/assignments。'); return; }
      var actor = prompt('操作人（班组长）：');
      if (!actor) return;
      var reason = prompt('理由：') || '';
      CM.api.updateAssignmentStatus(assignmentId, op, { actor_id: actor, reason: reason }).then(function () {
        alert('派工状态已更新：' + op);
        return CM.api.fetchAssignments().then(function (asn) {
          CM.DATA.assignments = asn;
          CM.scenarioPanel._reload();
        });
      }).catch(function (err) { alert('操作失败：' + (err.message || '')); });
    },

    _loadAudit: function () {
      if (CM.state.dataSource !== 'backend') { return; }
      this._loadingAudit = true;
      this.render();
      var self = this;
      CM.api.fetchAudit('', '', 100).then(function (resp) {
        self._auditItems = (resp && resp.items) || [];
        self._loadingAudit = false;
        self.render();
      }).catch(function () {
        self._loadingAudit = false;
        self._auditItems = [];
        self.render();
      });
    },

    _resetAssignments: function () {
      if (CM.state.dataSource !== 'backend') { alert('离线样本模式：不调用 /api/reset。'); return; }
      if (!confirm('确认清空会话级派工记录？真实数据不受影响。')) return;
      CM.api.reset().then(function () {
        CM.DATA.assignments = [];
        CM.scenarioPanel._reload();
      }).catch(function (err) { alert('重置失败：' + (err.message || '')); });
    }
  };
})();