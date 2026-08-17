"""EWOH 设备适配器管理器（真实实现）。

- 管理一组 ``BaseAdapter`` 实例的生命周期（register / start / stop / health）；
- 从适配器拉取统一语义帧，写入 Storage 并发布到 MessageBus（telemetry stream）；
- 适配器未注册时是合法的"空管理器"（无设备接入），不是 stub；
- Task 13.2：后台监督线程检测读取线程死亡并指数退避 respawn，adapter.start()
  失败同样退避重试（超阈值标记 degraded）。

与 ``edge_platform.stubs.AdapterManager``（空壳契约替身）区分：
生产装配使用本真实实现；stubs 仅用于测试/演示。
"""

from __future__ import annotations

import logging
import threading
import time

from edge_platform.edge.adapters.base import BaseAdapter
from edge_platform.edge.modeling.frame_adapter import is_grouped_frame, unified_to_telemetry_row
from edge_platform.runtime.protocols import STREAM_TELEMETRY, EventBusProtocol, StorageProtocol

logger = logging.getLogger("ewoh.edge.manager")

# EDGE-042：read_message 连续失败达到该阈值后，日志升级为 ERROR 级 degraded 信号
_READ_FAILURE_DEGRADED_THRESHOLD = 10


class AdapterManager:
    """设备适配器生命周期管理（生产实现）。

    - ``register(adapter)`` 注册适配器；
    - ``start()`` 启动全部已注册适配器，并为每个适配器启动后台读取线程
      （daemon），将统一帧写入 storage + bus（telemetry stream）；
    - ``stop()`` 停止全部线程与适配器；
    - ``health()`` 汇总各适配器健康状态（含监督字段）。

    Task 13.2 监督（supervision，运行时可靠性加固）：
    - ``start()`` 后启动一个 daemon 监督线程，周期性检查每个已激活适配器的
      读取线程；
    - 读取线程死亡（崩溃）→ 指数退避（默认 1s/2s/4s…，封顶 60s）后自动
      respawn 读取循环；
    - ``adapter.start()`` 失败 → 同样指数退避重试；连续失败超过阈值
      （``start_failure_degraded_threshold``，默认 3）→ health 标记 degraded；
    - 每次 respawn / start 失败记录在 ``health()`` 中
      （``respawns`` / ``last_respawn_at`` / ``start_failures`` / ``last_error``）；
    - 线程健康时监督不干预，不影响既有行为。
    """

    def __init__(
        self,
        storage: StorageProtocol,
        bus: EventBusProtocol,
        listeners=None,
        supervisor_interval: float = 1.0,
        respawn_backoff_base: float = 1.0,
        respawn_backoff_cap: float = 60.0,
        start_failure_degraded_threshold: int = 3,
    ):
        self.storage = storage
        self.bus = bus
        # listeners 保留旧接口兼容（port -> source_type 映射）；真实装配由适配器决定
        self.listeners = dict(listeners or {})
        self._adapters: list[BaseAdapter] = []
        self._threads: list[threading.Thread] = []
        self._stop_event = threading.Event()
        self._lock = threading.Lock()
        self._running = False
        # ---- Task 13.2 监督参数与状态 ----
        self.supervisor_interval = supervisor_interval
        self.respawn_backoff_base = respawn_backoff_base
        self.respawn_backoff_cap = respawn_backoff_cap
        self.start_failure_degraded_threshold = start_failure_degraded_threshold
        # adapter -> 监督记录（thread/respawns/start 统计/退避窗口）
        self._supervision: dict[BaseAdapter, dict] = {}
        self._supervisor_thread: threading.Thread | None = None

    # ---- 监督状态 ----
    @staticmethod
    def _new_supervision() -> dict:
        return {
            "thread": None,
            "respawns": 0,
            "last_respawn_at": None,
            "start_attempts": 0,
            "start_failures": 0,
            "start_succeeded": False,
            "degraded": False,
            "last_error": None,
            "next_attempt_at": 0.0,
            "attempting": False,
        }

    def _respawn_delay(self, attempt: int) -> float:
        """指数退避：base/2*base/4*base…，封顶 cap（默认 1s/2s/4s…/60s）。"""
        delay = self.respawn_backoff_base * (2 ** max(int(attempt) - 1, 0))
        return min(delay, self.respawn_backoff_cap)

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
            self._try_start_adapter(adapter)
        self._start_supervisor()

    def stop(self) -> None:
        self._stop_event.set()
        with self._lock:
            self._running = False
            adapters = list(self._adapters)
            threads = list(self._threads)
            self._threads.clear()
            supervisor = self._supervisor_thread
            self._supervisor_thread = None
        for adapter in adapters:
            try:
                adapter.stop()
            except Exception:
                logger.exception("adapter %s stop failed", getattr(adapter, "device_id", "?"))
        for t in threads:
            t.join(timeout=2)
        if supervisor is not None:
            supervisor.join(timeout=2)

    def health(self) -> list[dict]:
        out = []
        with self._lock:
            adapters = list(self._adapters)
            snap = {
                id(a): {
                    "thread": s.get("thread"),
                    "respawns": s.get("respawns", 0),
                    "last_respawn_at": s.get("last_respawn_at"),
                    "start_failures": s.get("start_failures", 0),
                    "start_succeeded": s.get("start_succeeded", False),
                    "last_error": s.get("last_error"),
                }
                for a, s in self._supervision.items()
            }
        for adapter in adapters:
            try:
                h = adapter.health() or {}
            except Exception:
                logger.exception("adapter %s health failed", getattr(adapter, "device_id", "?"))
                h = {"status": "error"}
            h.setdefault("device_id", getattr(adapter, "device_id", "?"))
            sup = snap.get(id(adapter))
            if sup is not None:
                thread = sup["thread"]
                thread_alive = thread is not None and thread.is_alive()
                h["respawns"] = sup["respawns"]
                h["last_respawn_at"] = sup["last_respawn_at"]
                h["start_failures"] = sup["start_failures"]
                if sup["last_error"]:
                    h["last_error"] = sup["last_error"]
                h["supervised"] = True
                if not thread_alive and not self._stop_event.is_set():
                    # 应运行但读取线程未运行：监督标注降级/离线
                    if sup["start_succeeded"]:
                        h["status"] = "degraded"  # 线程崩溃，等待退避 respawn
                    elif sup["start_failures"] >= self.start_failure_degraded_threshold:
                        h["status"] = "degraded"  # start 反复失败超阈值
                    else:
                        h["status"] = "offline"  # start 尚未成功（退避重试中）
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

    # ---- 内部：启动 / 重试 / 监督 ----
    def _try_start_adapter(self, adapter: BaseAdapter) -> None:
        """尝试启动适配器（幂等）：成功则派生读取线程；失败则记录并按退避重试。

        供 ``start()``（初始启动）与监督线程（失败重试）共用。
        """
        with self._lock:
            sup = self._supervision.setdefault(adapter, self._new_supervision())
            if sup["attempting"]:
                return  # 已有线程正在执行 start，避免重入
            if sup["start_succeeded"] and sup["thread"] is not None and sup["thread"].is_alive():
                return
            if time.time() < sup["next_attempt_at"]:
                return  # 仍在退避窗口
            sup["attempting"] = True
            sup["start_attempts"] += 1
        device = getattr(adapter, "device_id", "?")
        try:
            adapter.start()
        except Exception as exc:
            with self._lock:
                s = self._supervision[adapter]
                s["start_failures"] += 1
                s["last_error"] = f"{type(exc).__name__}: {exc}"
                # 失败后进入退避窗口：1 次失败→base，2 次→2*base，…
                s["next_attempt_at"] = time.time() + self._respawn_delay(s["start_failures"])
                if s["start_failures"] >= self.start_failure_degraded_threshold:
                    s["degraded"] = True
            logger.exception("adapter %s start failed (attempt %d)", device, sup["start_attempts"])
            return
        finally:
            with self._lock:
                self._supervision[adapter]["attempting"] = False
        with self._lock:
            s = self._supervision[adapter]
            s["start_failures"] = 0
            s["start_succeeded"] = True
            s["degraded"] = False
            s["last_error"] = None
        self._spawn_reader(adapter, respawn=False)

    def _spawn_reader(self, adapter: BaseAdapter, respawn: bool) -> None:
        """派生适配器读取线程（daemon）；respawn=True 时记录一次 respawn 并进入退避窗口。"""
        device = getattr(adapter, "device_id", "?")
        try:
            t = threading.Thread(
                target=self._read_loop,
                args=(adapter,),
                daemon=True,
                name=f"adapter-{device}",
            )
            t.start()
        except Exception:
            logger.exception("adapter %s reader thread spawn failed", device)
            return
        with self._lock:
            sup = self._supervision.setdefault(adapter, self._new_supervision())
            old = sup["thread"]
            sup["thread"] = t
            if old in self._threads:
                self._threads.remove(old)  # 替换旧线程，避免线程列表无界增长
            self._threads.append(t)
            if respawn:
                sup["respawns"] += 1
                sup["last_respawn_at"] = time.time()
                # 退避窗口：本次 respawn 后，下一次 respawn 至少间隔 delay(respawns)
                sup["next_attempt_at"] = time.time() + self._respawn_delay(sup["respawns"])

    def _start_supervisor(self) -> None:
        with self._lock:
            if self._supervisor_thread is not None and self._supervisor_thread.is_alive():
                return
            t = threading.Thread(
                target=self._supervisor_loop,
                daemon=True,
                name="adapter-supervisor",
            )
            self._supervisor_thread = t
        t.start()

    def _supervisor_loop(self) -> None:
        while not self._stop_event.is_set():
            time.sleep(self.supervisor_interval)
            try:
                self._supervise_once()
            except Exception:
                logger.exception("adapter supervisor check failed")

    def _supervise_once(self) -> None:
        with self._lock:
            adapters = list(self._adapters)
        for adapter in adapters:
            self._supervise_adapter(adapter)

    def _supervise_adapter(self, adapter: BaseAdapter) -> None:
        """单适配器监督：读取线程死亡 → 退避 respawn；start 未成功 → 退避重试 start。"""
        with self._lock:
            sup = self._supervision.get(adapter)
            if sup is None or self._stop_event.is_set():
                return
            thread = sup["thread"]
            if thread is not None and thread.is_alive():
                return  # 健康，无需干预
            if time.time() < sup["next_attempt_at"]:
                return  # 退避窗口内
        if sup["start_succeeded"]:
            # 线程死亡（崩溃）：respawn 读取循环
            logger.warning(
                "adapter %s reader thread dead → respawn (count=%d)",
                getattr(adapter, "device_id", "?"),
                sup["respawns"] + 1,
            )
            self._spawn_reader(adapter, respawn=True)
        else:
            # adapter.start() 尚未成功：退避重试
            self._try_start_adapter(adapter)

    # ---- 内部：后台读取循环 ----
    def _read_loop(self, adapter: BaseAdapter) -> None:
        """适配器读取循环。

        EDGE-042（2026-08-17 审计整改）：read_message 连续异常不再固定 1s 无限
        重试——按连续失败次数指数退避（1s→60s 封顶），达到阈值后升级为 ERROR
        级 degraded 日志（supervisor health 层面仍可见线程存活状态）。
        EDGE-043：帧持久化失败做一次有界重试，最终失败 ERROR 留痕（不静默丢帧）。
        """
        consecutive_failures = 0
        while not self._stop_event.is_set():
            try:
                msg = adapter.read_message(timeout=1.0)
            except Exception:
                consecutive_failures += 1
                device_id = getattr(adapter, "device_id", "?")
                if consecutive_failures >= _READ_FAILURE_DEGRADED_THRESHOLD:
                    logger.error(
                        "adapter %s read_message 连续失败 %d 次（degraded，退避 %.0fs）",
                        device_id,
                        consecutive_failures,
                        min(60.0, 1.0 * (2 ** min(consecutive_failures, 6))),
                    )
                else:
                    logger.exception("adapter %s read_message failed", device_id)
                time.sleep(min(60.0, 1.0 * (2 ** min(consecutive_failures, 6))))
                continue
            consecutive_failures = 0
            if msg is None:
                continue
            row = unified_to_telemetry_row(msg) if is_grouped_frame(msg) else msg
            # EDGE-043：持久化失败有界重试（共 2 次尝试），最终失败显式 ERROR。
            for attempt in (1, 2):
                try:
                    self.storage.insert_telemetry(row)
                    break
                except Exception:
                    if attempt == 2:
                        logger.error(
                            "adapter %s frame persistence failed（重试后仍失败，帧丢失留痕）: %s",
                            getattr(adapter, "device_id", "?"),
                            row.get("record_id"),
                        )
                    else:
                        time.sleep(0.05)
            try:
                self.bus.publish(STREAM_TELEMETRY, row)
            except Exception:
                logger.exception("adapter %s frame publish failed", getattr(adapter, "device_id", "?"))


__all__ = ["AdapterManager"]
