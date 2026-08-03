/* admin/admin.js — model & rule management skeleton.
   V0.1 stub: lists active/shadow models and active rules with version + source
   isolation tags. Edit/rollback buttons are disabled (governance: every weight or
   rule change is auditable with operator/time/reason). */
(function () {
  'use strict';
  var CM = window.CM;

  CM.admin = {
    render: function () {
      var host = document.getElementById('tab-admin');
      host.innerHTML =
        '<div class="cm-ad-wrap">' +
          '<div class="cm-ad-section">' +
            '<div class="cm-ad-head">' +
              '<h3>模型注册表</h3>' +
              '<span class="cm-ad-note">每个模型 100% 可追溯到模型与数据版本；unknown 强制输出，不得强制分类。</span>' +
            '</div>' +
            '<table class="cm-ad-table"><thead><tr>' +
            '<th>模型 ID</th><th>名称</th><th>版本</th><th>状态</th><th>来源</th><th>数据集</th><th>F1</th><th>更新</th><th>操作</th>' +
            '</tr></thead><tbody>' + this._modelRows() + '</tbody></table>' +
          '</div>' +
          '<div class="cm-ad-section">' +
            '<div class="cm-ad-head">' +
              '<h3>规则注册表</h3>' +
              '<span class="cm-ad-note">规则可解释易验收；权重/阈值调整需记录前后值、操作人、时间、原因。</span>' +
            '</div>' +
            '<table class="cm-ad-table"><thead><tr>' +
            '<th>规则 ID</th><th>名称</th><th>版本</th><th>状态</th><th>阈值条件</th><th>更新</th><th>操作</th>' +
            '</tr></thead><tbody>' + this._ruleRows() + '</tbody></table>' +
          '</div>' +
          '<div class="cm-ad-actions">' +
            '<button class="cm-btn" disabled>新增模型（需授权）</button>' +
            '<button class="cm-btn" disabled>新增规则（需授权）</button>' +
            '<span class="cm-ad-meta">V0.1 占位：写操作需身份权限与审计记录，回滚走 model_rollback 流程。</span>' +
          '</div>' +
        '</div>';
    },

    _modelRows: function () {
      return CM.DATA.models.map(function (m) {
        var stCls = m.status === 'active' ? 'cm-badge-success' : 'cm-badge-info';
        return '<tr>' +
          '<td class="cm-mono">' + m.model_id + '</td>' +
          '<td>' + CM.esc(m.name) + '</td>' +
          '<td class="cm-mono">' + m.version + '</td>' +
          '<td><span class="cm-badge ' + stCls + '">' + m.status + '</span></td>' +
          '<td>' + CM.srcTag(m.source_type) + '</td>' +
          '<td class="cm-mono">' + CM.esc(m.dataset) + '</td>' +
          '<td class="cm-mono">' + m.f1.toFixed(2) + '</td>' +
          '<td class="cm-mono">' + m.updated + '</td>' +
          '<td><button class="cm-btn cm-btn-sm" disabled>回滚</button> <button class="cm-btn cm-btn-sm" disabled>编辑</button></td>' +
        '</tr>';
      }).join('');
    },

    _ruleRows: function () {
      return CM.DATA.rules.map(function (r) {
        return '<tr>' +
          '<td class="cm-mono">' + r.rule_id + '</td>' +
          '<td>' + CM.esc(r.name) + '</td>' +
          '<td class="cm-mono">' + r.version + '</td>' +
          '<td><span class="cm-badge cm-badge-success">' + r.status + '</span></td>' +
          '<td class="cm-mono">' + CM.esc(r.threshold) + '</td>' +
          '<td class="cm-mono">' + r.updated + '</td>' +
          '<td><button class="cm-btn cm-btn-sm" disabled>编辑</button></td>' +
        '</tr>';
      }).join('');
    }
  };
})();
