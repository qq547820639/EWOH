"""Task 33 监控指标采集器（MetricsCollector）。

线程安全（threading.Lock），统一采集系统/设备/推理/业务四层指标：

- 系统级：uptime_seconds、db_counts（设备/人员/事件数）
- 设备级：online_count/offline_count、avg_packet_loss_pct、low_battery_count
- 推理级：inference_count、inference_p50_ms、inference_p95_ms、unknown_count、error_count
- 业务级：open_event_count、avg_event_close_hours、assignment_adoption_rate

设计为可注入单例：run.py 创建后传入 pipeline（record_inference）与 server（snapshot +
PrometheusExporter）。设备/数据库/事件计数等可派生指标在 snapshot() 时从注入的 storage
懒计算；服务器在生成快照前可通过 set_device_stats 注入实时设备级统计。

纯 Python 标准库实现。
"""

import threading
import time
from collections import deque

# 推理耗时样本上限（足够覆盖 P95 计算且避免无界增长）
_LATENCY_MAX = 10000
# 事件关闭耗时样本上限
_CLOSE_HOURS_MAX = 10000


def _percentile(sorted_xs, p):
    """从已排序样本计算百分位（最近秩法，与 inference/pipeline.py 保持一致）。"""
    n = len(sorted_xs)
    if not n:
        return 0.0
    idx = min(n - 1, max(0, int(round(p / 100.0 * n)) - 1))
    return sorted_xs[idx]


class MetricsCollector:
    """线程安全的统一监控指标采集器。

    可选注入 storage：用于 snapshot() 时派生 db_counts 与 open_event_count；
    未注入时这些派生指标回落到 0/空，不影响显式 record_* 计数。
    """

    def __init__(self, storage=None, start_time=None):
        self._storage = storage
        self._lock = threading.Lock()
        self._start = float(start_time) if start_time is not None else time.time()
        # 推理级
        self._inf_latencies = deque(maxlen=_LATENCY_MAX)
        self._inf_count = 0
        self._inf_unknown = 0
        self._inf_errors = 0
        # 业务级：事件开/闭
        self._event_open_total = 0
        self._event_close_hours = deque(maxlen=_CLOSE_HOURS_MAX)
        # 业务级：派工推荐/采纳
        self._recommend_count = 0
        self._confirmed_count = 0
        # 设备级（由 server 在生成快照前注入最新值）
        self._device_stats = {
            "online_count": 0,
            "offline_count": 0,
            "avg_packet_loss_pct": 0.0,
            "low_battery_count": 0,
        }
        # 系统级：db_counts 缓存（由 server 注入或从 storage 派生）
        self._db_counts = {}

    # ---- 推理级 ----
    def record_inference(self, duration_ms, label, error=False):
        """记录一次推理结果。

        - duration_ms：推理耗时（毫秒）
        - label：动作标签；"unknown" 计入 unknown_count
        - error：推理过程异常（不计入 P50/P95 样本，仅累加 error_count）
        """
        with self._lock:
            self._inf_count += 1
            if error:
                self._inf_errors += 1
                return
            if label == "unknown":
                self._inf_unknown += 1
            try:
                self._inf_latencies.append(float(duration_ms))
            except (TypeError, ValueError):
                # 非法耗时样本丢弃但不影响计数
                pass

    # ---- 业务级：事件 ----
    def record_event_open(self):
        """记录一次事件开启（累计计数）。"""
        with self._lock:
            self._event_open_total += 1

    def record_event_close(self, duration_hours):
        """记录一次事件关闭及其处置时长（小时）。"""
        with self._lock:
            try:
                self._event_close_hours.append(float(duration_hours))
            except (TypeError, ValueError):
                pass

    # ---- 业务级：派工 ----
    def record_recommendation(self):
        """记录一次任务推荐生成。"""
        with self._lock:
            self._recommend_count += 1

    def record_assignment_confirmed(self):
        """记录一次人工确认派工。"""
        with self._lock:
            self._confirmed_count += 1

    # ---- 设备级 / 系统级：由 server 注入 ----
    def set_device_stats(self, online_count, offline_count, avg_packet_loss_pct=0.0, low_battery_count=0):
        """注入设备级实时统计（由 server 在 snapshot 前调用）。"""
        with self._lock:
            self._device_stats = {
                "online_count": int(online_count),
                "offline_count": int(offline_count),
                "avg_packet_loss_pct": float(avg_packet_loss_pct or 0.0),
                "low_battery_count": int(low_battery_count),
            }

    def set_db_counts(self, counts):
        """注入数据库行数统计（可选；未注入则 snapshot 从 storage 派生）。"""
        with self._lock:
            self._db_counts = dict(counts or {})

    def bind_storage(self, storage):
        """绑定持久层引用，用于 snapshot() 派生 db_counts / open_event_count。

        run.py 在 storage 就绪后调用；也可在构造时通过 storage 参数传入。
        """
        with self._lock:
            self._storage = storage

    # ---- 快照 ----
    def snapshot(self):
        """返回所有当前指标的 dict（线程安全快照）。"""
        with self._lock:
            uptime = max(0.0, time.time() - self._start)
            lats = sorted(self._inf_latencies)
            p50 = _percentile(lats, 50)
            p95 = _percentile(lats, 95)
            close_hours = list(self._event_close_hours)
            avg_close = (sum(close_hours) / len(close_hours)) if close_hours else 0.0
            recommend_count = self._recommend_count
            confirmed_count = self._confirmed_count
            adoption = (confirmed_count / recommend_count) if recommend_count else 0.0
            device_stats = dict(self._device_stats)
            db_counts = dict(self._db_counts)
            inf_count = self._inf_count
            inf_unknown = self._inf_unknown
            inf_errors = self._inf_errors
            event_open_total = self._event_open_total
            storage = self._storage

        # 派生指标：优先从 storage 读取当前态（db_counts / open_event_count）
        # 在锁外调用 storage 避免 I/O 阻塞其他 record_*
        open_event_count = 0
        if storage is not None:
            try:
                events = storage.list_events(10000) or []
                open_event_count = sum(1 for e in events if (e.get("status") == "open"))
            except Exception:
                open_event_count = 0
            if not db_counts:
                try:
                    db_counts = dict(storage.counts() or {})
                except Exception:
                    db_counts = {}

        return {
            # 系统级
            "uptime_seconds": round(uptime, 3),
            "db_counts": db_counts,
            # 设备级
            "online_count": device_stats["online_count"],
            "offline_count": device_stats["offline_count"],
            "avg_packet_loss_pct": round(device_stats["avg_packet_loss_pct"], 3),
            "low_battery_count": device_stats["low_battery_count"],
            # 推理级
            "inference_count": inf_count,
            "inference_p50_ms": round(p50, 3),
            "inference_p95_ms": round(p95, 3),
            "unknown_count": inf_unknown,
            "error_count": inf_errors,
            # 业务级
            "open_event_count": open_event_count,
            "event_open_total": event_open_total,
            "avg_event_close_hours": round(avg_close, 3),
            "assignment_adoption_rate": round(adoption, 4),
            "recommendation_count": recommend_count,
            "confirmed_count": confirmed_count,
        }

    def reset(self):
        """重置所有计数与样本（启动时间也重置为当前时刻）。"""
        with self._lock:
            self._start = time.time()
            self._inf_latencies.clear()
            self._inf_count = 0
            self._inf_unknown = 0
            self._inf_errors = 0
            self._event_open_total = 0
            self._event_close_hours.clear()
            self._recommend_count = 0
            self._confirmed_count = 0
            self._device_stats = {
                "online_count": 0,
                "offline_count": 0,
                "avg_packet_loss_pct": 0.0,
                "low_battery_count": 0,
            }
            self._db_counts = {}
