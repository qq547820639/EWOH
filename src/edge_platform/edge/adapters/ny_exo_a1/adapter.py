"""NY-EXO-A1 腰部助力外骨骼适配器：NXP1 原始帧 → 统一语义帧。

对应 spec「外骨骼数据分级与统一语义」「多传感器适配扩展」：厂商私有字段在本层
全部转换为 `edge_platform.edge.exo_semantic.UnifiedExoFrame`，不泄漏到上层业务；
source_type ∈ {real, controlled_test, simulated} 实现来源隔离。

数据通路：
    原始字节 → protocol.decode_stream（CRC 校验/重同步）
             → protocol.parse_payload（厂商物理量）
             → VENDOR_TO_UNIFIED 映射 → UnifiedExoFrame

设备状态（device_id / 固件版本 / 故障码 / 电量）由 IDENT / FAULT / HEARTBEAT 帧
维护在适配器内部，并在每条 TELEMETRY 产出的统一帧上下文中携带。

纯 Python 标准库实现，不引入任何第三方依赖。
"""

import math
import queue
import struct
from datetime import datetime, timedelta, timezone

from edge_platform.edge.adapters.base import BaseAdapter
from edge_platform.edge.adapters.ny_exo_a1 import protocol
from edge_platform.edge.exo_semantic import (
    UnifiedExoFrame,
    map_vendor_to_unified,
    to_storage_dict,
)

#: 厂商原始字段 → 统一语义路径映射（spec 5.2；docs/data/multimodal_schema.md §6.2）
#: 未列入本表的厂商字段一律不进入统一帧。
VENDOR_TO_UNIFIED = {
    "device_id": "entity_id",
    "worker_id": "worker_id",
    "event_time": "event_time",
    "source_type": "source_type",
    # 运动级
    "pitch_deg": "pose.trunk_pitch_deg",
    "gyro_norm_dps": "pose.angular_velocity_dps",
    "joint_angles_deg": "pose.joint_angles_deg",
    # 负荷级
    "assist_level": "load.assist_level",
    "torque_nm": "load.torque_nm",
    "cumulative_load_score": "load.cumulative_load_score",
    # 设备级
    "battery_pct": "device.battery_pct",
    "temperature_c": "device.temperature_c",
    "fault_code": "device.fault_code",
    "health": "device.health",
    # 数据质量
    "packet_loss_pct": "quality.packet_loss_pct",
    "confidence": "quality.confidence",
    "quality_status": "quality.status",
}

#: 工厂本地时区偏移（小时）。NXP1 TS_MS 为设备本地 epoch 毫秒，统一转 ISO 8601 带偏移。
DEFAULT_TZ_OFFSET_HOURS = 8

#: 电量健康阈值（协议确认书：低电量安全阈值 10%）
LOW_BATTERY_PCT = 10


def ts_ms_to_iso(ts_ms, tz_offset_hours=DEFAULT_TZ_OFFSET_HOURS):
    """设备 epoch 毫秒 → ISO 8601 字符串（毫秒精度，带时区偏移）。

    输出形如 `2026-08-24T09:46:40.000+08:00`，可被标准库 `datetime.fromisoformat` 解析。
    """
    tz = timezone(timedelta(hours=tz_offset_hours))
    return datetime.fromtimestamp(ts_ms / 1000.0, tz).isoformat(timespec="milliseconds")


def _gyro_norm(gyro_dps):
    """三轴角速度 → 合成角速度模长（dps）；任一轴缺失则返回 None。"""
    if not gyro_dps or any(v is None for v in gyro_dps):
        return None
    return round(math.sqrt(sum(v * v for v in gyro_dps)), 4)


class NyExoA1Adapter(BaseAdapter):
    """NY-EXO-A1 外骨骼适配器。

    真实驱动子类通过 `feed(raw_bytes)` 投递设备原始字节流（TCP 粘包由内部缓冲处理），
    解析出的统一语义消息进入 `_inbox`；`read_message` 按 BaseAdapter 契约取出 dict。
    需要 dataclass 对象时用 `read_unified_frame`。
    """

    DEVICE_TYPE = "exoskeleton"
    PROTOCOL_VERSION = protocol.PROTOCOL_VERSION

    def __init__(self, device_id, source_type="real", model="NY-EXO-A1",
                 firmware_version="", worker_id=None,
                 tz_offset_hours=DEFAULT_TZ_OFFSET_HOURS, maxsize=1024):
        super().__init__(device_id, source_type=source_type, model=model,
                         firmware_version=firmware_version)
        self.worker_id = worker_id
        self.tz_offset_hours = tz_offset_hours
        self.hardware_version = ""
        self._inbox = queue.Queue(maxsize=maxsize)
        self._buffer = bytearray()
        self._last_seq = None
        self._last_seen = None
        self._fault_code = None
        self._battery_pct = None
        # 丢包统计：期望帧数与实际收到帧数（按 SEQ 连续性推算）
        self._expected_frames = 0
        self._received_frames = 0
        self._bad_crc_frames = 0
        self._malformed_frames = 0

    # ---- 生命周期 ----
    def start(self):
        self._running = True
        self._started_at = ts_ms_to_iso(_now_ms(), self.tz_offset_hours)

    def stop(self):
        self._running = False

    def reconnect(self):
        # 重连后 SEQ 基线失效，避免把重连当成一次巨量丢包
        self._last_seq = None
        self._buffer.clear()
        self._running = True
        return True

    # ---- 状态与元信息 ----
    def health(self):
        if not self._running:
            status = "offline"
        elif self._fault_code or self._is_low_battery():
            status = "degraded"
        else:
            status = "online"
        return {
            "device_id": self.device_id,
            "type": self.DEVICE_TYPE,
            "status": status,
            "source_type": self.source_type,
            "last_seen": self._last_seen,
            "started_at": self._started_at,
            "battery_pct": self._battery_pct,
            "fault_code": self._fault_code,
            "packet_loss_pct": self.packet_loss_pct(),
            "bad_crc_frames": self._bad_crc_frames,
        }

    def device_info(self):
        return {
            "device_id": self.device_id,
            "type": self.DEVICE_TYPE,
            "model": self.model,
            "firmware_version": self.firmware_version,
            "hardware_version": self.hardware_version,
            "protocol_version": self.PROTOCOL_VERSION,
            "source_type": self.source_type,
            "worker_id": self.worker_id,
        }

    # ---- 数据读取 ----
    def read_message(self, timeout=None):
        """取出一条统一语义消息 dict（spec 5.2 存储格式）；超时返回 None。"""
        frame = self.read_unified_frame(timeout=timeout)
        return to_storage_dict(frame) if frame is not None else None

    def read_unified_frame(self, timeout=None):
        """取出一个 UnifiedExoFrame 对象；超时返回 None。"""
        try:
            return self._inbox.get(timeout=timeout)
        except queue.Empty:
            return None

    def drain(self):
        """一次性取出当前队列中全部 UnifiedExoFrame（离线回放/批量测试用）。"""
        out = []
        while True:
            try:
                out.append(self._inbox.get_nowait())
            except queue.Empty:
                return out

    def feed(self, raw_bytes):
        """投递设备原始字节流，解析并入队统一语义帧，返回本次新增帧数。

        内部维护粘包缓冲：不完整的尾部字节保留到下次 feed。
        """
        self._buffer.extend(raw_bytes)
        produced = 0
        while True:
            frame, consumed = protocol.decode_frame(self._buffer)
            if consumed == 0:
                break  # 数据不足一帧，等待后续字节
            del self._buffer[:consumed]
            if frame is None:
                continue  # 帧头失配，已跳字节重同步
            unified = self._handle_frame(frame)
            if unified is not None:
                try:
                    self._inbox.put_nowait(unified)
                    produced += 1
                except queue.Full:
                    pass  # 背压：丢弃最新帧，由 packet_loss 统计体现
        return produced

    # ---- 内部：帧处理与统一语义映射 ----
    def _handle_frame(self, frame):
        """处理单帧：状态帧更新内部状态，TELEMETRY 返回 UnifiedExoFrame。"""
        if not frame["crc_ok"]:
            self._bad_crc_frames += 1
            return None  # 坏帧不进入上层（spec：CRC 失败帧拒绝）

        self._track_sequence(frame["seq"])
        self._last_seen = ts_ms_to_iso(frame["ts_ms"], self.tz_offset_hours)
        try:
            payload = protocol.parse_payload(frame)
        except (ValueError, struct.error):
            # CRC 通过但载荷长度不合法（固件异常/协议不匹配）：丢弃该帧，不中断采集
            self._malformed_frames += 1
            return None

        if frame["type"] == protocol.TYPE_IDENT:
            self.device_id = payload.get("device_id") or self.device_id
            self.firmware_version = payload.get("firmware_version") or self.firmware_version
            self.hardware_version = payload.get("hardware_version") or self.hardware_version
            return None
        if frame["type"] == protocol.TYPE_FAULT:
            self._fault_code = payload["fault_code"] if payload["faulted"] else None
            return None
        if frame["type"] == protocol.TYPE_HEARTBEAT:
            self._battery_pct = payload.get("battery_pct")
            return None
        if frame["type"] == protocol.TYPE_TELEMETRY:
            return self.to_unified(payload, frame["ts_ms"])
        return None  # BACKFILL 等类型由补传通道单独处理

    def _track_sequence(self, seq):
        """按 SEQ 连续性累计期望/实际帧数，用于丢包率统计。"""
        self._received_frames += 1
        if self._last_seq is None:
            self._expected_frames += 1
        else:
            delta = (seq - self._last_seq) & 0xFFFFFFFF
            # delta 过大视为重连/回绕，不计入丢包，避免统计被污染
            self._expected_frames += delta if 0 < delta <= 1000 else 1
        self._last_seq = seq

    def packet_loss_pct(self):
        """按 SEQ 推算的丢包率（0—100）。无样本时返回 0.0。"""
        if self._expected_frames <= 0:
            return 0.0
        lost = max(0, self._expected_frames - self._received_frames)
        return round(100.0 * lost / self._expected_frames, 4)

    def _is_low_battery(self):
        return self._battery_pct is not None and self._battery_pct < LOW_BATTERY_PCT

    def to_unified(self, telemetry, ts_ms):
        """厂商遥测物理量 dict → UnifiedExoFrame（唯一的统一语义转换入口）。

        质量判定：
        - 越量程（pitch/roll/torque/battery）→ quality.status=invalid，置信度 0.0；
        - 关键字段缺失（哨兵 0x7FFF）→ quality.status=degraded，置信度打折；
        - 否则 good。
        """
        pitch = telemetry.get("pitch_deg")
        torque = telemetry.get("torque_nm")
        battery = telemetry.get("battery_pct")
        assist_pct = telemetry.get("assist_pct")

        out_of_range = not (
            protocol.in_range(pitch, protocol.RANGE_PITCH_DEG)
            and protocol.in_range(telemetry.get("roll_deg"), protocol.RANGE_ROLL_DEG)
            and protocol.in_range(torque, protocol.RANGE_TORQUE_NM)
            and protocol.in_range(battery, protocol.RANGE_BATTERY_PCT)
        )
        missing = pitch is None or torque is None

        if out_of_range:
            quality_status, confidence = "invalid", 0.0
        elif missing:
            quality_status, confidence = "degraded", 0.5
        else:
            quality_status, confidence = "good", 0.95

        if self._fault_code:
            health = "fault"
        elif self._is_low_battery() or quality_status != "good":
            health = "degraded"
        else:
            health = "good"

        vendor = {
            "device_id": self.device_id,
            "worker_id": self.worker_id,
            "event_time": ts_ms_to_iso(ts_ms, self.tz_offset_hours),
            "source_type": self.source_type,
            "pitch_deg": pitch,
            "gyro_norm_dps": _gyro_norm(telemetry.get("gyro_dps")),
            # NXP1 v1.0 不提供关节角/设备温度/累计负荷，保持 None 待厂商扩展或算法层回填
            "joint_angles_deg": None,
            "assist_level": round(assist_pct / 100.0, 4) if assist_pct is not None else None,
            "torque_nm": torque,
            "cumulative_load_score": None,
            "battery_pct": battery,
            "temperature_c": None,
            "fault_code": self._fault_code,
            "health": health,
            "packet_loss_pct": self.packet_loss_pct(),
            "confidence": confidence,
            "quality_status": quality_status,
        }
        return map_vendor_to_unified(vendor, VENDOR_TO_UNIFIED)


def frames_from_bytes(raw, device_id="EXO-UNKNOWN", source_type="real",
                      worker_id=None, tz_offset_hours=DEFAULT_TZ_OFFSET_HOURS):
    """便捷函数：一段原始字节流 → [UnifiedExoFrame, ...]（离线回放/fixture 测试用）。

    仅解析，不启动适配器线程；坏帧按协议约定丢弃。
    """
    adapter = NyExoA1Adapter(device_id, source_type=source_type, worker_id=worker_id,
                             tz_offset_hours=tz_offset_hours)
    adapter.feed(raw)
    return adapter.drain()


def _now_ms():
    """当前 epoch 毫秒。"""
    return int(datetime.now(timezone.utc).timestamp() * 1000)


__all__ = [
    "NyExoA1Adapter", "VENDOR_TO_UNIFIED", "ts_ms_to_iso",
    "frames_from_bytes", "UnifiedExoFrame",
]
