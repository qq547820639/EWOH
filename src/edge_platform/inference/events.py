"""风险事件引擎：把规则 draft 落成结构化事件并维护证据窗口。

- handle_draft(draft)：无 end_time → 开事件（insert_event，status='open'，
  event_id=EVT-uuid8）；带 end_time → 收口（update_event_status → 'closed'，
  end_time 记录于 handling，受冻结契约 update_event_status(eid,status,handling)
  所限，end_time 无法写入独立列）。
- 证据：query_telemetry(device_id, start-30s, end+30s)，record_ids 上限 200 条，
  按 before/event/after 三段标注（70/60/70 配额，段内均匀抽样，保证前后
  各 30s 全窗口覆盖而非仅贴近事件的一段）。
- Task 17 事件证据字段补齐：evidence 增加 evidence_window_sec / evidence_quality /
  evidence_samples（各段样本数）/ evidence_summary（pitch 均值、torque 峰值等关键统计）；
  handling 增加 status / handler_id / action / comment / handled_at，统一开/关/处置结构。
- Task 22：aggregate_recent 对同设备多事件码在 5s 窗口内的 open 事件做保守聚合，
  返回聚合摘要（不修改原事件，不自动调用，由上层按需触发）。
- 事件可经 get_event 取回，含完整 trigger/evidence/handling；开/关均 publish 'event'。
"""

from . import ts_to_ms, ms_to_ts, new_id

# 证据分段配额（合计 200）
CAP_BEFORE = 70
CAP_EVENT = 60
CAP_AFTER = 70
QUERY_LIMIT = 5000

# Task 22: 聚合窗口（秒）
AGGREGATE_WINDOW_SEC = 5

# Task 17: 证据摘要关注的遥测字段（pitch 均值 / torque 峰值等）
_EVIDENCE_METRIC_FIELDS = ("pitch_deg", "torque_nm", "load_score", "battery_percent")


def _now_iso():
    """当前 ISO 8601 时间字符串（毫秒精度，UTC）。"""
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _even(xs, cap):
    """列表内均匀抽取至多 cap 条（含首尾），保持时间序。"""
    if len(xs) <= cap:
        return list(xs)
    step = (len(xs) - 1) / (cap - 1)
    return [xs[round(i * step)] for i in range(cap)]


class EventEngine:
    def __init__(self, storage, bus, window_sec=30):
        self.storage = storage
        self.bus = bus
        self.window_sec = window_sec
        self._open = {}  # (event_code, device_id) -> event_id

    # ---- 证据 ----
    def _rec_ts(self, r):
        return ts_to_ms(r.get("timestamp") or r.get("ts"))

    def _rec_quality(self, r):
        q = r.get("quality")
        if isinstance(q, dict):
            return q.get("status", "good")
        return r.get("quality_status", "good")

    @staticmethod
    def _rec_telemetry(r):
        """从记录中取 telemetry 负载 dict（兼容 real Storage 与 FakeStorage）。"""
        t = r.get("telemetry")
        if isinstance(t, dict):
            return t
        # real Storage 的 _tele_row 已把 payload_json 解析进 telemetry
        return {}

    def _build_evidence_summary(self, recs):
        """Task 17：从证据记录中提取关键统计量（pitch 均值 / torque 峰值等）。

        仅对 _EVIDENCE_METRIC_FIELDS 中出现的字段做均值/峰值聚合；缺失字段跳过。
        """
        summary = {"sample_count": len(recs)}
        buckets = {f: [] for f in _EVIDENCE_METRIC_FIELDS}
        for r in recs:
            t = self._rec_telemetry(r)
            for f in _EVIDENCE_METRIC_FIELDS:
                v = t.get(f)
                if v is None:
                    continue
                try:
                    buckets[f].append(float(v))
                except (TypeError, ValueError):
                    continue
        for f, vals in buckets.items():
            if not vals:
                continue
            summary[f"{f}_mean"] = round(sum(vals) / len(vals), 2)
            summary[f"{f}_peak"] = round(max(vals), 2)
        return summary

    def _build_evidence(self, device_id, start_ms, end_ms):
        w = self.window_sec * 1000
        recs = self.storage.query_telemetry(
            device_id, ms_to_ts(start_ms - w), ms_to_ts(end_ms + w), QUERY_LIMIT)
        recs = sorted(recs, key=self._rec_ts)
        before, event, after = [], [], []
        for r in recs:
            t = self._rec_ts(r)
            item = {"record_id": r.get("record_id"),
                    "segment": "before" if t < start_ms else ("after" if t > end_ms else "event")}
            if item["segment"] == "before":
                before.append(item)
            elif item["segment"] == "after":
                after.append(item)
            else:
                event.append(item)
        # 分段配额内均匀抽样：覆盖完整 ±30s，而非仅贴近事件的一小段
        ids = _even(before, CAP_BEFORE) + _even(event, CAP_EVENT) + _even(after, CAP_AFTER)
        n = len(recs)
        invalid = sum(1 for r in recs if self._rec_quality(r) == "invalid")
        non_good = sum(1 for r in recs if self._rec_quality(r) != "good")
        if n and invalid / n > 0.3:
            dq = "invalid"
        elif n and non_good:
            dq = "degraded"
        else:
            dq = "good"
        return {
            "window_before_sec": self.window_sec,
            "window_after_sec": self.window_sec,
            "record_ids": ids,
            "data_quality": dq,
            # Task 17：证据字段补齐
            "evidence_window_sec": self.window_sec,
            "evidence_quality": dq,
            "evidence_samples": {
                "before": len(before),
                "event": len(event),
                "after": len(after),
                "total": len(ids),
            },
            "evidence_summary": self._build_evidence_summary(recs),
        }

    # ---- 开/关事件 ----
    def handle_draft(self, draft):
        if draft.get("end_time"):
            return self._close(draft)
        return self._open_event(draft)

    def _open_event(self, draft):
        start_ms = ts_to_ms(draft["start_time"])
        evt = {
            "event_id": new_id("EVT"),
            "event_code": draft["event_code"],
            "severity": draft["severity"],
            "status": "open",
            "person_id": draft.get("person_id"),
            "device_id": draft.get("device_id"),
            "start_time": draft["start_time"],
            "end_time": None,
            "trigger": draft.get("trigger"),
            "evidence": self._build_evidence(draft["device_id"], start_ms, start_ms),
            "handling": {
                "status": "open",
                "handler_id": None,
                "action": None,
                "comment": None,
                "handled_at": None,
            },
            "source_type": draft.get("source_type"),
        }
        self.storage.insert_event(evt)
        self._open[(evt["event_code"], evt["device_id"])] = evt["event_id"]
        self.bus.publish("event", evt)
        return evt

    def _close(self, draft):
        key = (draft["event_code"], draft.get("device_id"))
        eid = self._open.pop(key, None)
        if eid is None:
            # 引擎重启后内存丢失：从存储扫描未关闭事件兜底
            for evt in self.storage.list_events(200):
                if (evt.get("event_code"), evt.get("device_id")) == key \
                        and evt.get("status") == "open":
                    eid = evt["event_id"]
                    break
        if eid is None:
            return None
        # Task 17：handling 统一结构（status/handler_id/action/comment/handled_at），
        # 同时保留 end_time/closed_by/close_reason/rule_version 等既有字段以兼容。
        handling = {
            "status": "closed",
            "handler_id": "rule_engine",
            "action": "auto_close",
            "comment": "condition_cleared",
            "handled_at": _now_iso(),
            "end_time": draft["end_time"],
            "closed_by": "rule_engine",
            "close_reason": "condition_cleared",
            "rule_version": (draft.get("trigger") or {}).get("rule_version"),
        }
        self.storage.update_event_status(eid, "closed", handling)
        evt = self.storage.get_event(eid)
        self.bus.publish("event", evt)
        return evt

    # ---- Task 22: 同设备多事件码聚合（保守实现） ----
    def aggregate_recent(self, device_id, ts_ms, window_sec=AGGREGATE_WINDOW_SEC):
        """对同设备在 [ts_ms - window, ts_ms] 窗口内的 open 事件做保守聚合。

        保守策略：不修改/关闭原事件，仅返回聚合摘要 dict。
        - 少于 2 条 open 事件时不聚合（返回 None）。
        - 聚合事件 event_code='AGGREGATE'，severity 取最高等级（L1>L2）。
        - aggregated_event_ids 列出被聚合的事件 ID（按 start_time 升序）。
        """
        w_ms = window_sec * 1000
        candidates = []
        for evt in self.storage.list_events(500):
            if evt.get("device_id") != device_id:
                continue
            if evt.get("status") != "open":
                continue
            start_ms = ts_to_ms(evt.get("start_time"))
            if start_ms is None:
                continue
            if ts_ms - w_ms <= start_ms <= ts_ms:
                candidates.append(evt)
        if len(candidates) < 2:
            return None
        candidates.sort(key=lambda e: ts_to_ms(e.get("start_time")))
        # severity 取最高等级（L1 > L2 > L3 ...）
        sev_order = {"L1": 3, "L2": 2, "L3": 1}
        worst = min(candidates, key=lambda e: -sev_order.get(e.get("severity"), 0))
        return {
            "event_id": new_id("AGG"),
            "event_code": "AGGREGATE",
            "severity": worst.get("severity"),
            "device_id": device_id,
            "start_time": candidates[0].get("start_time"),
            "aggregated_event_ids": [e["event_id"] for e in candidates],
            "aggregated_event_codes": [e.get("event_code") for e in candidates],
            "window_sec": window_sec,
            "as_of_ts": ms_to_ts(ts_ms),
        }
