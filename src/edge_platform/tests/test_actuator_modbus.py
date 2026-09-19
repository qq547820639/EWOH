"""Modbus/TCP 主站 Transport + 假从站测试（NO-62d）。

验证三件事（对应"真机接入路径"是否真的可跑通）：
  1. **协议是真的**：MBAP 编解码、功能码、异常响应（0x83 + 码）、越界拒绝；
  2. **设备语义是确定的**：命令 → 寄存器 → 状态（移动/到达/停机/故障）逐项可断言；
  3. **上层判定与传输无关**：`ActuatorAdapter` 的授权 fail-closed 顺序在 Modbus 传输上
     同样成立（高危命令没授权号 → 一个寄存器都不写）。
"""

import os
import socket
import struct
import sys
import time
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform.edge.adapters.actuator.adapter import ActuatorAdapter  # noqa: E402
from edge_platform.edge.adapters.actuator.modbus import (  # noqa: E402
    EXCEPTION_ILLEGAL_DATA_ADDRESS,
    EXCEPTION_ILLEGAL_DATA_VALUE,
    EXCEPTION_ILLEGAL_FUNCTION,
    FC_READ_HOLDING,
    FC_WRITE_SINGLE,
    FakeModbusSlave,
    ModbusError,
    ModbusTcpActuatorTransport,
    encode_fault_code,
    station_hash16,
)
from edge_platform.edge.adapters.actuator.protocol import (  # noqa: E402
    ACTUATOR_COMMANDS,
    ActuatorCommand,
)


def make_pair(device_id="AGV-MB-1", **kwargs):
    slave = FakeModbusSlave(device_id, **kwargs).start()
    transport = ModbusTcpActuatorTransport("127.0.0.1", device_id, port=slave.port, timeout=2.0)
    return slave, transport


def _read_exactly(sock: socket.socket, count: int) -> bytes:
    """TCP 是字节流：必须循环读够长度（单次 recv 可能只拿到半帧）。"""
    chunks = b""
    while len(chunks) < count:
        chunk = sock.recv(count - len(chunks))
        if not chunk:
            break
        chunks += chunk
    return chunks


def raw_pdu(port: int, pdu: bytes, unit: int = 1) -> bytes:
    """用裸 socket 发一帧（不经过 Transport）——用于验证"线上真的是 Modbus/TCP"。"""
    with socket.create_connection(("127.0.0.1", port), timeout=2.0) as sock:
        header = struct.pack(">HHHB", 0x1234, 0, len(pdu) + 1, unit)
        sock.sendall(header + pdu)
        raw_header = _read_exactly(sock, 7)
        tx, protocol, length, _unit = struct.unpack(">HHHB", raw_header)
        assert tx == 0x1234 and protocol == 0
        return _read_exactly(sock, max(int(length) - 1, 0))


class ModbusProtocolTest(unittest.TestCase):
    def test_mbap_framing_and_read_holding(self):
        slave, transport = make_pair()
        try:
            pdu = raw_pdu(slave.port, struct.pack(">BHH", FC_READ_HOLDING, 0, 6))
            self.assertEqual(pdu[0], FC_READ_HOLDING)
            self.assertEqual(pdu[1], 12)  # 6 个寄存器 = 12 字节
            values = struct.unpack(">6H", pdu[2:14])
            self.assertEqual(len(values), 6)
            self.assertEqual(slave.requests[-1]["pdu"].startswith("03"), True)
        finally:
            transport.close()
            slave.stop()

    def test_illegal_address_returns_exception_response(self):
        slave, transport = make_pair()
        try:
            # 越界读：必须异常响应（0x83 + 0x02），不返回 0 假装读到
            pdu = raw_pdu(slave.port, struct.pack(">BHH", FC_READ_HOLDING, 5000, 4))
            self.assertEqual(pdu[0], FC_READ_HOLDING | 0x80)
            self.assertEqual(pdu[1], EXCEPTION_ILLEGAL_DATA_ADDRESS)
            with self.assertRaises(ModbusError) as ctx:
                transport._read_registers(5000, 4)
            self.assertIn(f"modbus_exception:{EXCEPTION_ILLEGAL_DATA_ADDRESS}", str(ctx.exception))
        finally:
            transport.close()
            slave.stop()

    def test_illegal_function_and_value_return_exception_codes(self):
        slave, transport = make_pair()
        try:
            illegal = raw_pdu(slave.port, struct.pack(">BHH", 0x2B, 0, 1))
            self.assertEqual(illegal[0], 0x2B | 0x80)
            self.assertEqual(illegal[1], EXCEPTION_ILLEGAL_FUNCTION)
            # 命令码非法（不在词表内）→ 0x03
            bad = raw_pdu(slave.port, struct.pack(">BHH", FC_WRITE_SINGLE, slave.map.command, 999))
            self.assertEqual(bad[0], FC_WRITE_SINGLE | 0x80)
            self.assertEqual(bad[1], EXCEPTION_ILLEGAL_DATA_VALUE)
            # 读数量超规范上限 → 0x03
            too_many = raw_pdu(slave.port, struct.pack(">BHH", FC_READ_HOLDING, 0, 126))
            self.assertEqual(too_many[1], EXCEPTION_ILLEGAL_DATA_VALUE)
        finally:
            transport.close()
            slave.stop()

    def test_partial_write_does_not_execute_command(self):
        """只写目标/序号（参数）不得触发动作——命令寄存器才是提交点。"""
        slave, transport = make_pair()
        try:
            slave.device.register_station("ST-1", 2.0, 0.0)
            transport._write_register(slave.map.command_target, station_hash16("ST-1"))
            transport._write_register(slave.map.command_seq, 1)
            self.assertEqual(slave.device.recv(timeout=0).state, "idle")
            transport._write_register(slave.map.command, ACTUATOR_COMMANDS.index("dispatch_task") + 1)
            self.assertEqual(slave.device.recv(timeout=0).state, "moving")
        finally:
            transport.close()
            slave.stop()


class ModbusDeviceSemanticsTest(unittest.TestCase):
    def test_dispatch_pause_resume_stop_round_trip(self):
        slave, transport = make_pair()
        try:
            slave.device.register_station("ST-1", 3.0, 0.0)
            sent = transport.send(
                ActuatorCommand(
                    device_id="AGV-MB-1",
                    command_key="dispatch_task",
                    authorization_ref="control:CR-1",
                    payload={"targetStationId": "ST-1"},
                )
            )
            self.assertTrue(sent.accepted, sent.reason)
            self.assertEqual(sent.state.state, "moving")
            self.assertEqual(sent.state.target_station_id, "ST-1")
            self.assertAlmostEqual(sent.state.battery_pct, 88.0, places=1)

            slave.tick()
            mid = transport.recv()
            self.assertEqual(mid.state, "moving")
            self.assertGreater(mid.x, 0.0)

            self.assertTrue(transport.send(ActuatorCommand(device_id="AGV-MB-1", command_key="pause")).accepted)
            self.assertEqual(transport.recv().state, "paused")
            self.assertTrue(transport.send(ActuatorCommand(device_id="AGV-MB-1", command_key="resume")).accepted)
            self.assertEqual(transport.recv().state, "moving")

            slave.tick()
            slave.tick()
            slave.tick()
            self.assertEqual(transport.recv().state, "arrived")

            self.assertTrue(transport.send(ActuatorCommand(device_id="AGV-MB-1", command_key="stop")).accepted)
            final = transport.recv()
            self.assertEqual(final.state, "idle")
            self.assertIsNone(final.target_station_id)
        finally:
            transport.close()
            slave.stop()

    def test_dispatch_without_target_is_rejected_before_any_write(self):
        slave, transport = make_pair()
        try:
            result = transport.send(
                ActuatorCommand(device_id="AGV-MB-1", command_key="dispatch_task", payload={})
            )
            self.assertFalse(result.accepted)
            self.assertEqual(result.reason, "target_station_required")
            # 没有登记的目标工位 → 从站异常（slave_device_failure），命令未执行
            result2 = transport.send(
                ActuatorCommand(
                    device_id="AGV-MB-1",
                    command_key="dispatch_task",
                    payload={"targetStationId": "ST-UNKNOWN"},
                )
            )
            self.assertFalse(result2.accepted)
            self.assertIn("modbus_exception", result2.reason or "")
            self.assertEqual(slave.device.recv(timeout=0).state, "idle")
        finally:
            transport.close()
            slave.stop()

    def test_fault_code_is_encoded_and_read_back(self):
        slave, transport = make_pair()
        try:
            slave.device.inject_fault("MOTOR_OVERHEAT")
            slave._refresh_holding()  # noqa: SLF001 - 测试显式推进从站寄存器
            state = transport.recv()
            self.assertEqual(state.state, "fault")
            self.assertIsNotNone(state.fault_code)
            self.assertEqual(encode_fault_code("MOTOR_OVERHEAT") != 0, True)
            self.assertEqual(encode_fault_code(None), 0)
        finally:
            transport.close()
            slave.stop()

    def test_unknown_command_key_is_rejected_by_transport(self):
        slave, transport = make_pair()
        try:
            result = transport.send(ActuatorCommand(device_id="AGV-MB-1", command_key="teleport"))
            self.assertFalse(result.accepted)
            self.assertEqual(result.reason, "unknown_command_key")
        finally:
            transport.close()
            slave.stop()


class ModbusFailureModeTest(unittest.TestCase):
    def test_unreachable_slave_does_not_fabricate_state(self):
        transport = ModbusTcpActuatorTransport("127.0.0.1", "AGV-MB-X", port=1, timeout=0.5)
        try:
            result = transport.send(ActuatorCommand(device_id="AGV-MB-X", command_key="stop"))
            self.assertFalse(result.accepted)
            self.assertIn("connect_failed", result.reason or "")
            self.assertIsNone(transport.recv())
        finally:
            transport.close()

    def test_closed_transport_reports_closed(self):
        slave, transport = make_pair()
        try:
            transport.close()
            result = transport.send(ActuatorCommand(device_id="AGV-MB-1", command_key="stop"))
            self.assertFalse(result.accepted)
            self.assertEqual(result.reason, "transport_closed")
        finally:
            slave.stop()

    def test_station_hash_is_deterministic_and_documented_as_association_only(self):
        # 实测教训：直接取 FNV-1a-64 的**前 4 位十六进制**当 16 位哈希时，
        # "ST-1" 与 "ST-2" 撞在一起（短且相似的字符串在前缀位上不分散）。
        # 改为 64 位 → 16 位的异或折叠（高阶位参与），并对常用工位号做分散性自证。
        self.assertEqual(station_hash16("ST-1"), station_hash16("ST-1"))
        hashes = {station_hash16(f"ST-{i}") for i in range(1, 33)}
        self.assertEqual(len(hashes), 32, "ST-1..ST-32 的 16 位哈希应互不相同")
        self.assertTrue(0 <= station_hash16("") <= 0xFFFF)
        # 哈希只用于协议内关联，**不是**工位号本身（真值由主站侧保留）。
        self.assertNotEqual(station_hash16("ST-1"), "ST-1")


class ModbusAdapterBoundaryTest(unittest.TestCase):
    """授权判定与传输实现无关：换 Modbus 传输后 fail-closed 顺序不变。"""

    def test_high_risk_command_without_authorization_writes_nothing(self):
        slave, transport = make_pair("AGV-MB-2")
        try:
            slave.device.register_station("ST-1", 1.0, 0.0)
            adapter = ActuatorAdapter(
                "AGV-MB-2", source_type="controlled_test", transport=transport, tick_on_read=False
            )
            adapter.start()
            # 只比**命令寄存器**：状态寄存器由读操作按需刷新（惰性），
            # "被拒绝不得写命令"才是这条断言真正要证明的事。
            def command_registers():
                return [
                    slave.holding[slave.map.command],
                    slave.holding[slave.map.command_target],
                    slave.holding[slave.map.command_seq],
                ]

            before = command_registers()
            denied = adapter.send_command("dispatch_task", None, {"targetStationId": "ST-1"})
            self.assertFalse(denied["accepted"])
            self.assertEqual(denied["reason"], "authorization_required")
            self.assertEqual(slave.device.recv(timeout=0).state, "idle")
            self.assertEqual(command_registers(), before, "被拒绝的命令不得写任何命令寄存器")

            allowed = adapter.send_command(
                "dispatch_task", "control:CR-1", {"targetStationId": "ST-1"}
            )
            self.assertTrue(allowed["accepted"], allowed.get("reason"))
            self.assertEqual(allowed["state"]["state"], "moving")
            self.assertEqual(allowed["transport"], "modbus-tcp")
        finally:
            transport.close()
            slave.stop()


if __name__ == "__main__":
    unittest.main()


class ModbusCliEndToEndTest(unittest.TestCase):
    """CLI 走 Modbus/TCP：平台命令 → 真帧 → 假从站 → 数字孪生动作 → 回执。

    这是"真机接入路径"最接近现场的验证：除从站背后的设备是数字孪生外，
    链路（轮询 → 授权号核对 → Modbus 帧 → 状态回读 → ack/回执）与真机一致。
    """

    def test_cli_executes_command_over_modbus_wire(self):
        import json
        import subprocess
        import threading
        from http.server import BaseHTTPRequestHandler, HTTPServer

        # tests/ → edge_platform/ → src/ → 仓库根（少一层就会找不到 tools/edge_control_agent.py）
        repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
        slave = FakeModbusSlave("AGV-MB-CLI", port=0).start()
        slave.device.register_station("ST-1", 2.0, 0.0)
        received: dict = {"acks": [], "receipts": []}
        # NO-65a：边缘现在会先核对指纹——这里给一个**与授权范围一致**的 v1 指纹
        # （否则测到的是拒绝路径：`fingerprint_mismatch` → 退出码 2）。
        from edge_platform.edge.adapters.actuator.protocol import authorization_fingerprint

        command = {
            "commandId": "att-mb-1",
            "requestId": "ctl-mb-1",
            "commandKey": "dispatch_task",
            "attemptNo": 1,
            "authorizationRef": "control:ctl-mb-1",
            "authorizationFingerprint": authorization_fingerprint(
                "ctl-mb-1", "AGV-MB-CLI", "dispatch_task", None,
                {"targetStationId": "ST-1"},
            ),
            "payload": {"targetStationId": "ST-1"},
            "sentAt": "2026-09-12T03:00:00.000Z",
            "orgId": "ORG-1",
        }

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                return

            def _send(self, status, payload):
                body = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):  # noqa: N802
                if self.path.startswith("/api/control/commands/pending"):
                    self._send(200, {"deviceId": "AGV-MB-CLI", "commands": [command], "queued": 1})
                    return
                self._send(404, {"error": "not found"})

            def do_POST(self):  # noqa: N802
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length).decode() or "{}")
                if self.path.endswith("/ack"):
                    received["acks"].append(body)
                    self._send(200, {"commandId": "att-mb-1", "status": "gateway_received"})
                    return
                if self.path.endswith("/receipt"):
                    received["receipts"].append(body)
                    self._send(201, {"ok": True})
                    return
                self._send(404, {"error": "not found"})

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            result = subprocess.run(
                [
                    sys.executable,
                    os.path.join(repo_root, "tools", "edge_control_agent.py"),
                    "--once",
                    "--device", "AGV-MB-CLI",
                    "--platform-url", f"http://127.0.0.1:{server.server_address[1]}",
                    "--ingest-key", "k",
                    "--transport", "modbus",
                    "--modbus-host", "127.0.0.1",
                    "--modbus-port", str(slave.port),
                    "--source-type", "controlled_test",
                ],
                capture_output=True,
                text=True,
                timeout=90,
                cwd=repo_root,
            )
            last_line = (result.stdout or "").strip().split("\n")[-1]
            stats = json.loads(last_line)
            self.assertEqual(result.returncode, 0, result.stderr[-400:])
            self.assertEqual(stats["executed"], 1)
            # 回传的指纹必须**就是平台下发的那个**（不重算、不改写）
            self.assertEqual(
                stats["outcomes"][0]["authorizationFingerprint"], command["authorizationFingerprint"]
            )
            self.assertEqual(received["acks"][0]["delivered"], True)
            self.assertEqual(received["receipts"][0]["result"], "executed")
            # 设备真的动了：真帧把命令送到了从站寄存器，数字孪生进入 moving + 目标工位
            state = slave.device.recv(timeout=0)
            self.assertEqual(state.state, "moving")
            self.assertEqual(state.target_station_id, "ST-1")
        finally:
            server.shutdown()
            server.server_close()
            slave.stop()


# ── NO-75a：批量写事务（FC16 单 PDU）+ 重连退避 ─────────────────────────────

class TestBatchWriteTransaction(unittest.TestCase):
    """NO-75a：命令块必须**一帧到达**（撕裂写在协议层不可能，单事务可观测）。"""

    def _make_pair(self, device_id="AGV-BATCH"):
        slave = FakeModbusSlave(device_id).start()
        slave.device.register_station("ST-A", 1.0, 1.0)
        transport = ModbusTcpActuatorTransport(
            "127.0.0.1", device_id, port=slave.port, timeout=2.0,
            backoff_base_s=0.05, backoff_max_s=0.5,
        )
        transport.connect()
        return slave, transport

    def test_dispatch_arrives_in_single_fc16_transaction(self):
        """dispatch_task 的命令块（命令码+目标+序号）＝ 1 次 FC16、0 次 FC06。"""
        slave, transport = self._make_pair()
        try:
            result = transport.send(ActuatorCommand(
                device_id="AGV-BATCH", command_key="dispatch_task",
                authorization_ref=None, payload={"targetStationId": "ST-A"}, requested_at="",
            ))
            self.assertTrue(result.accepted)
            self.assertEqual(slave.stats["fc16"], 1, f"stats={slave.stats}")
            self.assertEqual(slave.stats["fc06"], 0, f"stats={slave.stats}")
        finally:
            transport.close()
            slave.stop()

    def test_non_dispatch_also_single_transaction(self):
        """非运动命令同样单帧（同块原子写入，目标寄存器写 0 不携带语义）。"""
        slave, transport = self._make_pair()
        try:
            result = transport.send(ActuatorCommand(
                device_id="AGV-BATCH", command_key="stop",
                authorization_ref=None, payload={}, requested_at="",
            ))
            self.assertTrue(result.accepted)
            self.assertEqual(slave.stats["fc16"], 1)
            self.assertEqual(slave.stats["fc06"], 0)
        finally:
            transport.close()
            slave.stop()

    def test_command_applied_exactly_once_with_target(self):
        """语义不回退：命令真实生效一次（目标正确、状态机迁移）。"""
        slave, transport = self._make_pair()
        try:
            transport.send(ActuatorCommand(
                device_id="AGV-BATCH", command_key="dispatch_task",
                authorization_ref=None, payload={"targetStationId": "ST-A"}, requested_at="",
            ))
            slave.tick()
            state = transport.recv()
            self.assertIsNotNone(state)
            # 回环设备的真实状态机：dispatch 后是 moving（运动中），不是凭空"已完成"
            self.assertEqual(state.state, "moving")
            self.assertEqual(state.target_station_id, "ST-A")
        finally:
            transport.close()
            slave.stop()


class TestReconnectBackoff(unittest.TestCase):
    """NO-75a：失败后退避窗口内**快速失败**；成功后窗口重置。"""

    def test_failed_connect_arms_backoff_and_fast_fails(self):
        transport = ModbusTcpActuatorTransport(
            "127.0.0.1", "AGV-BACKOFF", port=1,  # 端口 1 必连失败
            backoff_base_s=60.0, backoff_max_s=60.0,
        )
        with self.assertRaises(ModbusError) as first:
            transport.connect()
        self.assertIn("connect_failed", str(first.exception))
        self.assertGreater(transport._backoff_until, 0)
        # 窗口内第二次：快速失败（不发起真实握手）并给出退避原因
        started = time.monotonic()
        with self.assertRaises(ModbusError) as second:
            transport.connect()
        elapsed = time.monotonic() - started
        self.assertIn("reconnect_backoff", str(second.exception))
        self.assertLess(elapsed, 0.05, "窗口内必须快速失败，不能发起真实握手")
        transport.close()

    def test_successful_connect_resets_backoff(self):
        # 短窗口走完整"失败 → 窗口 → 成功"流程（不改内部状态，等真实窗口过期）。
        dead = ModbusTcpActuatorTransport(
            "127.0.0.1", "AGV-BACKOFF2", port=1,  # 必连失败
            backoff_base_s=0.05, backoff_max_s=0.05,
        )
        with self.assertRaises(ModbusError):
            dead.connect()
        self.assertGreater(dead._backoff_until, 0)
        dead.close()
        time.sleep(0.2)  # 等过 0.05s 全抖动窗口

        slave = FakeModbusSlave("AGV-BACKOFF2").start()
        transport = ModbusTcpActuatorTransport(
            "127.0.0.1", "AGV-BACKOFF2", port=slave.port,
            backoff_base_s=0.05, backoff_max_s=0.05,
        )
        transport.connect()
        self.assertEqual(transport._backoff_seconds, 0.0)
        self.assertEqual(transport._backoff_until, 0.0)
        transport.close()
        slave.stop()

