"""Edge→Cloud 指标上行（ADR-028 / NO-12d，§19 Observability 指标腿）。

MetricsUplink 周期性（EWOH_METRICS_UPLINK_INTERVAL_SEC，默认 60s）把边缘
MetricsCollector.snapshot() 转成规范样本批次（metricName/metricType/value/
labels，labels 含 edge_id；ewoh_db_count 附加 table 标签）POST 到云侧
POST /api/observability/edge-metrics（IngestGuard 机器通道：X-Ingest-Key +
X-Org-Id，与事件上行同通道）：

- 命名收敛：样本名 = 边缘 Prometheus exporter 的 ewoh_* 家族名（已入
  contracts/observability/metrics-registry.schema.json 注册表，ADR-028），
  云端 validateMetricSample 契约校验（未注册 = violation 显式，绝不静默）；
- 指标为周期性快照（latest-wins，云端按 (metricName,labels) upsert）：
  **不建磁盘队列**——与事件上行（事实不可丢）不同，指标快照丢失只损失
  一个周期的观测值，下一周期自然覆盖；失败显式 logging + stats 计数
  （§33 绝不静默吞异常），指数退避；
- 上行健康经云端 connector_* 家族计数（connector_active_total/
  connector_error_total/connector_telemetry_samples_total，connector_id=
  edge_id，connector_type=metrics_uplink）。

配置（config.Settings）：EWOH_METRICS_UPLINK_URL（空 = 上行显式关闭）、
EWOH_METRICS_UPLINK_KEY / EWOH_METRICS_UPLINK_ORG_ID（同事件上行语义）、
EWOH_METRICS_UPLINK_INTERVAL_SEC（默认 60）、EWOH_EDGE_ID（默认
edge-default）。

纯 Python 标准库实现。
"""

from __future__ import annotations

import json
import logging
import threading
import time
import urllib.error
import urllib.request
from typing import Any

from edge_platform.monitoring.exporter import METRIC_DEFS

logger = logging.getLogger("ewoh.bridge.metrics_uplink")

MAX_BACKOFF_SEC = 300
DEFAULT_INTERVAL_SEC = 60


def _runtime_mode() -> str:
    """读取运行时模式（EDGE-041：production 判定；读取失败按 development 宽松）。"""
    try:
        from edge_platform.config import Settings

        return Settings.load().runtime_mode
    except Exception:
        return "development"


class MetricsUplink:
    """边缘指标快照 → 云侧 /api/observability/edge-metrics 周期上行。"""

    def __init__(
        self,
        metrics,
        url: str,
        ingest_key: str = "",
        org_id: str = "",
        edge_id: str = "edge-default",
        interval_sec: float = DEFAULT_INTERVAL_SEC,
    ):
        self._metrics = metrics
        base = (url or "").strip()
        self._url = base.rstrip("/") + "/api/observability/edge-metrics" if base else ""
        self._ingest_key = ingest_key
        self._org_id = org_id
        self._edge_id = edge_id or "edge-default"
        self._interval = max(5.0, float(interval_sec))
        # EDGE-041：production 下 X-Ingest-Key 禁止明文 http 传输，显式禁用。
        self._disabled_reason = ""
        # UR8：scheme 大小写不敏感（RFC 3986）——先归一再判定，堵 "HTTP://" 旁路。
        if self._url.lower().startswith(("http://", "//")) and _runtime_mode() == "production":
            self._disabled_reason = "insecure_http_in_production"
            logger.error(
                "metrics uplink: production 下拒绝明文 http 上行（X-Ingest-Key 会暴露），已禁用: %s",
                self._url,
            )
        self._lock = threading.Lock()
        self._running = False
        self._thread: threading.Thread | None = None
        self._consecutive_failures = 0
        self._stats = {
            "sent_samples": 0,
            "batches": 0,
            "failures": 0,
            "last_success_ts": None,
            "last_error": None,
        }

    @property
    def enabled(self) -> bool:
        return bool(self._url) and not self._disabled_reason

    def health(self) -> dict[str, Any]:
        with self._lock:
            return {
                "enabled": self.enabled,
                "url": self._url,
                "disabled_reason": self._disabled_reason or None,
                "edge_id": self._edge_id,
                "interval_sec": self._interval,
                "stats": dict(self._stats),
            }

    def build_samples(self, snapshot: dict[str, Any]) -> list[dict[str, Any]]:
        """snapshot() → 规范样本批次（与 exporter 同一 METRIC_DEFS 单一事实源）。

        - 标量指标：labels={edge_id}；
        - ewoh_db_count：labels={table:..., edge_id}（按 table 排序稳定输出）。
        """
        samples: list[dict[str, Any]] = []
        for prom_name, mtype, _help, source_key, labels_spec in METRIC_DEFS:
            value = snapshot.get(source_key)
            if labels_spec is None:
                samples.append(self._sample(prom_name, mtype, value, {"edge_id": self._edge_id}))
            elif isinstance(value, dict):
                for label_value, v in sorted(value.items()):
                    samples.append(
                        self._sample(
                            prom_name,
                            mtype,
                            v,
                            {"table": str(label_value), "edge_id": self._edge_id},
                        )
                    )
        return samples

    @staticmethod
    def _sample(name: str, mtype: str, value: Any, labels: dict[str, str]) -> dict[str, Any]:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            value = 0
        return {"metricName": name, "metricType": mtype, "value": float(value), "labels": labels}

    def start(self) -> None:
        if self._running:
            return
        if self._disabled_reason:  # EDGE-041：production 明文 http → 拒绝启动
            logger.error("metrics uplink: 已禁用（%s），start() 不生效", self._disabled_reason)
            return
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True, name="metrics-uplink")
        self._thread.start()

    def stop(self) -> None:
        self._running = False

    def _loop(self) -> None:
        while self._running:
            try:
                snapshot = self._metrics.snapshot()
                samples = self.build_samples(snapshot)
                if self._post_batch(samples):
                    with self._lock:
                        self._stats["sent_samples"] += len(samples)
                        self._stats["batches"] += 1
                        self._stats["last_success_ts"] = time.time()
                        self._stats["last_error"] = None
                    self._consecutive_failures = 0
                else:
                    with self._lock:
                        self._stats["failures"] += 1
                        self._stats["last_error"] = "http_error"
                    self._consecutive_failures += 1
                    self._backoff()
            except Exception as exc:  # noqa: BLE001 —— 上行异常显式留痕，绝不静默
                logger.error("metrics uplink: 快照/发送异常: %s", exc)
                with self._lock:
                    self._stats["failures"] += 1
                    self._stats["last_error"] = str(exc)[:200]
                self._consecutive_failures += 1
                self._backoff()
            time.sleep(self._interval)

    def _post_batch(self, samples: list[dict[str, Any]]) -> bool:
        body = json.dumps({"metrics": samples}).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if self._ingest_key:
            headers["X-Ingest-Key"] = self._ingest_key
        if self._org_id:
            headers["X-Org-Id"] = self._org_id
        req = urllib.request.Request(self._url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:  # nosec B310 - configured internal HTTP client
                if not 200 <= resp.status < 300:
                    logger.warning("metrics uplink: 上行失败 status=%s", resp.status)
                    return False
                return True
        except urllib.error.URLError as exc:
            logger.warning("metrics uplink: 上行失败 %s", exc)
            return False

    def _backoff(self) -> None:
        delay = min(2 ** min(self._consecutive_failures, 8), MAX_BACKOFF_SEC)
        time.sleep(delay)


__all__ = ["MetricsUplink"]
