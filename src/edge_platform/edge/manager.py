"""EWOH 设备适配器管理器（真实实现）。

- 管理一组 ``BaseAdapter`` 实例的生命周期（register / start / stop / health）；
- 从适配器拉取统一语义帧，写入 Storage 并发布到 MessageBus（telemetry stream）；
- 适配器未注册时是合法的"空管理器"（无设备接入），不是 stub。

与 ``edge_platform.stubs.AdapterManager``（空壳契约替身）区分：
生产装配使用本真实实现；stubs 仅用于测试/演示。
"""

from __future__ import annotations

import logging
import threading
import time

from edge_platform.edge.adapters.base import BaseAdapter
from edge_platform.runtime.protocols import STREAM_TELEMETRY, EventBusProtocol, StorageProtocol

logger = logging.getLogger("ewoh.edge.manager")


class AdapterManager:
    """设备适配器生命周期管理（生产实现）。

    - ``register(adapter)`` 注册适配器；
    - ``start()`` 启动全部已注册适配器，并为每个适配器启动后台读取线程
      （daemon），将统一帧写入 storage + bus（telemetry stream）；
    - ``stop()`` 停止全部线程与适配器；
    - ``health()`` 汇总各适配器健康状态。
    """

    def __init__(self, storage: StorageProtocol, bus: EventBusProtocol, listeners=None):
        self.storage = storage
        self.bus = bus
        # listeners 保留旧接口兼容（port -> source_type 映射）；真实装配由适配器决定
        self.listeners = dict(listeners or {})
        self._adapters: list[BaseAdapter] = []
        self._threads: list[threading.Thread] = []
        self._stop_event = threading.Event()
        self._lock = threading.Lock()
        self._running = False

    # ---- 生命周期 ----
    def register(self, adapter: BaseAdapter) -> None:
        with self._lock:
            self._adapters.append(adapter)

    def start(self) -> None:
        with self._lock:
            if self._running:
                return
            self._running = True
            self._stop_event.clear()
            adapters = list(self._adapters)
        for adapter in adapters:
            try:
                adapter.start()
            except Exception:
                logger.exception("adapter %s start failed", getattr(adapter, "device_id", "?"))
                continue
            t = threading.Thread(
                target=self._read_loop,
                args=(adapter,),
                daemon=True,
                name=f"adapter-{getattr(adapter, 'device_id', '?')}",
            )
            t.start()
            self._threads.append(t)

    def stop(self) -> None:
        self._stop_event.set()
        with self._lock:
            self._running = False
            adapters = list(self._adapters)
            threads = list(self._threads)
            self._threads.clear()
        for adapter in adapters:
            try:
                adapter.stop()
            except Exception:
                logger.exception("adapter %s stop failed", getattr(adapter, "device_id", "?"))
        for t in threads:
            t.join(timeout=2)

    def health(self) -> list[dict]:
        out = []
        with self._lock:
            adapters = list(self._adapters)
        for adapter in adapters:
            try:
                h = adapter.health() or {}
            except Exception:
                logger.exception("adapter %s health failed", getattr(adapter, "device_id", "?"))
                h = {"status": "error"}
            h.setdefault("device_id", getattr(adapter, "device_id", "?"))
            out.append(h)
        return out

    def device_info(self) -> list[dict]:
        out = []
        with self._lock:
            adapters = list(self._adapters)
        for adapter in adapters:
            try:
                info = adapter.device_info() or {}
            except Exception:
                logger.exception("adapter %s device_info failed", getattr(adapter, "device_id", "?"))
                info = {"device_id": getattr(adapter, "device_id", "?")}
            out.append(info)
        return out

    # ---- 内部：后台读取循环 ----
    def _read_loop(self, adapter: BaseAdapter) -> None:
        while not self._stop_event.is_set():
            try:
                msg = adapter.read_message(timeout=1.0)
            except Exception:
                logger.exception(
                    "adapter %s read_message failed", getattr(adapter, "device_id", "?")
                )
                time.sleep(1.0)
                continue
            if msg is None:
                continue
            try:
                self.storage.insert_telemetry(msg)
                self.bus.publish(STREAM_TELEMETRY, msg)
            except Exception:
                logger.exception("adapter %s frame persistence failed", getattr(adapter, "device_id", "?"))


__all__ = ["AdapterManager"]
