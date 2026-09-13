"""OPC-UA 执行机构 Transport **骨架**（真实协议栈未接入；接入点见下）。

现状（必须如实说清，不许看起来像已支持真机）
--------------------------------------------
- 本模块提供 `OpcUaActuatorTransport`：一个实现 `ActuatorTransport` 契约的 OPC-UA
  **传输骨架**。它把「命令 → 写命令节点 → 读状态节点」的语义固定下来，但**线上部分**
  交给构造期**显式注入**的 `OpcUaClient` 完成；
- **真实 OPC-UA 二进制栈（UA-TCP / 安全通道 / 会话与服务集）没有接入**，本模块也
  **不打算**手写它——那是数万行且极易引入安全缺陷的工程量（安全策略、证书、加密
  一旦自己实现错了，比不接更危险）。接入方式是：用现场选定的 OPC-UA SDK
  （open62541 / asyncua / 厂商栈）实现 `OpcUaClient` 的 `read`/`write`/`close`
  三个方法，注入 `OpcUaActuatorTransport(client=...)` 即完成接入；
  上层（`ActuatorAdapter` 的授权判定顺序、统一状态帧、回执）**一行都不用改**。
- 本模块自带的 `TwinOpcUaServer` + `TwinOpcUaClient` 是**数字孪生假服务端**：进程内
  即可跑通「写命令节点 → 设备动作 → 读状态节点」整条语义，用于单测/演示/现场调试对端。
  它**不是真机**，也**不会被自动选中**（见下面的 fail-closed）。

fail-closed（"未接入"必须写在对外可见处）
------------------------------------------
- 未注入 client 时，`send()` 一律拒绝（reason=`opcua_client_not_configured`），
  `recv()` 返回 `None`——**绝不静默降级到孪生假从站**，也绝不返回一个"看起来空闲"
  的默认状态（那会把"没接上"伪装成"设备正常待命"）；
- `transport_status()` 与 `name` 把接入状态写在对外可见处：`kind="opcua"`、
  `real_stack_integrated=False`（含义：**本仓库未内置**真实栈）、
  `status ∈ {not_integrated, digital_twin, external_client}`，且 `name` 分别取
  `opcua-not-integrated` / `opcua-twin` / `opcua`——孪生不会伪装成真栈。
  任何"OPC-UA 已支持真机"的表述都必须先改 `REAL_STACK_INTEGRATED` 常量，而不是改注释。

与 Modbus 路径的关系
--------------------
两条路径在 `ActuatorTransport` 契约上**语义一致**（同一命令 → 同一状态迁移 →
同一 `ActuatorState` 字段），差异只在**线上表示**，且差异是真实存在的：
- Modbus 寄存器是 16 位整数，工位号只能带哈希（真值留在主站侧）；
  OPC-UA 节点值本身支持字符串，因此这里**直接写工位号真值**，无需哈希；
  连带一个诚实差异：Modbus 侧"未知工位号"在从站层就被拒（哈希查不到），而这里会真下发，
  由设备在下一 tick 报 `TARGET_STATION_UNKNOWN` 故障——后者更接近真机（设备接单后才发现
  目标不可达）。本模块**保留**这一差异，不为了"看起来和 Modbus 一样"而人为加一层校验。
- Modbus 坐标/电量按 ×10 定点化；OPC-UA 节点值原生浮点，不做定点换算。
`ActuatorAdapter` 不关心这些差异——它只认 `TransportResult` / `ActuatorState`。

纯 Python 标准库实现，不引入任何第三方依赖。
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any

from edge_platform.edge.adapters.actuator.protocol import (
    ACTUATOR_COMMANDS,
    ACTUATOR_STATES,
    ActuatorCommand,
    ActuatorState,
    ActuatorTransport,
    LoopbackActuatorTransport,
    TransportResult,
)

#: 对外声明的传输类型标识（device_info / health / 控制面按此展示）。
TRANSPORT_KIND = "opcua"

#: **本仓库**是否内置了真实 OPC-UA 栈（UA-TCP 二进制 + 会话）。恒为 False：
#: 本仓库没有、也不打算手写它，接入靠现场注入 OpcUaClient（那种情况在
#: `transport_status()["status"]` 上体现为 `external_client`，但"内置真栈"仍是否）。
#: 任何"OPC-UA 真机已支持"的说法都与此处冲突，属不实声明。
REAL_STACK_INTEGRATED = False

#: 接入状态词表（封闭）。
INTEGRATION_STATUSES = ("not_integrated", "digital_twin", "external_client")

#: 接入说明（对外展示，用于让运维一眼看清"现在连的是不是真机"）。
INTEGRATION_NOTE = (
    "真实 OPC-UA 栈（UA-TCP 二进制 + 安全通道 + 会话/服务集）未接入。"
    "接入点：实现 OpcUaClient 的 read/write/close（可用 open62541/asyncua/厂商 SDK），"
    "注入 OpcUaActuatorTransport(client=...)。"
    "TwinOpcUaServer/TwinOpcUaClient 仅为数字孪生测试替身，不会被自动选中。"
)


class OpcUaClientError(RuntimeError):
    """客户端层错误（节点不存在/读失败/写失败/质量不可用）。

    实现方**必须**在"读不到""质量差""写失败"时抛本异常，
    **不得**返回 None / 默认值冒充正常读数（那是本仓库最高纪律禁止的伪造）。
    """


class OpcUaClient(ABC):
    """真实 OPC-UA 栈的注入点（本仓库不含任何具体真栈实现，Twin 只是测试替身）。

    现场实现方（open62541 / asyncua / 厂商 SDK）只需满足三个方法：

    - `read(node_ids) -> dict[str, Any]`：读一组节点。返回**每个请求节点**的映射；
      读不到 / 质量非 Good 时抛 `OpcUaClientError`——不许用 None 冒充"值就是空"；
    - `write(node_id, value) -> None`：写单节点；失败抛 `OpcUaClientError`；
    - `close() -> None`：幂等释放会话/连接。

    另需声明两个自述属性，供 `transport_status()` 如实对外展示：
    - `name`：实现名（如 `"open62541"`）；
    - `kind`：`"digital_twin"`（本仓库孪生）或 `"external_client"`（现场真栈）。
    """

    name: str = "abstract"
    kind: str = "external_client"

    @abstractmethod
    def read(self, node_ids: list[str]) -> dict[str, Any]:  # pragma: no cover - 接口
        raise NotImplementedError

    @abstractmethod
    def write(self, node_id: str, value: Any) -> None:  # pragma: no cover - 接口
        raise NotImplementedError

    def close(self) -> None:  # pragma: no cover - 接口
        raise NotImplementedError


@dataclass
class OpcUaNodeMap:
    """节点地址契约（主站与孪生服务端共用同一份，改一处两侧同时生效）。

    对照 Modbus 的 `RegisterMap`：那里是 16 位寄存器地址，这里是节点 NodeId。
    """

    state: str = "ns=2;s=EWOH.Actuator.State"
    x: str = "ns=2;s=EWOH.Actuator.X"
    y: str = "ns=2;s=EWOH.Actuator.Y"
    battery: str = "ns=2;s=EWOH.Actuator.Battery"
    fault: str = "ns=2;s=EWOH.Actuator.Fault"
    target: str = "ns=2;s=EWOH.Actuator.Target"
    # 下行：命令键（提交点）、命令目标工位、命令请求序号（从站据此识别"新命令"）
    command: str = "ns=2;s=EWOH.Actuator.Command"
    command_target: str = "ns=2;s=EWOH.Actuator.CommandTarget"
    command_seq: str = "ns=2;s=EWOH.Actuator.CommandSeq"

    def read_nodes(self) -> list[str]:
        """状态读回所需的节点集合（顺序与 `OpcUaActuatorTransport.recv` 一致）。"""
        return [self.state, self.x, self.y, self.battery, self.fault, self.target]

    def all_nodes(self) -> list[str]:
        return self.read_nodes() + [self.command, self.command_target, self.command_seq]


DEFAULT_NODE_MAP = OpcUaNodeMap()


def _transport_name(client: OpcUaClient | None) -> str:
    """按注入的客户端决定传输对外名。

    刻意**不**统一叫 "opcua"：与 Modbus 路径不同（那条路的 MBAP 帧是真的，叫
    "modbus-tcp" 名副其实），本模块的线上部分**没有真栈**，所以孪生必须把
    "twin" 写在名字里——`ActuatorAdapter.device_info()/health()` 直接展示这个名字，
    运维不该在设备清单里看到 "opcua" 就以为已经接上真机。
    """
    if client is None:
        return "opcua-not-integrated"
    return "opcua-twin" if getattr(client, "kind", "") == "digital_twin" else "opcua"


class TwinOpcUaServer:
    """数字孪生 OPC-UA 假服务端：真的是"节点读写"语义，假的是设备本身。

    与 `FakeModbusSlave` 的分工：Modbus 假从站把"真帧"当卖点，本孪生把"真节点读写"
    当卖点，但两者背后的"车"都是 `LoopbackActuatorTransport`（同一套确定性语义），
    因此两条传输路径在 `ActuatorTransport` 契约上逐项可比。

    诚实边界：孪生**不做 UA-TCP 二进制帧、不做会话/安全通道**——那正是未接入的部分。
    """

    def __init__(
        self,
        device_id: str = "AGV-OPCUA-1",
        *,
        node_map: OpcUaNodeMap | None = None,
        device: LoopbackActuatorTransport | None = None,
    ):
        self.device_id = str(device_id)
        self.map = node_map or DEFAULT_NODE_MAP
        self.device = device or LoopbackActuatorTransport(
            device_id, x=0.0, y=0.0, battery_pct=88.0, step_m=1.0
        )
        self.nodes: dict[str, Any] = {node: None for node in self.map.all_nodes()}
        #: 客户端写留痕（现场调试可与真栈对账；不静默）
        self.writes: list[dict] = []
        self._last_seq: int | None = None
        self._closed = False
        self._refresh()

    # ---- 节点地址空间 ----
    def read(self, node_ids: list[str]) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for node_id in node_ids:
            if node_id not in self.nodes:
                # 未知节点显式报错：绝不返回 None 让调用方误以为"值就是空"
                raise OpcUaClientError(f"unknown_node:{node_id}")
            out[node_id] = self.nodes[node_id]
        return out

    def write(self, node_id: str, value: Any) -> None:
        if node_id not in self.nodes:
            raise OpcUaClientError(f"unknown_node:{node_id}")
        if node_id == self.map.state:
            raise OpcUaClientError(f"read_only_node:{node_id}")  # 状态由设备写，客户端不得直写
        self.writes.append({"node": node_id, "value": value})
        if node_id == self.map.command:
            self._apply_command(value)  # 提交点：命令节点最后写
        elif node_id == self.map.command_seq:
            self._last_seq = value
            self.nodes[node_id] = value
        else:
            self.nodes[node_id] = value

    def close(self) -> None:
        self._closed = True

    # ---- 设备语义（数字孪生）----
    def _apply_command(self, key: Any) -> None:
        command_key = str(key or "")
        if command_key not in ACTUATOR_COMMANDS:
            raise OpcUaClientError(f"illegal_command:{key!r}")
        payload: dict = {}
        if command_key == "dispatch_task":
            target = str(self.nodes.get(self.map.command_target) or "").strip()
            if target == "":
                raise OpcUaClientError("target_station_required")
            payload["targetStationId"] = target
        self.device.send(
            ActuatorCommand(
                device_id=self.device_id,
                command_key=command_key,
                authorization_ref=None,  # 授权判定在 Adapter 层；孪生不做授权决策
                payload=payload,
                requested_at="",
            )
        )
        self._refresh()

    def _refresh(self) -> None:
        state = self.device.recv(timeout=0)
        if state is None:  # pragma: no cover - 回环模拟器恒有状态
            return
        self.nodes[self.map.state] = state.state
        self.nodes[self.map.x] = state.x
        self.nodes[self.map.y] = state.y
        self.nodes[self.map.battery] = state.battery_pct
        self.nodes[self.map.fault] = state.fault_code
        self.nodes[self.map.target] = state.target_station_id

    def tick(self) -> ActuatorState:
        """推进一个仿真步（供测试/演示显式调用；孪生不后台自跑）。"""
        state = self.device.tick()
        self._refresh()
        return state


class TwinOpcUaClient(OpcUaClient):
    """数字孪生假服务端的进程内客户端（测试/演示用；**不是**真栈）。"""

    name = "twin-opcua"
    kind = "digital_twin"

    def __init__(self, server: TwinOpcUaServer):
        self.server = server

    def read(self, node_ids: list[str]) -> dict[str, Any]:
        return self.server.read(node_ids)

    def write(self, node_id: str, value: Any) -> None:
        self.server.write(node_id, value)

    def close(self) -> None:
        self.server.close()


class OpcUaActuatorTransport(ActuatorTransport):
    """OPC-UA 执行机构传输骨架（线上部分由注入的 `OpcUaClient` 完成）。

    参数：
    - `device_id`：设备号（与平台台账同号）；
    - `client`：注入的 OPC-UA 客户端。**不传即"未接入"**：`send()` 显式拒绝、
      `recv()` 返回 None，绝不回落到孪生假从站；
    - `node_map`：节点契约（现场地址空间不一致时改这里，不改逻辑）；
    - `timeout`：预留给真栈的读超时（孪生为进程内调用，不阻塞）。
    """

    def __init__(
        self,
        device_id: str,
        *,
        client: OpcUaClient | None = None,
        node_map: OpcUaNodeMap | None = None,
        timeout: float = 2.0,
    ):
        super().__init__(name=_transport_name(client))
        self.device_id = str(device_id)
        self.client = client
        self.map = node_map or DEFAULT_NODE_MAP
        self.timeout = float(timeout)
        self._command_seq = 0
        self._closed = False

    # ---- 接入状态（对外声明；这里不含任何"已支持真机"的暗示）----
    @property
    def integration_status(self) -> str:
        """`INTEGRATION_STATUSES` 之一。未注入 client → `not_integrated`。"""
        if self.client is None:
            return "not_integrated"
        return "digital_twin" if getattr(self.client, "kind", "") == "digital_twin" else "external_client"

    def transport_status(self) -> dict:
        """供 device_info/health/控制面展示的接入状态声明。"""
        return {
            "kind": TRANSPORT_KIND,
            "real_stack_integrated": REAL_STACK_INTEGRATED,
            "status": self.integration_status,
            "name": self.name,
            "client": getattr(self.client, "name", None),
            "client_kind": getattr(self.client, "kind", None),
            "note": INTEGRATION_NOTE,
        }

    # ---- ActuatorTransport ----
    def send(self, command: ActuatorCommand) -> TransportResult:
        """把命令写进节点地址空间；设备执行结果由 `recv()` 读回（两件事分开）。"""
        key = str(command.command_key or "")
        if key not in ACTUATOR_COMMANDS:
            return TransportResult(accepted=False, reason="unknown_command_key", state=self._safe_state())
        if self.client is None:
            # fail-closed：没配真实客户端就显式拒绝，绝不落到孪生假从站
            return TransportResult(
                accepted=False, reason="opcua_client_not_configured", state=None
            )
        if self._closed:
            return TransportResult(accepted=False, reason="transport_closed", state=self._safe_state())
        try:
            if key == "dispatch_task":
                target = str((command.payload or {}).get("targetStationId") or "").strip()
                if target == "":
                    return TransportResult(
                        accepted=False, reason="target_station_required", state=self._safe_state()
                    )
                # OPC-UA 节点值支持字符串 → 直接写工位号真值（不像 Modbus 只能带哈希）
                self.client.write(self.map.command_target, target)
            self._command_seq += 1
            # 顺序同 Modbus：先写参数、最后写命令节点（命令节点是"提交点"），
            # 避免从站读到"命令已到但参数还没到"的半成品状态。
            self.client.write(self.map.command_seq, self._command_seq)
            self.client.write(self.map.command, key)
        except OpcUaClientError as exc:
            return TransportResult(accepted=False, reason=f"opcua_error:{exc}", state=self._safe_state())
        except Exception as exc:  # noqa: BLE001 - 真栈可能抛 SDK 私有异常：显式转成原因，不吞
            return TransportResult(
                accepted=False, reason=f"opcua_error:{type(exc).__name__}", state=self._safe_state()
            )
        return TransportResult(accepted=True, reason=None, state=self.recv())

    def recv(self, timeout: float | None = None) -> ActuatorState | None:
        """读回设备状态节点。读不到 → 返回 None（**不伪造状态**）。"""
        if self.client is None or self._closed:
            return None
        try:
            values = self.client.read(self.map.read_nodes())
        except OpcUaClientError:
            return None
        except Exception:  # noqa: BLE001 - 真栈 SDK 异常：宁可不给状态，也不给假状态
            return None
        raw_state = str(values.get(self.map.state) or "")
        state = raw_state if raw_state in ACTUATOR_STATES else "unknown"
        return ActuatorState(
            device_id=self.device_id,
            state=state,
            x=values.get(self.map.x),
            y=values.get(self.map.y),
            battery_pct=values.get(self.map.battery),
            current_task_id=None,
            target_station_id=values.get(self.map.target) if state == "moving" else None,
            fault_code=values.get(self.map.fault),
            last_command_key=None,
            last_authorization_ref=None,
            updated_at="",
        )

    def close(self) -> None:
        self._closed = True
        client = self.client
        if client is not None:
            try:
                client.close()
            except Exception:  # noqa: BLE001 - 关闭失败不影响"已关闭"语义，但仍要留痕
                import logging

                logging.getLogger("ewoh.edge.actuator.opcua").warning(
                    "OpcUaActuatorTransport.close(): client.close() 抛错，已忽略（transport 已标记关闭）",
                    exc_info=True,
                )

    def _safe_state(self) -> ActuatorState | None:
        """失败路径上的状态读回：读不到就 None（调用方必须能区分"未知"与"空闲"）。"""
        return self.recv()


__all__ = [
    "DEFAULT_NODE_MAP",
    "INTEGRATION_NOTE",
    "INTEGRATION_STATUSES",
    "OpcUaActuatorTransport",
    "OpcUaClient",
    "OpcUaClientError",
    "OpcUaNodeMap",
    "REAL_STACK_INTEGRATED",
    "TRANSPORT_KIND",
    "TwinOpcUaClient",
    "TwinOpcUaServer",
]
