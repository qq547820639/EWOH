"""NY-EXO-A1 设备适配器（NXP1 v1.0 线协议，只读模式）。

负责：接收设备 TCP 字节流 -> 拆帧 -> 解码为标准消息 -> 质量检查 -> 写入
持久层（raw_frame + telemetry）-> 发布到总线。

安全边界（受控试点阶段 1）：
- 仅接收设备上行帧（IDENT/HEARTBEAT/TELEMETRY/BACKFILL/FAULT）。
- 不实现任何平台→设备业务命令发送。白名单命令 IDENT_REQUEST(0x81)/TIME_SYNC(0x82)
  本阶段不实现发送，仅声明；急停/限扭/关节实时控制等安全闭环能力全部归属
  设备本地控制器。
"""
import queue
import socket
import threading
import time
from datetime import datetime, timezone

from ..base import DeviceAdapter, make_record_id, now_iso
from .protocol import (decode_frame, encode_telemetry, DEVICE_MODEL, PROTOCOL_VERSION,
                        TYPE_IDENT, TYPE_HEARTBEAT, TYPE_TELEMETRY, TYPE_BACKFILL,
                        TYPE_FAULT)
from .decoder import (decode_ident_frame, decode_telemetry_frame, decode_heartbeat_frame,
                       decode_fault_frame, decode_backfill_item)
from .quality import QualityChecker

# ---- 跨 adapter 共享的在线状态（manager 依赖） ----
_online_state = {}            # device_id -> bool
_online_lock = threading.Lock()


def _set_online(device_id, online):
    with _online_lock:
        _online_state[device_id] = online


def _is_online(device_id):
    with _online_lock:
        return _online_state.get(device_id, False)


def ts_to_ms(ts_iso):
    """ISO 8601 时间字符串 -> epoch ms。非法/空返回 None。"""
    if not ts_iso:
        return None
    s = str(ts_iso).strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(round(dt.timestamp() * 1000))
    except (ValueError, OverflowError, OSError):
        return None


class RealClock:
    """真实时钟，供适配器与 manager 获取当前时间。"""

    def now_ms(self):
        return int(round(time.time() * 1000))

    def now_iso(self):
        return datetime.now().astimezone().isoformat(timespec="milliseconds")


def _safe_addr(addr):
    """把 addr 转为可读字符串（兼容 AF_UNIX 无端口场景）。"""
    try:
        if isinstance(addr, tuple) and len(addr) >= 2:
            return "%s:%d" % (addr[0], addr[1])
        return str(addr)
    except Exception:
        return "unknown"


class NYExoA1Adapter(DeviceAdapter):
    """NY-EXO-A1 设备适配器（一台设备一条连接一个实例）。

    只读模式：不实现 send_command / write_param 等平台→设备控制方法。
    """

    def __init__(self, conn, addr, storage, bus, source_type="real",
                 clock=None, device_id=None):
        self.conn = conn
        self.addr = addr
        self.storage = storage
        self.bus = bus
        self.source_type = source_type
        self.clock = clock or RealClock()
        self._device_id = device_id
        self._firmware_version = None
        self._hardware_version = None
        self._buf = b""
        self._stop = threading.Event()
        self._quality_checkers = {}     # device_id -> QualityChecker
        self._backfill_seen = {}        # device_id -> set(seq) 补传去重
        self._message_queue = queue.Queue(maxsize=1000)
        self._thread = None
        self._connected = False

    # ---- 生命周期 ----
    def start(self):
        self._stop.clear()
        self._connected = True
        self._thread = threading.Thread(target=self.run, daemon=True,
                                        name="ny-exo-a1:%s" % _safe_addr(self.addr))
        self._thread.start()

    def stop(self):
        self._stop.set()
        self._connected = False
        # 先 shutdown 中断阻塞中的 recv()（仅 close() 在某些平台不会立刻唤醒
        # 阻塞在 recv 上的线程，会导致 join 超时、_on_disconnect 延后执行）
        try:
            self.conn.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            self.conn.close()
        except OSError:
            pass
        # 等待 adapter 线程退出，避免 _on_disconnect 与上层 storage.close() 竞争
        if self._thread is not None:
            self._thread.join(timeout=3.0)
            self._thread = None

    def reconnect(self):
        """TCP 由设备主动连接，平台不主动重连。本方法为空实现。"""
        return None

    # ---- 主循环 ----
    def run(self):
        """阻塞接收循环：recv -> 拆帧 -> 分发。"""
        while not self._stop.is_set():
            try:
                data = self.conn.recv(4096)
            except OSError:
                break
            if not data:
                break
            self._buf += data
            self._process_buffer()
        self._on_disconnect()

    def _on_disconnect(self):
        self._connected = False
        if self._device_id:
            _set_online(self._device_id, False)
            ts = self.clock.now_iso()
            try:
                self.storage.mark_offline(self._device_id, ts)
            except Exception:
                pass
            self.bus.publish("device_status",
                             {"device_id": self._device_id, "status": "offline",
                              "timestamp": ts})

    def _process_buffer(self):
        """尽量消费缓冲区中的完整帧。"""
        while self._buf and not self._stop.is_set():
            frame, consumed = decode_frame(self._buf)
            if consumed == 0 and frame is None:
                break  # 数据不足，等待更多
            if frame is None:
                self._buf = self._buf[consumed:]  # 跳字节重同步
                continue
            self._buf = self._buf[consumed:]
            if not frame.get("crc_ok") or not frame.get("tail_ok"):
                continue  # CRC/帧尾失败：跳过该帧
            self._dispatch(frame)

    def _dispatch(self, frame):
        ftype = frame.get("type")
        if ftype == TYPE_IDENT:
            self._handle_ident(frame)
        elif ftype == TYPE_HEARTBEAT:
            self._handle_heartbeat(frame)
        elif ftype == TYPE_TELEMETRY:
            self._handle_telemetry(frame)
        elif ftype == TYPE_BACKFILL:
            self._handle_backfill(frame)
        elif ftype == TYPE_FAULT:
            self._handle_fault(frame)

    # ---- 帧处理 ----
    def _handle_ident(self, frame):
        info = decode_ident_frame(frame)
        device_id = info.get("device_id")
        if not device_id:
            return
        self._device_id = device_id
        self._firmware_version = info.get("firmware_version")
        self._hardware_version = info.get("hardware_version")
        now = self.clock.now_iso()
        _set_online(device_id, True)
        self.storage.upsert_device(
            device_id=device_id, device_type="exoskeleton",
            model=DEVICE_MODEL, device_model=DEVICE_MODEL,
            firmware_version=self._firmware_version, protocol_version=PROTOCOL_VERSION,
            online=1, source_type=self.source_type, last_seen=now)
        try:
            self.storage.insert_audit(
                actor="device:%s" % device_id, action="IDENT",
                object_type="device", object_id=device_id,
                after_json={"firmware_version": self._firmware_version,
                            "hardware_version": self._hardware_version},
                source_ip=_safe_addr(self.addr), result="ok")
        except Exception:
            pass
        self.bus.publish("device_status",
                         {"device_id": device_id, "status": "online", "timestamp": now})

    def _handle_heartbeat(self, frame):
        if not self._device_id:
            return
        info = decode_heartbeat_frame(frame)
        now = self.clock.now_iso()
        fw = info.get("firmware_version") or self._firmware_version
        if info.get("firmware_version"):
            self._firmware_version = info["firmware_version"]
        self.storage.upsert_device(
            device_id=self._device_id, device_type="exoskeleton",
            model=DEVICE_MODEL, device_model=DEVICE_MODEL,
            firmware_version=fw, protocol_version=PROTOCOL_VERSION,
            online=1, source_type=self.source_type, last_seen=now)
        _set_online(self._device_id, True)
        self.bus.publish("device_status",
                         {"device_id": self._device_id, "status": "online",
                          "timestamp": now,
                          "battery_percent": info.get("battery_percent")})

    def _handle_telemetry(self, frame):
        if not self._device_id:
            return
        msg = decode_telemetry_frame(frame, self.source_type, device_id_hint=self._device_id)
        msg["firmware_version"] = self._firmware_version
        msg = self._quality_check(self._device_id, msg)
        raw_ref = self.storage.insert_raw_frame(
            self._device_id, msg["timestamp"], msg.get("sequence") or 0,
            frame.get("type"), frame.get("raw", b""), self.source_type)
        msg["raw_ref"] = raw_ref
        self.storage.insert_telemetry(msg)
        self.bus.publish("telemetry", msg)
        try:
            self._message_queue.put_nowait(msg)
        except queue.Full:
            pass

    def _handle_backfill(self, frame):
        if not self._device_id:
            return
        payload = frame.get("payload") or {}
        items = payload.get("items", [])
        seen = self._backfill_seen.setdefault(self._device_id, set())
        # 把整条 BACKFILL 帧存为一条 raw_frame，子项通过 raw_ref 关联
        parent_raw_ref = self.storage.insert_raw_frame(
            self._device_id, self.clock.now_iso(), frame.get("seq") or 0,
            frame.get("type"), frame.get("raw", b""), self.source_type)
        for item in items:
            seq = item.get("seq")
            if seq is None:
                continue
            if seq in seen:
                continue  # 本会话内补传去重（内存级）
            seen.add(seq)
            # 跨连接持久化去重：若 (device_id, seq) 已存在于实时流或更早补传中，
            # 跳过本条，避免重复入库（对齐 spec §3.5「补传数据按 SEQ 去重」）
            try:
                if self.storage.has_telemetry_seq(self._device_id, seq):
                    continue
            except Exception:
                pass
            msg = decode_backfill_item(item, self.source_type, device_id_hint=self._device_id)
            msg["firmware_version"] = self._firmware_version
            msg["raw_ref"] = parent_raw_ref
            msg = self._quality_check(self._device_id, msg)
            self.storage.insert_telemetry(msg)
            self.bus.publish("telemetry", msg)

    def _handle_fault(self, frame):
        if not self._device_id:
            return
        info = decode_fault_frame(frame)
        info["device_id"] = self._device_id
        now = self.clock.now_iso()
        try:
            self.storage.insert_audit(
                actor="device:%s" % self._device_id, action="FAULT",
                object_type="device", object_id=self._device_id,
                after_json={"fault_code": info.get("fault_code"),
                            "fault_name": info.get("fault_name"),
                            "detail": info.get("detail")},
                source_ip=_safe_addr(self.addr), result="fault")
        except Exception:
            pass
        self.bus.publish("device_status",
                         {"device_id": self._device_id, "status": "fault",
                          "timestamp": now, "fault": info})

    def _quality_check(self, device_id, msg):
        checker = self._quality_checkers.get(device_id)
        if checker is None:
            checker = QualityChecker()
            self._quality_checkers[device_id] = checker
        return checker.check(device_id, msg)

    # ---- 查询接口 ----
    def health(self):
        return {"connected": self._connected, "device_id": self._device_id,
                "source_type": self.source_type,
                "firmware_version": self._firmware_version}

    def device_info(self):
        return {"device_id": self._device_id, "device_model": DEVICE_MODEL,
                "firmware_version": self._firmware_version,
                "hardware_version": self._hardware_version,
                "protocol_version": PROTOCOL_VERSION}

    def read_message(self):
        """读取一条已解码消息（无数据返回 None）。"""
        try:
            return self._message_queue.get_nowait()
        except queue.Empty:
            return None
