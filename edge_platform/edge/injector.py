"""NXP1 v1.0 线协议注入器（测试用）。

基于 protocol.encode_* 生成字节流，向目标 TCP 端口注入断线/补传/乱序/故障码
场景，用于适配层在无真机时的端到端测试。

安全声明：本注入器仅模拟设备上行帧，不发送任何平台→设备控制命令。
"""
import argparse
import random
import socket
import sys
import time

from .adapters.ny_exo_a1.protocol import (
    encode_ident, encode_telemetry, encode_heartbeat, encode_fault, encode_backfill,
    DEVICE_MODEL, PROTOCOL_VERSION)


class WireInjector:
    """向目标 TCP 端口注入 NXP1 v1.0 帧字节流。

    用法：
        inj = WireInjector("127.0.0.1", 9001, device_id="EXO-001")
        inj.connect()
        inj.send_ident()
        inj.stream_telemetry(40)
        inj.inject_disconnect(2.0)
        inj.close()
    """

    def __init__(self, host, port, device_id="EXO-INJ-001", fw="1.4.2", hw=0x23):
        self.host = host
        self.port = port
        self.device_id = device_id
        self.fw = fw
        self.hw = hw
        self.sock = None
        self.seq = 0

    def connect(self):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.settimeout(5.0)
        self.sock.connect((self.host, self.port))
        self.sock.settimeout(None)
        return self

    def close(self):
        if self.sock:
            try:
                self.sock.close()
            except OSError:
                pass
            self.sock = None

    def _next_seq(self):
        self.seq += 1
        return self.seq

    def _send(self, data):
        if self.sock:
            self.sock.sendall(data)

    def send_ident(self, ts_ms=None):
        ts_ms = ts_ms if ts_ms is not None else int(time.time() * 1000)
        seq = self._next_seq()
        self._send(encode_ident(self.device_id, self.fw, self.hw, seq=seq, ts_ms=ts_ms))
        return seq

    def send_telemetry(self, pitch=0.0, roll=0.0, ax=0, ay=0, az=9810,
                       gx=0.0, gy=0.0, gz=0.0, torque=0.0, assist=0, battery=80,
                       ts_ms=None, seq=None):
        ts_ms = ts_ms if ts_ms is not None else int(time.time() * 1000)
        seq = seq if seq is not None else self._next_seq()
        self._send(encode_telemetry(seq, ts_ms, pitch, roll, ax, ay, az,
                                    gx, gy, gz, torque, assist, battery))
        return seq

    def send_heartbeat(self, battery=80, status=0, ts_ms=None):
        ts_ms = ts_ms if ts_ms is not None else int(time.time() * 1000)
        seq = self._next_seq()
        self._send(encode_heartbeat(seq, ts_ms, battery, status, self.fw))
        return seq

    def send_fault(self, code=0x01, detail=0, ts_ms=None):
        ts_ms = ts_ms if ts_ms is not None else int(time.time() * 1000)
        seq = self._next_seq()
        self._send(encode_fault(seq, ts_ms, code, detail))
        return seq

    def send_backfill(self, items, ts_ms=None):
        ts_ms = ts_ms if ts_ms is not None else int(time.time() * 1000)
        seq = self._next_seq()
        self._send(encode_backfill(seq, ts_ms, items))
        return seq

    def stream_telemetry(self, count, interval_ms=50, start_ts_ms=None, **kw):
        """连续发送 count 条遥测帧，间隔 interval_ms。"""
        base = start_ts_ms if start_ts_ms is not None else int(time.time() * 1000)
        for i in range(count):
            self.send_telemetry(ts_ms=base + i * interval_ms, **kw)
            time.sleep(interval_ms / 1000.0)

    def inject_disconnect(self, duration_sec=2.0):
        """断开连接并等待后重连。"""
        self.close()
        time.sleep(duration_sec)
        self.connect()

    def inject_out_of_order(self, count, base_seq=None, interval_ms=50):
        """乱序发送：打乱 seq 顺序。"""
        base = int(time.time() * 1000)
        start = base_seq if base_seq is not None else 1
        order = list(range(start, start + count))
        random.shuffle(order)
        for i, s in enumerate(order):
            self.send_telemetry(ts_ms=base + i * interval_ms, seq=s)
            time.sleep(interval_ms / 1000.0)

    def inject_backfill(self, missing_count, interval_ms=50):
        """发送 IDENT + BACKFILL 补传 missing_count 条。"""
        self.send_ident()
        base = int(time.time() * 1000) - missing_count * interval_ms
        items = [(i + 1, base + i * interval_ms,
                  {"pitch": 30.0, "torque": 12.0, "az": 9810, "battery": 80})
                 for i in range(missing_count)]
        return self.send_backfill(items)


_SCENARIOS = ["normal", "disconnect", "backfill", "out_of_order", "fault"]


def _parse_args(argv):
    p = argparse.ArgumentParser(
        description="NXP1 v1.0 线协议注入器：向适配层注入测试场景。")
    p.add_argument("--host", default="127.0.0.1", help="目标适配层地址")
    p.add_argument("--port", type=int, default=9001, help="目标适配层端口")
    p.add_argument("--device-id", default="EXO-INJ-001", help="设备 ID")
    p.add_argument("--scenario", default="normal", choices=_SCENARIOS,
                   help="注入场景")
    p.add_argument("--count", type=int, default=20, help="遥测帧数（normal/out_of_order）")
    return p.parse_args(argv)


def main(argv=None):
    args = _parse_args(argv if argv is not None else sys.argv[1:])
    inj = WireInjector(args.host, args.port, device_id=args.device_id)
    try:
        inj.connect()
        print("[injector] 已连接 %s:%d，设备 %s" % (args.host, args.port, args.device_id))
        inj.send_ident()
        if args.scenario == "normal":
            inj.stream_telemetry(args.count)
        elif args.scenario == "disconnect":
            inj.stream_telemetry(10)
            print("[injector] 注入断线 ...")
            inj.inject_disconnect(2.0)
            inj.send_ident()
            inj.stream_telemetry(10)
        elif args.scenario == "backfill":
            inj.stream_telemetry(10)
            print("[injector] 注入断线 + 补传 ...")
            inj.inject_disconnect(2.0)
            inj.inject_backfill(10)
        elif args.scenario == "out_of_order":
            inj.inject_out_of_order(args.count)
        elif args.scenario == "fault":
            inj.stream_telemetry(5)
            inj.send_fault(code=0x01)
            print("[injector] 注入故障码 0x01 IMU_FAULT")
        print("[injector] 场景 %s 完成" % args.scenario)
    except OSError as e:
        print("[injector] 连接/发送失败: %s" % e, file=sys.stderr)
        return 1
    finally:
        inj.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
