/* scenario-panel/scenario-panel.js — scheduling plan comparison skeleton.
   Per spec scenario "方案对比": plans show per-metric breakdown
   (节拍提升 / 高负荷人员数 / 新增行走距离 / 低电量风险台数 / 延误风险 / 受影响人员),
   NOT just a total score. All plans are shadow-run suggestions awaiting
   manual confirmation by the shift lead (调度纪律 / 人在回路). */
(function () {
  'use strict';
  var CM = window.CM;

  CM.scenarioPanel = {
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
          '<div class="cm-sc-actions">' +
            '<button class="cm-btn" disabled>人工确认（需选择理由）</button>' +
            '<button class="cm-btn" disabled>驳回</button>' +
            '<span class="cm-sc-meta">V0.1 占位：确认审计需选择/填写理由形成审计记录，未确认不得自动执行；未经授权自动调度为 0。</span>' +
          '</div>' +
        '</div>';
    },

    _planCard: function (p) {
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
      // confidence row
      body += '<tr><td class="cm-sc-rowlabel">置信度</td>' + plans.map(function (p) {
        return '<td>' + (p.confidence * 100).toFixed(0) + '%</td>';
      }).join('') + '</tr>';
      return '<table class="cm-sc-table"><thead>' + head + '</thead><tbody>' + body + '</tbody></table>';
    }
  };
})();
