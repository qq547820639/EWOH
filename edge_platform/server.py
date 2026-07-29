#!/usr/bin/env python3
"""EWOH 平台服务层（纯标准库 HTTP 服务）。

覆盖任务：
- Task 4  平台数据源切换：全部数据接口读持久层 Storage，支持 real/controlled_test/simulated 过滤与来源标识
- Task 5  历史回放与原始数据导出（按设备+时间段，回放态/实时态区分）
- Task 15 九页 API 支撑：来源/更新时间/质量/版本/异常/证据入口
- Task 19 演示闭环：一键重置与六步演示指引
安全边界：本服务不提供任何写入急停、限扭、关节实时控制等安全闭环参数的接口。
"""
import json
import threading
import time
from datetime import datetime, timedelta
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs

from . import services

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
OFFLINE_AFTER_SEC = 20      # 超过该时长无新遥测即判定离线（掉线可视）
EVIDENCE_WINDOW_SEC = 30    # 事件证据窗口：前后各 30 秒
SOURCE_LABELS = {"real": "REAL DEVICE", "controlled_test": "受控数据", "simulated": "模拟数据"}

now_iso = lambda: services.iso(datetime.now())
parse_ts = services.parse_ts


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

        # ---- 基础工具 ----
        def send_json(self, obj, status=200, download=None):
            data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
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

        # ---- GET 路由 ----
        def do_GET(self):
            p = urlparse(self.path).path
            try:
                if p == "/api/status":
                    return self.send_json(self.api_status())
                if p == "/api/devices":
                    items = [_device_view(ctx, d) for d in _filter_source(ctx.storage.list_devices(), self.arg("source"))]
                    return self.send_json({"items": items, "now": now_iso(), "offline_after_sec": OFFLINE_AFTER_SEC})
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
                if p == "/api/event":
                    return self.api_event_detail()
                if p == "/api/tasks/assignments":
                    return self.send_json({"items": ctx.assignments})
                if p == "/api/demo/guide":
                    return self.send_json({"steps": DEMO_STEPS})
            except BrokenPipeError:
                return
            except Exception as e:  # 统一错误出口，避免泄露内部细节
                return self.send_json({"error": "请求处理失败", "detail": str(e)}, 500)
            return super().do_GET()

        # ---- POST 路由 ----
        def do_POST(self):
            p = urlparse(self.path).path
            payload = self.read_json()
            try:
                if p == "/api/event/status":
                    return self.api_event_status(payload)
                if p == "/api/tasks/recommend":
                    return self.send_json(services.recommend(ctx.storage, ctx.assignments, payload, ctx.device_online))
                if p == "/api/tasks/confirm":
                    res = services.confirm_assignment(ctx.storage, ctx.assignments, payload, ctx.device_online)
                    return self.send_json(res, 200 if res.get("ok") else 409)
                if p == "/api/query":
                    return self.send_json(services.answer(ctx.storage, payload.get("question", ""),
                                                          ctx.device_online, ctx.assignments))
                if p == "/api/scenario/evaluate":
                    return self.send_json(services.evaluate_scenario(payload))
                if p == "/api/reset":
                    return self.api_reset()
            except BrokenPipeError:
                return
            except Exception as e:
                return self.send_json({"error": "请求处理失败", "detail": str(e)}, 500)
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

        def api_event_detail(self):
            """事件详情 + 前后各 30 秒证据窗口（可追溯到原始数据）。"""
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
            evt["source_label"] = SOURCE_LABELS.get(evt.get("source_type"), evt.get("source_type"))
            return self.send_json({"event": evt, "evidence_window_sec": EVIDENCE_WINDOW_SEC,
                                   "evidence_records": records, "now": now_iso()})

        def api_event_status(self, payload):
            eid, status = payload.get("event_id"), payload.get("status")
            if status not in ("open", "confirmed", "closed", "dismissed"):
                return self.send_json({"error": "非法状态"}, 400)
            handling = payload.get("handling") or {}
            handling.setdefault("handled_by", payload.get("handled_by", ""))
            handling.setdefault("handled_at", now_iso())
            ctx.storage.update_event_status(eid, status, handling)
            return self.send_json({"ok": True, "event": services.norm_event(ctx.storage.get_event(eid))})

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
            return self.send_json({"ok": True, "note": note, "now": now_iso()})

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
