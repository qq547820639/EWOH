/* entity-panel/entity-panel.js — 右侧选中实体详情（Task 16 前端：看得懂）。
   人员详情页：匿名编号/当前任务/位置/技能/外骨骼/当前动作/累计负荷/风险趋势/最近事件/建议/数据质量
   外骨骼详情页：设备状态/电量/故障/最近推理/绑定人员/最新遥测
   工位详情页：节拍/占用/积压/关联事件
   V0.2：按需拉取 /api/person/profile、/api/devices/{id}/health、/api/events/{id} */
(function () {
  'use strict';
  var CM = window.CM;

  function row(label, value, cls) {
    return '<div class="cm-field"><span class="cm-field-label">' + label + '</span>' +
      '<span class="cm-field-value' + (cls ? ' ' + cls : '') + '">' + value + '</span></div>';
  }
  function subRow(label, value) {
    return '<div class="cm-sub-field"><div class="cm-sub-label">' + label + '</div>' +
      '<div class="cm-sub-value">' + (value == null || value === '' ? '--' : value) + '</div></div>';
  }
  function bindLink(id) {
    if (!id) return '--';
    var r = resolveEntity(id);
    var label = id;
    if (r) {
      if (r.kind === 'entity') label = CM.esc(r.obj.name || r.obj.entity_id);
      else if (r.kind === 'task' || r.kind === 'plan') label = id;
      else if (r.kind === 'assignment') label = id;
    }
    return '<span class="cm-bind-link" data-id="' + id + '">' + CM.esc(label) + '</span>';
  }

  // ===== 调度实体解析（Phase 7.5）：Task / Plan / Assignment 不在 CM.DATA.entities 中 =====
  function findTask(id) {
    var list = CM.DATA.tasks || [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].task_id === id) return list[i];
    return null;
  }
  function findPlan(id) {
    var list = CM.DATA.plans || [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].plan_id === id) return list[i];
    return null;
  }
  function findAssignment(id) {
    var list = CM.DATA.assignments || [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].assignment_id === id) return list[i];
    return null;
  }
  // 统一解析：优先空间实体，其次 Task / Assignment / Plan
  function resolveEntity(id) {
    var e = CM.findEntity(id);
    if (e) return { kind: 'entity', obj: e };
    var t = findTask(id);
    if (t) return { kind: 'task', obj: t };
    var a = findAssignment(id);
    if (a) return { kind: 'assignment', obj: a };
    var p = findPlan(id);
    if (p) return { kind: 'plan', obj: p };
    return null;
  }
  // 与某 id 相关的调度记录（正式 Assignment + 方案排程 CandidateAssignment）
  function relatedAssignments(id) {
    var out = [];
    (CM.DATA.assignments || []).forEach(function (a) {
      if (a.task_id === id || a.person_id === id || a.device_id === id || a.station_id === id) {
        out.push({ kind: '正式派工', assignment: a, plan: null });
      }
    });
    (CM.DATA.plans || []).forEach(function (p) {
      (p.assignments || []).forEach(function (a) {
        if (a.task_id === id || a.person_id === id || a.device_id === id || a.station_id === id) {
          out.push({ kind: '方案排程', assignment: a, plan: p });
        }
      });
    });
    return out;
  }
  function fmtIso(iso) {
    if (!iso) return '--';
    return String(iso).replace('T', ' ').slice(0, 19);
  }
  // 约束违反数：violations 可能是数组（后端）或数字，统一取数量
  function violationCount(cs) {
    if (!cs) return 0;
    var v = cs.violations;
    if (v == null) return 0;
    if (Array.isArray(v)) return v.length;
    return Number(v) || 0;
  }
  function statusBadge(s) {
    if (!s) return '--';
    var cls = ['executing', 'dispatched', 'received', 'normal', 'open'].indexOf(s) >= 0 ? 'success' :
              ['exception', 'expired', 'fault', 'closed'].indexOf(s) >= 0 ? 'danger' :
              ['pending_review', 'pending_dispatch', 'shadow', 'simulating', 'paused', 'warning'].indexOf(s) >= 0 ? 'warning' : 'muted';
    return '<span class="cm-badge cm-badge-' + cls + '">' + CM.esc(s) + '</span>';
  }

  // 简单 SVG 风险趋势迷你图：基于事件历史与负荷推断（非医学诊断）
  function riskSpark(personId, currentLoad, fatigueTrend) {
    // 取该人员最近 12 条事件作为风险历史样本（按时间正序）
    var evs = CM.DATA.events
      .filter(function (e) { return e.person_id === personId; })
      .sort(function (a, b) { return (a.time || '').localeCompare(b.time || ''); })
      .slice(-12);
    var pts = [];
    var baseline = 0.2 + (fatigueTrend || 0) * 0.3;
    for (var i = 0; i < 12; i++) {
      var ev = evs[i];
      var v;
      if (ev) {
        v = ev.severity === 'critical' ? 0.9 : ev.severity === 'warning' ? 0.65 : 0.3;
      } else {
        v = baseline + (currentLoad || 0) * 0.4;
      }
      pts.push([i * 12 + 4, 32 - v * 28]);
    }
    var path = pts.map(function (p, i) { return (i === 0 ? 'M' : 'L') + p[0] + ' ' + p[1]; }).join(' ');
    var svg = '<svg class="cm-spark" width="150" height="36" viewBox="0 0 150 36">' +
      '<path d="' + path + '" fill="none" stroke="#f59e0b" stroke-width="1.5"/>' +
      '<line x1="0" y1="32" x2="150" y2="32" stroke="#2a3340" stroke-width="1"/>' +
      '</svg>';
    return '<div class="cm-sub-field"><div class="cm-sub-label">风险趋势（仅推断，非医学诊断）</div><div class="cm-sub-value">' + svg + '</div></div>';
  }

  // 基于规则的简短建议（非 LLM，避免虚构）
  function suggestForPerson(p, profile) {
    var tips = [];
    var load = (p.person && p.person.load_level) || 0;
    var fatigue = (p.person && p.person.fatigue_trend) || 0;
    var workMin = (p.person && p.person.work_minutes) || 0;
    var metrics = (profile && profile.metrics) || {};
    if (load >= 0.7) tips.push('累计负荷偏高，建议安排换岗或短休（仅趋势建议，非医学诊断）');
    if (fatigue >= 0.6) tips.push('疲劳趋势上升，建议检查连续作业时长');
    if (workMin >= 120) tips.push('连续作业 ' + workMin + ' 分钟，接近常规归一化基准');
    if (metrics.open_high_events > 0) tips.push('存在 ' + metrics.open_high_events + ' 条未处置高风险事件，须班组长确认');
    if (metrics.open_events > 0 && metrics.open_high_events === 0) tips.push('存在 ' + metrics.open_events + ' 条未处置事件，关注处置进度');
    if (p.consent_status && p.consent_status !== 'granted') tips.push('人员授权状态：' + p.consent_status + '，停止新增采集');
    if (tips.length === 0) tips.push('当前指标在正常区间，维持现有作业安排');
    return tips;
  }

  CM.entityPanel = {
    // 当前正在异步加载的实体 ID（避免重复请求）
    _loadingId: null,

    render: function () {
      var host = document.getElementById('entity-detail');
      if (!host) return;
      var id = CM.state.selectedId;
      if (!id) {
        host.innerHTML = '<div class="cm-empty">点击地图实体查看唯一 ID、父级空间、坐标、朝向、边界框、状态、来源、置信度、更新时间与版本；调度对象（任务/方案/派工）展示关联关系。</div>';
        return;
      }
      var r = resolveEntity(id);
      if (!r) { host.innerHTML = '<div class="cm-empty">未找到实体或调度对象 ' + CM.esc(id) + '</div>'; return; }

      // 调度对象（Task / Assignment / Plan）走独立渲染
      if (r.kind === 'task') { this._renderTask(host, r.obj); return; }
      if (r.kind === 'assignment') { this._renderAssignment(host, r.obj); return; }
      if (r.kind === 'plan') { this._renderPlan(host, r.obj); return; }

      var e = r.obj;
      var html = '<div class="cm-entity-head">' +
        '<div class="cm-entity-title">' + CM.esc(e.name || e.entity_id) +
        '<span class="cm-entity-type">' + CM.esc(e.entity_type) + '</span></div>' +
        '<div class="cm-entity-id">' + CM.esc(e.entity_id) + '</div>' +
        '<div class="cm-entity-src">' + CM.srcTag(e.source_type) + '</div>' +
        '</div>';

      // 核心字段
      html += '<div class="cm-field-group"><div class="cm-field-group-title">空间实体字段（可追溯）</div>';
      html += row('唯一 ID', CM.esc(e.entity_id), 'cm-mono');
      html += row('实体类型', CM.esc(e.entity_type));
      html += row('父级空间', CM.esc(e.parent_id) + ' · ' + CM.esc(CM.parentName(e.parent_id)));
      html += row('坐标', '( ' + e.pose.x + ', ' + e.pose.y + ' ) 米', 'cm-mono');
      html += row('朝向', e.pose.yaw + '°', 'cm-mono');
      html += row('边界框', (e.bbox.w || 0) + ' × ' + (e.bbox.h || 0) + ' 米', 'cm-mono');
      html += row('状态', '<span class="cm-badge cm-badge-' + this._statusClass(e.status) + '">' + CM.esc(e.status) + '</span>');
      html += row('数据来源', CM.srcTag(e.source_type));
      html += row('置信度', (e.confidence * 100).toFixed(0) + '%', this._confClass(e.confidence));
      html += row('更新时间', CM.esc(e.updated_at), 'cm-mono');
      html += row('版本', 'v' + e.version, 'cm-mono');
      html += '</div>';

      // 类型扩展块
      html += this._extras(e);
      // 绑定关系
      html += this._binding(e);
      // 调度关系（Task/Person/Device/Station/Assignment）
      html += this._schedRelations(id);

      host.innerHTML = html;
      host.querySelectorAll('.cm-bind-link').forEach(function (lnk) {
        lnk.addEventListener('click', function () { CM.selectEntity(lnk.dataset.id); });
      });

      // 人员/设备详情页：异步拉取 backend 增强字段
      if (e.entity_type === 'person') {
        this._loadPersonProfile(e);
      } else if (e.entity_type === 'device') {
        this._loadDeviceHealth(e);
      }
    },

    _statusClass: function (s) {
      if (['online', 'producing', 'working', 'operational', 'normal', 'open'].indexOf(s) >= 0) return 'success';
      if (['offline', 'warning', 'caution', 'idle'].indexOf(s) >= 0) return 'warning';
      if (['fault', 'closed', 'confirmed'].indexOf(s) >= 0) return 'info';
      return 'muted';
    },
    _confClass: function (c) { return c >= 0.95 ? 'cm-conf-high' : c >= 0.85 ? 'cm-conf-mid' : 'cm-conf-low'; },

    _extras: function (e) {
      var h = '<div class="cm-field-group"><div class="cm-field-group-title">扩展属性</div><div class="cm-field-row">';
      if (e.device) {
        h += subRow('型号', e.device.model);
        h += subRow('固件', e.device.firmware);
        h += subRow('电量', e.device.battery + '%');
        h += subRow('温度', e.device.temp + '℃');
        h += subRow('在线', e.device.online ? '是' : '否');
        h += subRow('故障码', e.device.fault_code || '无');
        if (e.device.model_version) h += subRow('推理模型版本', e.device.model_version);
        if (e.device.action_label) h += subRow('最近动作', e.device.action_label + ' (' + ((e.device.action_confidence || 0) * 100).toFixed(0) + '%)');
        if (e.device.quality_status) h += subRow('数据质量', e.device.quality_status);
      } else if (e.person) {
        h += subRow('匿名编号', (e.anonymized_name || e.entity_id));
        h += subRow('当前动作', e.person.action);
        h += subRow('技能', e.person.skill);
        h += subRow('负荷等级', e.person.load_level.toFixed(2));
        h += subRow('疲劳趋势', e.person.fatigue_trend.toFixed(2));
        h += subRow('连续作业', e.person.work_minutes + ' 分');
        if (e.consent_status) h += subRow('授权状态', e.consent_status);
      } else if (e.station) {
        h += subRow('所属产线', e.station.line);
        h += subRow('节拍', e.station.takt + 's');
        h += subRow('占用', e.station.occupancy);
        h += subRow('积压', e.station.backlog + ' 任务');
      } else if (e.zone) {
        h += subRow('区域类型', e.zone_type);
        h += subRow('温度', e.env.temp + '℃');
        h += subRow('振动', e.env.vibration);
        h += subRow('噪声', e.env.noise + 'dB');
      } else if (e.route) {
        h += subRow('路径点数', e.route.path.length);
        h += subRow('状态', e.status);
      } else {
        return '';
      }
      h += '</div></div>';
      return h;
    },

    _binding: function (e) {
      if (e.person) {
        return '<div class="cm-field-group"><div class="cm-field-group-title">绑定关系（人—设备—任务—工位）</div>' +
          row('绑定设备', bindLink(e.person.device_id)) +
          row('当前任务', CM.esc(e.person.task_id) || '无') +
          row('所在工位', bindLink(e.person.station_id)) +
          '</div>';
      }
      if (e.device) {
        return '<div class="cm-field-group"><div class="cm-field-group-title">绑定关系</div>' +
          row('绑定人员', bindLink(e.device.person_id)) +
          row('当前任务', CM.esc(e.device.task_id) || '无') +
          row('所在工位', bindLink(e.device.station_id)) +
          '</div>';
      }
      if (e.station) {
        return '<div class="cm-field-group"><div class="cm-field-group-title">工位占用</div>' +
          row('占用人数', e.station.occupancy) +
          row('积压任务', e.station.backlog) +
          '</div>';
      }
      return '';
    },

    // ===== Phase 7.5：调度关系展示 =====
    // 空间实体（Person/Device/Station/Task 引用）→ 相关 Assignment/方案排程
    _schedRelations: function (id) {
      var rels = relatedAssignments(id);
      var html = '<div class="cm-field-group"><div class="cm-field-group-title">调度关系（Assignment / 方案排程）</div>';
      if (rels.length === 0) {
        html += '<div class="cm-empty">暂无相关调度记录。</div>';
      } else {
        html += '<div class="cm-sc-rlist">';
        rels.forEach(function (it) {
          var a = it.assignment;
          var planRef = it.plan ? bindLink(it.plan.plan_id) : (a.plan_id ? bindLink(a.plan_id) : '--');
          html += '<div class="cm-rrel">' +
            '<div class="cm-rrel-head">' +
              '<span class="cm-badge cm-badge-info">' + CM.esc(it.kind) + '</span>' +
              '<span class="cm-mono">' + CM.esc(a.task_id || '--') + '</span>' +
              statusBadge(a.status) +
            '</div>' +
            '<div class="cm-rrel-row">' +
              '<span>人 ' + bindLink(a.person_id) + '</span>' +
              '<span>设 ' + bindLink(a.device_id) + '</span>' +
              '<span>工位 ' + bindLink(a.station_id) + '</span>' +
            '</div>' +
            '<div class="cm-rrel-row">' +
              '<span>开始 ' + CM.esc(fmtIso(a.planned_start)) + '</span>' +
              '<span>结束 ' + CM.esc(fmtIso(a.planned_end)) + '</span>' +
            '</div>' +
            '<div class="cm-rrel-row">' +
              '<span>方案 ' + planRef + '</span>' +
              (a.assignment_id ? '<span>派工 ' + bindLink(a.assignment_id) + '</span>' : '') +
            '</div>' +
          '</div>';
        });
        html += '</div>';
      }
      html += '</div>';
      return html;
    },

    // Task 对象渲染
    _renderTask: function (host, t) {
      var skills = (t.required_skills || []).join('、') || '--';
      var caps = (t.required_device_capabilities || []).join('、') || '--';
      var preds = (t.predecessor_task_ids || []).join('、') || '--';
      var html = '<div class="cm-entity-head">' +
        '<div class="cm-entity-title">' + CM.esc(t.task_id) +
        '<span class="cm-entity-type">task</span></div>' +
        '<div class="cm-entity-id">' + CM.esc(t.task_id) + '</div>' +
        '</div>';
      html += '<div class="cm-field-group"><div class="cm-field-group-title">任务字段</div>';
      html += row('任务类型', CM.esc(t.task_type || '--'));
      html += row('优先级', CM.esc(t.priority != null ? 'P' + t.priority : '--'), t.priority != null && t.priority >= 2 ? 'cm-conf-high' : '');
      html += row('状态', statusBadge(t.status));
      html += row('工位', bindLink(t.station_id));
      html += row('区域', bindLink(t.zone_id));
      html += row('技能', CM.esc(skills));
      html += row('设备能力', CM.esc(caps));
      html += row('装载负荷', CM.esc(t.load_level != null ? t.load_level.toFixed(2) : '--'));
      html += row('安全关键', t.safety_critical ? '<span class="cm-badge cm-badge-danger">是</span>' : '否');
      html += row('预计时长', CM.esc(t.estimated_duration_sec != null ? Math.round(t.estimated_duration_sec / 60) + ' 分' : '--'));
      html += row('最早开始', CM.esc(fmtIso(t.earliest_start)));
      html += row('截止时间', CM.esc(fmtIso(t.due_at)));
      html += row('前置任务', CM.esc(preds));
      html += row('版本', 'v' + (t.version != null ? t.version : '--'), 'cm-mono');
      html += '</div>';
      html += this._schedRelations(t.task_id);
      host.innerHTML = html;
      this._bindLinks(host);
    },

    // Assignment 对象渲染
    _renderAssignment: function (host, a) {
      var html = '<div class="cm-entity-head">' +
        '<div class="cm-entity-title">' + CM.esc(a.assignment_id) +
        '<span class="cm-entity-type">assignment</span></div>' +
        '<div class="cm-entity-id">' + CM.esc(a.assignment_id) + '</div>' +
        '</div>';
      html += '<div class="cm-field-group"><div class="cm-field-group-title">派工记录</div>';
      html += row('任务', bindLink(a.task_id));
      html += row('方案', bindLink(a.plan_id));
      html += row('人员', bindLink(a.person_id));
      html += row('设备', bindLink(a.device_id));
      html += row('工位', bindLink(a.station_id));
      html += row('状态', statusBadge(a.status));
      html += row('计划开始', CM.esc(fmtIso(a.planned_start)), 'cm-mono');
      html += row('计划结束', CM.esc(fmtIso(a.planned_end)), 'cm-mono');
      html += row('实际开始', CM.esc(fmtIso(a.actual_start)), 'cm-mono');
      html += row('实际结束', CM.esc(fmtIso(a.actual_end)), 'cm-mono');
      html += row('版本', 'v' + (a.version != null ? a.version : '--'), 'cm-mono');
      html += '</div>';
      html += this._schedRelations(a.assignment_id);
      host.innerHTML = html;
      this._bindLinks(host);
    },

    // Plan 对象渲染
    _renderPlan: function (host, p) {
      var cs = p.constraint_summary || {};
      var ob = p.objective_breakdown || {};
      var html = '<div class="cm-entity-head">' +
        '<div class="cm-entity-title">' + CM.esc(p.plan_id) +
        '<span class="cm-entity-type">plan</span></div>' +
        '<div class="cm-entity-id">' + CM.esc(p.plan_id) + '</div>' +
        '</div>';
      html += '<div class="cm-field-group"><div class="cm-field-group-title">方案字段</div>';
      html += row('状态', statusBadge(p.status));
      html += row('请求', bindLink(p.request_id));
      html += row('版本', 'v' + (p.version != null ? p.version : '--'), 'cm-mono');
      html += row('世界状态', CM.esc(p.world_state_version || '--'), 'cm-mono');
      html += row('目标分', CM.esc(p.objective_score != null ? Number(p.objective_score).toFixed(2) : '--'));
      html += row('创建时间', CM.esc(fmtIso(p.created_at)), 'cm-mono');
      html += row('有效期', CM.esc(fmtIso(p.valid_until)), 'cm-mono');
      html += row('确认人', CM.esc(p.confirmed_by || '--'));
      html += row('确认理由', CM.esc(p.confirm_reason || '--'));
      html += row('任务/已派', CM.esc((cs.total_tasks != null ? cs.total_tasks : '--') + ' / ' + (cs.assigned != null ? cs.assigned : '--')));
      html += row('违反', CM.esc(violationCount(cs)));
      html += row('准时', CM.esc(ob.on_time_score != null ? Number(ob.on_time_score).toFixed(2) : '--'));
      html += '</div>';
      html += this._schedRelations(p.plan_id);
      host.innerHTML = html;
      this._bindLinks(host);
    },

    _bindLinks: function (host) {
      host.querySelectorAll('.cm-bind-link').forEach(function (lnk) {
        lnk.addEventListener('click', function () { CM.selectEntity(lnk.dataset.id); });
      });
    },

    // 异步加载人员画像（Task 16）：技能/动作分布/指标/最近事件/建议/数据质量
    _loadPersonProfile: function (e) {
      if (this._loadingId === e.entity_id) return;
      this._loadingId = e.entity_id;
      var host = document.getElementById('entity-detail');
      if (!host) return;
      // 先用本地数据补一版"建议"
      var localSuggest = suggestForPerson(e, null);
      var suggestHtml = '<div class="cm-field-group"><div class="cm-field-group-title">建议（规则推断，非 LLM，非医学诊断）</div>' +
        '<ul class="cm-suggest-list">' + localSuggest.map(function (s) { return '<li>' + CM.esc(s) + '</li>'; }).join('') + '</ul></div>';
      // 风险趋势迷你图（本地推断）
      var sparkHtml = '<div class="cm-field-group"><div class="cm-field-group-title">风险趋势</div>' +
        riskSpark(e.entity_id, e.person.load_level, e.person.fatigue_trend) + '</div>';
      host.insertAdjacentHTML('beforeend', sparkHtml + suggestHtml +
        '<div class="cm-field-group" id="profile-extra"><div class="cm-field-group-title">Backend 画像加载中…</div></div>');

      // 仅在 backend 可用时拉取
      if (CM.state.dataSource !== 'backend') {
        var extra = document.getElementById('profile-extra');
        if (extra) extra.innerHTML = '<div class="cm-field-group-title">Backend 画像</div><div class="cm-empty">离线样本模式：不调用 /api/person/profile。</div>';
        this._loadingId = null;
        return;
      }
      CM.api.fetchPersonProfile(e.entity_id).then(function (p) {
        var extra = document.getElementById('profile-extra');
        if (!extra) return;
        var dist = p.action_distribution_24h || {};
        var distRows = Object.keys(dist).map(function (k) {
          return '<div class="cm-sub-field"><div class="cm-sub-label">' + CM.esc(k) + '</div><div class="cm-sub-value">' + dist[k] + ' 次</div></div>';
        }).join('') || '<div class="cm-empty">无动作分布数据</div>';
        var skills = (p.skills || []).join('、') || '--';
        var m = p.metrics || {};
        var quality = p.quality || 'unknown';
        var evList = (p.events || []).slice(0, 5).map(function (ev) {
          return '<li><span class="cm-mono">' + CM.esc(ev.start_time || '') + '</span> ' +
                 '<span class="cm-badge cm-badge-' + (ev.severity === 'critical' ? 'danger' : ev.severity === 'warning' ? 'warning' : 'info') + '">' + CM.esc(ev.severity || '') + '</span> ' +
                 CM.esc(ev.event_code || ev.event_id) + '</li>';
        }).join('') || '<li>无最近事件</li>';
        var device = p.device || {};
        extra.innerHTML = '<div class="cm-field-group-title">人员画像（/api/person/profile）</div>' +
          '<div class="cm-field-row">' +
          subRow('技能', skills) +
          subRow('当前负荷', m.current_load != null ? m.current_load.toFixed(3) : '--') +
          subRow('连续作业分钟', m.work_minutes != null ? m.work_minutes.toFixed(1) : '--') +
          subRow('未处置事件', m.open_events != null ? m.open_events : '--') +
          subRow('高风险事件', m.open_high_events != null ? m.open_high_events : '--') +
          subRow('近期风险评分', m.risk_recent != null ? m.risk_recent.toFixed(3) : '--') +
          subRow('数据质量', quality) +
          subRow('绑定设备', device.device_id || '--') +
          '</div>' +
          '<div class="cm-sub-field"><div class="cm-sub-label">24h 动作分布</div><div class="cm-sub-value cm-field-row">' + distRows + '</div></div>' +
          '<div class="cm-sub-field"><div class="cm-sub-label">最近事件</div><div class="cm-sub-value"><ul class="cm-ev-mini">' + evList + '</ul></div></div>';
        // 用真实 metrics 重新生成建议
        var newSuggest = suggestForPerson(e, p);
        var suggestBox = host.querySelector('.cm-suggest-list');
        if (suggestBox) suggestBox.innerHTML = newSuggest.map(function (s) { return '<li>' + CM.esc(s) + '</li>'; }).join('');
      }).catch(function (err) {
        var extra = document.getElementById('profile-extra');
        if (extra) extra.innerHTML = '<div class="cm-field-group-title">Backend 画像</div><div class="cm-empty">加载失败：' + CM.esc(err.message || '') + '</div>';
      }).then(function () {
        CM.entityPanel._loadingId = null;
      });
    },

    // 异步加载设备健康（Task 16）：online/battery/fault/packet_loss/last_seen
    _loadDeviceHealth: function (e) {
      if (this._loadingId === e.entity_id) return;
      this._loadingId = e.entity_id;
      var host = document.getElementById('entity-detail');
      if (!host) return;
      host.insertAdjacentHTML('beforeend',
        '<div class="cm-field-group" id="health-extra"><div class="cm-field-group-title">设备健康加载中…</div></div>');
      if (CM.state.dataSource !== 'backend') {
        var ex1 = document.getElementById('health-extra');
        if (ex1) ex1.innerHTML = '<div class="cm-field-group-title">设备健康</div><div class="cm-empty">离线样本模式：不调用 /api/devices/{id}/health。</div>';
        this._loadingId = null;
        return;
      }
      CM.api.get('/api/devices/' + encodeURIComponent(e.entity_id) + '/health').then(function (h) {
        var ex = document.getElementById('health-extra');
        if (!ex) return;
        ex.innerHTML = '<div class="cm-field-group-title">设备健康（/api/devices/{id}/health）</div>' +
          '<div class="cm-field-row">' +
          subRow('在线', h.online ? '是' : '否') +
          subRow('最后通信', h.last_seen || '--') +
          subRow('电量', h.battery_pct != null ? h.battery_pct + '%' : '--') +
          subRow('故障', h.fault ? '是' : '否') +
          subRow('丢包率', h.packet_loss_pct != null ? h.packet_loss_pct + '%' : '--') +
          subRow('数据质量', h.quality_status || 'unknown') +
          '</div>';
      }).catch(function (err) {
        var ex = document.getElementById('health-extra');
        if (ex) ex.innerHTML = '<div class="cm-field-group-title">设备健康</div><div class="cm-empty">加载失败：' + CM.esc(err.message || '') + '</div>';
      }).then(function () {
        CM.entityPanel._loadingId = null;
      });
    }
  };
})();
