"""HTTP/Webhook connector surface (Final 5.0 AA-05).

Implements payload normalization and HMAC signature verification for
webhook-based OT integrations. A transport receiver feeds normalized raw
dictionaries into the adapter.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import queue
from typing import Any

from edge_platform.edge.adapters.base import BaseAdapter
from edge_platform.spatial import now_iso

_LOGGER = logging.getLogger("ewoh.connectors.webhook")


class WebhookError(ValueError):
    """Raised when a webhook payload violates the connector contract."""


def verify_webhook_signature(
    payload: bytes,
    signature: str,
    secret: str,
    algorithm: str = "sha256",
) -> bool:
    """Verify an HMAC webhook signature (constant-time).

    EDGE-208：哈希算法白名单（sha256/sha1/sha384/sha512）——非法算法名
    直接拒绝（False），不再把任意字符串透传 getattr(hashlib, ...)。
    """
    if not isinstance(payload, (bytes, bytearray)) or not isinstance(signature, str):
        return False
    if algorithm not in ("sha256", "sha1", "sha384", "sha512"):
        return False
    digest = hmac.new(
        secret.encode("utf-8"),
        bytes(payload),
        getattr(hashlib, algorithm),
    ).hexdigest()
    return hmac.compare_digest(digest, signature.lower())


def normalize_webhook_payload(
    raw: dict[str, Any],
    default_entity_id: str = "",
    default_source_type: str = "real",
) -> dict[str, Any]:
    """Convert a webhook body to the EWOH telemetry envelope."""
    if not isinstance(raw, dict):
        raise WebhookError("webhook payload must be an object")
    entity_id = str(
        raw.get("entityId")
        or raw.get("deviceId")
        or raw.get("id")
        or default_entity_id
        or "webhook"
    )
    event_type = str(raw.get("eventType") or raw.get("type") or "TelemetryObserved")
    return {
        "entity_id": entity_id,
        "event_type": event_type,
        "event_time": raw.get("sourceTimestamp") or raw.get("ts") or now_iso(),
        "source_type": default_source_type,
        "protocol_version": "HTTP-Webhook",
        "body": raw,
    }


class WebhookAdapter(BaseAdapter):
    """Edge adapter converting webhook payloads to EWOH telemetry frames."""

    DEVICE_TYPE = "webhook_connector"

    def __init__(
        self,
        device_id: str,
        endpoint_path: str = "/webhook",
        source_type: str = "real",
        model: str = "HTTP-WEBHOOK-GENERIC",
    ):
        super().__init__(
            device_id,
            source_type=source_type,
            model=model,
            firmware_version="HTTP-Webhook",
        )
        self.endpoint_path = endpoint_path
        self._inbox: queue.Queue = queue.Queue(maxsize=1024)
        self._dropped_payloads = 0  # R2-EDM-04：队列满丢弃计数（可观测，不静默）
        self._last_msg: dict[str, Any] | None = None
        self._last_seen: str | None = None

    def start(self) -> None:
        self._running = True
        self._started_at = now_iso()

    def stop(self) -> None:
        self._running = False

    def reconnect(self) -> bool:
        self._running = True
        return True

    def health(self) -> dict[str, Any]:
        return {
            "device_id": self.device_id,
            "type": self.DEVICE_TYPE,
            "status": "online" if self._running else "offline",
            "source_type": self.source_type,
            "last_seen": self._last_seen,
            "started_at": self._started_at,
            "endpoint_path": self.endpoint_path,
        }

    def device_info(self) -> dict[str, Any]:
        return {
            "device_id": self.device_id,
            "type": self.DEVICE_TYPE,
            "model": self.model,
            "firmware_version": self.firmware_version,
            "source_type": self.source_type,
            "endpoint_path": self.endpoint_path,
        }

    def read_message(self, timeout=None) -> dict[str, Any] | None:
        try:
            msg = self._inbox.get(timeout=timeout)
        except queue.Empty:
            return None
        self._last_msg = msg
        self._last_seen = msg.get("event_time")
        return msg

    def _enqueue_raw(self, raw: dict[str, Any]) -> None:
        """Normalize and enqueue one webhook payload (receiver callback)."""
        msg = normalize_webhook_payload(raw, default_source_type=self.source_type)
        try:
            self._inbox.put_nowait(msg)
        except queue.Full:
            # R2-EDM-04：队列满不再静默丢弃——warning 留痕 + dropped 计数
            #（对齐 csvfile/modbus 的 EDGE-218/219 整改模式）。
            self._dropped_payloads += 1
            if self._dropped_payloads % 100 == 1:  # 避免日志刷屏，周期性留痕
                _LOGGER.warning(
                    "webhook connector %s 收件箱满，累计丢弃 %d 条载荷",
                    self.device_id,
                    self._dropped_payloads,
                )
