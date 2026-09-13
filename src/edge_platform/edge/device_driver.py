"""外骨骼真实驱动（device_driver）：NXP1 字节流的 TCP 接收端（G8 / E-03 补链）。

背景（现场后果）
----------------
`ny_exo_a1.adapter` 的 docstring 声明「真实驱动通过 `feed(raw_bytes)` 投递设备字节流」，
`injector.py` 也点名 `edge_platform.edge.device_driver`——**但这个模块在仓库里从来
不存在**。后果是一条断链：`scripts/replay_device.py` 会向 TCP 9001 重放真机录制帧，
真机上线后也会向 9001 推流，而边缘侧**没有任何监听端**——「真机/录播 → 适配层」
这条链路的最后一跳缺失，遥测在边缘永远产不出来（跑得起来、状态全绿、数据为零）。

本模块只补这一跳，且只做这一跳::

    真机 或 scripts/replay_device.py ──TCP 9001──▶ TcpDeviceDriver
                                                     │ recv() 原样拿字节
                                                     ▼
                                      adapter.feed(raw_bytes)  ← 拆帧/粘包/失步重同步/CRC 全在适配器

为什么驱动**不**拆帧：适配器（`protocol.decode_frame` + `_buffer`）已经实现了粘包、
半包、失步重同步与 CRC 校验。驱动再拆一遍就是第二份协议实现，两份一旦不一致，
现场表现是"驱动认为的帧边界"与"适配器认为的帧边界"打架——静默错帧比直接崩溃更难查。
驱动只搬运字节，帧的判读权始终在适配器手里（这是本模块最重要的边界）。

断连（`replay_device.py --disconnect-at` 验证的那条路）
-------------------------------------------------------
一条 TCP 连接 = 一次设备会话。连接建立时驱动调用 `adapter.reconnect()`：**清掉半包缓冲**。
原因很具体：断线时缓冲区里可能留着半帧字节，若不清理，重连后第一帧的字节会被拼到上一段
残帧后面，产出一帧 CRC 错误的垃圾——现场表现是"每次重连都丢一帧并报坏帧"。
SEQ 去重窗口按适配器设计**不清空**（协议确认书 3.5：重连后设备会 BACKFILL 补传断线期间
的缓存，必须先去掉与实时帧重复的 SEQ），因此重连后不会重复计数。监听端本身不因单条
连接断开而退出，重连即继续。

并发会话（同一时刻只允许一条连接投递）
--------------------------------------
一台适配器只有**一个** `_buffer` 和一份设备状态（device_id/电量/故障码），所以
同一时刻只允许**一条**连接向它投递字节流。第二条并发连接（第二台真机接错端口、
或回放器撞上在线真机）会被驱动**立即关闭**（对端读到 EOF）并计入
`stats()["rejected_sessions"]`：驱动不拆帧、没有 device 维度可路由，放行就意味着
两条字节流交错——后到设备的 IDENT 改写适配器设备号（先到设备的遥测被记到别的
设备名下），并发 feed 在 `_buffer` 上无锁交错把帧撕成 CRC 垃圾。串数据比拒绝
连接危险得多，所以这里 fail-closed。顺序上一断一连（重连）不受影响。
诚实边界：若旧连接半开（对端断网未发 FIN），新连接会一直被拒到旧连接消亡为止，
`rejected_sessions` 持续增长就是现场排查信号。

fail-closed
-----------
绑定失败（端口被占用 / 地址不可用）在**构造期**直接抛 `DeviceDriverError`：配置错误必须让
装配（`build_adapters`）当场失败，而不是"启动成功、日志里再报找不到端口"。

来源隔离
--------
TCP 只能证明"有字节进来"，证明不了"这是真机"。因此驱动**不臆断来源**：`source_type` 由
装配侧（`EWOH_ADAPTERS` 的 `sourceType`）决定，驱动只把它记进 stats。注入器
（`WireInjector`）产生的字节流**不是真机数据**，要灌进适配器必须走本模块的
`InjectorDeviceDriver`——它在构造期拒绝 `source_type == "real"` 的适配器
（`injector.py` 声明的同名硬约束），避免受控数据被包装成真机结论。

纯 Python 标准库实现，不引入任何第三方依赖。
"""

from __future__ import annotations

import logging
import socketserver
import threading
from typing import Any

from edge_platform.edge.adapters.base import BaseAdapter
from edge_platform.edge.adapters.ny_exo_a1.adapter import NyExoA1Adapter
from edge_platform.spatial import now_iso

logger = logging.getLogger("ewoh.edge.device_driver")


class DeviceDriverError(RuntimeError):
    """驱动层错误（绑定失败/端口占用/适配器不接受字节/来源不匹配）。

    调用方必须显式处理：本模块**没有任何**"出错了就当没事发生"的路径。
    """


class _FeedHandler(socketserver.BaseRequestHandler):
    """单条 TCP 连接的处理：准入检查 → 只做 `recv → adapter.feed`，不解析字节内容。"""

    def handle(self) -> None:
        driver: TcpDeviceDriver = self.server.driver  # type: ignore[attr-defined]
        if not driver._admit_session(self.client_address):
            # 已有活跃会话占着这条设备流：一个字节都不能喂（喂了就是两台设备的
            # 字节流交错）。直接返回 = 关闭连接，对端读到 EOF。
            return
        try:
            while not driver._stop_event.is_set():
                try:
                    data = self.request.recv(driver.recv_size)
                except OSError:
                    break  # 连接层错误：交给 finally 记断开，不让异常吞掉日志
                if not data:
                    break  # 对端正常关闭（含 replay_device.py --disconnect-at）
                driver._feed(data)
        finally:
            driver._session_closed(self.client_address)


class _ThreadingServer(socketserver.ThreadingTCPServer):
    """每条连接一个 handler 线程；**并发投递**由 `TcpDeviceDriver._admit_session`
    在应用层裁决（同一时刻只放行一条会话，多余的立即关闭）——线程模型只是让
    "上一条连接还没退出时下一条就能被裁决"，不代表多条会话可以同时喂适配器。
    """

    allow_reuse_address = True
    daemon_threads = True


class TcpDeviceDriver:
    """NXP1 字节流的 TCP 接收驱动：监听 → 收字节 → `adapter.feed(raw_bytes)`。

    参数：
    - `adapter`：任何提供 `feed(raw_bytes) -> int` 的对象（本仓库为 `NyExoA1Adapter`）；
    - `host` / `port`：监听地址；默认 `127.0.0.1`（对齐 `record_raw_frames.py` 的
      EDGE-217 结论：默认不把设备端口暴露到局域网），`port=0` 由系统分配；
    - `recv_size`：单次 `recv` 上限（字节流语义，与帧边界无关）。

    构造期即完成 bind——端口占用/地址不可用当场抛 `DeviceDriverError`（fail-closed）。
    """

    def __init__(
        self,
        adapter: Any,
        host: str = "127.0.0.1",
        port: int = 9001,
        *,
        recv_size: int = 4096,
    ):
        if not callable(getattr(adapter, "feed", None)):
            raise DeviceDriverError(
                "适配器缺少 feed(raw_bytes)：驱动只搬字节、不拆帧，拆帧必须由适配器完成"
            )
        self.adapter = adapter
        self.recv_size = max(int(recv_size), 1)
        self._lock = threading.Lock()
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._sessions = 0
        self._active_sessions = 0
        self._rejected_sessions = 0
        self._bytes_received = 0
        self._feed_failures = 0
        self._reconnect_failures = 0
        self._last_error: str | None = None
        try:
            self._server = _ThreadingServer((str(host), int(port)), _FeedHandler)
        except OSError as exc:
            # fail-closed：端口占用/地址不可用必须在装配期炸出来
            raise DeviceDriverError(
                f"listen_failed:{host}:{int(port)}:{type(exc).__name__}:{exc}"
            ) from exc
        self._server.driver = self  # type: ignore[attr-defined]
        self.host = str(self._server.server_address[0])
        self.port = int(self._server.server_address[1])

    # ---- 生命周期 ----
    def start(self) -> TcpDeviceDriver:
        """启动监听线程（幂等）。bind 已在构造期完成，故此处不再有端口失败路径。"""
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return self
            self._stop_event.clear()
            self._thread = threading.Thread(
                target=self._server.serve_forever, name="ewoh-device-driver-tcp", daemon=True
            )
            self._thread.start()
        return self

    def stop(self) -> None:
        """停止监听并关闭套接字（幂等）。"""
        self._stop_event.set()
        with self._lock:
            thread = self._thread
            self._thread = None
        if thread is not None and thread.is_alive():
            self._server.shutdown()  # 必须由非 serve_forever 线程调用
        self._server.server_close()
        if thread is not None:
            thread.join(timeout=5)

    # ---- 连接回调（由 handler 线程调用）----
    def _admit_session(self, client_address: tuple) -> bool:
        """会话准入：同一时刻只放行**一条**连接向适配器投递字节流（fail-closed）。

        返回 False = 拒绝（调用方必须立即返回关闭连接，一个字节都不能喂）。
        为什么必须拒：适配器只有一份 `_buffer` 和一份设备状态，两条连接的字节流
        交错会（a）让后到设备的 IDENT 改写适配器 device_id——先到设备的遥测被记到
        别的设备名下；（b）并发 feed 在 `_buffer` 上无锁交错，帧被撕成 CRC 垃圾。
        驱动不拆帧、无从按设备路由，拒绝是唯一不串数据的处理。
        """
        with self._lock:
            self._sessions += 1  # 连接尝试总数（含被拒），现场对账用
            index = self._sessions
            if self._active_sessions >= 1:
                self._rejected_sessions += 1
                logger.warning(
                    "device driver: 拒绝连接 %s:%s（已有一条活跃设备会话，"
                    "两路字节流不得喂同一适配器；累计拒绝 %d）",
                    client_address[0],
                    client_address[1],
                    self._rejected_sessions,
                )
                return False
            self._active_sessions += 1
        # 新连接 = 新设备会话：清半包缓冲，避免断线残帧与重连首帧拼接成垃圾帧。
        # （能走到这里说明此前无活跃会话，不存在与上一会话 feed 的并发。）
        reconnect = getattr(self.adapter, "reconnect", None)
        if callable(reconnect):
            try:
                reconnect()
            except Exception as exc:  # noqa: BLE001 - 记录后继续监听，不静默
                with self._lock:
                    self._reconnect_failures += 1
                    self._last_error = f"reconnect_failed:{type(exc).__name__}:{exc}"
                logger.error("device driver: adapter.reconnect() 失败: %s", self._last_error)
        logger.info(
            "device driver: 会话 #%d 建立来自 %s:%s（监听 %s:%s）",
            index,
            client_address[0],
            client_address[1],
            self.host,
            self.port,
        )
        return True

    def _session_closed(self, client_address: tuple) -> None:
        with self._lock:
            self._active_sessions = max(self._active_sessions - 1, 0)
        logger.info(
            "device driver: 会话断开 %s:%s（当前活跃 %d）",
            client_address[0],
            client_address[1],
            self.stats()["active_sessions"],
        )

    def _feed(self, data: bytes) -> None:
        """把一段字节原样交给适配器（粘包由适配器内部缓冲处理）。"""
        with self._lock:
            self._bytes_received += len(data)
        try:
            self.adapter.feed(data)
        except Exception as exc:  # noqa: BLE001
            # 适配器内部异常不得静默：计数 + ERROR 留痕。
            # 不断开连接、不吞掉：单帧失败不应让整条设备会话消失，
            # 但丢了多少帧必须在 stats()/health() 里看得见。
            with self._lock:
                self._feed_failures += 1
                self._last_error = f"feed_failed:{type(exc).__name__}:{exc}"
            logger.error("device driver: adapter.feed() 失败: %s", self._last_error)

    # ---- 观测 ----
    def stats(self) -> dict:
        """接收端运行统计（health()/device_info() 直接暴露；无编造字段）。"""
        with self._lock:
            return {
                "kind": "tcp-ingest",
                "host": self.host,
                "port": self.port,
                "running": bool(self._thread is not None and self._thread.is_alive()),
                "sessions": self._sessions,
                "active_sessions": self._active_sessions,
                "rejected_sessions": self._rejected_sessions,
                "bytes_received": self._bytes_received,
                "feed_failures": self._feed_failures,
                "reconnect_failures": self._reconnect_failures,
                "last_error": self._last_error,
            }


class InjectorDeviceDriver:
    """进程内注入器驱动：把 `WireInjector` 生成的字节流投给适配器（无 socket）。

    存在理由是一条硬约束（`injector.py` 同名声明）：注入器产生的是**受控测试数据，
    不是真机数据**。若允许它直接喂给 `source_type == "real"` 的适配器，受控数据就会被
    包装成真机结论——本仓库最高纪律明令禁止。因此本驱动在**构造期**就拒绝 real 适配器，
    把这条纪律落成会抛错的代码，而不是一句注释。

    用途：无真机时把注入器场景灌进 `controlled_test` / `simulated` 适配器（自测与演示）。
    """

    def __init__(self, adapter: Any, injector: Any):
        if not callable(getattr(adapter, "feed", None)):
            raise DeviceDriverError("适配器缺少 feed(raw_bytes)")
        source_type = getattr(adapter, "source_type", None)
        if source_type == "real":
            raise DeviceDriverError(
                "拒绝把注入器接到 source_type=real 的适配器：注入器产出的是受控测试数据，"
                "接到 real 适配器会把受控数据包装成真机结论（injector.py 声明的硬约束）"
            )
        if not callable(getattr(injector, "scenario", None)):
            raise DeviceDriverError("注入器缺少 scenario(name)（应为 WireInjector 兼容对象）")
        self.adapter = adapter
        self.injector = injector
        self.frames_produced = 0
        self.scenarios_fed = 0

    def feed(self, raw_bytes: bytes) -> int:
        """投递一段原始字节，返回适配器本次新增的统一帧数。"""
        produced = int(self.adapter.feed(raw_bytes) or 0)
        self.frames_produced += produced
        return produced

    def feed_scenario(self, name: str) -> int:
        """投递一个预置场景（`injector.SCENARIOS` 中的名称）。"""
        produced = self.feed(self.injector.scenario(name))
        self.scenarios_fed += 1
        return produced

    def stats(self) -> dict:
        return {
            "kind": "injector",
            "source_type": getattr(self.adapter, "source_type", None),
            "scenarios_fed": self.scenarios_fed,
            "frames_produced": self.frames_produced,
        }


class NyExoA1TcpAdapter(BaseAdapter):
    """`EWOH_ADAPTERS` kind=`ny_exo_a1_tcp`：内层 `NyExoA1Adapter` + TCP 接收驱动。

    为什么需要这一层：`build_adapters` 的契约是返回 `BaseAdapter` 列表，由 manager 统一
    `start()` 并跑读取循环；而 TCP 监听是"数据来源"，不是适配器。本类把两者按同一生命
    周期绑在一起（一起起、一起停），使现场能用一行 `EWOH_ADAPTERS` 显式启用真机接收端，
    而不必改动 `run.py` 的装配流程。

    边界：**帧的判读仍在内层适配器**（`feed`），本类只转发生命周期、健康状态与读取。
    驱动侧的参数用 `listenHost` / `listenPort` 显式声明，避免与适配器参数混淆。
    """

    DEVICE_TYPE = NyExoA1Adapter.DEVICE_TYPE

    def __init__(self, device_id, source_type="real", host="127.0.0.1", port=9001, **adapter_kwargs):
        super().__init__(device_id, source_type=source_type, model="NY-EXO-A1")
        self.adapter = NyExoA1Adapter(device_id, source_type=source_type, **adapter_kwargs)
        self.driver = TcpDeviceDriver(self.adapter, host=host, port=port)

    # ---- 生命周期 ----
    def start(self):
        self.adapter.start()
        try:
            self.driver.start()
        except Exception:
            self.adapter.stop()  # 监听起不来就别把适配器留在 running
            self._running = False
            raise
        self._running = True
        self._started_at = now_iso()

    def stop(self):
        self._running = False
        self.driver.stop()
        self.adapter.stop()

    def reconnect(self):
        """重连语义：设备会话级重连由驱动按新连接处理；此处只保证运行态一致。"""
        if not self._running:
            self.start()
        else:
            self.adapter.reconnect()
        return True

    # ---- 状态与元信息 ----
    def health(self):
        out = dict(self.adapter.health())
        out.update(self.health_extras())
        out.setdefault("device_id", self.device_id)
        return out

    def health_extras(self):
        extras = dict(self.adapter.health_extras())
        extras["transport"] = "tcp-ingest"
        extras["ingest"] = self.driver.stats()
        return extras

    def device_info(self):
        out = dict(self.adapter.device_info())
        out["transport"] = "tcp-ingest"
        out["listen_host"] = self.driver.host
        out["listen_port"] = self.driver.port
        return out

    # ---- 数据读取（全部转发到内层适配器）----
    def read_message(self, timeout=None):
        return self.adapter.read_message(timeout=timeout)

    def read_unified_frame(self, timeout=None):
        return self.adapter.read_unified_frame(timeout=timeout)

    def drain(self):
        return self.adapter.drain()

    def feed(self, raw_bytes):
        return self.adapter.feed(raw_bytes)


__all__ = [
    "DeviceDriverError",
    "InjectorDeviceDriver",
    "NyExoA1TcpAdapter",
    "TcpDeviceDriver",
]
