"""EWOH 适配层管理器（AdapterManager，真实实现）。

为每个监听端口启动 TCP server，accept 后创建 NYExoA1Adapter 处理设备连接；
后台 watchdog 线程检查设备 last_seen，超 5s 判离线并发布 device_status offline。

端口绑定失败（权限/占用）时打印并跳过，不中断其他端口。

安全边界：manager 不主动向设备发送任何业务命令（只读模式）。
"""
import queue
import socket
import threading

from .adapters.ny_exo_a1.adapter import (
    NYExoA1Adapter, RealClock, ts_to_ms, _online_state, _online_lock)

_DEFAULT_LISTENERS = {9001: "real", 9002: "controlled_test", 9003: "simulated"}
_OFFLINE_AFTER_MS = 5000          # 5s 无帧判离线（协议确认书 3.2）
_WATCHDOG_INTERVAL_SEC = 1.0     # watchdog 检查周期
_ACCEPT_TIMEOUT_SEC = 0.5        # accept 超时，便于响应 stop


class AdapterManager:
    """适配层管理器：多端口 TCP 接入 + 在线 watchdog。"""

    def __init__(self, storage, bus, listeners=None, clock=None):
        self.storage = storage
        self.bus = bus
        self.listeners = listeners or dict(_DEFAULT_LISTENERS)
        self.clock = clock or RealClock()
        self.running = False
        self._servers = {}          # port -> socket
        self._adapters = []         # 活跃 NYExoA1Adapter 实例
        self._threads = []
        self._stop = threading.Event()
        self._device_last_seen = {}  # device_id -> epoch ms
        self._watchdog_thread = None
        self._last_seen_thread = None
        self._telemetry_sub = None
        self._status_sub = None

    def start(self):
        """启动所有监听端口 + watchdog + last_seen 更新线程。"""
        if self.running:
            return
        self.running = True
        self._stop.clear()
        for port, source_type in self.listeners.items():
            try:
                srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                srv.bind(("0.0.0.0", port))
                srv.listen(5)
                srv.settimeout(_ACCEPT_TIMEOUT_SEC)
                self._servers[port] = srv
                t = threading.Thread(target=self._accept_loop,
                                     args=(srv, port, source_type), daemon=True,
                                     name="adapter-accept:%d" % port)
                t.start()
                self._threads.append(t)
                print("[AdapterManager] 监听 %d (%s)" % (port, source_type))
            except OSError as e:
                print("[AdapterManager] 端口 %d 绑定失败，跳过: %s" % (port, e))
        # 订阅总线以更新 last_seen
        self._telemetry_sub = self.bus.subscribe("telemetry")
        self._status_sub = self.bus.subscribe("device_status")
        t = threading.Thread(target=self._last_seen_loop, daemon=True,
                             name="adapter-lastseen")
        t.start()
        self._threads.append(t)
        self._last_seen_thread = t
        # watchdog
        self._watchdog_thread = threading.Thread(target=self._watchdog_loop, daemon=True,
                                                  name="adapter-watchdog")
        self._watchdog_thread.start()

    def _accept_loop(self, srv, port, source_type):
        while not self._stop.is_set():
            try:
                conn, addr = srv.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            adapter = NYExoA1Adapter(conn, addr, self.storage, self.bus,
                                      source_type=source_type, clock=self.clock)
            self._adapters.append(adapter)
            adapter.start()

    def _last_seen_loop(self):
        """从总线消费 telemetry/device_status，更新 _device_last_seen。"""
        while not self._stop.is_set():
            for sub in (self._telemetry_sub, self._status_sub):
                if sub is None:
                    continue
                try:
                    msg = sub.get(timeout=0.2)
                except queue.Empty:
                    continue
                dev = msg.get("device_id")
                ts_ms = ts_to_ms(msg.get("timestamp"))
                if dev and ts_ms:
                    self.update_last_seen(dev, ts_ms)

    def update_last_seen(self, device_id, ms):
        """更新设备最近活跃时间（供测试直接调用）。"""
        if device_id and ms:
            self._device_last_seen[device_id] = ms

    def watchdog_once(self):
        """单次 watchdog 检查（供测试直接调用）。

        对每个有 last_seen 记录的设备，超过阈值未活跃则判离线。
        """
        now_ms = self.clock.now_ms()
        for dev_id, last_ms in list(self._device_last_seen.items()):
            if now_ms - last_ms > _OFFLINE_AFTER_MS:
                # 检查设备当前是否标记在线
                dev = next((d for d in self.storage.list_devices()
                            if d.get("device_id") == dev_id), None)
                if dev and dev.get("online"):
                    ts = self.clock.now_iso()
                    self.storage.mark_offline(dev_id, ts)
                    self.bus.publish("device_status",
                                     {"device_id": dev_id, "status": "offline",
                                      "timestamp": ts})

    def _watchdog_loop(self):
        while not self._stop.is_set():
            try:
                self.watchdog_once()
            except Exception:
                pass  # watchdog 异常不中断后台线程
            self._stop.wait(_WATCHDOG_INTERVAL_SEC)

    def stop(self):
        """停止所有 server socket 与 adapter。"""
        self._stop.set()
        self.running = False
        for srv in list(self._servers.values()):
            try:
                srv.close()
            except OSError:
                pass
        self._servers.clear()
        for ad in list(self._adapters):
            try:
                ad.stop()
            except Exception:
                pass
        self._adapters.clear()

    def health(self):
        return {"running": self.running, "servers": len(self._servers),
                "adapters": len(self._adapters),
                "listeners": self.listeners}
