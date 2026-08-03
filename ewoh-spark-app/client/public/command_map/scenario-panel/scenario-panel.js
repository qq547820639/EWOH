/* scenario-panel/scenario-panel.js — 调度方案比较（Task 28 前端：能建议）。
   - 分项指标对比（节拍/高负荷/行走/电量/延误/受影响人员），不只显示总分
   - 人工确认：每个方案可点击"确认"展开表单，必填确认人 + 理由（预设+自由文本）
   - 调用 /api/tasks/confirm 写入审计；展示会话级派工记录 + /api/audit 审计链路
   - 人在回路：未经班组长确认不得执行；未经授权自动调度为 0 */
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

  CM.scenarioPanel = {
    // 当前展开确认表单的方案 ID
    _confirmingPlan: null,
    // 审计记录缓存
    _auditItems: null,
    _loadingAudit: false,

    render: function () {
      var host = document.getElementById('tab-scenario');
      var plans = CM.DATA.plans;
      host.innerHTML =
        '<div class="cm-sc-wrap">' +
          '<div class="cm-sc-header">' +
            '<h3>调度方案比较</h3>' +
            '<span class="cm-badge cm-badge-warning">影子运行 · 仅记录不执行</span>' +
            '<span class="cm-sc-note">方案对比不只显示总分，按分项指标对比。所有方案为建议，未经班组长确认不得自动执行。</span>' +
          '</div>' +
          '<div class="cm-sc-plans">' + plans.map(this._planCard, this).join('') + '</div>' +
          '<div class="cm-sc-compare">' +
            '<h4>分项指标对比</h4>' + this._compareTable(plans) +
          '</div>' +
          this._assignmentsSection() +
          this._auditSection() +
          '<div class="cm-sc-actions">' +
            '<button class="cm-btn" id="sc-refresh-audit">刷新审计记录</button>' +
            '<button class="cm-btn" id="sc-reset">重置派工（清空会话级确认）</button>' +
            '<span class="cm-sc-meta">确认审计需选择/填写理由形成审计记录，未确认不得自动执行；未经授权自动调度为 0。</span>' +
          '</div>' +
        '</div>';
      this._bind(host);
      // 首次渲染时异步拉取审计
      if (CM.state.dataSource === 'backend' && !this._auditItems && !this._loadingAudit) {
        this._loadAudit();
      }
    },

    _planCard: function (p) {
      var confirmHtml = this._confirmingPlan === p.plan_id ? this._confirmForm(p) : '';
      return '<div class="cm-sc-card">' +
        '<div class="cm-sc-card-head">' +
          '<span class="cm-sc-card-name">' + CM.esc(p.name) + '</span>' +
          '<span class="cm-badge cm-badge-info">' + CM.esc(p.status) + '</span>' +
          '<span class="cm-sc-card-conf">置信度 ' + (p.confidence * 100).toFixed(0) + '%</span>' +
        '</div>' +
        '<div class="cm-sc-card-goal">目标：' + (p.target === 'production' ? '产能优先' : '负荷均衡') + '</div>' +
        '<div class="cm-sc-card-assumption">' + CM.esc(p.assumption) + '</div>' +
        '<div class="cm-sc-card-metrics">' +
          this._metricRow('节拍提升', p.metrics.takt_improvement, 'production') +
          this._metricRow('高负荷人员数', p.metrics.high_load_persons + ' 人', p.metrics.high_load_persons > 0 ? 'warn' : 'good') +
          this._metricRow('新增行走距离', p.metrics.extra_walking_m + ' m', 'neutral') +
          this._metricRow('低电量风险台数', p.metrics.low_battery_risk + ' 台', p.metrics.low_battery_risk > 0 ? 'warn' : 'good') +
          this._metricRow('延误风险', p.metrics.delay_risk, p.metrics.delay_risk === '低' ? 'good' : 'warn') +
          this._metricRow('受影响人员', p.metrics.affected_persons.length + ' 人', 'neutral') +
        '</div>' +
        '<div class="cm-sc-card-reason">' + CM.esc(p.reasoning) + '</div>' +
        '<div class="cm-sc-card-actions">' +
          '<button class="cm-btn cm-btn-primary" data-act="confirm" data-plan="' + p.plan_id + '">人工确认（需选择理由）</button>' +
          '<button class="cm-btn" data-act="reject" data-plan="' + p.plan_id + '">驳回</button>' +
        '</div>' +
        confirmHtml +
      '</div>';
    },

    // 确认表单：选择受影响人员 + 确认人 + 理由（预设下拉 + 自由文本）
    _confirmForm: function (p) {
      var persons = (p.metrics && p.metrics.affected_persons) || [];
      var personOpts = persons.map(function (pid) {
        var ent = CM.findEntity(pid);
        var label = ent ? CM.personDisplay(ent) : pid;
        return '<option value="' + pid + '">' + CM.esc(pid + ' · ' + label) + '</option>';
      }).join('');
      var reasonOpts = REASON_PRESETS.map(function (r) { return '<option value="' + CM.esc(r) + '">' + CM.esc(r) + '</option>'; }).join('');
      return '<div class="cm-sc-confirm-form">' +
        '<div class="cm-sc-confirm-title">人工确认派工（人在回路）</div>' +
        '<div class="cm-sc-field"><label>指派人员</label>' +
          '<select id="sc-cf-person" class="cm-ev-select">' + personOpts + '</select>' +
        '</div>' +
        '<div class="cm-sc-field"><label>确认人（班组长）</label>' +
          '<input type="text" id="sc-cf-confirmer" class="cm-ev-input" placeholder="必填：班组长工号或姓名">' +
        '</div>' +
        '<div class="cm-sc-field"><label>理由（必填）</label>' +
          '<select id="sc-cf-reason-sel" class="cm-ev-select">' + reasonOpts + '</select>' +
          '<textarea id="sc-cf-reason" class="cm-ev-textarea" placeholder="补充说明（关闭与驳回必须填写）"></textarea>' +
        '</div>' +
        '<div class="cm-sc-confirm-actions">' +
          '<button class="cm-btn cm-btn-primary" data-act="submit-confirm" data-plan="' + p.plan_id + '">提交确认</button>' +
          '<button class="cm-btn" data-act="cancel-confirm">取消</button>' +
        '</div>' +
        '<div class="cm-sc-warn">提交后写入审计日志，平台不自动执行设备控制；硬约束拦截的人员不可确认。</div>' +
      '</div>';
    },

    _metricRow: function (label, value, kind) {
      var cls = kind === 'good' ? 'cm-sc-good' : kind === 'warn' ? 'cm-sc-warn' : '';
      return '<div class="cm-sc-metric ' + cls + '"><span>' + label + '</span><b>' + value + '</b></div>';
    },

    _compareTable: function (plans) {
      var rows = [
        ['节拍提升', 'takt_improvement'],
        ['高负荷人员数', 'high_load_persons', '人'],
        ['新增行走距离', 'extra_walking_m', 'm'],
        ['低电量风险台数', 'low_battery_risk', '台'],
        ['延误风险', 'delay_risk'],
        ['受影响人员', 'affected_persons', '人']
      ];
      var head = '<tr><th>分项指标</th>' + plans.map(function (p) { return '<th>' + CM.esc(p.name) + '</th>'; }).join('') + '</tr>';
      var body = rows.map(function (r) {
        var label = r[0], key = r[1], unit = r[2];
        var cells = plans.map(function (p) {
          var v = p.metrics[key];
          if (key === 'affected_persons') v = v.length + ' 人';
          else if (unit) v = v + ' ' + unit;
          return '<td>' + CM.esc(String(v)) + '</td>';
        }).join('');
        return '<tr><td class="cm-sc-rowlabel">' + label + '</td>' + cells + '</tr>';
      }).join('');
      body += '<tr><td class="cm-sc-rowlabel">关键假设</td>' + plans.map(function (p) {
        return '<td>' + CM.esc(p.assumption) + '</td>';
      }).join('') + '</tr>';
      body += '<tr><td class="cm-sc-rowlabel">置信度</td>' + plans.map(function (p) {
        return '<td>' + (p.confidence * 100).toFixed(0) + '%</td>';
      }).join('') + '</tr>';
      return '<table class="cm-sc-table"><thead>' + head + '</thead><tbody>' + body + '</tbody></table>';
    },

    // 会话级派工记录（来自 backend /api/tasks/assignments）
    _assignmentsSection: function () {
      var items = CM.DATA.assignments || [];
      var html = '<div class="cm-sc-section"><div class="cm-sc-sec-title">会话级派工记录（人工确认后写入，仅本会话）</div>';
      if (items.length) {
        html += '<table class="cm-sc-table"><thead><tr>' +
          '<th>任务 ID</th><th>人员</th><th>确认人</th><th>状态</th><th>确认时间</th>' +
          '</tr></thead><tbody>';
        items.forEach(function (a) {
          html += '<tr>' +
            '<td class="cm-mono">' + CM.esc(a.task_id || '--') + '</td>' +
            '<td class="cm-mono">' + CM.esc(a.person_id) + '</td>' +
            '<td>' + CM.esc(a.confirmer || '--') + '</td>' +
            '<td><span class="cm-badge cm-badge-success">' + CM.esc(a.status) + '</span></td>' +
            '<td class="cm-mono">' + CM.esc((a.confirmed_at || '').replace('T', ' ')) + '</td>' +
          '</tr>';
        });
        html += '</tbody></table>';
      } else {
        html += '<div class="cm-ev-empty">尚无派工记录。</div>';
      }
      html += '</div>';
      return html;
    },

    // 审计链路（来自 backend /api/audit，过滤 confirm 相关动作）
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
          if (act === 'confirm') {
            self._confirmingPlan = (self._confirmingPlan === planId) ? null : planId;
            self.render();
          } else if (act === 'reject') {
            self._confirmingPlan = null;
            self.render();
          } else if (act === 'submit-confirm') {
            self._submitConfirm(planId);
          } else if (act === 'cancel-confirm') {
            self._confirmingPlan = null;
            self.render();
          }
        });
      });
      var refreshBtn = document.getElementById('sc-refresh-audit');
      if (refreshBtn) refreshBtn.addEventListener('click', function () { self._loadAudit(); });
      var resetBtn = document.getElementById('sc-reset');
      if (resetBtn) resetBtn.addEventListener('click', function () { self._resetAssignments(); });
      // 理由预设联动：选择预设时同步写入 textarea
      var reasonSel = document.getElementById('sc-cf-reason-sel');
      var reasonTa = document.getElementById('sc-cf-reason');
      if (reasonSel && reasonTa) {
        reasonSel.addEventListener('change', function () {
          if (reasonSel.value.indexOf('其他') < 0) reasonTa.value = reasonSel.value;
          else reasonTa.value = '';
        });
      }
    },

    _submitConfirm: function (planId) {
      var plan = CM.DATA.plans.find(function (p) { return p.plan_id === planId; });
      if (!plan) return;
      var personId = (document.getElementById('sc-cf-person') || {}).value || '';
      var confirmer = ((document.getElementById('sc-cf-confirmer') || {}).value || '').trim();
      var reasonPreset = (document.getElementById('sc-cf-reason-sel') || {}).value || '';
      var reasonFree = ((document.getElementById('sc-cf-reason') || {}).value || '').trim();
      if (!personId) { alert('请选择指派人员'); return; }
      if (!confirmer) { alert('请填写确认人（班组长工号或姓名），禁止自动派工'); return; }
      var reason = reasonFree || reasonPreset;
      if (!reason) { alert('请选择或填写理由（人在回路审计要求）'); return; }
      if (CM.state.dataSource !== 'backend') {
        alert('离线样本模式：不调用 /api/tasks/confirm。请启动 backend 后再确认。');
        return;
      }
      var btn = document.querySelector('[data-act="submit-confirm"]');
      if (btn) btn.disabled = true;
      // 调用 backend 确认派工（taskId 用 plan 的 plan_id 作为影子任务标识）
      CM.api.confirmTask(personId, confirmer, reason, planId).then(function (resp) {
        if (resp && resp.ok) {
          alert('派工已确认并写入审计。平台不自动执行设备控制；硬约束拦截的人员无法确认。');
          CM.scenarioPanel._confirmingPlan = null;
          // 重新拉取 assignments 与 audit
          CM.api.get('/api/tasks/assignments', {}).then(function (r) {
            CM.DATA.assignments = (r && r.items) || [];
            CM.scenarioPanel.render();
          }).catch(function () { CM.scenarioPanel.render(); });
          CM.scenarioPanel._loadAudit();
        } else {
          alert('确认失败：' + (resp && resp.error ? resp.error : '未知错误（可能硬约束拦截）'));
          if (btn) btn.disabled = false;
        }
      }).catch(function (err) {
        alert('确认请求失败：' + (err.message || ''));
        if (btn) btn.disabled = false;
      });
    },

    _loadAudit: function () {
      if (CM.state.dataSource !== 'backend') { return; }
      this._loadingAudit = true;
      this.render();
      var self = this;
      // 拉取所有审计记录（confirm 与 event_status 均相关），limit=100
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
      if (CM.state.dataSource !== 'backend') {
        alert('离线样本模式：不调用 /api/reset。');
        return;
      }
      if (!confirm('确认清空会话级派工记录？真实数据不受影响。')) return;
      CM.api.reset().then(function () {
        CM.DATA.assignments = [];
        CM.scenarioPanel.render();
      }).catch(function (err) {
        alert('重置失败：' + (err.message || ''));
      });
    }
  };
})();
