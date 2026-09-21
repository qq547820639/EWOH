"""真机接收端（TcpDeviceDriver / NyExoA1TcpAdapter / InjectorDeviceDriver）回归测试。

G8 补链：`ny_exo_a1` 声明了"真实驱动通过 feed(raw_bytes) 投递字节流"，但接收端在仓库里
从来不存在——`replay_device.py` 往 TCP 9001 重放真机帧却没人听。本测试钉住补上的这一跳：

  1. **真 socket → 适配器**：NXP1 字节流经真 TCP 连接进入适配器，被解码进 read_message/drain；
  2. **驱动不拆帧**：一坨多帧（粘包）、跨两次 send 的半帧（半包）都由适配器缓冲还原；
  3. **断连重连**（`replay_device.py --disconnect-at` 场景）：新连接清半包缓冲，
     残留半帧不得被拼进新连接的帧里（否则现场表现是"每次重连丢一帧并报坏帧"）；
     跨连接重复 SEQ 的 BACKFILL 仍被去重，**不重复计数**；最后一条用**真脚本**
     `scripts/replay_device.py --disconnect-at` 打真 socket 走完整链路；
  4. **fail-closed**：端口占用 / 非 feed 对象在构造期抛错；适配器 feed 抛错计数留痕不吞；
  5. **来源隔离**：`InjectorDeviceDriver` 拒绝 `source_type=real`（受控数据不得包装成真机结论）；
  6. **EWOH_ADAPTERS 显式启用**：kind=`ny_exo_a1_tcp` 可装配，未知参数仍 fail-closed。

纯标准库 unittest；真起本地 socket（端口用 0 由系统分配，避免与并行测试抢端口）。
"""

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform.edge.adapter_factory import build_adapters  # noqa: E402
from edge_platform.edge.adapters.base import BaseAdapter  # noqa: E402
from edge_platform.edge.adapters.ny_exo_a1 import codec  # noqa: E402
from edge_platform.edge.adapters.ny_exo_a1.adapter import NyExoA1Adapter  # noqa: E402
from edge_platform.edge.adapters.ny_exo_a1.injector import WireInjector  # noqa: E402
from edge_platform.edge.device_driver import (  # noqa: E402
    DeviceDriverError,
    InjectorDeviceDriver,
    NyExoA1TcpAdapter,
    TcpDeviceDriver,
)

BASE_TS_MS = 1_700_000_000_000


def _wait_for(predicate, timeout=5.0, interval=0.01):
    """轮询等待（TCP 投递是异步的：handler 线程何时跑到不可控，只能等条件成立）。"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return False


def _telemetry(seq, ts_ms=None, pitch_deg=5.0, torque_nm=8.0):
    """一帧合法 TELEMETRY：ts 按 50ms（20Hz）步进，避开漂移/采样率质量告警。"""
    return codec.encode_telemetry(
        seq=seq,
        ts_ms=BASE_TS_MS + (seq - 1) * 50 if ts_ms is None else ts_ms,
        pitch_deg=pitch_deg,
        roll_deg=0.0,
        ax_mg=0,
        ay_mg=0,
        az_mg=9810,
        gx_dps=0.0,
        gy_dps=38.0,
        gz_dps=0.0,
        torque_nm=torque_nm,
        assist_pct=20,
        battery_pct=90,
    )


def _telemetry_stream(count, start_seq=1):
    return b"".join(_telemetry(start_seq + i) for i in range(count))


class TcpDeviceDriverTest(unittest.TestCase):
    """真 socket → 适配器：帧被正确解码并进入 read_message / drain。"""

    def setUp(self):
        # 用 controlled_test：本测试的字节由 codec 生成，不冒充真机来源（来源隔离）
        self.adapter = NyExoA1Adapter("EXO-TCP1", source_type="controlled_test")
        self.adapter.start()
        self.driver = TcpDeviceDriver(self.adapter, port=0)
        self.driver.start()

    def tearDown(self):
        self.driver.stop()
        self.adapter.stop()

    def _connect(self):
        return socket.create_connection(("127.0.0.1", self.driver.port), timeout=3.0)

    def test_frames_arrive_via_read_message_and_drain(self):
        raw = codec.encode_ident("EXO-TCP1") + _telemetry_stream(20)
        with self._connect() as sock:
            sock.sendall(raw)
        # IDENT 不产出统一帧，20 条 TELEMETRY 各产出一条
        self.assertTrue(_wait_for(lambda: self.adapter._inbox.qsize() >= 20), "帧未在超时内到达适配器")

        first = self.adapter.read_message(timeout=1)  # 拉模式：read_message 取一条
        self.assertIsNotNone(first)
        self.assertEqual(first["entity_id"], "EXO-TCP1")
        self.assertEqual(first["source_type"], "controlled_test")
        self.assertEqual(first["sequence"], 1)
        self.assertAlmostEqual(first["pose"]["trunk_pitch_deg"], 5.0, places=1)

        rest = self.adapter.drain()  # 批量取剩余
        self.assertEqual(len(rest), 19)
        self.assertEqual([f.sequence for f in rest], list(range(2, 21)))
        self.assertEqual(self.driver.stats()["bytes_received"], len(raw))

    def test_sticky_and_split_packets_framed_by_adapter(self):
        """驱动只搬字节：粘包（一次 10 帧）与半包（跨两次 send）都由适配器缓冲还原。"""
        frames = [_telemetry(seq) for seq in range(1, 12)]
        blob = b"".join(frames[:10])  # 粘包：一次 send 里 10 帧
        split = frames[10]  # 半包：第 11 帧拆成两次 send
        with self._connect() as sock:
            sock.sendall(blob)
            sock.sendall(split[:10])
            time.sleep(0.05)
            sock.sendall(split[10:])
        self.assertTrue(_wait_for(lambda: self.adapter._inbox.qsize() >= 11), "粘包/半包未被适配器还原")
        got = self.adapter.drain()
        self.assertEqual([f.sequence for f in got], list(range(1, 12)))
        self.assertEqual(self.adapter.health()["bad_crc_frames"], 0)
        self.assertEqual(self.adapter.health()["malformed_frames"], 0)
        self.assertEqual(self.driver.stats()["bytes_received"], len(blob) + len(split))

    def test_disconnect_reconnect_clears_half_frame_and_keeps_counting(self):
        """断连（--disconnect-at）后重连：残半帧不得污染新连接的帧，计数不重复。"""
        head = b"".join(_telemetry(seq) for seq in range(1, 6))
        tail = b"".join(_telemetry(seq) for seq in range(6, 9))
        half = _telemetry(9)[:12]  # 只发半帧即断开，留下残渣

        with self._connect() as sock:
            sock.sendall(head + half)
        self.assertTrue(_wait_for(lambda: self.adapter._inbox.qsize() >= 5))
        self.assertTrue(_wait_for(lambda: self.driver.stats()["active_sessions"] == 0))

        with self._connect() as sock:  # 重连：新会话清半包缓冲
            sock.sendall(tail)
        self.assertTrue(_wait_for(lambda: self.adapter._inbox.qsize() >= 8), "重连后帧未继续到达")

        got = self.adapter.drain()
        self.assertEqual([f.sequence for f in got], [1, 2, 3, 4, 5, 6, 7, 8])
        health = self.adapter.health()
        self.assertEqual(health["bad_crc_frames"], 0, "残半帧被拼进了新连接的帧（未清半包缓冲）")
        self.assertEqual(health["malformed_frames"], 0)
        self.assertEqual(self.driver.stats()["sessions"], 2)

    def test_backfill_duplicate_seq_across_connections_is_deduped(self):
        """跨连接重复 SEQ 的 BACKFILL：去重后不重复计数（重连一次不得多算一批帧）。"""
        entries = [
            {"seq": seq, "ts_ms": BASE_TS_MS + i * 50, "telemetry": {"pitch_deg": 5.0}}
            for i, seq in enumerate((10, 11, 12))
        ]
        frame1 = codec.encode_backfill(entries, seq=100, ts_ms=BASE_TS_MS)
        frame2 = codec.encode_backfill(entries, seq=101, ts_ms=BASE_TS_MS)
        with self._connect() as sock:
            sock.sendall(frame1)
        self.assertTrue(_wait_for(lambda: self.adapter._inbox.qsize() >= 3))
        self.assertTrue(_wait_for(lambda: self.driver.stats()["active_sessions"] == 0))
        with self._connect() as sock:  # 重连后设备 BACKFILL 重复补传同一批
            sock.sendall(frame2)
        self.assertTrue(_wait_for(lambda: self.adapter.health()["backfill_duplicates"] >= 3))

        self.assertEqual(len(self.adapter.drain()), 3)
        self.assertEqual(self.adapter.health()["backfill_duplicates"], 3)

    def test_second_concurrent_session_is_refused_not_interleaved(self):
        """第二条并发连接必须被拒（fail-closed），先到会话的帧流不受污染。

        回归缺陷：此前每条连接都照常 feed 同一适配器——一台适配器只有**一个**
        `_buffer`/一份设备状态，两条设备的字节流一旦交错：
          · 后到设备的 IDENT 会把适配器 `device_id` 改写掉，先到设备的遥测从此
            被记到别的设备名下（来源归属污染，真机数据不可信）；
          · 并发 feed 在 `_buffer` 上无锁交错（extend/del 撕咬），帧被撕成 CRC 垃圾。
        驱动不拆帧（没有 device 维度可路由），唯一正确的处理是**同一时刻只允许
        一条会话投递**：第二条连接立即关闭（对端读到 EOF）并计数留痕。
        """
        with self._connect() as sock_a:
            # IDENT device_id 只有 8 字节（codec 截断）→ 用 8 字符以内的设备号
            sock_a.sendall(codec.encode_ident("EXO-PRI") + _telemetry_stream(3))
            self.assertTrue(_wait_for(lambda: self.adapter._inbox.qsize() >= 3))
            with self._connect() as sock_b:  # 第二台设备/回放器并发接入
                sock_b.sendall(codec.encode_ident("EXO-INT"))
                try:
                    closed = sock_b.recv(64) == b""  # 正常关闭：读到 EOF
                except ConnectionError:
                    closed = True  # 缓冲里还有未读字节时关闭会以 RST 呈现——同样是"连接被拒"
                self.assertTrue(closed, "并发第二条连接应被驱动立即关闭")
            # 先到会话继续投递不受影响
            sock_a.sendall(_telemetry_stream(4, start_seq=4))
            self.assertTrue(_wait_for(lambda: self.adapter._inbox.qsize() >= 7))

        self.assertTrue(_wait_for(lambda: self.driver.stats()["active_sessions"] == 0))
        frames = self.adapter.drain()
        self.assertTrue(
            all(f.entity_id == "EXO-TCP1" for f in frames),
            [f.entity_id for f in frames],
        )
        stats = self.driver.stats()
        self.assertEqual(stats["sessions"], 2, "连接尝试总数（含被拒）都应计数")
        self.assertEqual(stats["rejected_sessions"], 1, "被拒的第二条连接必须留痕")


class DeviceDriverFailClosedTest(unittest.TestCase):
    """fail-closed：不许"启动成功但什么都没接上"。"""

    def _adapter(self):
        adapter = NyExoA1Adapter("EXO-TCP-FC", source_type="controlled_test")
        adapter.start()
        return adapter

    def test_port_in_use_raises_at_construction(self):
        adapter = self._adapter()
        first = TcpDeviceDriver(adapter, port=0)
        first.start()
        try:
            with self.assertRaises(DeviceDriverError) as ctx:
                TcpDeviceDriver(adapter, port=first.port)
            self.assertIn("listen_failed", str(ctx.exception))
        finally:
            first.stop()
            adapter.stop()

    def test_object_without_feed_is_rejected(self):
        with self.assertRaises(DeviceDriverError) as ctx:
            TcpDeviceDriver(object(), port=0)
        self.assertIn("feed", str(ctx.exception))

    def test_feed_failure_is_counted_and_logged_not_swallowed(self):
        class _BoomAdapter:
            source_type = "controlled_test"

            def feed(self, raw_bytes):
                raise RuntimeError("boom")

        driver = TcpDeviceDriver(_BoomAdapter(), port=0)
        driver.start()
        try:
            with self.assertLogs("ewoh.edge.device_driver", level="ERROR"):
                with socket.create_connection(("127.0.0.1", driver.port), timeout=3.0) as sock:
                    sock.sendall(b"\xaa\x55\x00")
                self.assertTrue(_wait_for(lambda: driver.stats()["feed_failures"] >= 1))
            self.assertIn("feed_failed", driver.stats()["last_error"])
        finally:
            driver.stop()


class InjectorDeviceDriverTest(unittest.TestCase):
    """来源隔离：注入器（受控数据）不得接到 real 适配器。"""

    def test_real_adapter_is_refused_at_construction(self):
        real = NyExoA1Adapter("EXO-REAL", source_type="real")
        with self.assertRaises(DeviceDriverError) as ctx:
            InjectorDeviceDriver(real, WireInjector(device_id="EXO-REAL"))
        self.assertIn("real", str(ctx.exception))

    def test_controlled_test_adapter_accepts_scenario(self):
        adapter = NyExoA1Adapter("EXO-CT", source_type="controlled_test")
        adapter.start()
        driver = InjectorDeviceDriver(adapter, WireInjector(device_id="EXO-CT"))
        produced = driver.feed_scenario("normal")
        self.assertGreater(produced, 0)
        self.assertEqual(len(adapter.drain()), produced)
        self.assertEqual(driver.stats()["kind"], "injector")

    def test_missing_scenario_is_refused(self):
        adapter = NyExoA1Adapter("EXO-CT2", source_type="controlled_test")
        with self.assertRaises(DeviceDriverError):
            InjectorDeviceDriver(adapter, object())


class AdapterFactoryEnablementTest(unittest.TestCase):
    """EWOH_ADAPTERS 显式启用真机接收端（kind=ny_exo_a1_tcp）。"""

    def test_build_adapters_constructs_tcp_adapter(self):
        adapters = build_adapters(
            [
                {
                    "kind": "ny_exo_a1_tcp",
                    "deviceId": "EXO-TCP-2",
                    "sourceType": "controlled_test",
                    "listenHost": "127.0.0.1",
                    "listenPort": 0,
                }
            ]
        )
        self.assertEqual(len(adapters), 1)
        adapter = adapters[0]
        self.assertIsInstance(adapter, NyExoA1TcpAdapter)
        self.assertIsInstance(adapter, BaseAdapter)
        self.assertGreater(adapter.driver.port, 0)
        self.assertEqual(adapter.device_info()["transport"], "tcp-ingest")

        adapter.start()
        try:
            self.assertTrue(adapter.driver.stats()["running"])
            with socket.create_connection(("127.0.0.1", adapter.driver.port), timeout=3.0) as sock:
                sock.sendall(codec.encode_ident("EXO-TCP-2") + _telemetry_stream(3))
            self.assertTrue(_wait_for(lambda: adapter.health()["ingest"]["bytes_received"] > 0))
            # 等待条件必须是"3 帧全部入队"：回环 TCP 偶发把这段字节拆成多个分段，
            # 只等 bytes_received>0 就 drain 会在半包尚未拼齐时拿到部分帧（间歇性翻车）。
            self.assertTrue(
                _wait_for(lambda: adapter.adapter._inbox.qsize() >= 3),
                "帧未在超时内全部到达适配器",
            )
            self.assertEqual(len(adapter.drain()), 3)
            self.assertIn("ingest", adapter.health())
        finally:
            adapter.stop()

    def test_unknown_param_still_fail_closed(self):
        with self.assertRaises(ValueError) as ctx:
            build_adapters([{"kind": "ny_exo_a1_tcp", "deviceId": "EXO-TCP-3", "typoParam": 1}])
        self.assertIn("未知参数", str(ctx.exception))


class ReplayDeviceIntegrationTest(unittest.TestCase):
    """端到端：scripts/replay_device.py --disconnect-at 打真 socket，驱动必须扛住。

    这条锁定"断连要能被 replay_device.py 验证"：回放器在 seq=5 后真实断开再重连，
    接收端应表现为 2 个会话、10 帧全部到达、序号无重复、无坏帧。
    """

    def test_replay_with_disconnect_at_resumes_without_duplicates(self):
        repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
        script = os.path.join(repo_root, "src", "edge_platform", "scripts", "replay_device.py")
        self.assertTrue(os.path.exists(script), script)

        session_dir = tempfile.mkdtemp()
        frames_dir = os.path.join(session_dir, "frames")
        os.makedirs(frames_dir)
        base_ts = 1_700_000_000_000
        with open(os.path.join(session_dir, "index.jsonl"), "w", encoding="utf-8") as index:
            for seq in range(1, 11):
                raw = _telemetry(seq, ts_ms=base_ts + (seq - 1) * 50)
                name = f"{seq:06d}.bin"
                with open(os.path.join(frames_dir, name), "wb") as handle:
                    handle.write(raw)
                index.write(
                    json.dumps(
                        {
                            "ts": base_ts + (seq - 1) * 50,
                            "seq": seq,
                            "device_id": "EXO-RPL",
                            "frame_file": f"frames/{name}",
                            "frame_type": "TELEMETRY",
                            "bytes_len": len(raw),
                        }
                    )
                    + "\n"
                )
        with open(os.path.join(session_dir, "manifest.json"), "w", encoding="utf-8") as manifest:
            json.dump({"session_id": "sess-test", "protocol_version": "NXP1 v1.0"}, manifest)

        adapter = NyExoA1Adapter("EXO-RPL", source_type="controlled_test")
        adapter.start()
        driver = TcpDeviceDriver(adapter, port=0)
        driver.start()
        try:
            result = subprocess.run(
                [
                    sys.executable,
                    script,
                    "--session-dir", session_dir,
                    "--target-host", "127.0.0.1",
                    "--target-port", str(driver.port),
                    "--speed", "50",
                    "--disconnect-at", "5",
                    "--disconnect-duration", "0.3",
                ],
                capture_output=True,
                text=True,
                timeout=60,
                cwd=repo_root,
            )
            self.assertEqual(result.returncode, 0, result.stderr[-400:])
            self.assertTrue(_wait_for(lambda: adapter._inbox.qsize() >= 10), "回放帧未全部到达")
            self.assertEqual([f.sequence for f in adapter.drain()], list(range(1, 11)))
            self.assertEqual(driver.stats()["sessions"], 2, "断连注入应产生两次会话")
            self.assertEqual(adapter.health()["bad_crc_frames"], 0)
        finally:
            driver.stop()
            adapter.stop()


if __name__ == "__main__":
    unittest.main()
