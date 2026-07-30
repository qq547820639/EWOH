#!/usr/bin/env python3
"""NXP1 v1.0 设备模拟回放器。

用途
----
读取 record_raw_frames.py 录制的 session 目录（或手动构造的帧目录），按原始时间
间隔向指定 TCP 目标（适配层监听端口）重放帧字节流，用于：
  - 无真机时回放录制数据测试适配层（解码/质量/断线恢复/补传去重）
  - 演示真机数据
  - 故障注入（中途断连、乱序）

读取 manifest.json 获取会话信息，读取 index.jsonl 获取帧列表与时间戳；按帧
ts 计算间隔，用 time.sleep 控制发送节奏。也支持无 index.jsonl 的手动帧目录
（递归扫描 *.bin，按文件名排序，固定间隔发送）。

参数说明
--------
  --session-dir        录制会话目录（含 manifest.json + index.jsonl）
  --target-host        目标适配层地址（默认 127.0.0.1）
  --target-port        目标适配层端口（默认 9001）
  --speed              实时倍率：1.0=实时, 2.0=2 倍速, 0.5=半速（默认 1.0）
  --loop               循环回放
  --source-type        标记回放数据来源（默认 real）；仅用于演示切换，不改变
                       发送字节，回放数据真实来源仍为录制时的来源
  --disconnect-at SEQ  在发送指定 seq 的帧后断开
  --disconnect-duration 断连后等待秒数再重连（默认 3.0）
  --shuffle            随机打乱帧顺序（用于序号乱序检测）

运行示例
--------
  python edge_platform/scripts/replay_device.py --session-dir recordings/sess-20260730-100000 --target-port 9001
  python edge_platform/scripts/replay_device.py --session-dir recordings/sess-x --speed 4.0 --loop
  python edge_platform/scripts/replay_device.py --session-dir recordings/sess-x --disconnect-at 105 --disconnect-duration 5
  python edge_platform/scripts/replay_device.py --session-dir recordings/sess-x --shuffle
"""
import argparse
import json
import os
import random
import socket
import sys
import time


def _load_frames(session_dir):
    """从 session 目录加载帧列表。

    优先读取 index.jsonl；若不存在，递归扫描 *.bin 作为兜底（手动构造目录）。
    返回 (frames, meta) —— frames 为 dict 列表，meta 为会话元信息。
    """
    frames = []
    meta = {"session_dir": session_dir, "source": "index.jsonl"}

    index_path = os.path.join(session_dir, "index.jsonl")
    manifest_path = os.path.join(session_dir, "manifest.json")
    if os.path.exists(manifest_path):
        try:
            with open(manifest_path, "r", encoding="utf-8") as f:
                meta["manifest"] = json.load(f)
        except (OSError, ValueError):
            pass

    if os.path.exists(index_path):
        with open(index_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    frames.append(json.loads(line))
                except ValueError:
                    continue
        # 按 ts(then seq) 排序，保证时间顺序
        frames.sort(key=lambda e: (e.get("ts", 0), e.get("seq", 0)))
        return frames, meta

    # 兜底：递归扫描 *.bin
    meta["source"] = "scan_bin"
    bin_files = []
    for root, _dirs, files in os.walk(session_dir):
        for name in files:
            if name.endswith(".bin"):
                bin_files.append(os.path.join(root, name))
    bin_files.sort()
    base_ts = int(time.time() * 1000)
    for i, path in enumerate(bin_files):
        rel = os.path.relpath(path, session_dir).replace(os.sep, "/")
        frames.append({
            "ts": base_ts + i * 50,
            "seq": i,
            "device_id": None,
            "frame_file": rel,
            "frame_type": "UNKNOWN",
            "bytes_len": os.path.getsize(path),
        })
    return frames, meta


def _connect(host, port, log):
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(5.0)
    log("连接目标 %s:%d ..." % (host, port))
    sock.connect((host, port))
    sock.settimeout(None)
    log("已连接 %s:%d" % (host, port))
    return sock


def _send_frame(sock, frame_path, log):
    try:
        with open(frame_path, "rb") as f:
            data = f.read()
    except OSError as e:
        log("  读取帧文件失败 %s: %s" % (frame_path, e))
        return False
    try:
        sock.sendall(data)
    except OSError as e:
        log("  发送失败 (seq=%s): %s" % (frame.get("seq"), e))
        return False
    return True


def _replay_once(frames, session_dir, host, port, speed, shuffle,
                 disconnect_at, disconnect_duration, source_type, log):
    """单次回放帧列表。返回 True 正常完成，False 中途出错且无法恢复。"""
    order = list(frames)
    if shuffle:
        random.shuffle(order)
        log("已启用 --shuffle：帧顺序随机化（间隔固定 50ms/倍率）")

    # 默认间隔：遥测 20Hz => 50ms
    fixed_interval = 0.05
    sock = None
    try:
        sock = _connect(host, port, log)
        prev_ts = None
        sent = 0
        for idx, frame in enumerate(order):
            ts = frame.get("ts")
            # 计算发送间隔
            if shuffle or prev_ts is None or not isinstance(ts, (int, float)):
                interval = fixed_interval
            else:
                interval = max(0.0, (ts - prev_ts) / 1000.0)
            interval = interval / speed if speed > 0 else 0.0
            if idx > 0:
                time.sleep(min(interval, 60.0))  # 单帧间隔上限 60s，防异常 ts 卡死

            frame_path = os.path.join(session_dir, frame.get("frame_file", ""))
            ok = _send_frame(sock, frame_path, log)
            if ok:
                sent += 1
                if (sent % 20) == 1 or sent <= 3:
                    log("  发送 #%d seq=%s type=%s bytes=%s (%s)"
                        % (sent, frame.get("seq"), frame.get("frame_type"),
                           frame.get("bytes_len"), frame.get("frame_file")))
            prev_ts = ts if isinstance(ts, (int, float)) else prev_ts

            # 中途断连模拟
            if disconnect_at is not None and frame.get("seq") == disconnect_at:
                log("  --disconnect-at 命中 seq=%s：断开连接" % disconnect_at)
                try:
                    sock.close()
                except OSError:
                    pass
                sock = None
                log("  等待 %.2fs 后重连 ..." % disconnect_duration)
                time.sleep(disconnect_duration)
                try:
                    sock = _connect(host, port, log)
                except OSError as e:
                    log("  重连失败: %s，终止本次回放" % e)
                    return False
        log("本次回放完成：共发送 %d 帧" % sent)
        return True
    finally:
        if sock is not None:
            try:
                sock.close()
            except OSError:
                pass


def _parse_args(argv):
    p = argparse.ArgumentParser(
        description="NXP1 v1.0 设备模拟回放器：按原始时间间隔向适配层重放录制帧。")
    p.add_argument("--session-dir", required=True,
                   help="录制会话目录（含 manifest.json + index.jsonl，或手动构造的帧目录）")
    p.add_argument("--target-host", default="127.0.0.1", help="目标适配层地址（默认 127.0.0.1）")
    p.add_argument("--target-port", type=int, default=9001, help="目标适配层端口（默认 9001）")
    p.add_argument("--speed", type=float, default=1.0, help="实时倍率：1.0=实时, 2.0=2倍速, 0.5=半速（默认 1.0）")
    p.add_argument("--loop", action="store_true", help="循环回放")
    p.add_argument("--source-type", default="real",
                   help="标记回放数据来源（默认 real）；仅用于演示切换，不改变发送字节")
    p.add_argument("--disconnect-at", type=int, default=None,
                   help="在发送指定 seq 的帧后断开（断线恢复测试）")
    p.add_argument("--disconnect-duration", type=float, default=3.0,
                   help="断连后等待秒数再重连（默认 3.0）")
    p.add_argument("--shuffle", action="store_true", help="随机打乱帧顺序（序号乱序检测）")
    p.add_argument("--seed", type=int, default=None, help="--shuffle 用的随机种子（可复现）")
    return p.parse_args(argv)


def main(argv=None):
    args = _parse_args(argv if argv is not None else sys.argv[1:])

    if not os.path.isdir(args.session_dir):
        print("错误：session-dir 不存在: %s" % args.session_dir, file=sys.stderr)
        return 2
    if args.speed <= 0:
        print("错误：--speed 必须为正数", file=sys.stderr)
        return 2
    if args.seed is not None:
        random.seed(args.seed)

    def log(msg):
        print("[%s] %s" % (time.strftime("%H:%M:%S"), msg), flush=True)

    frames, meta = _load_frames(args.session_dir)
    if not frames:
        print("错误：未在 %s 找到任何帧（无 index.jsonl 且无 *.bin）" % args.session_dir, file=sys.stderr)
        return 2

    manifest = meta.get("manifest") or {}
    log("回放会话目录: %s" % os.path.abspath(args.session_dir))
    log("帧来源: %s  帧数: %d" % (meta["source"], len(frames)))
    log("session_id=%s  protocol=%s  录制设备=%s" % (
        manifest.get("session_id", "?"),
        manifest.get("protocol_version", "?"),
        manifest.get("device_ids", "?")))
    log("目标: %s:%d  speed=%.2f  loop=%s  shuffle=%s  source_type=%s（仅演示标记）" % (
        args.target_host, args.target_port, args.speed, args.loop, args.shuffle, args.source_type))
    if args.disconnect_at is not None:
        log("断连注入: 在 seq=%s 后断开 %.2fs 再重连" % (args.disconnect_at, args.disconnect_duration))

    loop_count = 0
    try:
        while True:
            loop_count += 1
            if args.loop:
                log("==== 循环回放第 %d 轮 ====" % loop_count)
            ok = _replay_once(frames, args.session_dir, args.target_host, args.target_port,
                              args.speed, args.shuffle, args.disconnect_at,
                              args.disconnect_duration, args.source_type, log)
            if not ok:
                log("回放异常退出（第 %d 轮）" % loop_count)
                return 1
            if not args.loop:
                break
            log("一轮完成，0.5s 后开始下一轮 ...")
            time.sleep(0.5)
    except KeyboardInterrupt:
        log("收到中断，停止回放")
    log("回放结束，共完成 %d 轮" % loop_count)
    return 0


if __name__ == "__main__":
    sys.exit(main())
