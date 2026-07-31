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

import hashlib
import math
import queue
import struct
from collections import deque
from datetime import datetime, timedelta, timezone

from edge_platform.edge.adapters.base import BaseAdapter
from edge_platform.edge.adapters.ny_exo_a1 import protocol
from edge_platform.edge.exo_semantic import (
    UnifiedExoFrame,
    map_vendor_to_unified,
    to_storage_dict,
)
from edge_platform.spatial import now_iso

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

#: BACKFILL 去重窗口：记住最近 N 个已产出的 SEQ（协议确认书 3.5「补传按 SEQ 去重」）
BACKFILL_DEDUP_WINDOW = 4096

#: 原始帧留存环形缓冲默认容量（Task 2.1「原始帧保留」/ Task 3.2「双向追溯」）
DEFAULT_RAW_RING_SIZE = 512

#: 时间戳漂移阈值（ms）：实时遥测帧间 ts_ms 跳变超过该值判 degraded（Task 10.1）
DEFAULT_TS_DRIFT_THRESHOLD_MS = 500

#: 采样率统计窗口（ms）：按该窗口统计实际帧数与期望采样率比较（Task 10.1）
DEFAULT_SAMPLING_WINDOW_MS = 10000

#: 期望采样率（Hz，协议确认书 3.4：TELEMETRY 20Hz）
DEFAULT_EXPECTED_HZ = 20.0

#: 采样率偏差阈值：实际/期望偏差超过该比例判 degraded（Task 10.1）
DEFAULT_SAMPLING_DEVIATION = 0.2


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


def _raw_ref(raw_bytes):
    """原始帧字节 → SHA256 hex 引用（spec「标准消息扩展」raw_ref 字段）。

    用于「标准消息 ↔ 原始帧」双向追溯；空输入返回空串。
    """
    if not raw_bytes:
        return ""
    return hashlib.sha256(raw_bytes).hexdigest()


class NyExoA1Adapter(BaseAdapter):
    """NY-EXO-A1 外骨骼适配器。

    真实驱动（`edge_platform.edge.device_driver`）通过 `feed(raw_bytes)` 投递设备原始
    字节流（TCP 粘包由内部缓冲处理）。产出的统一语义帧有两种取用方式：

    - **拉模式**（默认）：帧进入 `_inbox`，用 `read_message` / `read_unified_frame`
      / `drain` 取出，符合 BaseAdapter 契约；
    - **推模式**：构造时传入 `frame_sink=fn(unified_frame, meta)`，帧产出即回调，
      驱动层据此直接落库并建立「统一消息 ↔ 原始帧」索引，不再入队。

    `keep_raw=True` 时按环形缓冲留存原始帧字节（Task 2.1「原始帧保留」，
    配合 `find_raw` 支持 Task 3.2 的双向追溯）。
    """

    DEVICE_TYPE = "exoskeleton"
    PROTOCOL_VERSION = protocol.PROTOCOL_VERSION

    def __init__(self, device_id, source_type="real", model="NY-EXO-A1",
                 firmware_version="", worker_id=None,
                 tz_offset_hours=DEFAULT_TZ_OFFSET_HOURS, maxsize=1024,
                 frame_sink=None, keep_raw=False, raw_ring_size=DEFAULT_RAW_RING_SIZE,
                 ts_drift_threshold_ms=DEFAULT_TS_DRIFT_THRESHOLD_MS,
                 sampling_window_ms=DEFAULT_SAMPLING_WINDOW_MS,
                 expected_hz=DEFAULT_EXPECTED_HZ,
                 sampling_deviation_threshold=DEFAULT_SAMPLING_DEVIATION):
        super().__init__(device_id, source_type=source_type, model=model,
                         firmware_version=firmware_version)
        if frame_sink is not None and not callable(frame_sink):
            raise TypeError("frame_sink 必须可调用或为 None")
        self.worker_id = worker_id
        self.tz_offset_hours = tz_offset_hours
        self.hardware_version = ""
        self.frame_sink = frame_sink
        self.keep_raw = bool(keep_raw)
        self._inbox = queue.Queue(maxsize=maxsize)
        self._buffer = bytearray()
        self._last_seq = None
        self._last_seen = None
        self._fault_code = None
        self._fault_name = None
        self._battery_pct = None
        # 丢包统计：期望帧数与实际收到帧数（按 SEQ 连续性推算）
        self._expected_frames = 0
        self._received_frames = 0
        self._bad_crc_frames = 0
        self._malformed_frames = 0
        # 补传去重（协议确认书 3.5）与背压/回调计数
        self._seen_seqs = set()
        self._seen_seq_order = deque(maxlen=BACKFILL_DEDUP_WINDOW)
        self._backfill_frames = 0
        self._backfill_duplicates = 0
        self._dropped_frames = 0
        self._sink_errors = 0
        # 原始帧留存（record 形态见 _remember_raw）
        self._raw_ring = deque(maxlen=int(raw_ring_size))
        # Task 10.1 数据质量增强参数
        self._ts_drift_threshold_ms = int(ts_drift_threshold_ms)
        self._sampling_window_ms = int(sampling_window_ms)
        self._expected_hz = float(expected_hz)
        self._sampling_deviation_threshold = float(sampling_deviation_threshold)
        # 时间戳漂移/倒退基线（仅实时遥测帧维护，补传 ts 为历史值不参与）
        self._last_telemetry_ts_ms = None
        # 实时帧 SEQ 即时重复标志（由 _track_sequence 置位，TELEMETRY 分支消费）
        self._last_seq_duplicate = False
        # 采样率滑动窗口：最近一个窗口内的实时遥测 ts_ms（Task 10.1）
        self._telemetry_ts_window = deque()
        # 固件升级事件（最近一次，None 表示未发生；Task 10.1）
        self._firmware_upgraded = None

    # ---- 生命周期 ----
    def start(self):
        self._running = True
        self._started_at = ts_ms_to_iso(_now_ms(), self.tz_offset_hours)

    def stop(self):
        self._running = False

    def reconnect(self):
        """重连：清空半包缓冲与 SEQ 基线，恢复采集（平台无需重启，Task 6）。

        SEQ 去重窗口 **不清空**——重连后设备会 BACKFILL 补传断线期间的缓存，
        需要靠它把与实时帧重复的 SEQ 去掉（协议确认书 3.5）。
        时间戳漂移基线与采样率窗口一并清空：重连后时间连续性已断，避免误报。
        """
        self._last_seq = None
        self._last_seq_duplicate = False
        self._last_telemetry_ts_ms = None
        self._telemetry_ts_window.clear()
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
            "fault_name": self._fault_name,
            "packet_loss_pct": self.packet_loss_pct(),
            "bad_crc_frames": self._bad_crc_frames,
            "malformed_frames": self._malformed_frames,
            "backfill_frames": self._backfill_frames,
            "backfill_duplicates": self._backfill_duplicates,
            "dropped_frames": self._dropped_frames,
            "sink_errors": self._sink_errors,
            "firmware_upgraded": self._firmware_upgraded,
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
        """投递设备原始字节流，解析并产出统一语义帧，返回本次新增帧数。

        内部维护粘包缓冲：不完整的尾部字节保留到下次 feed。
        推模式（构造时给了 frame_sink）下帧直接回调，不入 `_inbox`。
        """
        self._buffer.extend(raw_bytes)
        produced = 0
        while True:
            frame, consumed = protocol.decode_frame(self._buffer)
            if consumed == 0:
                break  # 数据不足一帧，等待后续字节
            raw = bytes(self._buffer[:consumed])
            del self._buffer[:consumed]
            if frame is None:
                continue  # 帧头失配，已跳字节重同步
            for unified, meta in self._handle_frame(frame, raw):
                produced += 1
                if self.frame_sink is not None:
                    try:
                        self.frame_sink(unified, meta)
                    except Exception:  # noqa: BLE001 - 下游异常不得中断采集
                        self._sink_errors += 1
                    continue
                try:
                    self._inbox.put_nowait(unified)
                except queue.Full:
                    self._dropped_frames += 1  # 背压：由 dropped_frames 统计体现
        return produced

    # ---- 内部：帧处理与统一语义映射 ----
    def _handle_frame(self, frame, raw=b""):
        """处理单帧，返回 [(UnifiedExoFrame, meta), ...]。

        状态帧（IDENT/HEARTBEAT/FAULT）只更新内部状态，返回空列表；
        TELEMETRY 返回一条；BACKFILL 返回补传条目（按 SEQ 去重后）。
        """
        if not frame["crc_ok"]:
            self._bad_crc_frames += 1
            self._remember_raw(frame, raw, note="bad_crc")
            return []  # 坏帧不进入上层（spec：CRC 失败帧拒绝）

        self._track_sequence(frame["seq"])
        self._last_seen = ts_ms_to_iso(frame["ts_ms"], self.tz_offset_hours)
        try:
            payload = protocol.parse_payload(frame)
        except (ValueError, struct.error):
            # CRC 通过但载荷长度不合法（固件异常/协议不匹配）：丢弃该帧，不中断采集
            self._malformed_frames += 1
            self._remember_raw(frame, raw, note="malformed")
            return []

        self._remember_raw(frame, raw)

        if frame["type"] == protocol.TYPE_IDENT:
            self.device_id = payload.get("device_id") or self.device_id
            new_fw = payload.get("firmware_version")
            old_fw = self.firmware_version
            self.firmware_version = new_fw or self.firmware_version
            self.hardware_version = payload.get("hardware_version") or self.hardware_version
            # Task 10.1：固件版本变化 → 记录事件并产出一条状态消息
            if new_fw and old_fw and new_fw != old_fw:
                self._firmware_upgraded = {
                    "event": "firmware_upgraded",
                    "device_id": self.device_id,
                    "firmware_from": old_fw,
                    "firmware_to": new_fw,
                    "ts_ms": frame["ts_ms"],
                    "event_time": ts_ms_to_iso(frame["ts_ms"], self.tz_offset_hours),
                }
                return [(self._firmware_upgrade_frame(self._firmware_upgraded),
                         self._meta(frame, raw, frame["seq"], frame["ts_ms"], backfill=False))]
            return []
        if frame["type"] == protocol.TYPE_FAULT:
            faulted = payload["faulted"]
            self._fault_code = payload["fault_code"] if faulted else None
            self._fault_name = payload.get("fault_name") if faulted else None
            return []
        if frame["type"] == protocol.TYPE_HEARTBEAT:
            self._battery_pct = payload.get("battery_pct")
            return []
        if frame["type"] == protocol.TYPE_TELEMETRY:
            # 实时帧一律产出（重复 SEQ 只在补传通道去重），但登记 SEQ 以便补传去重
            self._mark_seq(frame["seq"])
            reasons = self._check_timestamp_drift(frame["ts_ms"])
            if self._last_seq_duplicate:
                reasons.append("duplicate_seq")
            if self._check_sampling_rate(frame["ts_ms"]):
                reasons.append("sampling_rate_anomaly")
            return [(self.to_unified(payload, frame["ts_ms"], raw_bytes=raw,
                                     quality_reasons=reasons),
                     self._meta(frame, raw, frame["seq"], frame["ts_ms"], backfill=False))]
        if frame["type"] == protocol.TYPE_BACKFILL:
            return self._handle_backfill(payload, frame, raw)
        return []  # 未知类型：忽略，不中断采集

    def _firmware_upgrade_frame(self, event):
        """固件升级状态消息：以 UnifiedExoFrame 形态承载事件，便于走既有产出通路。"""
        status = UnifiedExoFrame(
            entity_id=self.device_id,
            worker_id=self.worker_id,
            event_time=event["event_time"],
            source_type=self.source_type,
        )
        status.ingested_at = now_iso()
        status.device_model = self.model
        status.firmware_version = self.firmware_version
        status.protocol_version = self.PROTOCOL_VERSION
        status.device = {
            "battery_pct": self._battery_pct,
            "temperature_c": None,
            "fault_code": self._fault_code,
            "health": "fault" if self._fault_code else "good",
        }
        status.quality = {
            "packet_loss_pct": self.packet_loss_pct(),
            "confidence": 1.0,
            "status": "good",
            "reason": None,
            "event": "firmware_upgraded",
            "firmware_from": event["firmware_from"],
            "firmware_to": event["firmware_to"],
        }
        return status

    def _check_timestamp_drift(self, ts_ms):
        """实时遥测帧时间戳倒退/漂移检测（Task 10.1）。

        比较当前帧与上一实时遥测帧 ts_ms：倒退或漂移超过阈值返回对应降级原因。
        首帧（无基线）返回空列表。基线仅由实时帧维护，补传历史 ts 不参与。
        """
        reasons = []
        if self._last_telemetry_ts_ms is not None:
            delta = ts_ms - self._last_telemetry_ts_ms
            if delta < 0:
                reasons.append("timestamp_backward")
            elif delta > self._ts_drift_threshold_ms:
                reasons.append("timestamp_drift")
        self._last_telemetry_ts_ms = ts_ms
        return reasons

    def _check_sampling_rate(self, ts_ms):
        """滑动窗口采样率异常检测（Task 10.1）。

        维护最近一个窗口内的实时遥测 ts_ms；窗口跨度达到 sampling_window_ms 时
        统计实际帧数，与期望采样率比较，偏差超过阈值返回 True。窗口未满（启动期）
        不评估，避免误报。
        """
        window = self._telemetry_ts_window
        window.append(ts_ms)
        cutoff = ts_ms - self._sampling_window_ms
        while window and window[0] < cutoff:
            window.popleft()
        if len(window) < 2:
            return False
        span = ts_ms - window[0]
        if span < self._sampling_window_ms:
            return False  # 窗口未满，不评估
        expected = (span / 1000.0) * self._expected_hz
        if expected <= 0:
            return False
        deviation = abs(len(window) - expected) / expected
        return deviation > self._sampling_deviation_threshold

    def _handle_backfill(self, entries, frame, raw):
        """补传帧展开为统一语义帧（协议确认书 3.5：按 SEQ 去重）。"""
        self._backfill_frames += 1
        out = []
        for entry in entries:
            seq = entry.get("seq", 0)
            if not self._mark_seq(seq):
                self._backfill_duplicates += 1
                continue
            ts_ms = entry.get("ts_ms", frame["ts_ms"])
            out.append((self.to_unified(entry.get("telemetry") or {}, ts_ms, raw_bytes=raw),
                        self._meta(frame, raw, seq, ts_ms, backfill=True)))
        return out

    def _mark_seq(self, seq):
        """登记一个已产出的遥测 SEQ；返回 False 表示重复（应去重丢弃）。"""
        if seq in self._seen_seqs:
            return False
        if len(self._seen_seq_order) == self._seen_seq_order.maxlen:
            self._seen_seqs.discard(self._seen_seq_order[0])
        self._seen_seq_order.append(seq)
        self._seen_seqs.add(seq)
        return True

    def _meta(self, frame, raw, seq, ts_ms, backfill=False):
        """统一帧的溯源元信息：驱动层据此建立「标准消息 ↔ 原始帧」索引。"""
        return {
            "device_id": self.device_id,
            "source_type": self.source_type,
            "seq": seq,
            "ts_ms": ts_ms,
            "frame_seq": frame["seq"],
            "frame_type": frame["type"],
            "frame_type_name": frame["type_name"],
            "backfill": bool(backfill),
            "raw": raw,
            "raw_len": len(raw),
        }

    def _remember_raw(self, frame, raw, note="ok"):
        """按环形缓冲留存原始帧（keep_raw=True 时生效）。"""
        if not self.keep_raw or not raw:
            return
        self._raw_ring.append({
            "seq": frame.get("seq"),
            "ts_ms": frame.get("ts_ms"),
            "frame_type": frame.get("type_name"),
            "bytes_len": len(raw),
            "note": note,
            "raw_hex": raw.hex(),
        })

    def raw_frames(self, limit=None):
        """返回已留存的原始帧记录（最近 limit 条），供 G2 原始数据样本导出。"""
        items = list(self._raw_ring)
        if limit is not None and limit > 0:
            return items[-int(limit):]
        return items

    def find_raw(self, seq):
        """按 SEQ 反查原始帧记录（Task 3.2 双向追溯）；未留存返回 None。"""
        for item in reversed(self._raw_ring):
            if item.get("seq") == seq:
                return item
        return None

    def _track_sequence(self, seq):
        """按 SEQ 连续性累计期望/实际帧数，用于丢包率统计。

        Task 10.1：同时检测 SEQ 即时重复（delta==0，与上一帧同号），结果置入
        `self._last_seq_duplicate` 供 TELEMETRY 分支标记 degraded。补传通道的
        跨窗口去重仍由 `_mark_seq` 负责，两者互补。
        """
        self._received_frames += 1
        is_duplicate = False
        if self._last_seq is None:
            self._expected_frames += 1
        else:
            delta = (seq - self._last_seq) & 0xFFFFFFFF
            if delta == 0:
                # 即时重复：SEQ 未前进，计入实际帧但不增加期望帧（与丢包区分）
                is_duplicate = True
            else:
                # delta 过大视为重连/回绕，不计入丢包，避免统计被污染
                self._expected_frames += delta if 0 < delta <= 1000 else 1
        self._last_seq = seq
        self._last_seq_duplicate = is_duplicate

    def packet_loss_pct(self):
        """按 SEQ 推算的丢包率（0—100）。无样本时返回 0.0。"""
        if self._expected_frames <= 0:
            return 0.0
        lost = max(0, self._expected_frames - self._received_frames)
        return round(100.0 * lost / self._expected_frames, 4)

    def _is_low_battery(self):
        return self._battery_pct is not None and self._battery_pct < LOW_BATTERY_PCT

    def to_unified(self, telemetry, ts_ms, raw_bytes=b"", quality_reasons=None):
        """厂商遥测物理量 dict → UnifiedExoFrame（唯一的统一语义转换入口）。

        质量判定（Task 10.1/10.2）：
        - 越量程（pitch/roll/torque/battery）→ invalid，置信度 0.0；
        - 非数值（NaN/inf，防御性：协议层正常不产生，但 backfill/未来路径可能引入）
          → invalid，置信度 0.0；
        - 关键字段缺失（哨兵 0x7FFF）→ degraded，置信度打折；
        - 上游降级原因（时间戳漂移/倒退、SEQ 重复、采样率异常）非空 → degraded；
        - 否则 good。

        Task 10.2：invalid 帧保留原始（raw_ref）但 confidence=0.0 不进入推理管线；
        quality dict 增加 `reason` 字段说明 invalid/degraded 原因（good 时为 None）。

        标准消息扩展字段（spec「标准消息扩展与数据质量」）在本方法填充：
        device_model/firmware_version/protocol_version 取自适配器状态（IDENT/HEARTBEAT 维护），
        raw_ref 为原始帧字节 SHA256 引用，record_id/ingested_at 由 UnifiedExoFrame.__post_init__ 生成。
        """
        pitch = telemetry.get("pitch_deg")
        roll = telemetry.get("roll_deg")
        torque = telemetry.get("torque_nm")
        battery = telemetry.get("battery_pct")
        assist_pct = telemetry.get("assist_pct")

        out_of_range = not (
            protocol.in_range(pitch, protocol.RANGE_PITCH_DEG)
            and protocol.in_range(roll, protocol.RANGE_ROLL_DEG)
            and protocol.in_range(torque, protocol.RANGE_TORQUE_NM)
            and protocol.in_range(battery, protocol.RANGE_BATTERY_PCT)
        )
        missing = pitch is None or torque is None

        # 非数值检测（NaN/inf）：协议层正常产出 None 或有限数值，此处为防御性兜底。
        # 必须在越量程前判定——NaN 与任何量程边界比较均为 False，会被 in_range 误判为越界。
        non_numeric_fields = [
            name for name, val in (("pitch_deg", pitch), ("roll_deg", roll),
                                   ("torque_nm", torque), ("battery_pct", battery))
            if val is not None and (math.isnan(val) or math.isinf(val))
        ]
        non_numeric = bool(non_numeric_fields)

        upstream_reasons = list(quality_reasons or [])

        if non_numeric:
            quality_status, confidence, reason = (
                "invalid", 0.0, "non_numeric:" + ",".join(non_numeric_fields))
        elif out_of_range:
            quality_status, confidence, reason = "invalid", 0.0, "out_of_range"
        elif missing:
            quality_status, confidence, reason = "degraded", 0.5, "missing_field"
        elif upstream_reasons:
            quality_status, confidence, reason = (
                "degraded", 0.5, ",".join(upstream_reasons))
        else:
            quality_status, confidence, reason = "good", 0.95, None

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
        frame = map_vendor_to_unified(vendor, VENDOR_TO_UNIFIED)
        # 标准消息扩展字段（spec「标准消息扩展与数据质量」）：平台元信息直接写入帧，
        # 不经 vendor mapping（这些是平台级字段，非厂商字段）。
        # record_id / ingested_at 由 __post_init__ 自动生成；此处刷新 ingested_at 为
        # 平台接收时刻，与 event_time（设备产生时刻）区分。
        frame.ingested_at = now_iso()
        frame.device_model = self.model
        frame.firmware_version = self.firmware_version
        frame.protocol_version = self.PROTOCOL_VERSION
        frame.raw_ref = _raw_ref(raw_bytes)
        # Task 10.2：quality.reason 说明 invalid/degraded 原因（good 时 None）
        frame.quality["reason"] = reason
        return frame


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
