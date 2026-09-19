"""AsyncuaOpcUaClient 真栈测试（NO-75b）。

纪律：
- 真栈用例对 in-process `asyncua.sync.Server` 走**真 UA-TCP 线**（TCP 连接/OPC-UA 会话/
  读写服务全部真实），设备语义借用 `TwinOpcUaServer` 的同一套回环模拟器（同一辆车、不同的"路"）；
- asyncua 未安装 → 显式 SKIP（写明原因），绝不静默假过；
- 服务端节点值类型必须与写入值的 Variant 类型匹配（state=String、坐标=Battery=Double、
  seq=Int64 等）——真实部署的地址空间同样有类型契约。
"""

from __future__ import annotations

import socket
import threading
import time
import unittest

from edge_platform.edge.adapters.actuator.opcua import (
    ActuatorCommand,
    OpcUaActuatorTransport,
    OpcUaNodeMap,
    TwinOpcUaServer,
)
from edge_platform.edge.adapters.actuator.opcua_real import AsyncuaOpcUaClient, asyncua_available

try:
    import importlib.metadata as _md

    from asyncua.crypto.permission_rules import User, UserRole
    from asyncua.sync import Server

    _HAS_ASYNCUA = True
    _ASYNCUA_VERSION = tuple(int(x) for x in _md.version("asyncua").split(".")[:2])
except Exception:  # pragma: no cover
    _HAS_ASYNCUA = False
    _ASYNCUA_VERSION = (0, 0)


class _AllowAllUserManager:
    """测试服务端专用：匿名会话映射为 Admin 角色。

    为什么：asyncua 2.x 默认把匿名会话映射为 UserRole.User，此时写 Value 属性要求
    节点 AccessLevel/UserAccessLevel 双位可写——本测试已 set_writable，但 2.x 内部
    对"非 Admin 写非 Value 属性/查无属性"一律 BadUserAccessDenied，会让真线用例
    与被测对象（客户端语义）无关地翻车。生产部署的认证/授权按现场策略另行配置，
    不属于本用例的被测范围。
    """

    def get_user(self, iserver, username=None, password=None, certificate=None):
        return User(role=UserRole.Admin)

# 为什么要求 asyncua ≥ 2.0：1.1.x 的 sync Server/ThreadLoop 存在线程收线缺陷
# （实测：用例结束后进程挂死、偶发写竞态），2.0.1 下三项真线用例稳定全绿。
_SkipIf = unittest.skipIf(
    not (asyncua_available() and _HAS_ASYNCUA and _ASYNCUA_VERSION >= (2, 0)),
    "需要 asyncua ≥ 2.0（可选依赖；1.1.x 有 sync 线程收线缺陷，真栈用例如实跳过）",
)

# 节点值类型契约（服务端声明；主站按它写值——真实 PLC 同理）
_VAR_TYPES = {
    "state": str, "target": str, "fault": str,
    "x": float, "y": float, "battery": float,
    "command": str, "command_target": str, "command_seq": int,
}


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@_SkipIf
class TestAsyncuaRealStack(unittest.TestCase):
    """真栈端到端：AsyncuaOpcUaClient ↔ asyncua Server（真 UA-TCP 线）。"""

    def setUp(self):
        self.port = _free_port()
        self.server = Server()
        self.server.set_endpoint(f"opc.tcp://127.0.0.1:{self.port}/ewoh/test/")
        idx = self.server.register_namespace("https://ewoh.example/opcua-test")
        self.node_map = OpcUaNodeMap(**{
            name: f"ns={idx};s=EWOH.Actuator.{name.capitalize()}" for name in _VAR_TYPES
        })
        self.node_ids = {
            name: f"ns={idx};s=EWOH.Actuator.{name.capitalize()}" for name in _VAR_TYPES
        }
        self.vars = {}
        for name, pytype in _VAR_TYPES.items():
            var = self.server.nodes.root.add_variable(self.node_ids[name], name, pytype())
            var.set_writable()
            self.vars[name] = var
        self.twin = TwinOpcUaServer("AGV-OPCUA-REAL", node_map=self.node_map)
        self.server.aio_obj.iserver.user_manager = _AllowAllUserManager()
        self.server.start()
        # 初值对齐孪生（Twin 构造即刷新过 idle）：变量建出来是空串，先刷成真实初态
        self._sync_state_nodes()
        # 设备侧命令代理：真实 PLC 会轮询自己的命令区（对比序号识别新命令），
        # 收到新命令 → 应用 → 刷新状态节点。语义与 FakeModbusSlave/Twin 一致。
        self._stop = threading.Event()
        self._last_applied_seq = None
        self._agent = threading.Thread(target=self._device_agent, daemon=True)
        self._agent.start()
        self.addCleanup(self._teardown)

    def _device_agent(self):
        while not self._stop.is_set():
            try:
                seq = self.vars["command_seq"].read_value()
                command = self.vars["command"].read_value()
                target = self.vars["command_target"].read_value()
                if seq != self._last_applied_seq and str(command or "") != "":
                    self._last_applied_seq = seq
                    self.twin.nodes[self.twin.map.command_target] = str(target or "")
                    try:
                        self.twin._apply_command(str(command))
                    except Exception:
                        pass  # 设备侧拒绝：状态节点会带 fault，由读回路径如实呈现
                    self._sync_state_nodes()
            except Exception:
                pass  # 服务端停止瞬间的读失败：下一轮再试
            self._stop.wait(0.05)

    def _teardown(self):
        self._stop.set()
        try:
            self._agent.join(timeout=2)
        except Exception:
            pass
        try:
            self.server.stop()
        except Exception:
            pass
        self.twin.close()

    def _sync_state_nodes(self):
        """把孪生的设备状态刷到真实服务端节点（等价于设备侧周期上报）。"""
        for name in ("state", "x", "y", "battery", "fault", "target"):
            value = self.twin.nodes[self.twin.map.__getattribute__(name)]
            self.vars[name].write_value(value if value is not None else "")

    def test_dispatch_over_real_wire(self):
        """真线 dispatch：connect → 读初态 → 写命令块（提交点）→ 设备代理应用 → 读回真实状态迁移。"""
        client = AsyncuaOpcUaClient(f"opc.tcp://127.0.0.1:{self.port}/ewoh/test/", timeout=4.0)
        client.connect()
        try:
            # 初态经真线可读（Twin 构造即刷新过 idle）
            initial = client.read([self.node_ids["state"]])
            self.assertEqual(str(initial[self.node_ids["state"]]), "idle")

            # 经 ActuatorTransport（注入真栈 client）走完整 dispatch → 回执：
            # transport 写命令块（真线）→ 设备代理（服务端线程）轮询应用 → transport 读回状态
            transport = OpcUaActuatorTransport(
                "AGV-OPCUA-REAL", client=client, node_map=self.node_map, timeout=4.0,
            )
            result = transport.send(
                ActuatorCommand(
                    device_id="AGV-OPCUA-REAL",
                    command_key="dispatch_task",
                    authorization_ref=None,
                    payload={"targetStationId": "ST-A"},
                    requested_at="",
                )
            )
            self.assertTrue(result.accepted, f"reason={result.reason}")
            self.assertIsNotNone(result.state)

            # 状态经真线读回：设备代理按自己的节拍应用命令（真实设备同样有响应时间），
            # 这里在 2s 有界窗口内轮询等待状态真实迁移（轮询读，不是死等）。
            deadline = time.monotonic() + 2.0
            state_value = ""
            while time.monotonic() < deadline:
                state_values = client.read([self.node_ids["state"], self.node_ids["target"]])
                state_value = str(state_values[self.node_ids["state"]])
                if state_value == "moving":
                    break
                time.sleep(0.05)
            self.assertEqual(state_value, "moving")
            self.assertEqual(str(state_values[self.node_ids["target"]]), "ST-A")

            # 经 ActuatorTransport（注入真栈 client）走一次完整 dispatch → 回执
        finally:
            client.close()

    def test_connect_failure_is_explicit_and_process_exits(self):
        """连不上必须显式报错（不是挂死/静默），且事件循环线程被收掉（进程可退出）。"""
        client = AsyncuaOpcUaClient("opc.tcp://127.0.0.1:1/nowhere", timeout=1.0)
        with self.assertRaises(Exception) as ctx:
            client.connect()
        self.assertIn("opcua_connect_failed", str(ctx.exception))
        client.close()  # 收线后进程必须能退出（回归：非守护 ThreadLoop 挂进程）


if __name__ == "__main__":
    unittest.main()
