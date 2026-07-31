"""NXP1 v1.0 线协议注入器（Task 2.3）。

按与真机**完全相同**的线协议生成字节流并注入适配层，用于无真机时自测：
断线 / 补传 / 乱序 / 故障码 / 坏帧 / 字段缺失 / 越量程 / 低电量 等路径。

与 fixtures 的区别：`fixtures/` 是静态单帧样本（回归断言用），本模块是**有状态的
流式发生器**——维护 SEQ 单调递增、TS_MS 按采样周期推进、断线期间的设备侧缓存，
因此可以真实复现「断线 → 缓存 → 重连 → BACKFILL 补传 → SEQ 去重」这条链路。

来源隔离（硬约束）
------------------
注入器产生的字节流**不是真机数据**。使用方（`edge_platform.edge.device_driver`）
只允许把它接到 `source_type ∈ {controlled_test, simulated}` 的适配器上；
接到 `real` 适配器会在驱动构造期直接抛错，避免受控数据被包装成真机结论。

安全边界
--------
只生成设备→平台上行帧（编码由 `codec.py` 保证）；不生成、也无法生成任何
下行命令或协议确认书 §4 禁止写入清单中的能力。

纯 Python 标准库实现，不引入任何第三方依赖。
"""

import random
import struct
import time

from edge_platform.edge.adapters.ny_exo_a1 import codec, protocol

#: 采样周期（协议确认书 3.4：TELEMETRY 20Hz）
DEFAULT_HZ = 20.0

#: V0.1 冻结动作集合（delivery/03_数据与算法/data_dictionary.csv）对应的物理量画像。
#: 每项为 (pitch_deg, gyro_dps, torque_nm, assist_pct) 的中心值。
ACTION_PROFILES = {
    "stand": (3.0, 2.0, 2.0, 5),
    "walk": (7.0, 38.0, 8.0, 20),
    "bend": (46.0, 18.0, 24.0, 55),
    "lift": (28.0, 29.0, 42.0, 70),
}

#: 预置场景名（scenario() 可直接生成整段字节流）
SCENARIOS = (
    "normal",              # 正常上线 + 稳定遥测
    "disconnect_backfill",  # 断线 → 缓存 → 重连 → BACKFILL 补传（含重复 SEQ）
    "out_of_order",        # 帧乱序到达
    "fault",               # 故障码上报与恢复
    "crc_error",           # CRC 坏帧混入
    "degraded",            # 字段缺失 + 越量程 + 低电量
)


class WireInjector:
    """有状态的 NXP1 字节流发生器。

    典型用法::

        inj = WireInjector(device_id="EXO-CT-01")
        adapter.feed(inj.ident())
        adapter.feed(inj.telemetry_burst(20, action="lift"))
        adapter.feed(inj.scenario("disconnect_backfill"))

    所有随机扰动都受 `seed` 控制，同一 seed 产生完全相同的字节流（可复现）。
    """

    def __init__(self, device_id="EXO-CT-001", source_label="controlled_test",
                 firmware_version=codec.DEFAULT_FIRMWARE,
                 hardware_version=codec.DEFAULT_HARDWARE,
                 start_ts_ms=None, hz=DEFAULT_HZ, battery_pct=92, seed=20260729):
        if hz <= 0:
            raise ValueError("hz 必须为正数")
        self.device_id = str(device_id)
        self.source_label = source_label
        self.firmware_version = firmware_version
        self.hardware_version = hardware_version
        self.hz = float(hz)
        self.period_ms = int(round(1000.0 / self.hz))
        self.battery_pct = int(battery_pct)
        self._seq = 1
        self._ts_ms = int(start_ts_ms if start_ts_ms is not None else time.time() * 1000)
        self._rng = random.Random(seed)  # noqa: S311 - 仅用于可复现的测试数据扰动
        self._cache = []          # 断线期间设备侧缓存（协议确认书 3.5，最多 300 条）
        self._fault_code = None
        self.frames_emitted = 0

    # ---- 状态只读视图 ----
    @property
    def seq(self):
        """下一帧将使用的 SEQ。"""
        return self._seq

    @property
    def ts_ms(self):
        """下一帧将使用的设备本地 epoch 毫秒。"""
        return self._ts_ms

    @property
    def cached_count(self):
        """当前设备侧缓存条数（等待 BACKFILL 补传）。"""
        return len(self._cache)

    @property
    def fault_code(self):
        return self._fault_code

    # ---- 内部：推进时间与序号 ----
    def _advance(self):
        seq, ts = self._seq, self._ts_ms
        self._seq = (self._seq + 1) & 0xFFFFFFFF
        self._ts_ms += self.period_ms
        return seq, ts

    def _emit(self, raw):
        self.frames_emitted += 1
        return raw

    def _telemetry_fields(self, action="stand", **overrides):
        """按动作画像生成一组厂商物理量（带小幅可复现扰动）。"""
        pitch, gyro, torque, assist = ACTION_PROFILES.get(action, ACTION_PROFILES["stand"])
        jitter = self._rng.uniform
        fields = {
            "pitch_deg": round(pitch + jitter(-1.5, 1.5), 1),
            "roll_deg": round(jitter(-2.0, 2.0), 1),
            "ax_mg": int(jitter(-200, 200)),
            "ay_mg": int(jitter(-200, 200)),
            "az_mg": int(9810 + jitter(-150, 150)),
            "gx_dps": round(jitter(-3.0, 3.0), 1),
            "gy_dps": round(max(0.0, gyro + jitter(-4.0, 4.0)), 1),
            "gz_dps": round(jitter(-3.0, 3.0), 1),
            "torque_nm": round(max(0.0, torque + jitter(-2.0, 2.0)), 1),
            "assist_pct": assist,
            "battery_pct": self.battery_pct,
        }
        fields.update(overrides)
        return fields

    # ---- 单帧生成 ----
    def ident(self):
        """IDENT(0x02)：连接建立后首发（协议确认书 3.1）。"""
        seq, ts = self._advance()
        return self._emit(codec.encode_ident(
            self.device_id, seq=seq, ts_ms=ts,
            firmware_version=self.firmware_version,
            hardware_version=self.hardware_version))

    def heartbeat(self, battery_pct=None, status=0):
        """HEARTBEAT(0x01)：1s 周期心跳（协议确认书 3.2）。"""
        seq, ts = self._advance()
        if battery_pct is not None:
            self.battery_pct = int(battery_pct)
        return self._emit(codec.encode_heartbeat(
            self.battery_pct, status=status, seq=seq, ts_ms=ts,
            firmware_version=self.firmware_version))

    def telemetry(self, action="stand", **overrides):
        """TELEMETRY(0x10)：单帧遥测。"""
        seq, ts = self._advance()
        return self._emit(codec.encode_telemetry(
            seq=seq, ts_ms=ts, **self._telemetry_fields(action, **overrides)))

    def telemetry_burst(self, count, action="stand", **overrides):
        """连续 count 帧遥测（SEQ 连续，无丢包）。"""
        return b"".join(self.telemetry(action, **overrides) for _ in range(int(count)))

    def fault(self, fault_code=0x01, detail=0):
        """FAULT(0x20)：上报故障码（协议确认书 2.5）。"""
        seq, ts = self._advance()
        self._fault_code = int(fault_code) or None
        return self._emit(codec.encode_fault(fault_code, detail=detail, seq=seq, ts_ms=ts))

    def fault_clear(self):
        """FAULT(0x20) code=0x00：故障恢复。"""
        return self.fault(0x00)

    def corrupted(self, action="stand"):
        """CRC 坏帧：合法遥测帧翻转一字节，必须被解码层拒绝。"""
        seq, ts = self._advance()
        raw = codec.encode_telemetry(seq=seq, ts_ms=ts, **self._telemetry_fields(action))
        return self._emit(codec.corrupt_crc(raw))

    def missing_field(self, field="torque_nm"):
        """字段缺失帧：指定字段写入哨兵 0x7FFF（传感器故障），质量层应判 degraded。"""
        return self.telemetry("lift", **{field: None})

    def out_of_range(self, pitch_deg=185.0):
        """越量程帧：线协议合法但超出 ±180°，质量层应判 invalid。"""
        return self.telemetry("bend", pitch_deg=pitch_deg)

    def low_battery(self, battery_pct=8):
        """低电量帧 + 心跳（低于协议确认书 10% 安全阈值）。"""
        self.battery_pct = int(battery_pct)
        return self.heartbeat() + self.telemetry("stand")

    # ---- 断线 / 补传 ----
    def disconnect(self, missed_frames=10, action="lift"):
        """模拟断线：SEQ/TS 继续推进，被丢弃的帧进入设备侧缓存等待补传。

        不产生任何字节（这正是断线的含义），返回缓存条数。
        缓存上限遵循协议确认书 3.5（最多 300 条），超出按设备行为丢弃最早的。
        """
        for _ in range(int(missed_frames)):
            seq, ts = self._advance()
            self._cache.append({"seq": seq, "ts_ms": ts,
                                "telemetry": self._telemetry_fields(action)})
        if len(self._cache) > codec.MAX_BACKFILL_CACHE:
            self._cache = self._cache[-codec.MAX_BACKFILL_CACHE:]
        return len(self._cache)

    def backfill(self, include_duplicates=0):
        """重连后补传缓存（BACKFILL 0x11），并清空缓存。

        include_duplicates>0 时额外重复补传最近 n 条，用于验证平台侧按 SEQ 去重
        （协议确认书 3.5：补传数据按 SEQ 去重）。
        """
        entries = list(self._cache)
        if include_duplicates > 0 and entries:
            entries += entries[-int(include_duplicates):]
        self._cache = []
        if not entries:
            return b""
        seq, ts = self._advance()
        raw = codec.encode_backfill_batch(entries, start_seq=seq, ts_ms=ts)
        # encode_backfill_batch 内部自增 SEQ，这里把发生器的 SEQ 推到同一水位
        frames = -(-len(entries) // codec.MAX_BACKFILL_ENTRIES_PER_FRAME)
        self._seq = (seq + frames) & 0xFFFFFFFF
        self.frames_emitted += frames
        return raw

    def reconnect(self, missed_frames=10, duplicates=2, action="lift"):
        """完整重连序列：IDENT → BACKFILL 补传（含重复条目）→ 恢复实时遥测。

        调用前应先 `disconnect()` 制造缓存；返回重连后应投递的字节流。
        """
        if missed_frames:
            self.disconnect(missed_frames, action=action)
        return self.ident() + self.backfill(include_duplicates=duplicates)

    # ---- 乱序 ----
    def out_of_order(self, count=6, action="walk"):
        """生成 count 帧遥测后按帧边界打乱顺序（模拟网络乱序到达）。

        每一帧本身仍然合法，只是到达顺序与 SEQ 顺序不一致。
        """
        count = max(2, int(count))
        frames = [self.telemetry(action) for _ in range(count)]
        self._rng.shuffle(frames)
        return b"".join(frames)

    # ---- Task 37：补充故障注入方法 ----
    def timestamp_backwards(self, frame_bytes=None, action="stand"):
        """时间戳倒退帧：在合法遥测字节流的 TS_MS 字段写入比上一帧更早的值。

        不传 frame_bytes 时按 action 现生成一帧遥测，并把 ts_ms 强制回退两个采样周期
        （一个周期用于抵消 _advance 自增，另一个周期使其真正小于上一帧 ts）。
        解码侧 CRC 仍通过（只改 TS_MS + 重算 CRC），质量层应判 timestamp_backward。
        """
        if frame_bytes is None:
            seq, ts = self._advance()
            backward_ts = max(0, ts - 2 * self.period_ms)
            return self._emit(self._rewrite_ts(codec.encode_telemetry(
                seq=seq, ts_ms=ts, **self._telemetry_fields(action)), backward_ts))
        # 已有帧字节：保留 SEQ，把 TS_MS 改为「减一个周期」
        frame, _ = protocol.decode_frame(frame_bytes)
        if frame is None:
            raise ValueError("frame_bytes 不是合法 NXP1 帧")
        backward_ts = max(0, frame["ts_ms"] - self.period_ms)
        return self._emit(self._rewrite_ts(frame_bytes, backward_ts))

    def timestamp_drift(self, frame_bytes=None, drift_ms=1000, action="stand"):
        """时间戳漂移帧：TS_MS 在上一帧基础上多跳 drift_ms（默认 1000ms）。

        drift_ms 为正表示向前漂移，为负表示向后漂移。CRC 重算后仍合法，
        质量层应按时间戳漂移阈值（默认 500ms）判 timestamp_drift 或 timestamp_backward。
        """
        if not isinstance(drift_ms, int) or drift_ms == 0:
            raise ValueError("drift_ms 必须为非零整数")
        if frame_bytes is None:
            seq, ts = self._advance()
            drifted_ts = max(0, ts + int(drift_ms))
            return self._emit(self._rewrite_ts(codec.encode_telemetry(
                seq=seq, ts_ms=ts, **self._telemetry_fields(action)), drifted_ts))
        frame, _ = protocol.decode_frame(frame_bytes)
        if frame is None:
            raise ValueError("frame_bytes 不是合法 NXP1 帧")
        drifted_ts = max(0, frame["ts_ms"] + int(drift_ms))
        return self._emit(self._rewrite_ts(frame_bytes, drifted_ts))

    def nan_field(self, frame_bytes=None, fields=None, action="stand"):
        """非数值字段帧：协议层 i16 无法表达 NaN，编码为哨兵 0x7FFF（传感器缺失）。

        协议层 ``_phys_to_i16`` 对 None 编码为哨兵 0x7FFF，解码后还原为 None（缺失）。
        NaN/inf 物理量只能在适配器 ``to_unified`` 直接路径触发非数值检测（防御性兜底，
        协议层正常不产生 NaN，但 backfill/未来路径可能引入）。本方法在字节流层面把
        指定字段编码为哨兵值（等同传感器故障），用于驱动适配器 missing_field 路径；
        如需触发 non_numeric 路径，调用方应直接用 ``adapter.to_unified`` 传入 NaN。
        """
        target_fields = fields or ("pitch_deg",)
        none_fields = {f: None for f in target_fields}
        if frame_bytes is None:
            return self.telemetry(action, **none_fields)
        # 已有帧字节不做改写：协议层 i16 无法表达 NaN，调用方应直接走 to_unified 路径
        return self._emit(bytes(frame_bytes))

    def sample_rate_anomaly(self, frames=None, actual_hz=10.0, action="walk"):
        """采样率异常帧流：按 actual_hz 生成 frames 帧（默认 11 帧）。

        适配器以 expected_hz=20 评估时，actual_hz=10 的偏差 ~50% 超过 20% 阈值，
        窗口满后质量层应判 sampling_rate_anomaly。返回拼接字节流。
        """
        if actual_hz <= 0:
            raise ValueError("actual_hz 必须为正数")
        n = int(frames) if frames is not None else 11
        if n <= 0:
            raise ValueError("frames 必须为正整数")
        # 临时切换采样周期以模拟异常采样率，调用后恢复
        original_period = self.period_ms
        try:
            self.period_ms = int(round(1000.0 / float(actual_hz)))
            return self.telemetry_burst(n, action)
        finally:
            self.period_ms = original_period

    def firmware_upgrade(self, frame_bytes=None, new_version="2.0.0", action="stand"):
        """固件升级帧：发一帧 IDENT 携带 new_version，触发适配器固件升级事件。

        不传 frame_bytes 时直接构造新 IDENT 帧；传入旧 IDENT 帧字节时按其 SEQ/TS
        重编码为 new_version。返回该 IDENT 帧字节。
        """
        if frame_bytes is None:
            seq, ts = self._advance()
            return self._emit(codec.encode_ident(
                self.device_id, seq=seq, ts_ms=ts,
                firmware_version=new_version,
                hardware_version=self.hardware_version))
        frame, _ = protocol.decode_frame(frame_bytes)
        if frame is None or frame["type"] != protocol.TYPE_IDENT:
            raise ValueError("frame_bytes 必须为 IDENT 帧")
        ident = protocol.parse_ident_payload(frame["payload"])
        # parse_ident_payload 把 hardware_version 解码为字符串 "2.3"，需还原为 BCD int
        hw_str = ident.get("hardware_version")
        hw_int = self._parse_hw_version(hw_str) if hw_str else self.hardware_version
        return self._emit(codec.encode_ident(
            ident.get("device_id", self.device_id),
            seq=frame["seq"], ts_ms=frame["ts_ms"],
            firmware_version=new_version,
            hardware_version=hw_int))

    @staticmethod
    def _parse_hw_version(hw_str):
        """BCD 风格 hardware_version 字符串 '2.3' → int 0x23。解析失败返回 0x00。"""
        if not hw_str or "." not in hw_str:
            return 0x00
        parts = hw_str.split(".")
        try:
            major = int(parts[0]) & 0x0F
            minor = int(parts[1]) & 0x0F
            return (major << 4) | minor
        except ValueError:
            return 0x00

    # ---- 内部：重写 TS_MS 并重算 CRC（保持帧其余字段不变） ----
    @staticmethod
    def _rewrite_ts(frame_bytes, new_ts_ms):
        """重写帧的 TS_MS 字段（偏移 8，u64 LE）并重算 CRC，返回新字节流。"""
        data = bytearray(frame_bytes)
        if len(data) < protocol.FRAME_OVERHEAD:
            raise ValueError("帧长度不足，无法重写 TS_MS")
        length = data[2]
        total = protocol.FRAME_OVERHEAD + length
        if len(data) < total:
            raise ValueError("帧长度不足，无法重写 TS_MS")
        struct.pack_into("<Q", data, 8, int(new_ts_ms) & 0xFFFFFFFFFFFFFFFF)
        body = bytes(data[2:16 + length])
        crc = protocol.crc16_ccitt_false(body)
        struct.pack_into("<H", data, 16 + length, crc)
        return bytes(data)

    # ---- 预置场景 ----
    def scenario(self, name):
        """按名称生成一整段场景字节流（SCENARIOS 中的取值）。"""
        if name not in SCENARIOS:
            raise ValueError("未知场景: %s（可用: %s）" % (name, ", ".join(SCENARIOS)))
        if name == "normal":
            return self.ident() + self.heartbeat() + self.telemetry_burst(20, "walk")
        if name == "disconnect_backfill":
            head = self.ident() + self.telemetry_burst(5, "lift")
            self.disconnect(missed_frames=12, action="lift")
            return head + self.reconnect(missed_frames=0, duplicates=3)
        if name == "out_of_order":
            return self.ident() + self.out_of_order(count=8)
        if name == "fault":
            return (self.ident() + self.telemetry_burst(3, "stand")
                    + self.fault(0x01) + self.telemetry_burst(3, "stand")
                    + self.fault_clear() + self.telemetry_burst(3, "stand"))
        if name == "crc_error":
            return (self.ident() + self.telemetry_burst(2, "walk")
                    + self.corrupted() + self.telemetry_burst(2, "walk"))
        # degraded
        return (self.ident() + self.missing_field() + self.out_of_range()
                + self.low_battery())

    def inject(self, adapter, scenario_name):
        """把一个预置场景直接注入适配器，返回适配器产出的统一帧条数。"""
        return adapter.feed(self.scenario(scenario_name))

    def describe(self):
        """注入器当前状态摘要（写运行日志/报告用）。"""
        return {
            "device_id": self.device_id,
            "protocol_version": protocol.PROTOCOL_VERSION,
            "source_label": self.source_label,
            "hz": self.hz,
            "next_seq": self._seq,
            "next_ts_ms": self._ts_ms,
            "cached_entries": len(self._cache),
            "fault_code": self._fault_code,
            "frames_emitted": self.frames_emitted,
        }


__all__ = ["WireInjector", "SCENARIOS", "ACTION_PROFILES", "DEFAULT_HZ"]
