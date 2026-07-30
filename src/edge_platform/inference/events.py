"""风险事件引擎：把规则 draft 落成结构化事件并维护证据窗口。

- handle_draft(draft)：无 end_time → 开事件（insert_event，status='open'，
  event_id=EVT-uuid8）；带 end_time → 收口（update_event_status → 'closed'，
  end_time 记录于 handling，受冻结契约 update_event_status(eid,status,handling)
  所限，end_time 无法写入独立列）。
- 证据：query_telemetry(device_id, start-30s, end+30s)，record_ids 上限 200 条，
  按 before/event/after 三段标注（70/60/70 配额，段内均匀抽样，保证前后
  各 30s 全窗口覆盖而非仅贴近事件的一段）。
- 事件可经 get_event 取回，含完整 trigger/evidence/handling；开/关均 publish 'event'。
"""

from . import ts_to_ms, ms_to_ts, new_id

# 证据分段配额（合计 200）
CAP_BEFORE = 70
CAP_EVENT = 60
CAP_AFTER = 70
QUERY_LIMIT = 5000


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
            "handling": None,
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
        handling = {
            "end_time": draft["end_time"],
            "closed_by": "rule_engine",
            "close_reason": "condition_cleared",
            "rule_version": (draft.get("trigger") or {}).get("rule_version"),
        }
        self.storage.update_event_status(eid, "closed", handling)
        evt = self.storage.get_event(eid)
        self.bus.publish("event", evt)
        return evt
