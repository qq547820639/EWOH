#!/usr/bin/env python3
"""外骨骼虚拟机群仿真器：设备物理模型 + 真实 NXP1 线协议 + 对抗注入。

用途
----
没有真机时，用**真实边缘运行时**（真实 RuntimeFactory 装配 + 真实 TCP 线协议
适配器 + 真实推理管线 + 真实上行桥）跑一个外骨骼机群，把平台/边缘的累积类
逻辑（热积累 / 电量衰减 / 风险规则 / 事件上行 / 幂等去重）放进**对抗**环境验证：

对抗设计（谁对抗谁）
--------------------
- 仿真器扮演"真设备"：用**独立参数**的一阶热模型产生电机温度**真值**（真值不进
  帧——NXP1 线协议无温度字段），只写进 stats-json；
- 边缘的 ``thermal.py`` 估计器只能从 torque 帧流推算（系数是它的默认值，与真值
  参数**不同**）；E2E 断言估计值在容差内跟踪真值——参数漂移在容差上暴露；
- 线协议层注入：CRC 坏帧（解码层必须拒绝）、SEQ 重放（去重层必须吸收）、
  未来时间戳（平台 CLOCK_DRIFT_FUTURE_TS 必须显式拒绝 → 边缘死信）；
- 电量模型穿越 LOW_BATTERY 阈值 → 边缘规则 → 平台事件台账必达。

三条"腿"（--legs，默认三台设备各担一腿，账目相互不污染）
--------------------------------------------------------
- ``thermal``：重负载占空比（热积累越 warn 阈值 → THERMAL_ACCUMULATION 事件）；
- ``battery``：快速放电穿越低电量阈值（LOW_BATTERY 事件）；
- ``faults``：线协议对抗注入（CRC/SEQ 重放/未来时间戳/突发粘包）。

输出
----
``--stats-json``：每设备真值序列摘要（温度终值/峰值、电量终值、力矩均值）、
注入计数、两座上行桥的 health、边缘驱动与死信统计。E2E 据此断言
"估计=真值±容差、事件必达、不丢不重、拒绝留痕"，而不是靠日志猜测。

用法
----
    python tools/exo_fleet_sim.py \
      --platform-url http://127.0.0.1:3100 \
      --ingest-key local-verify-ingest-key-0001 \
      --org-id 00000000-0000-4000-8000-000000000001 \
      --workdir /tmp/exo-simfarm --duration-sec 45 --hz 5 \
      --stats-json /tmp/exo-simfarm/stats.json

纯 Python 标准库实现。
"""

from __future__ import annotations

import argparse
import json
import os
import random
import socket
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if os.path.isdir(os.path.join(_REPO_ROOT, "src", "edge_platform")):
    sys.path.insert(0, os.path.join(_REPO_ROOT, "src"))

from edge_platform.edge.adapters.ny_exo_a1 import codec  # noqa: E402
from edge_platform.edge.bridge.event_uplink import EventUplink  # noqa: E402
from edge_platform.edge.bridge.sensor_uplink import SensorUplinkBridge  # noqa: E402
from edge_platform.inference.thermal import ThermalEstimator  # noqa: E402
from edge_platform.runtime.bootstrap import RuntimeFactory  # noqa: E402

LEG_THERMAL = "thermal"
LEG_BATTERY = "battery"
LEG_FAULTS = "faults"
LEGS = (LEG_THERMAL, LEG_BATTERY, LEG_FAULTS)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


class VirtualExo:
    """一台虚拟外骨骼：真实 NXP1 字节流 + 确定性设备物理 + 按角色注入。"""

    def __init__(
        self,
        device_id: str,
        port: int,
        role: str,
        *,
        hz: float,
        worker_id: str,
        battery_start: float,
        battery_drain_work_per_sec: float,
        battery_drain_rest_per_sec: float,
        duty_work_sec: float,
        duty_rest_sec: float,
        torque_work: float,
        torque_rest: float,
        truth_k_heat: float,
        truth_tau_cool_sec: float,
        truth_ambient_c: float,
        crc_error_rate: float,
        seq_replay_rate: float,
        future_ts_rate: float,
        burst_every: int,
        seed: int,
    ):
        if role not in LEGS:
            raise ValueError(f"未知腿角色: {role}")
        self.device_id = device_id
        self.port = port
        self.role = role
        self.hz = float(hz)
        self.period_s = 1.0 / self.hz
        self.worker_id = worker_id
        self.battery = float(battery_start)
        self.duty_work_sec = float(duty_work_sec)
        self.duty_rest_sec = float(duty_rest_sec)
        self.torque_work = float(torque_work)
        self.torque_rest = float(torque_rest)
        self.crc_error_rate = float(crc_error_rate)
        self.seq_replay_rate = float(seq_replay_rate)
        self.future_ts_rate = float(future_ts_rate)
        self.burst_every = int(burst_every)
        self.battery_drain_work_per_sec = float(battery_drain_work_per_sec)
        self.battery_drain_rest_per_sec = float(battery_drain_rest_per_sec)
        # 角色化参数：thermal 腿重负载占空比（干净物理）；battery 腿快放电穿越
        # 低电量阈值；faults 腿高注入率（线协议对抗），且互不污染账目
        if role == LEG_THERMAL:
            self.crc_error_rate = 0.0
            self.seq_replay_rate = 0.0
            self.future_ts_rate = 0.0
        elif role == LEG_BATTERY:
            # ~3%/s 平均放电：45s 内从 92% 穿越低电量阈值并保持 >5s（LOW_BATTERY 触发窗）
            self.battery_drain_work_per_sec = max(self.battery_drain_work_per_sec, 3.0)
            self.battery_drain_rest_per_sec = max(self.battery_drain_rest_per_sec, 2.5)
            self.crc_error_rate = 0.0
            self.seq_replay_rate = 0.0
            self.future_ts_rate = 0.0
        else:  # faults
            self.crc_error_rate = max(self.crc_error_rate, 0.15)
            self.seq_replay_rate = max(self.seq_replay_rate, 0.12)
            self.future_ts_rate = max(self.future_ts_rate, 0.08)
            self.burst_every = max(self.burst_every, 7)
        self._rng = random.Random(seed)  # noqa: S311 - 可复现仿真扰动
        # 对抗注入采用**确定性调度**（每第 N 帧必注入一次），不用概率——短时长
        # 运行下概率注入会偶发 0 次，E2E 断言被环境噪声打成伪红。
        self._frame_no = 0
        # 热真值：独立参数（对抗估计器——估计器用 rules.py 默认系数）
        self.truth = ThermalEstimator(
            k_heat=truth_k_heat,
            tau_cool_sec=truth_tau_cool_sec,
            ambient_c=truth_ambient_c,
            dt_cap_sec=5.0,
        )
        self.seq = 1
        self.ts_ms = int(time.time() * 1000)
        self.counters = {
            "frames_sent": 0,
            "crc_injected": 0,
            "seq_replays": 0,
            "future_ts_injected": 0,
            "bursts": 0,
            "heartbeats": 0,
        }
        self.truth_series_peak = 0.0
        self.truth_series = []  # 采样真值序列 [(ts_ms, temp_c)]（E2E 按事件时刻插值对照）
        self.torque_sum = 0.0
        self.torque_n = 0
        self._sock: socket.socket | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    # ---- NXP1 字节流 ----
    def _connect(self) -> None:
        self._sock = socket.create_connection(("127.0.0.1", self.port), timeout=5)
        ident = codec.encode_ident(self.device_id, seq=self._next_seq(), ts_ms=self._tick_ts())
        self._sock.sendall(ident)
        self.counters["frames_sent"] += 1

    def _next_seq(self) -> int:
        seq = self.seq
        self.seq = (self.seq + 1) & 0xFFFFFFFF
        return seq

    def _tick_ts(self) -> int:
        ts = self.ts_ms
        self.ts_ms += int(self.period_s * 1000)
        return ts

    def _telemetry_fields(self, torque: float, pitch: float) -> dict:
        jitter = self._rng.uniform
        return {
            "pitch_deg": round(pitch + jitter(-1.0, 1.0), 1),
            "roll_deg": round(jitter(-2.0, 2.0), 1),
            "ax_mg": int(jitter(-200, 200)),
            "ay_mg": int(jitter(-200, 200)),
            "az_mg": int(9810 + jitter(-150, 150)),
            "gx_dps": round(jitter(-3.0, 3.0), 1),
            "gy_dps": round(jitter(-4.0, 20.0), 1),
            "gz_dps": round(jitter(-3.0, 3.0), 1),
            "torque_nm": round(max(0.0, torque + jitter(-1.0, 1.0)), 1),
            "assist_pct": int(min(90, max(5, torque * 2))),
            "battery_pct": int(max(0, min(100, round(self.battery)))),
        }

    def _frame_bytes(self, torque: float, pitch: float) -> bytes:
        self._frame_no += 1
        seq = self._next_seq()
        ts = self._tick_ts()
        # 三类调度错位（0 / 13 / 7 偏移，模长互质）：保证坏 CRC 帧与未来时间戳帧
        # 不落在同一帧上——否则该帧在边缘解码层就被拒，到不了平台，E2E 的
        # "平台逐帧拒绝数 ≥ 注入数"对账会少一。
        if self.future_ts_rate and self._frame_no % 40 == 13:
            self.counters["future_ts_injected"] += 1
            ts = ts + int(timedelta(minutes=45).total_seconds() * 1000)
        raw = codec.encode_telemetry(
            seq=seq, ts_ms=ts, **self._telemetry_fields(torque, pitch)
        )
        if self.crc_error_rate and self._frame_no % 25 == 0:
            self.counters["crc_injected"] += 1
            raw = codec.corrupt_crc(raw)
        return raw

    # ---- 物理推进 ----
    def _physics(self, elapsed: float) -> tuple[float, float]:
        """推进一个 tick 的物理，返回 (torque, pitch)。"""
        cycle = self.duty_work_sec + self.duty_rest_sec
        phase = elapsed % cycle
        working = phase < self.duty_work_sec
        torque = self.torque_work if working else self.torque_rest
        # 工作相里穿插弯腰 episode（真实作业画像；不在此链断言姿态规则）
        pitch = 46.0 if (working and (elapsed % (cycle * 2)) < self.duty_work_sec * 0.5) else 8.0
        drain = self.battery_drain_work_per_sec if working else self.battery_drain_rest_per_sec
        self.battery = max(0.0, self.battery - drain * self.period_s)
        self.truth.update(torque, self.period_s)
        self.truth_series_peak = max(self.truth_series_peak, self.truth.temperature_c)
        # 真值序列采样（~1Hz 即可支撑事件时刻插值，不必逐帧）
        if not self.truth_series or self.ts_ms - self.truth_series[-1][0] >= 1000:
            self.truth_series.append((self.ts_ms, round(self.truth.temperature_c, 2)))
        self.torque_sum += torque
        self.torque_n += 1
        return torque, pitch

    def _loop(self) -> None:
        try:
            self._connect()
        except OSError as exc:
            print(f"[sim] {self.device_id} TCP 连接失败（边缘驱动未监听?）: {exc}", file=sys.stderr)
            return
        start = time.monotonic()
        frames_since_burst = 0
        last_raw = b""
        while not self._stop.is_set() and time.monotonic() - start < self.duration_cap_s:
            elapsed = time.monotonic() - start
            torque, pitch = self._physics(elapsed)
            raw = self._frame_bytes(torque, pitch)
            payload = raw
            if self.seq_replay_rate and self._frame_no % 30 == 7 and last_raw:
                # SEQ 重放：原样重发上一帧（同 SEQ）——实时通道按"重复标记
                # degraded"处理（不丢弃），质量层与 DATA_DEGRADED 事件可观测。
                self.counters["seq_replays"] += 1
                payload = last_raw + raw
            last_raw = raw
            try:
                frames_since_burst += 1
                if self.burst_every and frames_since_burst >= self.burst_every:
                    # 突发：积攒 3 帧一次写出（真实 TCP 粘包路径）
                    self.counters["bursts"] += 1
                    frames_since_burst = 0
                    self._sock.sendall(payload * 3)
                    self.counters["frames_sent"] += 2
                else:
                    self._sock.sendall(payload)
                self.counters["frames_sent"] += 1
            except OSError:
                break
            # 心跳：每 ~10 帧一跳（协议 1s 周期的仿真近似）。
            # ts 用"窥视"（不 tick）：心跳不推进仿真时钟——否则帧时间轴比物理
            # 时间轴快 ~10%，真值序列与事件 occurredAt 的对齐被 harness 自身污染。
            if self.counters["frames_sent"] % 10 == 0:
                hb = codec.encode_heartbeat(
                    int(max(0, min(100, round(self.battery)))),
                    status=0,
                    seq=self._next_seq(),
                    ts_ms=self.ts_ms,
                )
                try:
                    self._sock.sendall(hb)
                    self.counters["heartbeats"] += 1
                except OSError:
                    break
            # 帧时间戳按真实墙钟推进（未来时间戳注入除外）——平台 CLOCK 检查按墙钟
            sleep_for = self.period_s - (time.monotonic() - start - elapsed)
            if sleep_for > 0:
                time.sleep(sleep_for)

    duration_cap_s = 120.0  # 由 runner 覆盖

    def start(self, duration_cap_s: float) -> None:
        self.duration_cap_s = float(duration_cap_s)
        self._thread = threading.Thread(target=self._loop, name=f"virtual-exo-{self.device_id}", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)
        if self._sock is not None:
            try:
                self._sock.close()
            except OSError:
                pass

    def truth_summary(self) -> dict:
        return {
            "device_id": self.device_id,
            "role": self.role,
            "port": self.port,
            "worker_id": self.worker_id,
            "temp_final_c": round(self.truth.temperature_c, 2),
            "temp_peak_c": round(self.truth_series_peak, 2),
            "truth_series": self.truth_series,
            "battery_final_pct": round(self.battery, 2),
            "torque_mean_nm": round(self.torque_sum / max(self.torque_n, 1), 2),
            "truth_model": {"k_heat": self.truth.k_heat, "tau_cool_sec": self.truth.tau_cool_sec},
            **self.counters,
        }


def build_arg_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description="外骨骼虚拟机群仿真器（真实边缘运行时 + 对抗注入）")
    ap.add_argument("--platform-url", default="http://127.0.0.1:3100")
    ap.add_argument("--ingest-key", default="")
    ap.add_argument("--org-id", default="")
    ap.add_argument("--workdir", default="")
    ap.add_argument("--duration-sec", type=float, default=45.0)
    ap.add_argument("--hz", type=float, default=5.0)
    ap.add_argument("--devices", type=int, default=3, help="虚拟设备数（≥3 时按三腿分配）")
    ap.add_argument("--base-port", type=int, default=9101, help="适配器 TCP 监听起始端口")
    ap.add_argument("--device-prefix", default="EXO", help="≤8 字符（NXP1 IDENT device_id 仅 8B ASCII）")
    ap.add_argument("--worker-prefix", default="P-EXOSIM")
    ap.add_argument("--battery-start", type=float, default=92.0)
    ap.add_argument("--duty-work-sec", type=float, default=10.0)
    ap.add_argument("--duty-rest-sec", type=float, default=2.0)
    ap.add_argument(
        "--torque-work", type=float, default=38.0,
        help="工作相力矩（38Nm×占空比 10/2 → 45s 内真值越过热规则 warn 阈值，默认 60）",
    )
    ap.add_argument("--torque-rest", type=float, default=2.0)
    ap.add_argument("--thermal-truth-k", type=float, default=0.001, help="真值模型 k（≠估计器默认，对抗）")
    ap.add_argument("--thermal-truth-tau", type=float, default=130.0, help="真值模型 tau（≠估计器默认，对抗）")
    ap.add_argument("--thermal-ambient-c", type=float, default=25.0)
    ap.add_argument("--stats-json", default="")
    return ap


def main(argv: list[str] | None = None) -> int:
    args = build_arg_parser().parse_args(argv)
    workdir = Path(args.workdir or os.path.join(tempfile_dir(), "exo-simfarm"))
    workdir.mkdir(parents=True, exist_ok=True)
    db_path = str(workdir / "edge.db")

    n = max(1, int(args.devices))
    roles = [LEGS[i % len(LEGS)] for i in range(n)]
    devices = []
    for i, role in enumerate(roles):
        device_id = f"{args.device_prefix}-{i + 1:02d}"
        if len(device_id.encode("ascii", "replace")) > 8:
            raise ValueError(f"device_id 超过 NXP1 IDENT 8B 上限: {device_id}")
        devices.append(
            VirtualExo(
                device_id,
                args.base_port + i,
                role,
                hz=args.hz,
                worker_id=f"{args.worker_prefix}-{i + 1:02d}",
                battery_start=args.battery_start,
                battery_drain_work_per_sec=0.05,
                battery_drain_rest_per_sec=0.02,
                duty_work_sec=args.duty_work_sec,
                duty_rest_sec=args.duty_rest_sec,
                torque_work=args.torque_work,
                torque_rest=args.torque_rest,
                truth_k_heat=args.thermal_truth_k,
                truth_tau_cool_sec=args.thermal_truth_tau,
                truth_ambient_c=args.thermal_ambient_c,
                crc_error_rate=0.0,
                seq_replay_rate=0.0,
                future_ts_rate=0.0,
                burst_every=0,
                seed=20260915 + i,
            )
        )

    # ---- 真实边缘运行时装配（RuntimeFactory 真实路径，非 stub）----
    adapter_specs = [
        {
            "kind": "ny_exo_a1_tcp",
            "deviceId": d.device_id,
            "sourceType": "simulated",
            "workerId": d.worker_id,
            "listenHost": "127.0.0.1",
            "listenPort": d.port,
        }
        for d in devices
    ]
    from edge_platform.edge.adapter_factory import build_adapters

    adapters = build_adapters(adapter_specs)
    components = RuntimeFactory(db_path=str(db_path)).assemble("development")
    manager = components.manager
    pipeline = components.pipeline
    for adapter in adapters:
        manager.register(adapter)
    manager.start()
    pipeline.start()

    # ---- 上行桥：事件（规则/热/电量）+ 传感器帧（外骨骼遥测）----
    event_uplink = EventUplink(
        components.bus,
        args.platform_url,
        ingest_key=args.ingest_key,
        org_id=args.org_id,
        queue_path=str(Path(db_path).with_suffix(".uplink-queue.json")),
    )
    event_uplink.start()
    sensor_uplink = SensorUplinkBridge(
        components.bus,
        args.platform_url,
        ingest_key=args.ingest_key,
        org_id=args.org_id,
        queue_path=str(Path(db_path).with_suffix(".sensor-uplink-queue.jsonl")),
        include_exoskeleton=True,
    )
    sensor_uplink.start()

    # ---- 起虚拟机群 ----
    for d in devices:
        d.start(args.duration_sec + 5)
    print(f"[sim] 机群运行 {args.duration_sec}s：{[d.device_id + '/' + d.role for d in devices]}")
    deadline = time.monotonic() + args.duration_sec
    while time.monotonic() < deadline:
        time.sleep(1)

    # ---- 停机顺序：先停设备（不再产帧）→ 停适配器 → 桥冲刷 → 统计 ----
    # 冲刷宽限：规则事件（尤其热越线若发生在收尾阶段）在桥的批量缓冲里，
    # 必须给上行循环留出最后一批发送的时间，否则停在队列文件里等"下次"。
    for d in devices:
        d.stop()
    try:
        manager.stop()
    except Exception:
        pass
    time.sleep(3)
    event_uplink.stop()
    sensor_uplink.stop(timeout=8)

    # 估计器状态（边缘侧口径；平台口径由事件 trigger.condition 交叉核对）
    thermal_est = {}
    try:
        for dev, est in getattr(components.rules, "_thermal", {}).items():
            thermal_est[dev] = round(est.temperature_c, 2)
    except Exception:
        thermal_est = {}

    # 线协议层账目（解码/去重/坏帧计数来自真实适配器）
    wire = []
    for adapter in adapters:
        try:
            inner = adapter.adapter.health() or {}
            wire.append(
                {
                    "device_id": adapter.device_id,
                    "bad_crc_frames": inner.get("bad_crc_frames"),
                    "malformed_frames": inner.get("malformed_frames"),
                    "backfill_duplicates": inner.get("backfill_duplicates"),
                    "dropped_frames": inner.get("dropped_frames"),
                    "packet_loss_pct": inner.get("packet_loss_pct"),
                    "driver": adapter.driver.stats(),
                }
            )
        except Exception as exc:  # noqa: BLE001 - 统计失败不掩盖主账目
            wire.append({"device_id": adapter.device_id, "error": str(exc)})

    stats = {
        "finished_at": _now_iso(),
        "duration_sec": args.duration_sec,
        "devices": [d.truth_summary() for d in devices],
        "thermal_estimator_c": thermal_est,
        "wire": wire,
        "event_uplink": event_uplink.health(),
        "sensor_uplink": sensor_uplink.health(),
    }
    if args.stats_json:
        Path(args.stats_json).parent.mkdir(parents=True, exist_ok=True)
        with open(args.stats_json, "w", encoding="utf-8") as fh:
            json.dump(stats, fh, ensure_ascii=False, indent=2)
    sent = stats["event_uplink"]["stats"].get("sent", 0)
    dead = stats["event_uplink"]["stats"].get("dead_lettered", 0)
    sensor_sent = stats["sensor_uplink"]["stats"].get("sent", 0)
    print(
        f"[sim] 完成：事件上行 sent={sent} dead_lettered={dead} · 遥测上行 sent={sensor_sent}"
        f" · 估计器={thermal_est}"
    )
    return 0 if any(d.counters["frames_sent"] > 0 for d in devices) else 1


def tempfile_dir() -> str:
    import tempfile

    return tempfile.gettempdir()


if __name__ == "__main__":
    sys.exit(main())
