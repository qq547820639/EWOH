#!/usr/bin/env python3
"""NXP1 v1.0 原始帧录制工具。

用途
----
监听指定 TCP 端口，接收真实 NY-EXO-A1 设备字节流，按帧拆分后保存为带时间戳的
原始帧文件 + 索引文件，用于：
  - 无真机时回放真实数据（配合 replay_device.py）
  - 协议调试与帧结构分析
  - 固件升级前后的真实数据对比
  - 现场问题复现（保留原始字节，便于离线重放）

输出目录结构
------------
  recordings/<session_id>/<device_id>/<YYYYMMDD>/<HHMMSS_mmm>_<seq>.bin   # 原始帧文件
  recordings/<session_id>/index.jsonl                                      # 每帧一条索引
  recordings/<session_id>/manifest.json                                    # 会话汇总（退出时写）

index.jsonl 每行 JSON：{ts, seq, device_id, frame_file, frame_type, bytes_len, ...}
manifest.json：{session_id, started_at, ended_at, device_ids, total_frames, protocol_version}

帧拆分使用 `edge_platform.edge.protocol.decode_frame`（仅拆帧边界、读 frame_type/
seq/device_id，不解析业务字段）。若 protocol.py 尚未落地，使用内置等价回退实现。

运行示例
--------
  python edge_platform/scripts/record_raw_frames.py --port 9001
  python edge_platform/scripts/record_raw_frames.py --port 9001 --max-frames 1000 --duration-sec 600 --session-id pilot-20260730
"""
import argparse
import json
import os
import signal
import socketserver
import struct
import sys
import threading
import time
from datetime import datetime


def _find_repo_root():
    """沿 __file__ 向上查找包含 edge_platform 目录的仓库根。"""
    d = os.path.dirname(os.path.abspath(__file__))
    for _ in range(8):
        if os.path.isdir(os.path.join(d, "edge_platform")):
            return d
        d = os.path.dirname(d)
    return None


_REPO_ROOT = _find_repo_root()
if _REPO_ROOT and _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

PROTOCOL_VERSION = "NXP1 v1.0"
TYPE_NAMES = {0x01: "HEARTBEAT", 0x02: "IDENT", 0x10: "TELEMETRY",
              0x11: "BACKFILL", 0x20: "FAULT"}

# ---- 协议实现：优先复用 edge/protocol.py，缺失时使用内置回退（仅 decode） ------
try:
    from edge_platform.edge.protocol import decode_frame as _proto_decode_frame  # type: ignore
    try:
        from edge_platform.edge.protocol import PROTOCOL_VERSION  # type: ignore
    except Exception:  # noqa: BLE001
        pass
    _USING_REAL_PROTOCOL = True
except Exception:  # noqa: BLE001
    _USING_REAL_PROTOCOL = False
    _FRAME_HEAD = b"\xAA\x55"
    TYPE_IDENT = 0x02

    def _crc16_ccitt_false(data):
        crc = 0xFFFF
        for b in data:
            crc ^= (b << 8)
            for _ in range(8):
                crc = ((crc << 1) ^ 0x1021) & 0xFFFF if (crc & 0x8000) else (crc << 1) & 0xFFFF
        return crc

    def _proto_decode_frame(buf):
        """从 buf 起始解析一帧；返回 (frame_dict|None, consumed_bytes)。"""
        if len(buf) < 2 or buf[0] != 0xAA or buf[1] != 0x55:
            return None, 1
        if len(buf) < 20:
            return None, 0
        length = buf[2]
        total = 20 + length
        if len(buf) < total:
            return None, 0
        frame_type = buf[3]
        seq = struct.unpack_from("<I", buf, 4)[0]
        ts_ms = struct.unpack_from("<Q", buf, 8)[0]
        payload = bytes(buf[16:16 + length])
        crc_recv = struct.unpack_from("<H", buf, 16 + length)[0]
        crc_calc = _crc16_ccitt_false(buf[2:16 + length])
        tail_ok = buf[total - 2] == 0x0D and buf[total - 1] == 0x0A
        device_id = None
        if frame_type == TYPE_IDENT and length >= 8:
            device_id = payload[0:8].rstrip(b"\x00").decode("ascii", "replace")
        return {
            "type": frame_type, "seq": seq, "ts_ms": ts_ms, "payload": payload,
            "crc_ok": crc_recv == crc_calc, "tail_ok": tail_ok,
            "total_len": total, "device_id": device_id,
        }, total


def _decode(buf):
    """统一 decode_frame 调用入口，兼容多种返回形态。

    支持返回：(frame|None, consumed) / frame dict（含 total_len）/ frame 列表。
    始终返回 (frame|None, consumed_int)。
    """
    res = _proto_decode_frame(buf)
    if isinstance(res, tuple) and len(res) == 2:
        frame, consumed = res
        if isinstance(consumed, int):
            return frame, consumed
        return None, 0
    if isinstance(res, dict):
        return res, int(res.get("total_len", 0) or 0)
    if isinstance(res, list) and res:
        first = res[0]
        consumed = sum(int(f.get("total_len", 0) or 0) for f in res if isinstance(f, dict))
        return first, consumed
    return None, 0


def _sanitize_device_id(device_id):
    """将 device_id 转为文件系统安全的目录名。"""
    if not device_id:
        return "unknown"
    safe = []
    for ch in str(device_id):
        if ch.isalnum() or ch in "-_.":
            safe.append(ch)
        else:
            safe.append("_")
    name = "".join(safe).strip("._") or "unknown"
    return name


def _type_name(t):
    return TYPE_NAMES.get(t, "0x%02X" % t)


def _iso_from_ms(ms):
    try:
        return datetime.fromtimestamp(ms / 1000.0).astimezone().isoformat(timespec="milliseconds")
    except (OSError, ValueError, OverflowError):
        return None


class FrameRecorder:
    """会话级录制器：线程安全地保存帧文件、追加索引、统计汇总。"""

    def __init__(self, session_dir, session_id, started_at, max_frames=0):
        self.session_dir = session_dir
        self.session_id = session_id
        self.started_at = started_at
        self.max_frames = max_frames
        self.total_frames = 0
        self.device_ids = set()
        self._lock = threading.Lock()
        self.index_path = os.path.join(session_dir, "index.jsonl")
        os.makedirs(session_dir, exist_ok=True)
        # 截断旧索引（新会话）
        open(self.index_path, "w").close()

    def save_frame(self, device_id, frame, raw_bytes):
        """保存一帧。返回 True 表示继续，False 表示已达 max_frames 上限。"""
        with self._lock:
            if self.max_frames and self.total_frames >= self.max_frames:
                return False
            seq = frame.get("seq", 0)
            ts_ms = frame.get("ts_ms", 0)
            ftype = frame.get("type")
            dev = _sanitize_device_id(device_id)
            self.device_ids.add(dev)

            # 路径：recordings/<session>/<device>/<YYYYMMDD>/<HHMMSS_mmm>_<seq>.bin
            try:
                dt = datetime.fromtimestamp(ts_ms / 1000.0)
            except (OSError, ValueError, OverflowError):
                dt = datetime.now()
            date_dir = dt.strftime("%Y%m%d")
            time_part = dt.strftime("%H%M%S")
            millis = dt.microsecond // 1000
            fname = "%s_%03d_%06d.bin" % (time_part, millis, seq)
            rel_dir = os.path.join(dev, date_dir)
            abs_dir = os.path.join(self.session_dir, rel_dir)
            os.makedirs(abs_dir, exist_ok=True)
            abs_path = os.path.join(abs_dir, fname)
            rel_path = os.path.join(rel_dir, fname)
            with open(abs_path, "wb") as f:
                f.write(raw_bytes)

            entry = {
                "ts": int(ts_ms),
                "ts_iso": _iso_from_ms(ts_ms),
                "received_at": time.time(),
                "seq": int(seq),
                "device_id": device_id,
                "frame_file": rel_path.replace(os.sep, "/"),
                "frame_type": _type_name(ftype),
                "bytes_len": len(raw_bytes),
                "crc_ok": bool(frame.get("crc_ok")),
            }
            with open(self.index_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
            self.total_frames += 1
            return self.max_frames == 0 or self.total_frames < self.max_frames

    def write_manifest(self, ended_at):
        manifest = {
            "session_id": self.session_id,
            "started_at": self.started_at,
            "ended_at": ended_at,
            "device_ids": sorted(self.device_ids),
            "total_frames": self.total_frames,
            "protocol_version": PROTOCOL_VERSION,
            "output_dir": self.session_dir,
        }
        with open(os.path.join(self.session_dir, "manifest.json"), "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2)
        return manifest


class _RecorderState:
    """跨 handler 共享的停止信号与录制器句柄。"""

    def __init__(self, recorder, stop_event):
        self.recorder = recorder
        self.stop_event = stop_event


class DeviceHandler(socketserver.BaseRequestHandler):
    """每条 TCP 连接视为一台设备；缓存字节、拆帧、落盘。"""

    def handle(self):
        state = self.server.recorder_state  # type: ignore
        recorder = state.recorder
        stop_event = state.stop_event
        peer = "%s:%d" % self.client_address
        device_id = "unknown"
        buf = b""
        self.server.log("%s 设备连接" % peer)  # type: ignore
        try:
            while not stop_event.is_set():
                try:
                    data = self.request.recv(4096)
                except OSError:
                    break
                if not data:
                    break
                buf += data
                # 尽量消费缓冲区中的完整帧
                progress = True
                while progress and not stop_event.is_set():
                    progress = False
                    frame, consumed = _decode(buf)
                    if consumed == 0 and frame is None:
                        break  # 数据不足，等待更多
                    if frame is None:
                        buf = buf[consumed:]  # 跳字节重同步
                        progress = True
                        continue
                    raw = bytes(buf[:consumed])
                    buf = buf[consumed:]
                    progress = True
                    if frame.get("device_id"):
                        device_id = frame["device_id"]
                    keep_going = recorder.save_frame(device_id, frame, raw)
                    if not keep_going:
                        stop_event.set()
                        break
        finally:
            self.server.log("%s 设备断开 (device_id=%s)" % (peer, device_id))  # type: ignore


class RecordingServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, server_address, handler, logger):
        super().__init__(server_address, handler)
        self._logger = logger

    def log(self, msg):
        self._logger(msg)


def _parse_args(argv):
    p = argparse.ArgumentParser(
        description="NXP1 v1.0 原始帧录制工具：监听 TCP 端口，按帧拆分保存真实设备字节流。")
    p.add_argument("--port", type=int, default=9001, help="监听 TCP 端口（默认 9001）")
    p.add_argument("--host", default="0.0.0.0", help="监听地址（默认 0.0.0.0）")
    p.add_argument("--output-dir", default="recordings", help="录制根目录（默认 recordings/）")
    p.add_argument("--session-id", default=None, help="会话 ID（默认用启动时间戳生成）")
    p.add_argument("--max-frames", type=int, default=0, help="最大录制帧数，0=无限（默认 0）")
    p.add_argument("--duration-sec", type=float, default=0.0, help="最长录制秒数，0=无限（默认 0）")
    return p.parse_args(argv)


def main(argv=None):
    args = _parse_args(argv if argv is not None else sys.argv[1:])

    started_at_dt = datetime.now().astimezone()
    started_at = started_at_dt.isoformat(timespec="milliseconds")
    session_id = args.session_id or started_at_dt.strftime("sess-%Y%m%d-%H%M%S")
    session_dir = os.path.join(args.output_dir, session_id)
    os.makedirs(session_dir, exist_ok=True)

    recorder = FrameRecorder(session_dir, session_id, started_at, max_frames=args.max_frames)
    stop_event = threading.Event()

    def log(msg):
        print("[%s] %s" % (datetime.now().strftime("%H:%M:%S"), msg), flush=True)

    log("录制会话启动: session_id=%s" % session_id)
    log("输出目录: %s" % os.path.abspath(session_dir))
    log("监听: %s:%d  协议: %s（来源: %s）" % (
        args.host, args.port, PROTOCOL_VERSION,
        "edge_platform.edge.protocol" if _USING_REAL_PROTOCOL else "内置回退"))
    log("max_frames=%s  duration_sec=%s" % (
        args.max_frames if args.max_frames else "无限",
        args.duration_sec if args.duration_sec else "无限"))

    try:
        server = RecordingServer((args.host, args.port), DeviceHandler, log)
    except OSError as e:
        log("无法监听 %s:%d：%s" % (args.host, args.port, e))
        return 2

    server.recorder_state = _RecorderState(recorder, stop_event)

    def _sigint(signum, frame):
        log("收到中断信号，正在停止...")
        stop_event.set()

    signal.signal(signal.SIGINT, _sigint)
    signal.signal(signal.SIGTERM, _sigint)

    serve_thread = threading.Thread(target=server.serve_forever, daemon=True)
    serve_thread.start()
    log("按 Ctrl+C 优雅退出并写入 manifest.json")

    start_wall = time.time()
    try:
        while not stop_event.is_set():
            if args.max_frames and recorder.total_frames >= args.max_frames:
                log("已达 max_frames=%d，停止录制" % args.max_frames)
                break
            if args.duration_sec and (time.time() - start_wall) >= args.duration_sec:
                log("已达 duration_sec=%ss，停止录制" % args.duration_sec)
                break
            time.sleep(0.2)
    finally:
        stop_event.set()
        server.shutdown()
        server.server_close()
        ended_at = datetime.now().astimezone().isoformat(timespec="milliseconds")
        manifest = recorder.write_manifest(ended_at)
        log("录制结束: total_frames=%d device_ids=%s" %
            (manifest["total_frames"], manifest["device_ids"]))
        log("manifest: %s" % os.path.abspath(os.path.join(session_dir, "manifest.json")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
