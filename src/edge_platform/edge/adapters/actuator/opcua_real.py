"""AsyncuaOpcUaClient —— 真实 OPC-UA 栈（asyncua）的 `OpcUaClient` 实现（NO-75b）。

选型结论（本轮调研，详见 runbook 与 capability-alignment）：
- asyncua（opcua-asyncio）2.x：纯 Python、LGPLv3+、活跃维护、内置 sync 包装与 Server；
  对比 node-opcua（MIT 但 Node 生态，需跨语言 sidecar）、open62541（C，需原生编译+FFI）、
  Eclipse Milo（Java）——适配成本最低，且 LGPL 以 pip 依赖动态使用（不拷码）与本仓库兼容。
- **可选依赖**：本模块对 asyncua 懒加载。未安装时构造抛 `OpcUaClientError`（原因 =
  `opcua_sdk_unavailable`）——**绝不静默降级到 Twin 假从站**（fail-closed，与骨架同纪律）。
- 线程模型：asyncua.sync 内部自管事件循环线程，三个方法都是阻塞调用，
  与 `ActuatorTransport` 的同步契约天然对齐。

与 Twin 的关系：`TwinOpcUaServer` 是数字孪生假服务端（测试/演示用）；
本类是**真栈客户端**——对真实 OPC-UA 服务器（现场 PLC/网关，或测试里 in-process
起一个 asyncua Server）执行真实的 UA-TCP 会话。两者实现同一个 `OpcUaClient` ABC。
"""

from __future__ import annotations

from typing import Any

from edge_platform.edge.adapters.actuator.opcua import OpcUaClient, OpcUaClientError

try:  # 可选依赖：只在真栈路径 import；stdlib 路径永远不需要它
    from asyncua import ua
    from asyncua.sync import Client as _SyncClient

    _ASYNCUA_AVAILABLE = True
    _IMPORT_ERROR = ""
except Exception as _exc:  # pragma: no cover - 未安装时走不到真栈路径
    _ASYNCUA_AVAILABLE = False
    _IMPORT_ERROR = str(_exc)


def asyncua_available() -> bool:
    """asyncua 是否可导入（测试用：不可用时真栈用例显式 SKIP，绝不静默）。"""
    return _ASYNCUA_AVAILABLE


class AsyncuaOpcUaClient(OpcUaClient):
    """基于 asyncua sync 包装的真实栈客户端（connect/read/write/close）。

    - `read(node_ids)`：一次会话内逐节点 `read_data_value`；Status != Good 或结果缺失
      → 抛 `OpcUaClientError`（不用 None/0 冒充值——原则 7）；
    - `write(node_id, value)`：`write_data_value(Variant)`；服务端拒绝/断连 → 抛错；
    - `close()`：幂等断开会话（断线后再 close 不抛）。
    """

    name = "asyncua"

    def __init__(self, url: str, timeout: float = 4.0):
        if not _ASYNCUA_AVAILABLE:
            raise OpcUaClientError(f"opcua_sdk_unavailable:asyncua not installed ({_IMPORT_ERROR})")
        self.url = str(url)
        self.timeout = float(timeout)
        self.kind = "external_client"
        self._client = _SyncClient(self.url, timeout=self.timeout)

    def connect(self) -> None:
        try:
            self._client.connect()
        except Exception as exc:
            # 连接失败也必须收掉 sync 包装的事件循环线程（ThreadLoop 是**非守护线程**，
            # 不收线 = 进程永远退不出去——实测踩过）。disconnect() 的 finally 会 stop tloop。
            try:
                self._client.disconnect()
            except Exception:
                pass
            raise OpcUaClientError(f"opcua_connect_failed:{type(exc).__name__}") from exc

    def read(self, node_ids: list[str]) -> dict[str, Any]:
        if not self._client:
            raise OpcUaClientError("opcua_not_connected")
        values: dict[str, Any] = {}
        try:
            for node_id in node_ids:
                dv = self._client.get_node(node_id).read_data_value()
                status = getattr(getattr(dv, "status", None), "value", None)
                # StatusCode.Good == 0；非 Good 一律如实报错（不许把 Bad 读成"值就是空"）
                if status is not None and int(status) != 0:
                    raise OpcUaClientError(f"opcua_bad_status:{node_id}:{int(status)}")
                values[node_id] = dv.Value.Value if dv.Value else None
        except OpcUaClientError:
            raise
        except Exception as exc:
            raise OpcUaClientError(f"opcua_read_failed:{type(exc).__name__}") from exc
        return values

    def write(self, node_id: str, value: Any) -> None:
        if not self._client:
            raise OpcUaClientError("opcua_not_connected")
        try:
            node = self._client.get_node(node_id)
            variant_type = self._infer_variant_type(node, value)
            node.write_value(ua.DataValue(ua.Variant(value, variant_type)))
        except OpcUaClientError:
            raise
        except Exception as exc:
            raise OpcUaClientError(f"opcua_write_failed:{type(exc).__name__}") from exc

    def _infer_variant_type(self, node: Any, value: Any) -> int:
        """按节点声明类型写值（宁可多问服务端一次，不猜类型写坏节点）。"""
        try:
            dv = node.read_data_type_as_variant_type()
            return dv
        except Exception:
            # 读不到类型定义时按 Python 类型兜底（真实部署应布好类型定义）
            if isinstance(value, bool):
                return ua.VariantType.Boolean
            if isinstance(value, int):
                return ua.VariantType.Int64
            if isinstance(value, float):
                return ua.VariantType.Double
            return ua.VariantType.String

    def close(self) -> None:
        client = getattr(self, "_client", None)
        if client is None:
            return
        try:
            client.disconnect()
        except Exception:
            # 断线后再 close：释放尽力而为，不把收尾当故障（与 Modbus close 同语义）
            pass
        finally:
            self._client = None


__all__ = ["AsyncuaOpcUaClient", "asyncua_available"]
