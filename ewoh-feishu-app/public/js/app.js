/* ====================================================================
 * EWOH 外骨骼作业监督平台 — 前端逻辑
 * 纯原生 JS，无框架。通过 fetch 调用后端 REST API（localhost:3000）。
 * ==================================================================== */

(function () {
  "use strict";

  /* ---------- 配置 ---------- */
  // 后端运行在 localhost:3000；同源时为空字符串也可，这里显式指定以兼容 file:// 调试
  const API_BASE = "http://localhost:3000";
  const POLL_FAST_MS = 2000;   // 状态卡片 + 最新遥测
  const POLL_LIST_MS = 5000;   // 列表 / 曲线刷新

  /* ---------- 全局状态 ---------- */
  const state = {
    currentTab: "dashboard",
    eventFilterStatus: "open",
    auditFilterAction: "",
    dashChartDeviceId: null,   // 看板曲线所选用设备
    deviceChartDeviceId: null, // 设备页曲线所选用设备
    cachedDevices: [],         // /api/devices 缓存（供快照合并使用）
  };

  /* ---------- DOM 引用 ---------- */
  const $ = (id) => document.getElementById(id);
  const dom = {
    statusCards: $("statusCards"),
    latestStrip: $("latestStrip"),
    dashDevices: $("dashDevices"),
    dashEvents: $("dashEvents"),
    dashChart: $("dashChart"),
    dashChartTitle: $("dashChartTitle"),
    dashLegend: $("dashLegend"),
    eventsList: $("eventsList"),
    devicesList: $("devicesList"),
    deviceChart: $("deviceChart"),
    deviceChartTitle: $("deviceChartTitle"),
    deviceLegend: $("deviceLegend"),
    auditList: $("auditList"),
    modal: $("eventModal"),
    eventDetail: $("eventDetail"),
    pollIndicator: $("pollIndicator"),
    clock: $("clock"),
  };

  /* ====================================================================
   * 工具函数
   * ==================================================================== */

  async function fetchJSON(url) {
    const res = await fetch(API_BASE + url, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error("HTTP " + res.status + " @ " + url);
    return res.json();
  }

  async function postJSON(url, body) {
    const res = await fetch(API_BASE + url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body || {}),
    });
    if (!res.ok) throw new Error("HTTP " + res.status + " @ " + url);
    return res.json().catch(() => ({}));
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function formatTime(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
           " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }

  function timeAgo(iso) {
    if (!iso) return "—";
    const t = new Date(iso).getTime();
    if (isNaN(t)) return String(iso);
    const diff = Math.max(0, Date.now() - t) / 1000;
    if (diff < 10) return "刚刚";
    if (diff < 60) return Math.floor(diff) + " 秒前";
    if (diff < 3600) return Math.floor(diff / 60) + " 分钟前";
    if (diff < 86400) return Math.floor(diff / 3600) + " 小时前";
    if (diff < 86400 * 30) return Math.floor(diff / 86400) + " 天前";
    return formatTime(iso);
  }

  function setPollState(ok) {
    dom.pollIndicator.dataset.state = ok ? "ok" : "err";
    dom.pollIndicator.textContent = ok ? "已连接" : "连接异常";
  }

  /* ====================================================================
   * 通用渲染片段
   * ==================================================================== */

  function batteryBar(pct) {
    const p = Math.max(0, Math.min(100, Number(pct)));
    const v = isNaN(p) ? 0 : p;
    const color = v > 50 ? "var(--green)" : v > 20 ? "var(--yellow)" : "var(--red)";
    return '<div class="battery">' +
      '<div class="battery-track"><div class="battery-fill" style="width:' + v + "%;background:" + color + '"></div></div>' +
      '<span>' + (isNaN(p) ? "—" : v + "%") + "</span></div>";
  }

  function onlineBadge(online) {
    return online
      ? '<span class="badge badge-online">在线</span>'
      : '<span class="badge badge-offline">离线</span>';
  }

  function statusBadge(status) {
    const map = { open: ["badge-open", "进行中"], handled: ["badge-handled", "已处理"], closed: ["badge-closed", "已关闭"] };
    const m = map[status];
    return m ? '<span class="badge ' + m[0] + '">' + m[1] + "</span>"
             : '<span class="badge">' + escapeHtml(status || "—") + "</span>";
  }

  function severityBadge(sev) {
    if (sev === "L2") return '<span class="badge badge-L2">L2 严重</span>';
    if (sev === "L1") return '<span class="badge badge-L1">L1 警告</span>';
    return '<span class="badge">' + escapeHtml(sev || "—") + "</span>";
  }

  function typeBadge(type) {
    return '<span class="badge badge-type">' + escapeHtml(type || "—") + "</span>";
  }

  function qualityBadge(q) {
    const map = { normal: ["badge-q-normal", "正常"], warning: ["badge-q-warning", "警告"], error: ["badge-q-error", "异常"] };
    const m = map[q];
    return m ? '<span class="badge ' + m[0] + '">' + m[1] + "</span>"
             : '<span class="badge">' + escapeHtml(q || "—") + "</span>";
  }

  function empty(text) {
    return '<div class="empty">' + escapeHtml(text) + "</div>";
  }

  /* ====================================================================
   * 看板：状态卡片
   * ==================================================================== */

  function renderStatusCards(s) {
    const cards = [
      { label: "设备总数", value: s.devices_total, icon: "📟", cls: "" },
      { label: "在线设备", value: s.devices_online, icon: "🟢", cls: "s-green", sub: s.devices_total != null ? "共 " + s.devices_total + " 台" : "" },
      { label: "活跃事件", value: s.events_open, icon: "⚠️", cls: "s-orange", sub: s.events_total != null ? "累计 " + s.events_total : "" },
      { label: "遥测帧数", value: s.telemetry_total, icon: "📈", cls: "s-teal" },
    ];
    dom.statusCards.innerHTML = cards.map((c) =>
      '<div class="status-card ' + c.cls + '">' +
        '<div class="status-icon">' + c.icon + "</div>" +
        '<div class="status-info">' +
          '<div class="status-value">' + (c.value ?? "—") + "</div>" +
          '<div class="status-label">' + escapeHtml(c.label) + "</div>" +
          (c.sub ? '<div class="status-sub">' + escapeHtml(c.sub) + "</div>" : "") +
        "</div>" +
      "</div>"
    ).join("");
  }

  /* ====================================================================
   * 看板：最新遥测快照（/api/telemetry/latest）
   * ==================================================================== */

  function renderLatestStrip(latest) {
    if (!latest || typeof latest !== "object") {
      dom.latestStrip.innerHTML = empty("暂无遥测数据");
      return;
    }
    const ids = Object.keys(latest);
    if (!ids.length) { dom.latestStrip.innerHTML = empty("暂无遥测数据"); return; }
    dom.latestStrip.innerHTML = ids.map((id) => {
      const d = latest[id] || {};
      return '<div class="latest-tile">' +
        '<div class="lt-head"><span class="lt-id">' + escapeHtml(id) + "</span>" +
        '<span class="lt-time">' + timeAgo(d.ts) + "</span></div>" +
        '<div class="lt-metrics">' +
          metricCell(d.pitch_deg, "°", "var(--accent)") +
          metricCell(d.torque_nm, "Nm", "var(--orange)") +
          metricCell(d.battery_pct, "%", "var(--green)") +
        "</div>" +
        '<div style="margin-top:6px">' + qualityBadge(d.quality_status) + "</div>" +
      "</div>";
    }).join("");
  }

  function metricCell(val, unit, color) {
    const v = val == null ? "—" : (Number(val).toFixed(1));
    return '<div class="lt-metric"><div class="m-val" style="color:' + color + '">' + v + "</div>" +
           '<div class="m-lbl">' + unit + "</div></div>";
  }

  /* ====================================================================
   * 看板：设备健康列表
   * ==================================================================== */

  function renderDashDevices(devices) {
    if (!devices || !devices.length) {
      dom.dashDevices.innerHTML = empty("暂无设备");
      return;
    }
    dom.dashDevices.innerHTML =
      '<div class="table-head"><div class="cell">设备</div><div class="cell">工人</div>' +
      '<div class="cell">电量</div><div class="cell">状态</div><div class="cell">通信</div></div>' +
      devices.map((d) =>
        '<div class="row' + (state.dashChartDeviceId === d.device_id ? " selected" : "") + '" data-device-dash="' + escapeHtml(d.device_id) + '">' +
          '<div class="cell"><strong>' + escapeHtml(d.device_id) + "</strong></div>" +
          '<div class="cell">' + escapeHtml(d.worker_name || "—") + "</div>" +
          '<div class="cell">' + batteryBar(d.battery_pct) + "</div>" +
          '<div class="cell">' + onlineBadge(d.online) + "</div>" +
          '<div class="cell">' + timeAgo(d.last_telemetry_at) + "</div>" +
        "</div>"
      ).join("");
  }

  /* ====================================================================
   * 看板：活跃事件列表
   * ==================================================================== */

  function eventRowHTML(e) {
    return '<div class="event-row" data-event="' + escapeHtml(e.event_id) + '">' +
      '<div class="event-main">' +
        '<div class="event-title">' + escapeHtml(e.title || e.event_code || "事件 " + (e.event_id || "")) + "</div>" +
        '<div class="event-meta">' +
          typeBadge(e.event_type) +
          severityBadge(e.severity) +
          statusBadge(e.status) +
          '<span class="muted">设备 ' + escapeHtml(e.device_id || "—") + "</span>" +
          '<span class="muted">' + timeAgo(e.created_at) + "</span>" +
        "</div>" +
      "</div>" +
      '<button class="btn btn-primary btn-sm" data-event-btn="' + escapeHtml(e.event_id) + '">处置</button>' +
    "</div>";
  }

  function renderDashEvents(events) {
    if (!events || !events.length) {
      dom.dashEvents.innerHTML = empty("无活跃事件 🎉");
      return;
    }
    dom.dashEvents.innerHTML = events.map(eventRowHTML).join("");
  }

  /* ====================================================================
   * 看板：完整渲染
   * ==================================================================== */

  async function renderDashboard() {
    try {
      const [status, devices, events] = await Promise.all([
        fetchJSON("/api/status"),
        fetchJSON("/api/devices"),
        fetchJSON("/api/events?status=open&limit=50"),
      ]);
      state.cachedDevices = devices || [];
      renderStatusCards(status);
      renderDashDevices(devices);
      renderDashEvents(events);
      if (!state.dashChartDeviceId && devices && devices[0]) {
        state.dashChartDeviceId = devices[0].device_id;
      }
      await refreshDashChart();
      setPollState(true);
    } catch (err) {
      console.error("[dashboard]", err);
      setPollState(false);
    }
  }

  async function refreshDashChart() {
    if (!state.dashChartDeviceId) return;
    try {
      const data = await fetchJSON("/api/telemetry?device_id=" + encodeURIComponent(state.dashChartDeviceId) + "&limit=100");
      dom.dashChartTitle.textContent = "实时遥测曲线 — " + state.dashChartDeviceId;
      drawTelemetryChart(dom.dashChart, data);
      renderLegend(dom.dashLegend);
    } catch (err) {
      console.error("[dashChart]", err);
    }
  }

  /* ====================================================================
   * 快速轮询：状态卡片 + 最新遥测快照（每 2 秒）
   * ==================================================================== */

  async function pollFast() {
    try {
      const [status, latest] = await Promise.all([
        fetchJSON("/api/status"),
        fetchJSON("/api/telemetry/latest"),
      ]);
      renderStatusCards(status);
      renderLatestStrip(latest);
      setPollState(true);
    } catch (err) {
      console.error("[pollFast]", err);
      setPollState(false);
    }
  }

  /* ====================================================================
   * 事件页
   * ==================================================================== */

  async function renderEvents() {
    try {
      const q = state.eventFilterStatus ? ("status=" + state.eventFilterStatus + "&") : "";
      const list = await fetchJSON("/api/events?" + q + "limit=50");
      if (!list || !list.length) {
        dom.eventsList.innerHTML = empty("没有匹配的事件");
        return;
      }
      dom.eventsList.innerHTML = list.map(eventRowHTML).join("");
    } catch (err) {
      console.error("[events]", err);
      dom.eventsList.innerHTML = empty("事件列表加载失败");
    }
  }

  /* ---------- 事件详情 ---------- */

  async function renderEventDetail(eventId) {
    openModal();
    dom.eventDetail.innerHTML = empty("加载中…");
    try {
      const ev = await fetchJSON("/api/events/" + encodeURIComponent(eventId));
      dom.eventDetail.innerHTML =
        detailSection("基本信息", [
          kv("事件ID", escapeHtml(ev.event_id)),
          kv("设备", escapeHtml(ev.device_id || "—")),
          kv("事件码", escapeHtml(ev.event_code || "—")),
          kv("类型", typeBadge(ev.event_type)),
          kv("严重度", severityBadge(ev.severity)),
          kv("状态", statusBadge(ev.status)),
          kv("标题", escapeHtml(ev.title || "—")),
          kv("创建时间", timeAgo(ev.created_at) + " <span class='muted'>(" + formatTime(ev.created_at) + ")</span>"),
        ]) +
        detailSection("触发数据", '<pre class="code-block">' + escapeHtml(safeStringify(ev.trigger_data)) + "</pre>") +
        detailSection("证据快照", '<pre class="code-block">' + escapeHtml(safeStringify(ev.evidence)) + "</pre>") +
        detailSection("处置", handleFormHTML(ev.event_id));
      const form = document.getElementById("handleForm");
      if (form) form.addEventListener("submit", onHandleSubmit);
    } catch (err) {
      console.error("[eventDetail]", err);
      dom.eventDetail.innerHTML = empty("事件详情加载失败：" + err.message);
    }
  }

  function detailSection(title, content) {
    const body = Array.isArray(content) ? content.join("") : content;
    return '<div class="detail-section"><h4>' + escapeHtml(title) + "</h4>" + body + "</div>";
  }

  function kv(k, v) {
    return '<div class="kv"><span>' + escapeHtml(k) + "</span><b>" + v + "</b></div>";
  }

  function safeStringify(obj) {
    try { return JSON.stringify(obj ?? {}, null, 2); }
    catch { return String(obj); }
  }

  function handleFormHTML(eventId) {
    return '<form id="handleForm">' +
      '<input type="hidden" name="event_id" value="' + escapeHtml(eventId) + '">' +
      '<div class="form-row"><label>处理人 ID</label>' +
        '<input type="text" name="handler_id" placeholder="如 supervisor-01" required></div>' +
      '<div class="form-row"><label>动作</label><select name="action" required>' +
        '<option value="acknowledge">acknowledge — 确认</option>' +
        '<option value="resolve">resolve — 解决</option>' +
        '<option value="escalate">escalate — 上报</option>' +
        '<option value="comment">comment — 备注</option>' +
      "</select></div>" +
      '<div class="form-row"><label>备注</label>' +
        '<textarea name="comment" rows="3" placeholder="处置说明…"></textarea></div>' +
      '<button type="submit" class="btn btn-primary">提交处置</button>' +
    "</form>";
  }

  async function onHandleSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const fd = new FormData(form);
    const eventId = fd.get("event_id");
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = "提交中…";
    try {
      await handleEvent(eventId, {
        handler_id: fd.get("handler_id"),
        action: fd.get("action"),
        comment: fd.get("comment"),
      });
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "提交处置";
    }
  }

  async function handleEvent(eventId, payload) {
    try {
      await postJSON("/api/events/" + encodeURIComponent(eventId) + "/handle", payload);
      closeModal();
      // 刷新当前可能受影响的视图
      await renderEvents();
      await renderDashboard();
    } catch (err) {
      console.error("[handleEvent]", err);
      alert("处置失败：" + err.message);
    }
  }

  /* ====================================================================
   * 设备页
   * ==================================================================== */

  async function renderDevices() {
    try {
      const devices = await fetchJSON("/api/devices");
      state.cachedDevices = devices || [];
      if (!devices || !devices.length) {
        dom.devicesList.innerHTML = empty("暂无设备");
        return;
      }
      dom.devicesList.innerHTML =
        '<div class="table-head"><div class="cell">设备ID</div><div class="cell">工人</div>' +
        '<div class="cell">型号</div><div class="cell">电量</div><div class="cell">状态</div>' +
        '<div class="cell">最后通信</div></div>' +
        devices.map((d) =>
          '<div class="row' + (state.deviceChartDeviceId === d.device_id ? " selected" : "") + '" data-device-tab="' + escapeHtml(d.device_id) + '">' +
            '<div class="cell"><strong>' + escapeHtml(d.device_id) + "</strong></div>" +
            '<div class="cell">' + escapeHtml(d.worker_name || "—") + "</div>" +
            '<div class="cell">' + escapeHtml(d.device_model || "—") + "</div>" +
            '<div class="cell">' + batteryBar(d.battery_pct) + "</div>" +
            '<div class="cell">' + onlineBadge(d.online) + "</div>" +
            '<div class="cell">' + timeAgo(d.last_telemetry_at) + "</div>" +
          "</div>"
        ).join("");
      // 默认选中第一个设备
      if (!state.deviceChartDeviceId && devices[0]) {
        await loadDeviceChart(devices[0].device_id);
      }
    } catch (err) {
      console.error("[devices]", err);
      dom.devicesList.innerHTML = empty("设备列表加载失败");
    }
  }

  async function loadDeviceChart(deviceId) {
    state.deviceChartDeviceId = deviceId;
    // 高亮选中行
    dom.devicesList.querySelectorAll(".row").forEach((r) => {
      r.classList.toggle("selected", r.dataset.deviceTab === deviceId);
    });
    dom.deviceChartTitle.textContent = "遥测曲线 — " + deviceId;
    try {
      const data = await fetchJSON("/api/telemetry?device_id=" + encodeURIComponent(deviceId) + "&limit=100");
      drawTelemetryChart(dom.deviceChart, data);
      renderLegend(dom.deviceLegend);
    } catch (err) {
      console.error("[deviceChart]", err);
      drawTelemetryChart(dom.deviceChart, []);
    }
  }

  /* ====================================================================
   * 审计页
   * ==================================================================== */

  async function renderAudit() {
    try {
      const act = state.auditFilterAction ? ("action=" + encodeURIComponent(state.auditFilterAction) + "&") : "";
      const list = await fetchJSON("/api/audit?" + act + "limit=50");
      if (!list || !list.length) {
        dom.auditList.innerHTML = empty("暂无审计日志");
        return;
      }
      dom.auditList.innerHTML = list.map((a) =>
        '<div class="audit-row">' +
          '<div class="audit-line">' +
            '<span class="audit-action">' + escapeHtml(a.action || "—") + "</span>" +
            '<span class="audit-meta">操作人: ' + escapeHtml(a.actor_id || "—") + "</span>" +
            '<span class="audit-meta">' + escapeHtml(a.target_type || "—") + " / " + escapeHtml(a.target_id || "—") + "</span>" +
            '<span class="audit-meta">' + timeAgo(a.ts) + "</span>" +
          "</div>" +
          (a.detail ? '<div class="audit-detail">' + escapeHtml(a.detail) + "</div>" : "") +
        "</div>"
      ).join("");
    } catch (err) {
      console.error("[audit]", err);
      dom.auditList.innerHTML = empty("审计日志加载失败");
    }
  }

  /* ====================================================================
   * Canvas 遥测曲线绘制
   *   三条线：pitch(°) / torque(Nm) / battery(%)，各线按自身 min/max 归一化
   * ==================================================================== */

  const SERIES = [
    { key: "pitch_deg",   color: "#4f7cff", label: "pitch(°)" },
    { key: "torque_nm",   color: "#f97316", label: "torque(Nm)" },
    { key: "battery_pct", color: "#22c55e", label: "battery(%)" },
  ];

  function renderLegend(el) {
    if (!el) return;
    el.innerHTML = SERIES.map((s) =>
      "<span><i style=\"background:" + s.color + '"></i>' + s.label + "</span>"
    ).join("");
  }

  function drawTelemetryChart(canvas, data) {
    if (!canvas) return;
    // 适配 DPR 以获得清晰显示
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || canvas.width;
    const cssH = canvas.clientHeight || canvas.height;
    if (canvas.width !== Math.floor(cssW * dpr) || canvas.height !== Math.floor(cssH * dpr)) {
      canvas.width = Math.floor(cssW * dpr);
      canvas.height = Math.floor(cssH * dpr);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = cssW, H = cssH;

    // 背景
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#1a1d29";
    ctx.fillRect(0, 0, W, H);

    const padL = 52, padR = 16, padT = 16, padB = 34;
    const cw = Math.max(10, W - padL - padR);
    const ch = Math.max(10, H - padT - padB);

    // 网格
    ctx.strokeStyle = "#2f3447";
    ctx.lineWidth = 1;
    ctx.fillStyle = "#6b7280";
    ctx.font = "11px " + "ui-monospace, Menlo, monospace";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let i = 0; i <= 4; i++) {
      const y = padT + (ch * i) / 4;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(W - padR, y);
      ctx.stroke();
      ctx.fillText(String(100 - i * 25), padL - 6, y);
    }

    if (!data || !data.length) {
      ctx.fillStyle = "#6b7280";
      ctx.font = "13px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("暂无遥测数据", W / 2, H / 2);
      return;
    }

    // 按时间正序排序，保证曲线从左到右
    const pts = data.slice().sort((a, b) => new Date(a.ts) - new Date(b.ts));
    const n = pts.length;

    // X 坐标
    const xOf = (i) => padL + (n <= 1 ? cw / 2 : (cw * i) / (n - 1));

    // 各序列归一化绘制
    SERIES.forEach((s) => {
      const vals = pts.map((d) => Number(d[s.key]));
      let min = Infinity, max = -Infinity;
      for (const v of vals) {
        if (!isFinite(v)) continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (!isFinite(min) || !isFinite(max)) return; // 该序列无数据
      const range = max - min || 1;

      // 区域填充
      ctx.beginPath();
      pts.forEach((d, i) => {
        const v = Number(d[s.key]);
        const x = xOf(i);
        const y = padT + ch - ch * ((v - min) / range);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.lineTo(xOf(n - 1), padT + ch);
      ctx.lineTo(xOf(0), padT + ch);
      ctx.closePath();
      ctx.fillStyle = s.color + "22";
      ctx.fill();

      // 折线
      ctx.beginPath();
      pts.forEach((d, i) => {
        const v = Number(d[s.key]);
        const x = xOf(i);
        const y = padT + ch - ch * ((v - min) / range);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.stroke();

      // 末端点
      const last = pts[n - 1];
      const lv = Number(last[s.key]);
      const lx = xOf(n - 1);
      const ly = padT + ch - ch * ((lv - min) / range);
      ctx.beginPath();
      ctx.arc(lx, ly, 3, 0, Math.PI * 2);
      ctx.fillStyle = s.color;
      ctx.fill();

      // 左侧序列标注（min~max）
      ctx.fillStyle = s.color;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.font = "10px ui-monospace, Menlo, monospace";
      ctx.fillText(s.label + " " + fmtNum(min) + " ~ " + fmtNum(max), padL + 6, padT + 4 + SERIES.indexOf(s) * 14);
    });

    // X 轴时间标签（首/中/尾）
    ctx.fillStyle = "#6b7280";
    ctx.font = "10px ui-monospace, Menlo, monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    const tickIdx = [0, Math.floor((n - 1) / 2), n - 1];
    tickIdx.forEach((i) => {
      if (i < 0 || i >= n) return;
      const x = xOf(i);
      const label = shortTime(pts[i].ts);
      const tx = clamp(x - 14, padL, W - padR - 40);
      ctx.fillText(label, tx, padT + ch + 6);
    });
  }

  function fmtNum(v) {
    if (v == null || !isFinite(v)) return "—";
    return Number(v).toFixed(1);
  }

  function shortTime(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const p = (n) => String(n).padStart(2, "0");
    return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  /* ====================================================================
   * Modal 控制
   * ==================================================================== */

  function openModal() {
    dom.modal.classList.add("open");
    dom.modal.setAttribute("aria-hidden", "false");
  }
  function closeModal() {
    dom.modal.classList.remove("open");
    dom.modal.setAttribute("aria-hidden", "true");
  }

  /* ====================================================================
   * Tab 切换
   * ==================================================================== */

  function switchTab(tab) {
    state.currentTab = tab;
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    const panel = document.getElementById("panel-" + tab);
    if (panel) panel.classList.add("active");
    // 立即刷新当前 tab 内容
    refreshForTab(tab);
  }

  function refreshForTab(tab) {
    switch (tab) {
      case "dashboard": renderDashboard(); break;
      case "events":    renderEvents(); break;
      case "devices":   renderDevices(); break;
      case "audit":     renderAudit(); break;
    }
  }

  /* ====================================================================
   * 轮询
   * ==================================================================== */

  let fastTimer = null;
  let listTimer = null;

  function startPolling() {
    stopPolling();
    fastTimer = setInterval(pollFast, POLL_FAST_MS);
    listTimer = setInterval(() => {
      // 列表按当前 tab 刷新；看板曲线在 renderDashboard 内刷新
      refreshForTab(state.currentTab);
    }, POLL_LIST_MS);
  }

  function stopPolling() {
    if (fastTimer) clearInterval(fastTimer);
    if (listTimer) clearInterval(listTimer);
    fastTimer = listTimer = null;
  }

  /* ====================================================================
   * 时钟
   * ==================================================================== */

  function tickClock() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    dom.clock.textContent = p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }

  /* ====================================================================
   * 事件绑定
   * ==================================================================== */

  function bindEvents() {
    // Tab 切换
    document.getElementById("tabs").addEventListener("click", (e) => {
      const btn = e.target.closest(".tab");
      if (btn) switchTab(btn.dataset.tab);
    });

    // 事件筛选
    document.getElementById("eventFilters").addEventListener("click", (e) => {
      const btn = e.target.closest(".filter");
      if (!btn) return;
      state.eventFilterStatus = btn.dataset.status;
      document.querySelectorAll("#eventFilters .filter").forEach((b) => b.classList.toggle("active", b === btn));
      renderEvents();
    });
    document.getElementById("refreshEvents").addEventListener("click", renderEvents);

    // 审计刷新
    document.getElementById("refreshAudit").addEventListener("click", renderAudit);

    // 看板设备行 → 选中并刷新看板曲线
    dom.dashDevices.addEventListener("click", (e) => {
      const row = e.target.closest("[data-device-dash]");
      if (!row) return;
      state.dashChartDeviceId = row.dataset.deviceDash;
      dom.dashDevices.querySelectorAll(".row").forEach((r) => r.classList.toggle("selected", r === row));
      refreshDashChart();
    });

    // 设备页设备行 → 选中并加载曲线
    dom.devicesList.addEventListener("click", (e) => {
      const row = e.target.closest("[data-device-tab]");
      if (!row) return;
      loadDeviceChart(row.dataset.deviceTab);
    });

    // 事件行 → 打开详情（处置按钮也触发）
    const openEvent = (eventId) => { if (eventId) renderEventDetail(eventId); };
    dom.eventsList.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-event-btn]");
      if (btn) { e.stopPropagation(); openEvent(btn.dataset.eventBtn); return; }
      const row = e.target.closest("[data-event]");
      if (row) openEvent(row.dataset.event);
    });
    dom.dashEvents.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-event-btn]");
      if (btn) { e.stopPropagation(); openEvent(btn.dataset.eventBtn); return; }
      const row = e.target.closest("[data-event]");
      if (row) openEvent(row.dataset.event);
    });

    // Modal 关闭
    document.getElementById("modalClose").addEventListener("click", closeModal);
    dom.modal.addEventListener("click", (e) => { if (e.target === dom.modal) closeModal(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

    // 窗口尺寸变化时重绘曲线
    let resizeTimer = null;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        refreshDashChart();
        if (state.deviceChartDeviceId) loadDeviceChart(state.deviceChartDeviceId);
      }, 200);
    });

    // 页面隐藏时暂停轮询，节省资源
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) stopPolling();
      else { startPolling(); refreshForTab(state.currentTab); }
    });
  }

  /* ====================================================================
   * 启动
   * ==================================================================== */

  function init() {
    bindEvents();
    tickClock();
    setInterval(tickClock, 1000);
    // 首屏立即拉取
    pollFast();
    renderDashboard();
    startPolling();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
