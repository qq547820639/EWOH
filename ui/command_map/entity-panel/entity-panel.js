/* entity-panel/entity-panel.js — right-side selected entity details.
   Satisfies the "空间实体可追溯" scenario: shows full spec fields
   id/parent/坐标/朝向/边界框/状态/来源/置信度/更新时间/版本 plus type-specific extras
   and the person—device—task—station binding. */
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
    var e = CM.findEntity(id);
    return '<span class="cm-bind-link" data-id="' + id + '">' + id + (e ? ' · ' + CM.esc(e.name) : '') + '</span>';
  }

  CM.entityPanel = {
    render: function () {
      var host = document.getElementById('entity-detail');
      var id = CM.state.selectedId;
      if (!id) {
        host.innerHTML = '<div class="cm-empty">点击地图实体查看唯一 ID、父级空间、坐标、朝向、边界框、状态、来源、置信度、更新时间与版本。</div>';
        return;
      }
      var e = CM.findEntity(id);
      if (!e) { host.innerHTML = '<div class="cm-empty">未找到实体 ' + CM.esc(id) + '</div>'; return; }

      var html = '<div class="cm-entity-head">' +
        '<div class="cm-entity-title">' + CM.esc(e.name || e.entity_id) +
        '<span class="cm-entity-type">' + CM.esc(e.entity_type) + '</span></div>' +
        '<div class="cm-entity-id">' + CM.esc(e.entity_id) + '</div>' +
        '<div class="cm-entity-src">' + CM.srcTag(e.source_type) + '</div>' +
        '</div>';

      // core spec fields
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

      // type-specific extras
      html += this._extras(e);
      // binding
      html += this._binding(e);

      host.innerHTML = html;
      // bind-link clicks jump selection to related entity.
      host.querySelectorAll('.cm-bind-link').forEach(function (lnk) {
        lnk.addEventListener('click', function () { CM.selectEntity(lnk.dataset.id); });
      });
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
      } else if (e.person) {
        h += subRow('当前动作', e.person.action);
        h += subRow('技能', e.person.skill);
        h += subRow('负荷等级', e.person.load_level.toFixed(2));
        h += subRow('疲劳趋势', e.person.fatigue_trend.toFixed(2));
        h += subRow('连续作业', e.person.work_minutes + ' 分');
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
        return ''; // workshop has no extra block
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
    }
  };
})();
