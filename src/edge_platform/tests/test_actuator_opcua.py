"""OPC-UA 执行机构 Transport 骨架测试（真实协议栈未接入；孪生假服务端验证语义）。

钉住的不变量：
  1. **fail-closed**：未注入 client → `send()` 显式拒绝（`opcua_client_not_configured`）、
     `recv()` 返回 None；**绝不静默降级**到孪生假从站，也不返回"看起来空闲"的默认状态；
  2. **对外声明如实**：`REAL_STACK_INTEGRATED=False`、`transport_status()` 的 status 落在
     封闭词表内、未接入时 name 明确写 "opcua-not-integrated"——不许看起来像已支持真机；
  3. **与 Modbus 路径语义一致**：同一命令序列在两条 `ActuatorTransport` 上跑，
     状态迁移/目标工位/坐标逐项相同（契约级一致，不是字节级一致）；
  4. **提交点语义**：只写参数节点不触发动作，写命令节点才触发；
  5. **契约边界**：未知命令/未知节点/读失败都显式，不伪造；
  6. **上层判定与传输无关**：换 OPC-UA 后高危命令没授权号 → 一个节点都不写。

纯标准库 unittest。
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform.edge.adapters.actuator.adapter import ActuatorAdapter  # noqa: E402
from edge_platform.edge.adapters.actuator.modbus import (  # noqa: E402
    FakeModbusSlave,
    ModbusTcpActuatorTransport,
)
from edge_platform.edge.adapters.actuator.opcua import (  # noqa: E402
    INTEGRATION_STATUSES,
    REAL_STACK_INTEGRATED,
    TRANSPORT_KIND,
    OpcUaActuatorTransport,
    OpcUaClient,
    OpcUaClientError,
    TwinOpcUaClient,
    TwinOpcUaServer,
)
from edge_platform.edge.adapters.actuator.protocol import (  # noqa: E402
    ActuatorCommand,
)


def make_twin(device_id="AGV-OP-1", **kwargs):
    """孪生服务端 + 骨架传输（显式注入孪生客户端——不是默认、不是回落）。"""
    server = TwinOpcUaServer(device_id, **kwargs)
    transport = OpcUaActuatorTransport(device_id, client=TwinOpcUaClient(server))
    return server, transport


class OpcUaTwinSemanticsTest(unittest.TestCase):
    """孪生服务端上的命令 → 状态 → 回执路径。"""

    def test_dispatch_pause_resume_stop_round_trip(self):
        server, transport = make_twin()
        server.device.register_station("ST-1", 3.0, 0.0)
        sent = transport.send(
            ActuatorCommand(
                device_id="AGV-OP-1",
                command_key="dispatch_task",
                authorization_ref="control:CR-1",
                payload={"targetStationId": "ST-1"},
            )
        )
        self.assertTrue(sent.accepted, sent.reason)
        self.assertEqual(sent.state.state, "moving")
        self.assertEqual(sent.state.target_station_id, "ST-1")
        self.assertAlmostEqual(sent.state.battery_pct, 88.0, places=1)

        server.tick()
        mid = transport.recv()
        self.assertEqual(mid.state, "moving")
        self.assertGreater(mid.x, 0.0)

        self.assertTrue(transport.send(ActuatorCommand(device_id="AGV-OP-1", command_key="pause")).accepted)
        self.assertEqual(transport.recv().state, "paused")
        self.assertTrue(transport.send(ActuatorCommand(device_id="AGV-OP-1", command_key="resume")).accepted)
        self.assertEqual(transport.recv().state, "moving")

        server.tick()
        server.tick()
        self.assertEqual(transport.recv().state, "arrived")

        self.assertTrue(transport.send(ActuatorCommand(device_id="AGV-OP-1", command_key="stop")).accepted)
        final = transport.recv()
        self.assertEqual(final.state, "idle")
        self.assertIsNone(final.target_station_id)

    def test_dispatch_without_target_is_rejected(self):
        server, transport = make_twin()
        before = list(server.writes)
        result = transport.send(ActuatorCommand(device_id="AGV-OP-1", command_key="dispatch_task", payload={}))
        self.assertFalse(result.accepted)
        self.assertEqual(result.reason, "target_station_required")
        self.assertEqual(server.writes, before, "缺目标工位不得写任何节点")
        self.assertEqual(server.device.recv(timeout=0).state, "idle")

    def test_unknown_station_is_dispatched_then_faults_on_tick(self):
        """与 Modbus 的诚实差异：OPC-UA 节点值能带工位号真值，未知工位号不会被从站提前拒绝，
        而是真下发、由设备在下一 tick 报 TARGET_STATION_UNKNOWN——更接近真机（接单后才知不可达）。"""
        server, transport = make_twin()
        sent = transport.send(
            ActuatorCommand(
                device_id="AGV-OP-1",
                command_key="dispatch_task",
                payload={"targetStationId": "ST-UNKNOWN"},
            )
        )
        self.assertTrue(sent.accepted)
        state = server.tick()
        self.assertEqual(state.state, "fault")
        self.assertEqual(state.fault_code, "TARGET_STATION_UNKNOWN")
        # 故障必须能被读回，不得静默停在原地
        self.assertEqual(transport.recv().fault_code, "TARGET_STATION_UNKNOWN")


class OpcUaModbusParityTest(unittest.TestCase):
    """同一 ActuatorTransport 契约：OPC-UA 与 Modbus 两条路径语义一致。"""

    def test_command_sequence_is_semantically_identical(self):
        twin_server, opcua = make_twin("AGV-PARITY")
        twin_server.device.register_station("ST-1", 3.0, 0.0)
        modbus_slave = FakeModbusSlave("AGV-PARITY", port=0).start()
        modbus_slave.device.register_station("ST-1", 3.0, 0.0)
        modbus = ModbusTcpActuatorTransport("127.0.0.1", "AGV-PARITY", port=modbus_slave.port, timeout=2.0)
        try:
            dispatch = dict(command_key="dispatch_task", payload={"targetStationId": "ST-1"})
            for transport in (opcua, modbus):
                result = transport.send(ActuatorCommand(device_id="AGV-PARITY", **dispatch))
                self.assertTrue(result.accepted, result.reason)

            steps = ["dispatch", "tick", "pause", "resume", "tick", "tick"]
            for step in steps:
                if step == "tick":
                    twin_server.tick()
                    modbus_slave.tick()
                elif step == "pause":
                    opcua.send(ActuatorCommand(device_id="AGV-PARITY", command_key="pause"))
                    modbus.send(ActuatorCommand(device_id="AGV-PARITY", command_key="pause"))
                elif step == "resume":
                    opcua.send(ActuatorCommand(device_id="AGV-PARITY", command_key="resume"))
                    modbus.send(ActuatorCommand(device_id="AGV-PARITY", command_key="resume"))
                a, b = modbus.recv(), opcua.recv()  # 同一步骤下两条路径的状态必须逐项相同
                self.assertEqual(a.state, b.state, f"step={step}")
                self.assertEqual(a.target_station_id, b.target_station_id, f"step={step}")
                self.assertAlmostEqual(a.x or 0.0, b.x or 0.0, places=3, msg=f"step={step}")
                self.assertAlmostEqual(a.y or 0.0, b.y or 0.0, places=3, msg=f"step={step}")
                self.assertAlmostEqual(a.battery_pct or 0.0, b.battery_pct or 0.0, places=1, msg=f"step={step}")
        finally:
            modbus.close()
            modbus_slave.stop()
            opcua.close()


class OpcUaFailClosedTest(unittest.TestCase):
    """未接入真栈时必须显式拒绝，不许看起来像已支持真机。"""

    def test_no_client_refuses_and_never_falls_back_to_twin(self):
        transport = OpcUaActuatorTransport("AGV-OP-NC")
        result = transport.send(ActuatorCommand(device_id="AGV-OP-NC", command_key="stop"))
        self.assertFalse(result.accepted)
        self.assertEqual(result.reason, "opcua_client_not_configured")
        self.assertIsNone(result.state, "未接入不得返回任何状态（哪怕是默认空闲）")
        self.assertIsNone(transport.recv())

    def test_transport_status_declares_not_integrated(self):
        self.assertFalse(REAL_STACK_INTEGRATED, "真实 OPC-UA 栈尚未接入，常量必须为 False")
        self.assertEqual(TRANSPORT_KIND, "opcua")
        transport = OpcUaActuatorTransport("AGV-OP-NC")
        status = transport.transport_status()
        self.assertFalse(status["real_stack_integrated"])
        self.assertEqual(status["status"], "not_integrated")
        self.assertIn(status["status"], INTEGRATION_STATUSES)
        self.assertEqual(status["name"], "opcua-not-integrated")
        self.assertIn("未接入", status["note"])

    def test_twin_status_is_honest_about_being_a_twin(self):
        _, transport = make_twin()
        status = transport.transport_status()
        self.assertFalse(status["real_stack_integrated"], "孪生可跑 ≠ 真栈已接入")
        self.assertEqual(status["status"], "digital_twin")
        self.assertEqual(status["client_kind"], "digital_twin")
        self.assertEqual(transport.name, "opcua-twin")
        self.assertIn(status["status"], INTEGRATION_STATUSES)

    def test_read_failure_returns_none_not_fabricated_state(self):
        class _FailingClient(OpcUaClient):
            name = "failing"
            kind = "external_client"

            def read(self, node_ids):
                raise OpcUaClientError("no_communication")

            def write(self, node_id, value):
                raise OpcUaClientError("write_denied")

            def close(self):
                return None

        transport = OpcUaActuatorTransport("AGV-OP-ERR", client=_FailingClient())
        self.assertIsNone(transport.recv(), "读失败必须返回 None，不得伪造状态")
        result = transport.send(ActuatorCommand(device_id="AGV-OP-ERR", command_key="stop"))
        self.assertFalse(result.accepted)
        self.assertIn("opcua_error", result.reason)

    def test_closed_transport_reports_closed(self):
        _, transport = make_twin()
        transport.close()
        result = transport.send(ActuatorCommand(device_id="AGV-OP-1", command_key="stop"))
        self.assertFalse(result.accepted)
        self.assertEqual(result.reason, "transport_closed")
        self.assertIsNone(transport.recv())


class OpcUaNodeContractTest(unittest.TestCase):
    """节点地址空间契约：未知节点/只读节点/提交点必须显式。"""

    def test_unknown_node_raises_instead_of_returning_none(self):
        server, transport = make_twin()
        with self.assertRaises(OpcUaClientError) as ctx:
            server.read(["ns=2;s=EWOH.Nope"])
        self.assertIn("unknown_node", str(ctx.exception))
        with self.assertRaises(OpcUaClientError):
            server.write("ns=2;s=EWOH.Nope", 1)

    def test_state_node_is_read_only(self):
        server, _ = make_twin()
        with self.assertRaises(OpcUaClientError) as ctx:
            server.write(server.map.state, "moving")
        self.assertIn("read_only_node", str(ctx.exception))

    def test_command_node_is_the_commit_point(self):
        server, transport = make_twin()
        server.device.register_station("ST-1", 2.0, 0.0)
        # 只写参数（目标/序号）不得触发动作——命令节点才是提交点
        transport.client.write(transport.map.command_target, "ST-1")
        transport.client.write(transport.map.command_seq, 1)
        self.assertEqual(server.device.recv(timeout=0).state, "idle")
        transport.client.write(transport.map.command, "dispatch_task")
        self.assertEqual(server.device.recv(timeout=0).state, "moving")

    def test_unknown_command_key_rejected_by_transport(self):
        _, transport = make_twin()
        result = transport.send(ActuatorCommand(device_id="AGV-OP-1", command_key="teleport"))
        self.assertFalse(result.accepted)
        self.assertEqual(result.reason, "unknown_command_key")

    def test_illegal_command_on_twin_is_refused(self):
        server, _ = make_twin()
        with self.assertRaises(OpcUaClientError) as ctx:
            server.write(server.map.command, "teleport")
        self.assertIn("illegal_command", str(ctx.exception))


class OpcUaAdapterBoundaryTest(unittest.TestCase):
    """授权判定与传输实现无关：换 OPC-UA 后 fail-closed 顺序不变。"""

    def test_high_risk_command_without_authorization_writes_nothing(self):
        server, transport = make_twin("AGV-OP-2")
        server.device.register_station("ST-1", 1.0, 0.0)
        adapter = ActuatorAdapter(
            "AGV-OP-2", source_type="controlled_test", transport=transport, tick_on_read=False
        )
        adapter.start()
        before = list(server.writes)
        denied = adapter.send_command("dispatch_task", None, {"targetStationId": "ST-1"})
        self.assertFalse(denied["accepted"])
        self.assertEqual(denied["reason"], "authorization_required")
        self.assertEqual(server.writes, before, "被拒绝的命令不得写任何节点")
        self.assertEqual(server.device.recv(timeout=0).state, "idle")

        allowed = adapter.send_command("dispatch_task", "control:CR-1", {"targetStationId": "ST-1"})
        self.assertTrue(allowed["accepted"], allowed.get("reason"))
        self.assertEqual(allowed["state"]["state"], "moving")
        self.assertEqual(allowed["transport"], "opcua-twin")
        self.assertEqual(adapter.device_info()["transport"], "opcua-twin")


if __name__ == "__main__":
    unittest.main()
