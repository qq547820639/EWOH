#!/usr/bin/env python3
"""设备物理仿真器：AGV 电量/位置状态流 + PLC/执行机构数字孪生（故障窗口对抗）。

两条腿
------
``--role agv``
    电量（SOC）+ 位置状态流：按 ``--soc-sequence``（逗号分隔的 SOC 序列，每
    ``--tick-sec`` 一帧）向平台 ``POST /api/ingest/actuator`` 上行状态帧。
    ``--soc-window-min > 0`` 时 n 帧均匀铺在最近该分钟数内（物理时间匹配，
    合法放电/充电曲线）；``= 0`` 时全部用 now-2s（对抗腿：非物理单帧跳变）。
    对抗点：SOC 跌破派工门槛（battery_low）、**坏传感电量回跳**（8%→95% 单帧
    跳变——平台合理性闸门 SOC_JUMP_IMPLAUSIBLE 如实拒绝、连续同水平帧触发
    SOC_REANCHOR 再锚定，E2E 据此断言两段行为）。

``--role plc``
    基于 ``FakeModbusSlave``（真实 Modbus/TCP 协议帧）+ 数字孪生执行机构。
    孪生是**故障门控**的：设备处于故障窗口时拒绝 dispatch_task（真实车辆/PLC
    不会在急停状态下执行搬运）——``LoopbackActuatorTransport.send`` 本身不挡
    故障态，本孪生覆写它（这是孪生的建模选择，不是平台行为）。
    故障窗口由 ``--fault-window <start_s>:<end_s>`` 脚本化：窗口内 inject_fault，
    窗口结束自动恢复 idle。命令/状态迁移全程记入 stats-json，
    E2E 据此断言"物理故障期执行必须失败、恢复后才能成功"（回执不伪装终态）。

用法
----
    python tools/device_physics_sim.py --role agv \
      --platform-url http://127.0.0.1:3100 --ingest-key K --org-id ORG \
      --device-id AGV-SIM-1 --soc-sequence 90,55,20,8,95 --tick-sec 2 \
      --soc-window-min 135 \
      --stats-json /tmp/dp-agv.json

    python tools/device_physics_sim.py --role plc \
      --device-id PLC-SIM-1 --port 15030 --duration-sec 40 \
      --fault-window 8:20 --stats-json /tmp/dp-plc.json

纯 Python 标准库实现。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if os.path.isdir(os.path.join(_REPO_ROOT, "src", "edge_platform")):
    sys.path.insert(0, os.path.join(_REPO_ROOT, "src"))

from edge_platform.edge.adapters.actuator.fault_gated import FaultGatedActuatorTransport  # noqa: E402
from edge_platform.edge.adapters.actuator.modbus import FakeModbusSlave  # noqa: E402


def _now() -> datetime:
    return datetime.now(timezone.utc)


def post_json(url: str, payload: dict, headers: dict) -> tuple[int, dict]:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", **headers},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as exc:
        try:
            body = json.loads(exc.read().decode() or "{}")
        except Exception:  # noqa: BLE001
            body = {}
        return exc.code, body
    except urllib.error.URLError as exc:
        return 0, {"error": str(exc)}


def run_agv(args) -> int:
    headers = {"X-Ingest-Key": args.ingest_key, "X-Org-Id": args.org_id}
    soc_seq = [float(x) for x in args.soc_sequence.split(",") if x.strip() != ""]
    x, y = args.x, args.y
    series = []
    jumps = []  # 单帧跳变超过阈值的 (prev, cur)
    # NO-92a：SOC 序列时间窗。真实放电/充电是**物理过程**——把数小时的电量
    # 变化压进几秒真时（event_time 全用 now-2s）本身就是非物理序列，平台合理性
    # 闸门（SOC_JUMP_IMPLAUSIBLE）会如实拒绝。窗口语义：n 帧均匀铺在最近
    # `--soc-window-min` 分钟内、末帧落在 now-2s，dt 与帧间 SOC 变化率匹配真实
    # 物理时间。窗口 ≤0 时保持旧行为（全部 now-2s，用于触发闸门的对抗腿）。
    window_min = max(0.0, args.soc_window_min)
    n = len(soc_seq)
    total_sec = window_min * 60.0
    for i, soc in enumerate(soc_seq):
        if series and abs(soc - series[-1]["soc"]) >= args.jump_threshold_pct:
            jumps.append({"tick": i, "prev": series[-1]["soc"], "cur": soc})
        if window_min > 0 and n > 1:
            offset_sec = total_sec * (n - 1 - i) / (n - 1)
        else:
            offset_sec = 2.0
        event_time = _now() - timedelta(seconds=offset_sec)
        series.append({"tick": i, "t_offset_sec": i * args.tick_sec, "soc": soc,
                       "event_time": event_time.isoformat()})
        payload = {
            "device_id": args.device_id,
            "event_time": event_time.isoformat(),
            "state": "idle",
            "x": x,
            "y": y,
            "battery_pct": soc,
            "record_id": f"{args.device_id.lower()}-soc-{i}-{args.tag}",
        }
        status, body = post_json(
            args.platform_url.rstrip("/") + "/api/ingest/actuator", payload, headers
        )
        series[-1]["http_status"] = status
        # 逐帧响应要点：data_quality / error（SOC_JUMP_IMPLAUSIBLE 等）/
        # soc_reanchored——E2E 据此断言闸门的拒绝与再锚定行为。
        series[-1]["resp"] = {
            "data_quality": body.get("data_quality"),
            "error": body.get("error"),
            "soc_reanchored": body.get("soc_reanchored"),
        }
        if status not in (200, 201):
            print(f"[dp-agv] 帧 {i} 上行被拒 status={status} body={body}", file=sys.stderr)
        time.sleep(args.tick_sec)
    stats = {
        "role": "agv",
        "device_id": args.device_id,
        "soc_window_min": window_min,
        "soc_series": series,
        "soc_jumps": jumps,
        "frames_posted": len(series),
        "frames_rejected": sum(1 for s in series if s.get("http_status") not in (200, 201)),
        "reanchored_frames": sum(1 for s in series if s.get("resp", {}).get("soc_reanchored")),
    }
    _write_stats(args, stats)
    print(
        f"[dp-agv] 完成：{len(series)} 帧（拒 {stats['frames_rejected']}）· "
        f"跳变 {len(jumps)} 次 {[(j['prev'], j['cur']) for j in jumps]}"
    )
    return 0


def run_plc(args) -> int:
    device = FaultGatedActuatorTransport(
        args.device_id,
        now_fn=lambda: _now().isoformat(timespec="milliseconds"),
        x=0.0,
        y=0.0,
        battery_pct=95.0,
        step_m=10.0,
        battery_drain_pct_per_tick=args.battery_drain_per_tick,
        low_battery_pct=5.0,
    )
    device.register_station("ST-SIM-1", 40.0, 30.0)
    slave = FakeModbusSlave(args.device_id, host="127.0.0.1", port=args.port, device=device)
    slave.start()

    fw_start, fw_end = (float(x) for x in args.fault_window.split(":"))
    state_log = []
    stop = threading.Event()

    def twin_clock():
        """1Hz 孪生时钟：推进运动/电量 + 脚本化故障窗口。"""
        t0 = time.monotonic()
        faulted = False
        while not stop.is_set():
            t = time.monotonic() - t0
            want_fault = fw_start <= t < fw_end
            if want_fault and not faulted:
                device.inject_fault("PLC_ESTOP_SIM")
                faulted = True
            elif not want_fault and faulted:
                device.state.state = "idle"
                device.state.fault_code = None
                faulted = False
            try:
                st = device.tick()
                state_log.append(
                    {
                        "t_sec": round(t, 1),
                        "state": st.state,
                        "fault_code": st.fault_code,
                        "battery_pct": round(st.battery_pct, 1),
                    }
                )
            except Exception as exc:  # noqa: BLE001
                state_log.append({"t_sec": round(t, 1), "error": str(exc)})
            stop.wait(1.0)

    clock = threading.Thread(target=twin_clock, name="plc-twin-clock", daemon=True)
    clock.start()
    print(
        f"[dp-plc] 孪生运行 {args.duration_sec}s：Modbus/TCP 127.0.0.1:{slave.port}"
        f" · 故障窗口 [{fw_start}s, {fw_end}s)"
    )
    deadline = time.monotonic() + args.duration_sec
    while time.monotonic() < deadline:
        time.sleep(1)
    stop.set()
    clock.join(timeout=3)
    try:
        slave.stop()
    except Exception:  # noqa: BLE001
        pass

    stats = {
        "role": "plc",
        "device_id": args.device_id,
        "modbus_port": slave.port,
        "fault_window": [fw_start, fw_end],
        "state_log": state_log,
        "command_log": device.command_log,
        "requests_served": len(slave.requests),
        "final_state": device.state.to_dict(),
    }
    _write_stats(args, stats)
    print(
        f"[dp-plc] 完成：状态迁移 {len(state_log)} 条 · 命令 {len(device.command_log)} 条 · "
        f"Modbus 请求 {stats['requests_served']} 次"
    )
    return 0


def _write_stats(args, stats: dict) -> None:
    if not args.stats_json:
        return
    Path(args.stats_json).parent.mkdir(parents=True, exist_ok=True)
    with open(args.stats_json, "w", encoding="utf-8") as fh:
        json.dump(stats, fh, ensure_ascii=False, indent=2)


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description="设备物理仿真器（AGV SOC 流 + PLC 故障门控孪生）")
    ap.add_argument("--role", choices=("agv", "plc"), required=True)
    ap.add_argument("--device-id", required=True)
    ap.add_argument("--stats-json", default="")
    ap.add_argument("--tag", default="dp")
    # agv
    ap.add_argument("--platform-url", default="http://127.0.0.1:3100")
    ap.add_argument("--ingest-key", default="")
    ap.add_argument("--org-id", default="")
    ap.add_argument(
        "--soc-sequence",
        default="90,55,20,8,95",
        help="SOC 序列（每 tick-sec 一帧）；含 ≥jump-threshold 的单帧跳变即坏传感对抗",
    )
    ap.add_argument("--tick-sec", type=float, default=2.0)
    ap.add_argument("--x", type=float, default=10.0)
    ap.add_argument("--y", type=float, default=8.0)
    ap.add_argument(
        "--soc-window-min",
        type=float,
        default=0.0,
        help="SOC 序列时间窗（分钟）：>0 时 n 帧均匀铺在最近该分钟数内（末帧≈now），"
             "dt 与真实物理时间匹配；≤0 保持全部 now-2s（对抗腿：触发平台合理性闸门）",
    )
    ap.add_argument("--jump-threshold-pct", type=float, default=30.0)
    # plc
    ap.add_argument("--port", type=int, default=0, help="Modbus/TCP 监听端口（0=系统分配）")
    ap.add_argument("--duration-sec", type=float, default=40.0)
    ap.add_argument("--fault-window", default="8:20", help="故障窗口 start:end（秒）")
    ap.add_argument("--battery-drain-per-tick", type=float, default=0.1)
    return ap


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.role == "agv":
        return run_agv(args)
    return run_plc(args)


if __name__ == "__main__":
    sys.exit(main())
