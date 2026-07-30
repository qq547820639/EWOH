#!/usr/bin/env python3
"""EWOH 平台服务层（纯标准库 HTTP 服务）。

覆盖任务：
- Task 4  平台数据源切换：全部数据接口读持久层 Storage，支持 real/controlled_test/simulated 过滤与来源标识
- Task 5  历史回放与原始数据导出（按设备+时间段，回放态/实时态区分）
- Task 15 九页 API 支撑：来源/更新时间/质量/版本/异常/证据入口
- Task 19 演示闭环：一键重置与六步演示指引
- 阶段 2（Task 14/15/16/17）：迁移/保留/撤回/审计/限流/请求 ID/幂等键；新增
  设备详情、设备健康、事件评论、审计/模型/规则列表、鉴权占位等端点
安全边界：本服务不提供任何写入急停、限扭、关节实时控制等安全闭环参数的接口。
"""
import json
import os
import threading
import time
import uuid
from datetime import datetime, timedelta
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs

from . import services

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
MIGRATIONS_DIR = ROOT / "migrations"
OFFLINE_AFTER_SEC = 20      # 超过该时长无新遥测即判定离线（掉线可视）
# 事件证据窗口（前后各 N 秒）：阶段 2 改读 EWOH_EVIDENCE_WINDOW_SEC 环境变量
EVIDENCE_WINDOW_SEC = int(os.environ.get("EWOH_EVIDENCE_WINDOW_SEC") or 30)
SOURCE_LABELS = {"real": "REAL DEVICE", "controlled_test": "受控数据", "simulated": "模拟数据"}

# 全局限流（Task 16）：每 IP 每 60 秒最多 100 次请求
RATE_LIMIT_WINDOW_SEC = 60
RATE_LIMIT_MAX_REQUESTS = 100

now_iso = lambda: services.iso(datetime.now())
parse_ts = services.parse_ts


class _RateLimiter:
    """简单的内存计数器限流：每 IP 一个滑动窗口（线程安全）。

    生产环境如需分布式限流可换 Redis；阶段 2 仅占位实现。
    """
    def __init__(self, window_sec=RATE_LIMIT_WINDOW_SEC, max_req=RATE_LIMIT_MAX_REQUESTS):
        self.window_sec = window_sec
        self.max_req = max_req
        self._lock = threading.Lock()
        self._buckets = {}  # ip -> [(ts, ...), ...]

    def allow(self, ip):
        now = time.time()
        cutoff = now - self.window_sec
        with self._lock:
            hits = [t for t in self._buckets.get(ip, []) if t >= cutoff]
            if len(hits) >= self.max_req:
                self._buckets[ip] = hits
                return False
            hits.append(now)
            self._buckets[ip] = hits
            return True


# 进程级单例（多 Handler 实例共享）
_RATE_LIMITER = _RateLimiter()


class Context:
    """平台运行上下文：依赖按契约注入（联调前可注入 stub）。"""
    def __init__(self, storage, bus=None, pipeline=None, registry=None, rules=None, manager=None):
        self.storage = storage
        self.bus = bus
        self.pipeline = pipeline
        self.registry = registry
        self.rules = rules
        self.manager = manager
        self.started_at = time.time()
        self.assignments = []   # 人工确认派工记录（演示会话级，不自动派工）
        self.lock = threading.Lock()

    def device_online(self, d):
        """掉线判定：online 标志 + last_seen 新鲜度双重判断。"""
        last = parse_ts(d.get("last_seen"))
        fresh = bool(last) and (datetime.now().astimezone() - last).total_seconds() <= OFFLINE_AFTER_SEC
        return bool(d.get("online")) and fresh


def _device_view(ctx, d):
    v = dict(d)
    v["online"] = ctx.device_online(d)
    v["source_label"] = SOURCE_LABELS.get(d.get("source_type"), d.get("source_type"))
    return v


def _filter_source(items, source):
    if source in SOURCE_LABELS:
        return [x for x in items if x.get("source_type") == source]
    return items


def _latest_state(ctx, device_id):
    """实时态：最新一条遥测 + 最近推理结果。"""
    rec = services.norm_telemetry(ctx.storage.latest_telemetry(device_id))
    if not rec:
        return None
    end = parse_ts(rec.get("timestamp")) or datetime.now().astimezone()
    inf = ctx.storage.query_inference(device_id, services.iso(end - timedelta(seconds=10)),
                                      services.iso(end + timedelta(seconds=1)), 1)
    rec["inference"] = services.norm_inference(inf[-1]) if inf else None
    rec["source_label"] = SOURCE_LABELS.get(rec.get("source_type"), rec.get("source_type"))
    rec["mode"] = "realtime"
    return rec


def make_handler(ctx):
    class Handler(SimpleHTTPRequestHandler):
        def translate_path(self, path):
            parsed = urlparse(path).path
            if parsed.startswith("/api/"):
                return str(STATIC_DIR / "index.html")
            if parsed == "/":
                parsed = "/index.html"
            return str(STATIC_DIR / parsed.lstrip("/"))

        def log_message(self, fmt, *args):
            print("[EWOH]", fmt % args)

        # ---- 阶段 2 中间件 helpers（Task 16） ----
        def _client_ip(self):
            # 反代场景可读 X-Forwarded-For 第一段；本服务在内网，简单处理
            xff = self.headers.get("X-Forwarded-For", "")
            if xff:
                return xff.split(",")[0].strip()
            return self.client_address[0] if self.client_address else "unknown"

        def _request_id(self):
            """读取或生成 X-Request-ID；响应头回显。"""
            rid = self.headers.get("X-Request-ID") or uuid.uuid4().hex
            self._rid = rid
            return rid

        def _audit(self, action, object_type=None, object_id=None,
                   before=None, after=None, result="ok", actor=None):
            """审计 helper：只在 storage 提供 insert_audit 时调用，
            保证 stubs（无 insert_audit）路径同样可用。"""
            if hasattr(ctx.storage, "insert_audit"):
                try:
                    ctx.storage.insert_audit(
                        actor=actor or self._require_role(),
                        action=action, object_type=object_type, object_id=object_id,
                        before_json=before, after_json=after,
                        source_ip=self._client_ip(), request_id=getattr(self, "_rid", None),
                        result=result)
                except Exception:
                    pass  # 审计失败不应影响业务路径

        def _require_role(self, role=None):
            """角色占位：阶段 4 接 JWT 后改为从 token 解析。

            当前固定返回 "anonymous"（标识真实用户身份未接入）。
            """
            # TODO 阶段 4：解析 Authorization Bearer token，校验角色与权限
            return "anonymous"

        def _rate_limit(self):
            """限流检查；超限返回 False 并写入 429 响应。"""
            ip = self._client_ip()
            if not _RATE_LIMITER.allow(ip):
                self.send_json({"error": "too_many_requests",
                                "detail": "请求频率超过限制（每 IP 每 %d 秒 %d 次）"
                                          % (RATE_LIMIT_WINDOW_SEC, RATE_LIMIT_MAX_REQUESTS),
                                "retry_after_sec": RATE_LIMIT_WINDOW_SEC}, 429)
                return False
            return True

        def _check_idempotency(self):
            """幂等键检查（Idempotency-Key 头）。

            简单实现：在 ctx 内缓存 Idempotency-Key -> 上次响应快照，
            命中则直接回放，避免重复执行写入操作。未提供 key 时返回 None。
            """
            key = self.headers.get("Idempotency-Key")
            if not key:
                return None
            cache = getattr(ctx, "_idempotency_cache", None)
            if cache is None:
                cache = {}
                ctx._idempotency_cache = cache
            return cache.get(key)

        def _save_idempotency(self, payload):
            """记录幂等键的响应快照。"""
            key = self.headers.get("Idempotency-Key")
            if not key:
                return
            cache = getattr(ctx, "_idempotency_cache", None)
            if cache is None:
                cache = {}
                ctx._idempotency_cache = cache
            cache[key] = payload

        # ---- 基础工具 ----
        def send_json(self, obj, status=200, download=None):
            data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Request-ID", getattr(self, "_rid", "") or "")
            if download:
                self.send_header("Content-Disposition", 'attachment; filename="%s"' % download)
            self.end_headers()
            self.wfile.write(data)

        def read_json(self):
            n = int(self.headers.get("Content-Length", "0") or 0)
            try:
                return json.loads(self.rfile.read(n).decode("utf-8") or "{}")
            except ValueError:
                return {}

        def qs(self):
            return parse_qs(urlparse(self.path).query)

        def arg(self, name, default=""):
            return self.qs().get(name, [default])[0]

        def _path_part(self, prefix):
            """从 path 中提取 /api/<prefix>/<id> 形式的 id；不匹配返回 None。

            用于 /api/devices/{id}、/api/events/{id} 等路径参数解析。
            """
            p = urlparse(self.path).path
            prefix = prefix if prefix.endswith("/") else prefix + "/"
            if not p.startswith(prefix):
                return None
            tail = p[len(prefix):]
            if not tail or "/" in tail:
                return None
            return tail

        # ---- GET 路由 ----
        def do_GET(self):
            self._request_id()
            p = urlparse(self.path).path
            # 静态资源与 /api/ 路径分离：仅对 /api/ 应用限流
            if p.startswith("/api/"):
                if not self._rate_limit():
                    return
            try:
                if p == "/api/status":
                    return self.send_json(self.api_status())
                if p == "/api/devices":
                    items = [_device_view(ctx, d) for d in _filter_source(ctx.storage.list_devices(), self.arg("source"))]
                    return self.send_json({"items": items, "now": now_iso(), "offline_after_sec": OFFLINE_AFTER_SEC})
                # GET /api/devices/{id}/health：设备健康摘要
                if p.startswith("/api/devices/") and p.endswith("/health"):
                    hid = p[len("/api/devices/"):-len("/health")]
                    if hid and "/" not in hid:
                        return self.api_device_health(hid)
                # GET /api/devices/{id}：单个设备详情
                dev_id = self._path_part("/api/devices")
                if dev_id is not None:
                    return self.api_device_detail(dev_id)
                if p == "/api/people":
                    return self.send_json({"items": ctx.storage.list_people(), "now": now_iso()})
                if p == "/api/telemetry":
                    return self.api_latest()
                if p == "/api/telemetry/series":
                    return self.api_series()
                if p == "/api/telemetry/export":
                    return self.api_export()
                if p == "/api/inference":
                    return self.api_inference()
                if p == "/api/person/profile":
                    return self.api_profile()
                if p == "/api/events":
                    items = [services.norm_event(e) for e in ctx.storage.list_events(int(self.arg("limit", "100") or 100))]
                    for e in items:
                        e["source_label"] = SOURCE_LABELS.get(e.get("source_type"), e.get("source_type"))
                    return self.send_json({"items": _filter_source(items, self.arg("source")), "now": now_iso()})
                # GET /api/events/{id}：事件详情（与 /api/event?id= 等价，路径参数版）
                evt_id = self._path_part("/api/events")
                if evt_id is not None:
                    return self.api_event_detail(evt_id)
                if p == "/api/event":
                    return self.api_event_detail()
                if p == "/api/audit":
                    return self.api_audit()
                if p == "/api/models":
                    return self.api_models()
                if p == "/api/rules":
                    return self.api_rules()
                if p == "/api/me":
                    return self.send_json({"error": "auth_not_implemented",
                                           "detail": "鉴权与 /api/me 在阶段 4 实现"}, 501)
                if p == "/api/tasks/assignments":
                    return self.send_json({"items": ctx.assignments})
                if p == "/api/demo/guide":
                    return self.send_json({"steps": DEMO_STEPS})
            except BrokenPipeError:
                return
            except Exception as e:  # 统一错误出口，避免泄露内部细节
                return self.send_json({"error": "请求处理失败", "detail": str(e),
                                       "request_id": getattr(self, "_rid", "")}, 500)
            return super().do_GET()

        # ---- POST 路由 ----
        def do_POST(self):
            self._request_id()
            p = urlparse(self.path).path
            if not self._rate_limit():
                return
            payload = self.read_json()
            # 幂等键命中：直接回放上次响应（仅对 POST 写入有意义）
            cached = self._check_idempotency()
            if cached is not None:
                return self.send_json(cached)
            try:
                if p == "/api/event/status":
                    return self.api_event_status(payload)
                # POST /api/events/{id}/comment：事件评论
                if p.startswith("/api/events/") and p.endswith("/comment"):
                    eid = p[len("/api/events/"):-len("/comment")]
                    if eid and "/" not in eid:
                        return self.api_event_comment(eid, payload)
                if p == "/api/tasks/recommend":
                    return self.send_json(services.recommend(ctx.storage, ctx.assignments, payload, ctx.device_online))
                if p == "/api/tasks/confirm":
                    res = services.confirm_assignment(ctx.storage, ctx.assignments, payload, ctx.device_online)
                    self._save_idempotency(res)
                    return self.send_json(res, 200 if res.get("ok") else 409)
                if p == "/api/query":
                    return self.send_json(services.answer(ctx.storage, payload.get("question", ""),
                                                          ctx.device_online, ctx.assignments,
                                                          source=payload.get("source")))
                if p == "/api/scenario/evaluate":
                    return self.send_json(services.evaluate_scenario(payload))
                if p == "/api/reset":
                    return self.api_reset()
                if p == "/api/admin/retention-purge":
                    return self.api_retention_purge(payload)
                # POST /api/people/{id}/withdraw-consent
                if p.startswith("/api/people/") and p.endswith("/withdraw-consent"):
                    pid = p[len("/api/people/"):-len("/withdraw-consent")]
                    if pid and "/" not in pid:
                        return self.api_withdraw_consent(pid, payload)
                # 鉴权占位（Task 16）：返回 501，避免阻塞联调
                if p in ("/api/auth/login", "/api/auth/refresh"):
                    return self.send_json({"error": "auth_not_implemented",
                                           "detail": "鉴权在阶段 4 实现；当前使用匿名占位身份。"}, 501)
            except BrokenPipeError:
                return
            except Exception as e:
                return self.send_json({"error": "请求处理失败", "detail": str(e),
                                       "request_id": getattr(self, "_rid", "")}, 500)
            return self.send_json({"error": "not found"}, 404)

        # ---- API 实现 ----
        def api_status(self):
            try:
                counts = ctx.storage.counts()
                db_ok = isinstance(counts, dict)
            except Exception:
                counts, db_ok = {}, False
            latency = {}
            if ctx.pipeline and hasattr(ctx.pipeline, "latency_stats"):
                try:
                    latency = ctx.pipeline.latency_stats()
                except Exception:
                    latency = {}
            model = {"active": None, "versions": [], "mode": "rules_only"}
            if ctx.registry:
                try:
                    model = {"active": ctx.registry.active(), "versions": ctx.registry.versions(),
                             "mode": "model" if ctx.registry.active() else "rules_only"}
                except Exception:
                    pass
            services_health = {
                "gateway": "healthy",                       # 本 HTTP 网关
                "database": "healthy" if db_ok else "down", # SQLite 持久层
                "inference": "healthy" if ctx.pipeline else ("rules_only" if ctx.rules else "unknown"),
                "assistant": "healthy",                     # 本地白名单助手，无外部依赖
                "adapters": "healthy" if ctx.manager else "not_running",
            }
            return {"offline": True, "now": now_iso(),
                    "uptime_sec": round(time.time() - ctx.started_at),
                    "services": services_health, "db_counts": counts, "latency": latency,
                    "model": model, "rule_version": getattr(ctx.rules, "rule_version", None),
                    "listeners": getattr(ctx.manager, "listeners", {}),
                    "source_labels": SOURCE_LABELS,
                    "safety_boundary": "平台与大模型不得写入急停、限扭、关节实时控制等安全闭环参数。"}

        def api_latest(self):
            device_id = self.arg("device_id")
            if not device_id:
                devices = _filter_source(ctx.storage.list_devices(), self.arg("source"))
                device_id = devices[0]["device_id"] if devices else ""
            rec = _latest_state(ctx, device_id)
            if not rec:
                return self.send_json({"error": "no data", "device_id": device_id, "mode": "realtime"}, 404)
            return self.send_json(rec)

        def api_series(self):
            """回放态：按设备+时间段返回原始时间序列（正序）。"""
            device_id, start, end = self.arg("device_id"), self.arg("start"), self.arg("end")
            limit = int(self.arg("limit", "2000") or 2000)
            if not (device_id and parse_ts(start) and parse_ts(end)):
                return self.send_json({"error": "需要 device_id/start/end（ISO 时间）"}, 400)
            rows = ctx.storage.query_telemetry(device_id, services.iso(parse_ts(start)),
                                               services.iso(parse_ts(end)), limit)
            items = [services.norm_telemetry(r) for r in rows]
            inf = [services.norm_inference(r) for r in
                   ctx.storage.query_inference(device_id, services.iso(parse_ts(start)),
                                               services.iso(parse_ts(end)), limit)]
            for r in items:
                r["source_label"] = SOURCE_LABELS.get(r.get("source_type"), r.get("source_type"))
            return self.send_json({"device_id": device_id, "mode": "replay", "items": items,
                                   "inference": inf, "start": start, "end": end, "now": now_iso()})

        def api_export(self):
            """原始数据片段导出（Task 5）：JSON 附件下载，携带来源标识。"""
            device_id, start, end = self.arg("device_id"), self.arg("start"), self.arg("end")
            if not (device_id and parse_ts(start) and parse_ts(end)):
                return self.send_json({"error": "需要 device_id/start/end（ISO 时间）"}, 400)
            slice_ = ctx.storage.export_slice(device_id, services.iso(parse_ts(start)), services.iso(parse_ts(end)))
            if isinstance(slice_, list):
                slice_ = {"records": slice_}
            out = {"export_type": "raw_slice", "device_id": device_id, "start": start, "end": end,
                   "exported_at": now_iso(), "slice": slice_}
            fname = "ewoh_slice_%s_%s.json" % (device_id, datetime.now().strftime("%Y%m%d_%H%M%S"))
            return self.send_json(out, download=fname)

        def api_inference(self):
            device_id = self.arg("device_id")
            now = datetime.now().astimezone()
            start = parse_ts(self.arg("start")) or (now - timedelta(hours=24))
            end = parse_ts(self.arg("end")) or now
            limit = int(self.arg("limit", "200") or 200)
            items = [services.norm_inference(r) for r in
                     ctx.storage.query_inference(device_id, services.iso(start), services.iso(end), limit)]
            return self.send_json({"items": items, "now": now_iso()})

        def api_profile(self):
            """单人作业画像：人员 + 绑定设备 + 当前状态 + 24h 动作分布 + 未处置事件。"""
            pid = self.arg("person_id")
            person = next((p for p in ctx.storage.list_people() if p.get("person_id") == pid), None)
            if not person:
                return self.send_json({"error": "人员不存在"}, 404)
            dev = next((d for d in ctx.storage.list_devices() if d.get("person_id") == pid), None)
            now = datetime.now().astimezone()
            dist, latest, quality = {}, None, "unknown"
            if dev:
                latest = _latest_state(ctx, dev["device_id"])
                quality = (latest or {}).get("quality", {}).get("status", "unknown")
                start = services.iso(now - timedelta(hours=24))
                for r in ctx.storage.query_inference(dev["device_id"], start, services.iso(now), 2000):
                    r = services.norm_inference(r)
                    dist[r.get("label", "unknown")] = dist.get(r.get("label", "unknown"), 0) + 1
            metrics = services.person_metrics(ctx.storage, person, dev)
            events = [services.norm_event(e) for e in ctx.storage.list_events(100)
                      if services.norm_event(e).get("person_id") == pid]
            return self.send_json({"person": person, "skills": services.person_skills(person),
                    "device": _device_view(ctx, dev) if dev else None,
                    "latest": latest, "action_distribution_24h": dist, "metrics": metrics,
                    "events": events[:10], "quality": quality, "now": now_iso()})

        def api_event_detail(self, eid=None):
            """事件详情 + 前后各 EVIDENCE_WINDOW_SEC 秒证据窗口（可追溯到原始数据）。

            支持两种入参：
              - eid 位置参数：来自 /api/events/{id} 路径
              - 查询参数 id：来自旧版 /api/event?id=... （兼容保留）
            """
            if eid is None:
                eid = self.arg("id")
            evt = services.norm_event(ctx.storage.get_event(eid))
            if not evt:
                return self.send_json({"error": "事件不存在"}, 404)
            t0 = parse_ts(evt.get("start_time"))
            t1 = parse_ts(evt.get("end_time")) or t0
            records, dev_id = [], evt.get("device_id")
            if t0 and dev_id:
                rows = ctx.storage.query_telemetry(
                    dev_id, services.iso(t0 - timedelta(seconds=EVIDENCE_WINDOW_SEC)),
                    services.iso(t1 + timedelta(seconds=EVIDENCE_WINDOW_SEC)), 500)
                records = [services.norm_telemetry(r) for r in rows]
            # 同步写入 event_handling 流水（若 storage 支持）——记录证据窗口已读取
            if hasattr(ctx.storage, "insert_event_handling"):
                try:
                    ctx.storage.insert_event_handling(
                        event_id=eid, action="evidence_view", operator=self._require_role(),
                        comment={"window_sec": EVIDENCE_WINDOW_SEC,
                                  "record_count": len(records)})
                except Exception:
                    pass
            evt["source_label"] = SOURCE_LABELS.get(evt.get("source_type"), evt.get("source_type"))
            return self.send_json({"event": evt, "evidence_window_sec": EVIDENCE_WINDOW_SEC,
                                   "evidence_record_ids": [r.get("record_id") for r in records],
                                   "evidence_records": records, "now": now_iso()})

        def api_event_status(self, payload):
            eid, status = payload.get("event_id"), payload.get("status")
            if status not in ("open", "confirmed", "closed", "dismissed"):
                return self.send_json({"error": "非法状态"}, 400)
            handling = payload.get("handling") or {}
            handling.setdefault("handled_by", payload.get("handled_by", ""))
            handling.setdefault("handled_at", now_iso())
            before = services.norm_event(ctx.storage.get_event(eid)) if hasattr(ctx.storage, "get_event") else None
            ctx.storage.update_event_status(eid, status, handling)
            after = services.norm_event(ctx.storage.get_event(eid))
            # 写入事件处置流水（若 storage 支持）
            if hasattr(ctx.storage, "insert_event_handling"):
                try:
                    ctx.storage.insert_event_handling(
                        event_id=eid, action="status_change:%s" % status,
                        operator=payload.get("handled_by") or self._require_role(),
                        comment=handling)
                except Exception:
                    pass
            self._audit(action="EVENT_STATUS_CHANGE", object_type="risk_event",
                        object_id=eid, before=before, after=after,
                        actor=payload.get("handled_by"))
            self._save_idempotency({"ok": True, "event": after})
            return self.send_json({"ok": True, "event": after})

        def api_reset(self):
            """一键重置（Task 19）：清空演示派工与模拟态数据；真实数据必须保留。"""
            with ctx.lock:
                ctx.assignments.clear()
            note = "已清空人工确认记录。"
            if hasattr(ctx.storage, "reset_demo"):
                ctx.storage.reset_demo()
                note += "模拟/受控演示数据已重置；真实设备数据不受影响。"
            else:
                note += "持久层数据保持不动（真实数据不做清除）。"
            self._audit(action="DEMO_RESET", object_type="system", object_id="all",
                        after={"note": note})
            return self.send_json({"ok": True, "note": note, "now": now_iso()})

        # ============================================================
        # 阶段 2 新增端点
        # ============================================================

        def api_device_detail(self, device_id):
            """单个设备详情：基础信息 + 健康摘要 + 最新遥测 + 最近推理。"""
            dev = ctx.storage.get_device(device_id) if hasattr(ctx.storage, "get_device") else \
                  next((d for d in ctx.storage.list_devices() if d.get("device_id") == device_id), None)
            if not dev:
                return self.send_json({"error": "设备不存在"}, 404)
            view = _device_view(ctx, dev)
            view["health"] = (ctx.storage.device_health(device_id)
                              if hasattr(ctx.storage, "device_health") else None)
            view["latest"] = _latest_state(ctx, device_id)
            return self.send_json(view)

        def api_device_health(self, device_id):
            """设备健康：online/last_packet_ts/packet_loss_pct/clock_offset_ms/battery/
            fault/reconnect_count。

            若 storage 不提供 device_health，则用最新遥测 payload 推断。
            """
            if hasattr(ctx.storage, "device_health"):
                h = ctx.storage.device_health(device_id)
                if h is None:
                    return self.send_json({"error": "设备不存在"}, 404)
                h["online"] = ctx.device_online(ctx.storage.get_device(device_id)) \
                    if hasattr(ctx.storage, "get_device") else h.get("online")
                return self.send_json({"device_id": device_id, "health": h, "now": now_iso()})
            # stubs 路径：从 list_devices + latest_telemetry 推断
            dev = next((d for d in ctx.storage.list_devices() if d.get("device_id") == device_id), None)
            if not dev:
                return self.send_json({"error": "设备不存在"}, 404)
            latest = services.norm_telemetry(ctx.storage.latest_telemetry(device_id)) or {}
            payload = latest.get("telemetry", {}) or {}
            quality = latest.get("quality", {}) or {}
            h = {
                "device_id": device_id,
                "online": ctx.device_online(dev),
                "last_seen": dev.get("last_seen"),
                "last_packet_ts": latest.get("timestamp"),
                "packet_loss_pct": payload.get("packet_loss_pct") or quality.get("packet_loss_pct"),
                "clock_offset_ms": payload.get("clock_offset_ms"),
                "battery": payload.get("battery_percent") or payload.get("battery"),
                "fault": None if quality.get("status") == "good" else quality.get("status"),
                "reconnect_count": None,
                "source_type": dev.get("source_type"),
            }
            return self.send_json({"device_id": device_id, "health": h, "now": now_iso()})

        def api_event_comment(self, eid, payload):
            """事件评论：写入 event_handling，并审计。"""
            comment = payload.get("comment")
            if not comment:
                return self.send_json({"error": "评论内容不可为空"}, 400)
            evt = services.norm_event(ctx.storage.get_event(eid)) if hasattr(ctx.storage, "get_event") else None
            if not evt:
                return self.send_json({"error": "事件不存在"}, 404)
            operator = (payload.get("operator") or "").strip() or self._require_role()
            handling_id = None
            if hasattr(ctx.storage, "insert_event_handling"):
                handling_id = ctx.storage.insert_event_handling(
                    event_id=eid, action="comment", operator=operator, comment=comment)
            self._audit(action="EVENT_COMMENT", object_type="risk_event", object_id=eid,
                        after={"comment": comment, "operator": operator, "handling_id": handling_id},
                        actor=operator)
            return self.send_json({"ok": True, "handling_id": handling_id,
                                   "event_id": eid, "operator": operator,
                                   "comment": comment, "handled_at": now_iso()})

        def api_audit(self):
            """审计查询：支持 limit/action/actor/object_type 过滤。"""
            if not hasattr(ctx.storage, "list_audit"):
                return self.send_json({"items": [], "note": "当前持久层未提供审计能力"})
            limit = int(self.arg("limit", "100") or 100)
            action = self.arg("action") or None
            actor = self.arg("actor") or None
            object_type = self.arg("object_type") or None
            items = ctx.storage.list_audit(limit=limit, action=action, actor=actor,
                                            object_type=object_type)
            return self.send_json({"items": items, "now": now_iso(), "filter": {
                "limit": limit, "action": action, "actor": actor, "object_type": object_type}})

        def api_models(self):
            """模型列表：合并 registry（运行时） + storage.model_registry（持久化）。"""
            registry_info = {"active": None, "versions": [], "mode": "rules_only"}
            if ctx.registry:
                try:
                    registry_info = {"active": ctx.registry.active(),
                                      "versions": ctx.registry.versions(),
                                      "mode": "model" if ctx.registry.active() else "rules_only"}
                except Exception:
                    pass
            stored = []
            if hasattr(ctx.storage, "list_models"):
                try:
                    stored = ctx.storage.list_models()
                except Exception:
                    stored = []
            return self.send_json({"runtime": registry_info, "registry": stored,
                                   "rule_version": getattr(ctx.rules, "rule_version", None),
                                   "now": now_iso()})

        def api_rules(self):
            """规则列表：合并 ctx.rules（运行时）+ storage.rule_registry（持久化）。"""
            runtime = {"rule_version": getattr(ctx.rules, "rule_version", None),
                        "config": getattr(ctx.rules, "config", None)}
            stored = []
            if hasattr(ctx.storage, "list_rules"):
                try:
                    stored = ctx.storage.list_rules()
                except Exception:
                    stored = []
            return self.send_json({"runtime": runtime, "registry": stored, "now": now_iso()})

        def api_retention_purge(self, payload):
            """数据保留清理：删除早于 retention_days 的 telemetry/inference，保留事件与审计。

            管理员操作（阶段 2 鉴权未实现前为占位），写入审计。
            """
            retention_days = int(payload.get("retention_days", 30))
            person_id = payload.get("person_id")
            if not hasattr(ctx.storage, "retention_purge"):
                return self.send_json({"error": "当前持久层未提供 retention_purge 能力"}, 501)
            before = ctx.storage.counts() if hasattr(ctx.storage, "counts") else {}
            deleted = ctx.storage.retention_purge(retention_days, person_id=person_id)
            after = ctx.storage.counts() if hasattr(ctx.storage, "counts") else {}
            self._audit(action="RETENTION_PURGE", object_type="system",
                        object_id=person_id or "all",
                        before=before, after=after,
                        result="ok",
                        actor=payload.get("operator") or self._require_role())
            return self.send_json({"ok": True, "deleted": deleted,
                                   "retention_days": retention_days,
                                   "person_id": person_id,
                                   "before_counts": before, "after_counts": after,
                                   "now": now_iso()})

        def api_withdraw_consent(self, pid, payload):
            """授权撤回：更新 person.consent_status='withdrawn'，写 consent_record，
            并清理该人员的 telemetry/inference（保留事件与审计）。

            安全管理员操作（鉴权占位为 anonymous），入审计。
            """
            if not hasattr(ctx.storage, "withdraw_consent"):
                return self.send_json({"error": "当前持久层未提供 withdraw_consent 能力"}, 501)
            person = next((p for p in ctx.storage.list_people() if p.get("person_id") == pid), None)
            if not person:
                return self.send_json({"error": "人员不存在"}, 404)
            withdrawn_at = payload.get("withdrawn_at") or now_iso()
            reason = payload.get("reason")
            scope = payload.get("scope")
            operator = (payload.get("operator") or self._require_role())
            consent_id = ctx.storage.withdraw_consent(
                person_id=pid, withdrawn_at=withdrawn_at, reason=reason, scope=scope,
                source="admin", actor=operator)
            # 同步删除该人员的历史 telemetry / inference（保留 risk_event 与 audit_log）
            deleted = {"telemetry": 0, "inference": 0}
            if hasattr(ctx.storage, "retention_purge"):
                try:
                    deleted = ctx.storage.retention_purge(retention_days=0, person_id=pid)
                except Exception:
                    pass
            return self.send_json({"ok": True, "consent_id": consent_id,
                                   "person_id": pid, "withdrawn_at": withdrawn_at,
                                   "deleted": deleted,
                                   "note": "已撤回授权并清理该人员历史遥测；事件与审计保留。",
                                   "now": now_iso()})

    return Handler


DEMO_STEPS = [
    {"step": 1, "name": "断公网展示本地服务", "panel": "health", "hint": "拔掉外网后系统健康页全部本地服务保持 healthy"},
    {"step": 2, "name": "真机上线与人员绑定", "panel": "devices", "hint": "设备管理页出现 REAL DEVICE 标识与绑定人员"},
    {"step": 3, "name": "真人站立/行走/弯腰/搬举", "panel": "realtime", "hint": "实时态势页动作标签随真人动作变化"},
    {"step": 4, "name": "触发安全可控风险事件", "panel": "events", "hint": "事件中心出现结构化事件，可查看前后 30 秒证据"},
    {"step": 5, "name": "本地查询事件与人员状态", "panel": "assistant", "hint": "本地助手引用真实记录回答白名单问题"},
    {"step": 6, "name": "输入客户场景生成试点建议", "panel": "scenario", "hint": "场景评估器输出一页纸与捷顺下一步请求"},
]


def build_server(addr, ctx):
    return ThreadingHTTPServer(addr, make_handler(ctx))
