/* event-center/event-center.js — 事件中心（Task 16 前端：看得懂 + Task 22 数据冲突人工标记）。
   - 事件列表：按时间 / 严重度 / 状态 / 关键字过滤
   - 事件详情：因果链（trigger）+ 证据窗（前后 N 秒遥测）+ 处置记录（handlings）+ 评论
   - 处置动作：确认 / 关闭 / 驳回 / 评论，调用 /api/events/{id}/status 与 /api/events/{id}/comment
   - Task 22：SENSOR_CONFLICT 事件增加"人工标记现场事实"入口（写入评论 + 状态变更，可审计）
   V0.2：异步拉取 backend /api/events/{id} 增强字段；离线样本模式仅展示本地字段。 */
(function () {
  'use strict';
  var CM = window.CM;

  var SEV_LABEL = { critical: '严重', warning: '告警', info: '提示' };
  var STATUS_LABEL = { open: '未处置', confirmed: '已确认', closed: '已关闭', dismissed: '已驳回' };
  // 前端会话级筛选状态
  CM.state.eventFilter = CM.state.eventFilter || { severity: '', status: '', kw: '', time: '' };

  function sevBadge(s) {
    var cls = s === 'critical' ? 'cm-badge-danger' : s === 'warning' ? 'cm-badge-warning' : 'cm-badge-info';
    return '<span class="cm-badge ' + cls + '">' + (SEV_LABEL[s] || s) + '</span>';
  }
  function statusBadge(s) {
    var cls = s === 'open' ? 'cm-badge-danger' : s === 'confirmed' ? 'cm-badge-warning' :
              s === 'closed' ? 'cm-badge-success' : 'cm-badge-muted';
    return '<span class="cm-badge ' + cls + '">' + (STATUS_LABEL[s] || s) + '</span>';
  }

  // 时间过滤选项（按开始时间）
  function inTimeRange(t, range) {
    if (!range) return true;
    if (!t) return false;
    var ts = new Date(t).getTime();
    if (isNaN(ts)) return true;
    var now = Date.now();
    if (range === '1h') return now - ts <= 3600 * 1000;
    if (range === '8h') return now - ts <= 8 * 3600 * 1000;
    if (range === 'shift') return now - ts <= 9 * 3600 * 1000;
    return true;
  }

  CM.eventCenter = {
    selectedEvent: null,
    // 当前异步加载事件详情的 ID（避免重复请求）
    _loadingDetail: null,

    render: function () {
      var host = document.getElementById('tab-events');
      var f = CM.state.eventFilter;
      var self = this;
      host.innerHTML =
        '<div class="cm-ev-wrap">' +
          '<div class="cm-ev-col">' +
            '<div class="cm-ev-filters">' +
              '<select id="ev-f-sev" class="cm-ev-select">' +
                '<option value="">全部严重度</option>' +
                '<option value="critical"' + (f.severity === 'critical' ? ' selected' : '') + '>严重</option>' +
                '<option value="warning"' + (f.severity === 'warning' ? ' selected' : '') + '>告警</option>' +
                '<option value="info"' + (f.severity === 'info' ? ' selected' : '') + '>提示</option>' +
              '</select>' +
              '<select id="ev-f-st" class="cm-ev-select">' +
                '<option value="">全部状态</option>' +
                '<option value="open"' + (f.status === 'open' ? ' selected' : '') + '>未处置</option>' +
                '<option value="confirmed"' + (f.status === 'confirmed' ? ' selected' : '') + '>已确认</option>' +
                '<option value="closed"' + (f.status === 'closed' ? ' selected' : '') + '>已关闭</option>' +
                '<option value="dismissed"' + (f.status === 'dismissed' ? ' selected' : '') + '>已驳回</option>' +
              '</select>' +
              '<select id="ev-f-tm" class="cm-ev-select">' +
                '<option value="">全部时间</option>' +
                '<option value="1h"' + (f.time === '1h' ? ' selected' : '') + '>近 1 小时</option>' +
                '<option value="8h"' + (f.time === '8h' ? ' selected' : '') + '>近 8 小时</option>' +
                '<option value="shift"' + (f.time === 'shift' ? ' selected' : '') + '>本班次</option>' +
              '</select>' +
              '<input type="text" id="ev-f-kw" class="cm-ev-input" placeholder="搜索事件编号/标题/人员/设备" value="' + CM.esc(f.kw || '') + '">' +
              '<span class="cm-ev-count">' + this._filtered().length + ' / ' + CM.DATA.events.length + '</span>' +
            '</div>' +
            '<div class="cm-ev-list" id="cm-ev-list">' + this._list() + '</div>' +
          '</div>' +
          '<div class="cm-ev-detail" id="cm-ev-detail">' +
            '<div class="cm-ev-empty">选择一条事件查看因果链、证据窗与处置记录。</div>' +
          '</div>' +
        '</div>';
      // 绑定过滤事件
      ['ev-f-sev', 'ev-f-st', 'ev-f-tm'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.addEventListener('change', function () {
          f.severity = document.getElementById('ev-f-sev').value;
          f.status = document.getElementById('ev-f-st').value;
          f.time = document.getElementById('ev-f-tm').value;
          CM.eventCenter._refreshListOnly();
        });
      });
      var kw = document.getElementById('ev-f-kw');
      if (kw) kw.addEventListener('input', function () {
        f.kw = kw.value.trim();
        CM.eventCenter._refreshListOnly();
      });
      host.querySelectorAll('.cm-ev-item').forEach(function (it) {
        it.addEventListener('click', function () { self._select(it.dataset.id); });
      });
      // 若之前已选中，恢复选中态并刷新详情
      if (this.selectedEvent) {
        var item = host.querySelector('.cm-ev-item[data-id="' + this.selectedEvent + '"]');
        if (item) item.classList.add('active');
      }
    },

    // 仅刷新列表区域（避免详情面板被重置）
    _refreshListOnly: function () {
      var listEl = document.getElementById('cm-ev-list');
      if (!listEl) return;
      listEl.innerHTML = this._list();
      var cntEl = document.querySelector('.cm-ev-count');
      if (cntEl) cntEl.textContent = this._filtered().length + ' / ' + CM.DATA.events.length;
      var self = this;
      listEl.querySelectorAll('.cm-ev-item').forEach(function (it) {
        it.addEventListener('click', function () { self._select(it.dataset.id); });
      });
      // 恢复选中态
      if (this.selectedEvent) {
        var item = listEl.querySelector('.cm-ev-item[data-id="' + this.selectedEvent + '"]');
        if (item) item.classList.add('active');
      }
    },

    _filtered: function () {
      var f = CM.state.eventFilter;
      return CM.DATA.events.filter(function (e) {
        if (f.severity && e.severity !== f.severity) return false;
        if (f.status && e.status !== f.status) return false;
        if (!inTimeRange(e.time, f.time)) return false;
        if (f.kw) {
          var hay = (e.event_id + ' ' + e.code + ' ' + e.title + ' ' +
                     (e.person_id || '') + ' ' + (e.device_id || '') + ' ' +
                     (e.detail || '')).toLowerCase();
          if (hay.indexOf(f.kw.toLowerCase()) < 0) return false;
        }
        return true;
      });
    },

    _list: function () {
      return this._filtered().map(function (e) {
        return '<div class="cm-ev-item' + (CM.eventCenter.selectedEvent === e.event_id ? ' active' : '') + '" data-id="' + e.event_id + '">' +
          '<div class="cm-ev-item-head">' +
            sevBadge(e.severity) +
            '<span class="cm-ev-title">' + CM.esc(e.title) + '</span>' +
            statusBadge(e.status) +
          '</div>' +
          '<div class="cm-ev-item-meta">' +
            '<span class="cm-mono">' + (e.time || '').replace('T', ' ') + '</span>' +
            CM.srcTag(e.source_type) +
            '<span>' + (e.person_id || e.device_id || e.station_id || '系统') + '</span>' +
          '</div>' +
          '<div class="cm-ev-item-id">' + e.event_id + ' · ' + e.code + '</div>' +
        '</div>';
      }).join('') || '<div class="cm-ev-empty">无匹配事件。</div>';
    },

    _select: function (id) {
      var e = CM.DATA.events.find(function (x) { return x.event_id === id; });
      if (!e) return;
      this.selectedEvent = id;
      document.querySelectorAll('#cm-ev-list .cm-ev-item').forEach(function (it) {
        it.classList.toggle('active', it.dataset.id === id);
      });
      this._renderDetail(e);
    },

    // 渲染详情骨架；若 backend 可用则异步拉取增强字段
    _renderDetail: function (e) {
      var det = document.getElementById('cm-ev-detail');
      if (!det) return;
      det.innerHTML = this._detailSkeleton(e);
      this._bindDetailActions(e);
      // 异步拉取事件详情（证据窗 + 处置记录）
      if (CM.state.dataSource === 'backend' && this._loadingDetail !== e.event_id) {
        this._loadingDetail = e.event_id;
        var self = this;
        CM.api.fetchEventDetail(e.event_id).then(function (d) {
          self._renderDetailEnhanced(e, d);
          self._loadingDetail = null;
        }).catch(function (err) {
          var ex = document.getElementById('ev-detail-enhanced');
          if (ex) ex.innerHTML = '<div class="cm-ev-empty">Backend 详情加载失败：' + CM.esc(err.message || '') + '</div>';
          self._loadingDetail = null;
        });
      } else {
        var ex = document.getElementById('ev-detail-enhanced');
        if (ex) ex.innerHTML = '<div class="cm-ev-empty">离线样本模式：仅展示本地字段，不调用 /api/events/{id}。</div>';
      }
    },

    // 详情骨架（本地字段先渲染，避免空屏）
    _detailSkeleton: function (e) {
      var trig = e.trigger || {};
      var html =
        '<div class="cm-ev-d-head">' +
          '<div class="cm-ev-d-title">' + CM.esc(e.title) +
          sevBadge(e.severity) +
          statusBadge(e.status) +
          '</div>' +
          '<div class="cm-ev-d-id cm-mono">' + e.event_id + ' · ' + e.code + '</div>' +
        '</div>' +
        '<div class="cm-ev-d-row"><span>触发时间</span><b class="cm-mono">' + (e.time || '').replace('T', ' ') + '</b></div>' +
        (e.end_time ? '<div class="cm-ev-d-row"><span>结束时间</span><b class="cm-mono">' + e.end_time.replace('T', ' ') + '</b></div>' : '') +
        '<div class="cm-ev-d-row"><span>关联人员</span><b>' + CM.esc(e.person_id || '--') + '</b></div>' +
        '<div class="cm-ev-d-row"><span>关联设备</span><b>' + CM.esc(e.device_id || '--') + '</b></div>' +
        '<div class="cm-ev-d-row"><span>关联工位</span><b>' + CM.esc(e.station_id || (e.zone_id || '--')) + '</b></div>' +
        '<div class="cm-ev-d-row"><span>数据来源</span><b>' + CM.srcTag(e.source_type) + '</b></div>' +
        '<div class="cm-ev-d-row"><span>置信度</span><b>' + ((e.confidence || 0) * 100).toFixed(0) + '%</b></div>' +
        '<div class="cm-ev-d-detail">' + CM.esc(e.detail) + '</div>';

      // 因果链（trigger）：触发类型 / 条件 / 规则版本 / 模型版本
      html += '<div class="cm-ev-d-section"><div class="cm-ev-d-sec-title">因果链 · 触发依据</div>';
      if (trig && Object.keys(trig).length) {
        html += '<div class="cm-ev-d-row"><span>触发类型</span><b>' + CM.esc(trig.type || '--') + '</b></div>';
        if (trig.condition) html += '<div class="cm-ev-d-row"><span>触发条件</span><b>' + CM.esc(trig.condition) + '</b></div>';
        if (trig.rule_version) html += '<div class="cm-ev-d-row"><span>规则版本</span><b class="cm-mono">' + CM.esc(trig.rule_version) + '</b></div>';
        if (trig.model_version) html += '<div class="cm-ev-d-row"><span>模型版本</span><b class="cm-mono">' + CM.esc(trig.model_version) + '</b></div>';
        if (trig.confidence != null) html += '<div class="cm-ev-d-row"><span>触发置信度</span><b>' + (trig.confidence * 100).toFixed(0) + '%</b></div>';
      } else {
        html += '<div class="cm-ev-empty">无触发依据记录（本地样本未提供）。</div>';
      }
      html += '</div>';

      // 跳转按钮
      html += '<div class="cm-ev-d-actions">' +
        (e.person_id ? '<button class="cm-btn" data-jump="' + e.person_id + '">定位人员</button>' : '') +
        (e.device_id ? '<button class="cm-btn" data-jump="' + e.device_id + '">定位设备</button>' : '') +
        (e.station_id ? '<button class="cm-btn" data-jump="' + e.station_id + '">定位工位</button>' : '') +
      '</div>';

      // 处置动作（人在回路：未关闭事件可确认/关闭/驳回；可评论）
      if (e.status !== 'closed' && e.status !== 'dismissed') {
        html += '<div class="cm-ev-d-section"><div class="cm-ev-d-sec-title">处置（人在回路）</div>' +
          '<div class="cm-ev-d-actions">' +
            '<button class="cm-btn cm-btn-primary" data-act="status" data-status="confirmed">确认</button>' +
            '<button class="cm-btn" data-act="status" data-status="closed">关闭</button>' +
            '<button class="cm-btn" data-act="status" data-status="dismissed">驳回</button>' +
          '</div>' +
          '<textarea id="ev-comment" class="cm-ev-textarea" placeholder="处置说明 / 评论（必填关闭与驳回理由）"></textarea>' +
          '<div class="cm-ev-d-actions">' +
            '<button class="cm-btn" data-act="comment">追加评论</button>' +
          '</div>' +
        '</div>';
      } else {
        html += '<div class="cm-ev-d-section"><div class="cm-ev-d-sec-title">处置（人在回路）</div>' +
          '<div class="cm-ev-empty">事件已' + STATUS_LABEL[e.status] + '，可继续追加评论。</div>' +
          '<textarea id="ev-comment" class="cm-ev-textarea" placeholder="追加评论"></textarea>' +
          '<div class="cm-ev-d-actions"><button class="cm-btn" data-act="comment">追加评论</button></div>' +
        '</div>';
      }

      // Task 22：传感器冲突事件提供"人工标记现场事实"入口
      if (e.code === 'SENSOR_CONFLICT') {
        html += '<div class="cm-ev-d-section cm-ev-d-sitefact">' +
          '<div class="cm-ev-d-sec-title">人工标记现场事实（Task 22 · 数据冲突处理）</div>' +
          '<div class="cm-ev-empty">传感器冲突须由现场负责人裁定真实情况，标记结果写入审计。</div>' +
          '<select id="ev-sitefact-src" class="cm-ev-select">' +
            '<option value="">选择以哪个来源为现场事实</option>' +
            '<option value="uwb">UWB 定位为准</option>' +
            '<option value="vision">视觉检测为准</option>' +
            '<option value="exo_imu">外骨骼 IMU 为准</option>' +
            '<option value="manual">人工现场观察为准</option>' +
            '<option value="unknown">无法判定（保留冲突，降级使用）</option>' +
          '</select>' +
          '<textarea id="ev-sitefact-note" class="cm-ev-textarea" placeholder="现场情况说明（可选）"></textarea>' +
          '<div class="cm-ev-d-actions"><button class="cm-btn cm-btn-primary" data-act="sitefact">标记现场事实</button></div>' +
        '</div>';
      }

      // 增强字段容器（证据窗 + 处置记录）
      html += '<div id="ev-detail-enhanced"><div class="cm-ev-empty">Backend 详情加载中…</div></div>';
      return html;
    },

    // 用 backend 返回的 evidence_records + handlings 渲染增强区
    _renderDetailEnhanced: function (e, d) {
      var ex = document.getElementById('ev-detail-enhanced');
      if (!ex) return;
      var evt = (d && d.event) || {};
      var win = (d && d.evidence_window_sec) || 30;
      var recs = (d && d.evidence_records) || [];
      var handlings = (d && d.handlings) || [];
      var html = '';

      // 证据窗
      html += '<div class="cm-ev-d-section"><div class="cm-ev-d-sec-title">证据窗（前后 ' + win + ' 秒遥测）</div>';
      if (recs.length) {
        html += '<div class="cm-ev-evi-count">' + recs.length + ' 条原始记录</div>';
        html += '<table class="cm-ev-evi-table"><thead><tr>' +
          '<th>时间</th><th>设备</th><th>负荷</th><th>电量</th><th>来源</th></tr></thead><tbody>';
        recs.slice(0, 30).forEach(function (r) {
          var tele = (r.telemetry) || {};
          html += '<tr>' +
            '<td class="cm-mono">' + CM.esc((r.timestamp || '').replace('T', ' ').slice(11, 19)) + '</td>' +
            '<td class="cm-mono">' + CM.esc(r.device_id || '') + '</td>' +
            '<td>' + (tele.load_score != null ? tele.load_score.toFixed(2) : '--') + '</td>' +
            '<td>' + (tele.battery_level != null ? tele.battery_level + '%' : (tele.battery_pct != null ? tele.battery_pct + '%' : '--')) + '</td>' +
            '<td>' + CM.srcTag(r.source_type) + '</td>' +
          '</tr>';
        });
        html += '</tbody></table>';
        if (recs.length > 30) html += '<div class="cm-ev-empty">… 仅展示前 30 条，完整 ' + recs.length + ' 条可导出。</div>';
      } else {
        html += '<div class="cm-ev-empty">无证据窗记录（事件未关联设备或无遥测）。</div>';
      }
      html += '</div>';

      // 处置记录（handlings）
      html += '<div class="cm-ev-d-section"><div class="cm-ev-d-sec-title">处置记录（审计链路）</div>';
      if (handlings.length) {
        html += '<ul class="cm-ev-handlings">';
        handlings.forEach(function (h) {
          var act = h.action || '--';
          var by = h.handler_id || h.handled_by || '--';
          var at = (h.handled_at || h.ts || '').replace('T', ' ');
          var cmt = h.comment || '';
          var ref = h.audit_ref ? '<span class="cm-mono cm-ev-audit-ref">审计 ' + CM.esc(h.audit_ref) + '</span>' : '';
          html += '<li>' +
            '<span class="cm-badge cm-badge-muted">' + CM.esc(act) + '</span> ' +
            '<span class="cm-mono">' + CM.esc(at) + '</span> · ' +
            '<span>' + CM.esc(by) + '</span>' +
            (cmt ? '<div class="cm-ev-handling-cmt">' + CM.esc(cmt) + '</div>' : '') +
            ref +
          '</li>';
        });
        html += '</ul>';
      } else {
        html += '<div class="cm-ev-empty">尚无处置记录。</div>';
      }
      html += '</div>';

      ex.innerHTML = html;
    },

    // 绑定详情区按钮：跳转 / 状态变更 / 评论 / 现场事实
    _bindDetailActions: function (e) {
      var det = document.getElementById('cm-ev-detail');
      if (!det) return;
      var self = this;
      det.querySelectorAll('[data-jump]').forEach(function (b) {
        b.addEventListener('click', function () {
          CM.selectEntity(b.dataset.jump);
          CM.setTab('timeline');
        });
      });
      det.querySelectorAll('[data-act]').forEach(function (b) {
        b.addEventListener('click', function () {
          var act = b.dataset.act;
          if (act === 'status') self._updateStatus(e, b.dataset.status);
          else if (act === 'comment') self._addComment(e);
          else if (act === 'sitefact') self._markSiteFact(e);
        });
      });
    },

    // 调用后端更新事件状态
    _updateStatus: function (e, status) {
      var cmt = (document.getElementById('ev-comment').value || '').trim();
      if ((status === 'closed' || status === 'dismissed') && !cmt) {
        alert('关闭与驳回必须填写理由（人在回路审计要求）');
        return;
      }
      if (CM.state.dataSource !== 'backend') {
        alert('离线样本模式：不调用 /api/events/{id}/status。请启动 backend 后再处置。');
        return;
      }
      var self = this;
      CM.api.updateEventStatus(e.event_id, status, cmt, status).then(function () {
        // 本地同步状态，避免等下次轮询
        e.status = status;
        if (e.handling) e.handling.status = status;
        CM.eventCenter._refreshListOnly();
        CM.eventCenter._renderDetail(e);
        CM.renderTopbar();
      }).catch(function (err) {
        alert('状态更新失败：' + (err.message || ''));
      });
    },

    // 调用后端追加评论
    _addComment: function (e) {
      var cmt = (document.getElementById('ev-comment').value || '').trim();
      if (!cmt) { alert('评论不能为空'); return; }
      if (CM.state.dataSource !== 'backend') {
        alert('离线样本模式：不调用 /api/events/{id}/comment。');
        return;
      }
      CM.api.addEventComment(e.event_id, cmt, 'operator').then(function () {
        document.getElementById('ev-comment').value = '';
        // 重新拉取详情以显示新评论
        CM.api.fetchEventDetail(e.event_id).then(function (d) {
          CM.eventCenter._renderDetailEnhanced(e, d);
        }).catch(function () {});
      }).catch(function (err) {
        alert('评论失败：' + (err.message || ''));
      });
    },

    // Task 22：标记现场事实（写入评论 + 状态变更，可审计）
    _markSiteFact: function (e) {
      var srcSel = document.getElementById('ev-sitefact-src');
      var noteEl = document.getElementById('ev-sitefact-note');
      var src = (srcSel && srcSel.value) || '';
      var note = (noteEl && noteEl.value || '').trim();
      if (!src) { alert('请选择以哪个来源为现场事实'); return; }
      var srcLabel = srcSel.options[srcSel.selectedIndex].text;
      var cmt = '【人工标记现场事实】' + srcLabel + (note ? '；说明：' + note : '');
      if (CM.state.dataSource !== 'backend') {
        alert('离线样本模式：不调用 /api/events/{id}/comment。请启动 backend 后再标记。');
        return;
      }
      var self = this;
      // 先写评论，再标记为已确认（人工裁定后视为已确认）
      CM.api.addEventComment(e.event_id, cmt, 'operator').then(function () {
        return CM.api.updateEventStatus(e.event_id, 'confirmed', cmt, 'mark_site_fact');
      }).then(function () {
        e.status = 'confirmed';
        CM.eventCenter._refreshListOnly();
        CM.eventCenter._renderDetail(e);
      }).catch(function (err) {
        alert('标记现场事实失败：' + (err.message || ''));
      });
    }
  };
})();
