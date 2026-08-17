"""Edge→Cloud 事件上行（NO-04b：Catalog 信封事件批量上行 + 离线缓冲）。

EventUplink 订阅 STREAM_EVENTS（规则事件 / 世界投影 EntityDeclared /
EntityStateObserved 等 Catalog 信封事件），批量（≤100）POST 到云侧
POST /api/ingest/events（ADR-009 信封 + 传输级 (org,source,eventId) 幂等去重）：

- 信封契约校验（validate_envelope fail-closed，非法不发送并计数）；
- 离线缓冲 + 跨重启断点续传（NO-04c）：未发送信封持久化到 queue_path 侧车
  JSON 文件（原子替换写），启动时加载、入队即落盘、发送成功后截断——边缘
  进程重启/崩溃不丢未发送批次（本地事件库 risk_event 不存 envelope 字段，
  故队列文件是信封的持久载体）；加载损坏显式 ERROR（以空队列启动，绝不静默）；
- 幂等重放安全：云端按 (org, source, event_id) 去重，重试重复投递不重复落账
  （这正是传输级去重的意义：发送端可以做 at-least-once）。

配置（config.Settings）：EWOH_EVENT_UPLINK_URL（空 = 上行关闭，显式打印）、
EWOH_EVENT_UPLINK_KEY（X-Ingest-Key）、EWOH_EVENT_UPLINK_ORG_ID（X-Org-Id）；
queue_path 由 run.py 传入（<db>.uplink-queue.json）。

纯 Python 标准库实现。
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import urllib.error
import urllib.request
from typing import Any

from edge_platform.contracts import envelope as envelope_contract
from edge_platform.contracts.event_catalog import EVENT_CATALOG_TYPES

logger = logging.getLogger("ewoh.bridge.event_uplink")

BATCH_SIZE = 100
MAX_BACKOFF_SEC = 60
CATALOG_TYPES: frozenset = frozenset(EVENT_CATALOG_TYPES)


def _runtime_mode() -> str:
    """读取运行时模式（EDGE-041：production 判定；读取失败按 development 宽松）。"""
    try:
        from edge_platform.config import Settings

        return Settings.load().runtime_mode
    except Exception:
        return "development"


class EventUplink:
    """STREAM_EVENTS → 云侧 /api/ingest/events 批量上行（持久化离线缓冲 + 退避）。"""

    def __init__(
        self,
        bus,
        spark_url: str,
        ingest_key: str = "",
        org_id: str = "",
        batch_size: int = BATCH_SIZE,
        queue_path: str = "",
    ):
        self._bus = bus
        self._url = spark_url.rstrip("/") + "/api/ingest/events"
        self._ingest_key = ingest_key
        self._org_id = org_id
        self._batch_size = max(1, min(batch_size, BATCH_SIZE))
        self._queue_path = queue_path or ""
        # EDGE-041（2026-08-17 审计整改）：production 下 X-Ingest-Key 禁止经
        # 明文 http 传输——上行地址必须为 https://，否则本组件显式禁用
        # （enabled=false，health 说明原因），绝不降级发送凭据。
        # （mTLS/HMAC 签名属云端协同改造，由云侧任务域跟进；此处先消除明文面。）
        self._disabled_reason = ""
        if self._url.startswith(("http://", "//")) and _runtime_mode() == "production":
            self._disabled_reason = "insecure_http_in_production"
            logger.error(
                "event uplink: production 下拒绝明文 http 上行（X-Ingest-Key 会暴露），已禁用: %s",
                self._url,
            )
        self._buffer: list[dict] = []
        # NO-04c：断点续传——启动加载未发送队列；损坏显式 ERROR（空队列启动，不静默）。
        if self._queue_path and os.path.exists(self._queue_path):
            try:
                with open(self._queue_path, encoding="utf-8") as fh:
                    loaded = json.load(fh)
                if isinstance(loaded, list):
                    self._buffer = [e for e in loaded if isinstance(e, dict)]
                logger.info("event uplink: 队列恢复 %d 条（%s）", len(self._buffer), self._queue_path)
            except Exception as exc:
                logger.error("event uplink: 队列加载失败（以空队列启动）: %s", exc)
        self._lock = threading.Lock()
        self._running = False
        self._thread: threading.Thread | None = None
        self._sub_id = None
        self._consecutive_failures = 0
        self._stats = {"sent": 0, "buffered": 0, "dropped_invalid": 0, "failures": 0}

    @property
    def enabled(self) -> bool:
        return bool(self._url) and not self._disabled_reason

    def health(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "url": self._url,
            "disabled_reason": self._disabled_reason or None,
            "stats": dict(self._stats),
            "buffer": len(self._buffer),
            "queue_path": self._queue_path,
        }

    def _persist(self) -> None:
        """未发送队列原子落盘（tmp + rename；queue_path 为空 = 不持久化）。"""
        if not self._queue_path:
            return
        tmp = f"{self._queue_path}.tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(self._buffer, fh, ensure_ascii=False)
            os.replace(tmp, self._queue_path)
        except Exception as exc:
            logger.error("event uplink: 队列持久化失败: %s", exc)

    def start(self) -> None:
        if self._running:
            return
        if self._disabled_reason:  # EDGE-041：production 明文 http → 拒绝启动
            logger.error("event uplink: 已禁用（%s），start() 不生效", self._disabled_reason)
            return
        self._running = True
        self._sub_id = self._bus.subscribe("events", self._enqueue)
        self._thread = threading.Thread(target=self._loop, daemon=True, name="event-uplink")
        self._thread.start()

    def stop(self) -> None:
        self._running = False

    def _enqueue(self, evt: dict) -> None:
        """STREAM_EVENTS 回调：契约校验后入缓冲（fail-closed，非法计数不发送）。"""
        envelope = evt.get("envelope") if isinstance(evt, dict) else None
        if not isinstance(envelope, dict):
            self._stats["dropped_invalid"] += 1
            return
        errors = envelope_contract.validate_envelope(envelope, CATALOG_TYPES)
        if errors:
            logger.warning("event uplink: 信封契约校验失败（不发送）: %s", errors)
            self._stats["dropped_invalid"] += 1
            return
        with self._lock:
            self._buffer.append(envelope)
            self._stats["buffered"] += 1
            self._persist()  # NO-04c：入队即落盘（跨重启断点续传）

    def _loop(self) -> None:
        while self._running:
            batch = self._drain()
            if batch:
                if self._post_batch(batch):
                    self._stats["sent"] += len(batch)
                    self._consecutive_failures = 0
                    with self._lock:
                        self._persist()  # 成功即截断队列文件
                else:
                    # 失败：批次重新放回缓冲头部（at-least-once，云端幂等去重兜底；
                    # 队列文件仍保留完整未发送集合，重启后继续续传）
                    with self._lock:
                        self._buffer = batch + self._buffer
                    self._stats["failures"] += 1
                    self._consecutive_failures += 1
                    self._backoff()
            else:
                time.sleep(1.0)

    def _drain(self) -> list[dict]:
        with self._lock:
            if not self._buffer:
                return []
            batch = self._buffer[: self._batch_size]
            self._buffer = self._buffer[len(batch) :]
            return batch

    def _post_batch(self, batch: list[dict]) -> bool:
        body = json.dumps({"events": batch}).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if self._ingest_key:
            headers["X-Ingest-Key"] = self._ingest_key
        if self._org_id:
            headers["X-Org-Id"] = self._org_id
        req = urllib.request.Request(self._url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:  # nosec B310 - configured internal HTTP client
                return 200 <= resp.status < 300
        except urllib.error.URLError as exc:
            logger.warning("event uplink: 上行失败 %s", exc)
            return False

    def _backoff(self) -> None:
        delay = min(2 ** min(self._consecutive_failures, 6), MAX_BACKOFF_SEC)
        time.sleep(delay)


__all__ = ["EventUplink"]
