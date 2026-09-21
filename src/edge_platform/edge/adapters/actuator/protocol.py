"""执行机构（AGV/PLC）统一协议与回环模拟器（NO-59b）。

对应愿景「设备、产线、工位、物料**和执行机构**是工厂的执行层」与决策原则 11
（没有真实硬件时建设硬件抽象、数字孪生和可替换模拟设备）。

为什么需要这一层：
- 平台侧已有控制命令域（`POST /api/control/requests`：设备 + commandKeys + 幂等键，
  高危命令必须走审批；`/:id/commands` 下发、`/:id/receipts` 回收执），
  但**边缘侧没有任何执行机构通道**——真实 AGV/PLC 接不进来，命令也落不到设备上。
- 本模块定义边缘侧协议面：`ActuatorTransport`（真实协议实现的接口）+
  `LoopbackActuatorTransport`（确定性回环模拟器 → 无硬件也能跑通"命令→状态→回执"）。

真实协议实现路径（现场接入时新增 Transport 子类，不改上层）：
- Modbus/TCP、OPC-UA：`send()` 写寄存器/节点，`recv()` 读状态；
- 厂商 AGV HTTP/MQTT API：`send()` 发任务单，`recv()` 取车辆状态推送；
- 现场总线（CAN/Profinet）：由网关进程转换为本接口的字节/JSON 帧。
"""

from __future__ import annotations

import hashlib
import hmac
import json
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

# ── 统一状态词表（封闭；页面/上游按此判定，不允许厂商私有状态泄漏）──────────
ACTUATOR_STATES = ("idle", "moving", "arrived", "paused", "fault", "offline")

# ── 命令词表（封闭）────────────────────────────────────────────────────────
# 高危命令（会让人机共享空间里的设备动起来 / 解除安全停机）必须有平台授权号；
# `stop` 例外：**安全动作永远不被授权链卡住**（见 adapter.py 的判定顺序）。
ACTUATOR_COMMANDS = (
    "dispatch_task",
    "pause",
    "resume",
    "return_to_dock",
    "stop",
    "clear_fault",
)
ACTUATOR_HIGH_RISK_COMMANDS = ("dispatch_task", "resume", "clear_fault")
ACTUATOR_SAFETY_COMMANDS = ("stop",)

#: 授权号前缀白名单：平台侧控制请求 / 审批 / 方案 / 任务号（规范身份引用）。
AUTHORIZATION_REF_PREFIXES = ("control:", "approval:", "plan:", "task:")

#: 下行投递优先级（NO-62b）：数字越小越先投递；未登记命令键 → UNKNOWN_COMMAND_PRIORITY。
#: 与平台侧 `ewoh-spark-app/shared/actuator.ts` 的 ACTUATOR_COMMAND_PRIORITY 逐项对账
#: （`shared/actuator.spec.ts` 直接读本文件比对）。
#: 为什么平台排序还不够：平台返回窗口受 limit 限制，安全动作会被排队命令挤出窗口；
#: 平台已按优先级排序，边缘侧再排一次是**纵深防御**——顺序不一致时上报
#: `platform_order_violation`，绝不静默接受一个"急停排在搬运后面"的投递顺序。
ACTUATOR_COMMAND_PRIORITY = {
    "stop": 0,
    "pause": 1,
    "return_to_dock": 2,
    "clear_fault": 3,
    "resume": 4,
    "dispatch_task": 5,
}

#: 未登记命令键的优先级（大数 = 最后投递；不是 0，未知不能插队）。
UNKNOWN_COMMAND_PRIORITY = 99

#: 授权范围指纹算法标识（与平台共享实现，见 shared/actuator.ts）。
AUTHORIZATION_FINGERPRINT_ALGO = "fnv1a64:v1"


def command_priority(command_key: Any) -> int:
    """取命令键的投递优先级（未知键 → UNKNOWN_COMMAND_PRIORITY）。"""
    return ACTUATOR_COMMAND_PRIORITY.get(str(command_key or "").strip(), UNKNOWN_COMMAND_PRIORITY)


def canonical_json(value: Any) -> str:
    """规范化 JSON（键递归排序、无空白）——与 TS `canonicalJson` 逐字符一致。"""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)


def fnv1a64_hex(text: str) -> str:
    """FNV-1a 64 位（小写十六进制，16 字符）；对 UTF-8 字节计算，与 TS 侧一致。"""
    hash_value = 0xCBF29CE484222325
    prime = 0x100000001B3
    mask = 0xFFFFFFFFFFFFFFFF
    for byte in text.encode("utf-8"):
        hash_value ^= byte
        hash_value = (hash_value * prime) & mask
    return f"{hash_value:016x}"


def authorization_fingerprint(
    request_id: Any,
    device_id: Any,
    command_key: Any,
    approval_instance_id: Any = None,
    payload: Any = None,
) -> str:
    """计算授权范围指纹（与平台同算法；缺失项按空串/None 参与，不抛异常）。"""
    material = "|".join(
        [
            AUTHORIZATION_FINGERPRINT_ALGO,
            str(request_id or ""),
            str(device_id or ""),
            str(command_key or ""),
            str(approval_instance_id or ""),
            canonical_json(payload),
        ]
    )
    return fnv1a64_hex(material)


#: NO-65a：签名指纹（v2）前缀与算法标识（与平台 `shared/actuator.ts` 逐项一致）。
AUTHORIZATION_FINGERPRINT_ALGO_V2 = "hmac-sha256:v2"
AUTHORIZATION_FINGERPRINT_V2_PREFIX = AUTHORIZATION_FINGERPRINT_ALGO_V2 + ":"


def authorization_fingerprint_material(
    request_id: Any,
    device_id: Any,
    command_key: Any,
    approval_instance_id: Any = None,
    payload: Any = None,
) -> str:
    """v2 签名的规范材料（与 TS `authorizationFingerprintMaterial` 同序同域）。"""
    return "|".join(
        [
            "sha256",
            str(request_id or ""),
            str(device_id or ""),
            str(command_key or ""),
            str(approval_instance_id or ""),
            canonical_json(payload),
        ]
    )


def authorization_fingerprint_v2(
    request_id: Any,
    device_id: Any,
    command_key: Any,
    approval_instance_id: Any = None,
    payload: Any = None,
    secret: Any = "",
) -> str:
    """计算 v2 签名指纹（HMAC-SHA256，截断 128 位十六进制）。空密钥显式报错，不签。"""
    key = str(secret or "").strip()
    if key == "":
        raise ValueError("authorization_fingerprint_v2: 密钥为空（不得用空密钥签名）")
    material = authorization_fingerprint_material(
        request_id, device_id, command_key, approval_instance_id, payload
    )
    digest = hmac.new(key.encode("utf-8"), material.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{AUTHORIZATION_FINGERPRINT_V2_PREFIX}{digest[:32]}"


def is_signed_authorization_fingerprint(value: Any) -> bool:
    """是否为 v2（签名）指纹。"""
    return str(value or "").startswith(AUTHORIZATION_FINGERPRINT_V2_PREFIX)


def verify_authorization_fingerprint(
    fingerprint: Any,
    *,
    request_id: Any,
    device_id: Any,
    command_key: Any,
    approval_instance_id: Any = None,
    payload: Any = None,
    secret: Any = "",
    expected_scheme: Any = None,
    scope_present: bool = True,
) -> tuple[bool, str | None]:
    """按**已下发指纹的方案**复核签名/一致性。

    返回 `(ok, reason)`；`reason` 属于封闭词表：
      - `fingerprint_signature_invalid`：签名不符（内容/范围被改写，或密钥不一致）；
      - `fingerprint_signature_missing_scope`：平台发了签名指纹却没给可重建的授权范围；
      - `fingerprint_secret_missing`：本机没有密钥，无法验证签名（**不假装验过**）；
      - `fingerprint_mismatch`：v1（一致性）指纹不符。
    诚实边界：本机无密钥时**不拒绝**投递（否则现场漏配即全线停摆），但如实返回原因，
    由调用方写进 ack/回执留痕（平台上可见）。

    `approval_instance_id is None` **不是**"缺范围"（NO-68b 修复）：
    免审批命令（`pause` / `stop` / `return_to_dock` …）本来就没有审批实例号，
    平台侧 `String(scope.approvalInstanceId ?? "")` 与本侧 `str(approval_instance_id or "")`
    都把缺失项算成**空串**，材料因此**完全可重建**。此前把"无审批实例"当成"范围不可重建"
    直接返回 `fingerprint_signature_missing_scope`，导致一旦两侧配好
    `EWOH_CONTROL_FINGERPRINT_SECRET`（即推荐的生产姿态），**全部免审批命令——包括
    安全停机 `stop`——都会被边缘拒绝投递**，与"stop 永不受审批/配额约束且投递优先级最高"
    的安全不变量直接冲突。
    真正"范围不可重建"的判据是**平台有没有下发 `authorizationScope`**，
    由调用方通过 `scope_present` 如实告知。
    """
    value = str(fingerprint or "").strip()
    if value == "":
        return True, None  # 未携带指纹（老版本平台）→ 由平台侧负责，本机不臆断
    if is_signed_authorization_fingerprint(value):
        key = str(secret or "").strip()
        if key == "":
            return False, "fingerprint_secret_missing"
        if not scope_present:
            return False, "fingerprint_signature_missing_scope"
        expected = authorization_fingerprint_v2(
            request_id, device_id, command_key, approval_instance_id, payload, key
        )
        return (expected == value), (None if expected == value else "fingerprint_signature_invalid")
    # v1 一致性指纹（无密钥）：只能发现偶然漂移。
    expected_v1 = authorization_fingerprint(
        request_id, device_id, command_key, approval_instance_id, payload
    )
    return (expected_v1 == value), (None if expected_v1 == value else "fingerprint_mismatch")


def authorization_ref_valid(ref: Any) -> bool:
    """授权号形状校验：非空前缀 + 非空标识（不做存在性校验——那是平台侧的事）。"""
    value = str(ref or "").strip()
    if value == "":
        return False
    lowered = value.lower()
    return any(
        lowered.startswith(prefix) and value[len(prefix):].strip() != ""
        for prefix in AUTHORIZATION_REF_PREFIXES
    )


@dataclass
class ActuatorCommand:
    """一条下发给执行机构的命令（已归一化；厂商字段在 Transport 内消化）。"""

    device_id: str
    command_key: str
    authorization_ref: str | None = None
    payload: dict = field(default_factory=dict)
    requested_at: str = ""

    def to_dict(self) -> dict:
        return {
            "device_id": self.device_id,
            "command_key": self.command_key,
            "authorization_ref": self.authorization_ref,
            "payload": dict(self.payload),
            "requested_at": self.requested_at,
        }


@dataclass
class ActuatorState:
    """执行机构统一状态（`read_message()` 输出的核心字段）。"""

    device_id: str
    state: str = "idle"
    x: float | None = None
    y: float | None = None
    battery_pct: float | None = None
    current_task_id: str | None = None
    target_station_id: str | None = None
    fault_code: str | None = None
    last_command_key: str | None = None
    last_authorization_ref: str | None = None
    updated_at: str = ""

    def to_dict(self) -> dict:
        return {
            "device_id": self.device_id,
            "state": self.state,
            "x": self.x,
            "y": self.y,
            "battery_pct": self.battery_pct,
            "current_task_id": self.current_task_id,
            "target_station_id": self.target_station_id,
            "fault_code": self.fault_code,
            "last_command_key": self.last_command_key,
            "last_authorization_ref": self.last_authorization_ref,
            "updated_at": self.updated_at,
        }


@dataclass
class TransportResult:
    """Transport 层结果：accepted=False 时 reason 必填（不许静默失败）。"""

    accepted: bool
    reason: str | None = None
    state: ActuatorState | None = None

    def to_dict(self) -> dict:
        return {
            "accepted": self.accepted,
            "reason": self.reason,
            "state": self.state.to_dict() if self.state else None,
        }


@dataclass
class ActuatorTransport:
    """真实协议实现的接口面（Modbus/OPC-UA/厂商 API/网关字节流都实现它）。

    约定：
    - `send(command)` 只做"把命令交给设备"，**不做授权判定**（判定在 Adapter 层，
      这样真实实现不会各自漏判）；
    - `recv(timeout)` 返回当前状态帧；超时返回 None（不伪造状态）；
    - `close()` 幂等。
    """

    name: str = "abstract"

    def send(self, command: ActuatorCommand) -> TransportResult:  # pragma: no cover - 接口
        raise NotImplementedError

    def recv(self, timeout: float | None = None) -> ActuatorState | None:  # pragma: no cover
        raise NotImplementedError

    def close(self) -> None:  # pragma: no cover - 接口
        raise NotImplementedError


class LoopbackActuatorTransport(ActuatorTransport):
    """确定性回环模拟器：无硬件也能验证"命令 → 状态迁移 → 回执"整条链。

    行为（全部确定性，便于单测/演示；无随机数、无真实时钟依赖）：
    - `dispatch_task`：进入 `moving`，按 `step_m` 每 tick 朝目标工位移动；
      到达（距离 ≤ step）→ `arrived`、`current_task_id` 置为任务号；
    - `pause`/`resume`：`moving` ↔ `paused`（paused 时 tick 不移动）；
    - `return_to_dock`：朝 (0,0) 移动，到达 → `idle`；
    - `stop`：立即 `idle`（安全停机，任何时候都允许，且清空目标）；
    - `clear_fault`：清除故障回到 `idle`；
    - 电量：每 tick 消耗 `battery_drain_pct_per_tick`；低于 `low_battery_pct` 自动 `fault`
      + `fault_code=LOW_BATTERY`（真实车辆同样会自停，模拟器不美化）。
    - `inject_fault(code)`：注入故障供测试/演示（页面必须显示原因）。
    """

    def __init__(
        self,
        device_id: str,
        *,
        now_fn: Callable[[], str] | None = None,
        x: float = 0.0,
        y: float = 0.0,
        battery_pct: float = 100.0,
        step_m: float = 1.0,
        battery_drain_pct_per_tick: float = 0.1,
        low_battery_pct: float = 5.0,
    ):
        super().__init__(name="loopback")
        self.device_id = device_id
        self._now = now_fn or (lambda: "")
        self.step_m = max(float(step_m), 0.0)
        self.battery_drain_pct_per_tick = max(float(battery_drain_pct_per_tick), 0.0)
        self.low_battery_pct = float(low_battery_pct)
        self.station_coords: dict[str, tuple[float, float]] = {"DOCK": (0.0, 0.0)}
        self.state = ActuatorState(
            device_id=device_id,
            state="idle",
            x=float(x),
            y=float(y),
            battery_pct=float(battery_pct),
            updated_at=self._now(),
        )
        self.command_log: list[dict] = []
        self._closed = False

    # ---- 供测试/演示使用 ----
    def register_station(self, station_id: str, x: float, y: float) -> None:
        self.station_coords[station_id] = (float(x), float(y))

    def inject_fault(self, code: str) -> None:
        self.state.state = "fault"
        self.state.fault_code = str(code)
        self.state.updated_at = self._now()

    # ---- ActuatorTransport ----
    def send(self, command: ActuatorCommand) -> TransportResult:
        if self._closed:
            return TransportResult(accepted=False, reason="transport_closed", state=self.state)
        key = command.command_key
        if key == "dispatch_task":
            target = str(command.payload.get("targetStationId") or "").strip()
            if target == "":
                return TransportResult(accepted=False, reason="target_station_required", state=self.state)
            self.state.target_station_id = target
            self.state.current_task_id = command.payload.get("taskId") or self.state.current_task_id
            self.state.last_command_key = key
            self.state.last_authorization_ref = command.authorization_ref
            self.state.state = "moving"
        elif key == "pause":
            if self.state.state != "moving":
                return TransportResult(accepted=False, reason="not_moving", state=self.state)
            self.state.state = "paused"
            self.state.last_command_key = key
        elif key == "resume":
            if self.state.state != "paused":
                return TransportResult(accepted=False, reason="not_paused", state=self.state)
            self.state.state = "moving"
            self.state.last_command_key = key
            self.state.last_authorization_ref = command.authorization_ref
        elif key == "return_to_dock":
            self.state.target_station_id = "DOCK"
            self.state.current_task_id = None
            self.state.state = "moving"
            self.state.last_command_key = key
        elif key == "stop":
            self.state.state = "idle"
            self.state.target_station_id = None
            self.state.last_command_key = key
        elif key == "clear_fault":
            if self.state.state != "fault":
                return TransportResult(accepted=False, reason="no_active_fault", state=self.state)
            self.state.state = "idle"
            self.state.fault_code = None
            self.state.last_command_key = key
            self.state.last_authorization_ref = command.authorization_ref
        else:  # pragma: no cover - Adapter 层已拦未知命令（双保险）
            return TransportResult(accepted=False, reason="unknown_command_key", state=self.state)
        self.state.updated_at = self._now()
        self.command_log.append(
            {
                "command_key": key,
                "authorization_ref": command.authorization_ref,
                "at": self.state.updated_at,
                "state": self.state.state,
            }
        )
        return TransportResult(accepted=True, state=self.state)

    def recv(self, timeout: float | None = None) -> ActuatorState | None:
        return self.state

    def close(self) -> None:
        self._closed = True
        self.state.state = "offline"
        self.state.updated_at = self._now()

    # ---- 时间推进（由适配器读取循环/测试显式调用；不用后台线程）----
    def tick(self) -> ActuatorState:
        """推进一个仿真步：按当前状态移动/耗尽电量。返回推进后的状态。"""
        if self.state.state == "moving" and self.state.target_station_id:
            target = self.station_coords.get(self.state.target_station_id)
            if target is None:
                # 目标工位没有坐标 → 显式故障（不猜位置、不静默停在原地）
                self.state.state = "fault"
                self.state.fault_code = "TARGET_STATION_UNKNOWN"
            else:
                cx, cy = float(self.state.x or 0.0), float(self.state.y or 0.0)
                dx, dy = target[0] - cx, target[1] - cy
                distance = (dx * dx + dy * dy) ** 0.5
                if distance <= self.step_m or distance == 0:
                    self.state.x, self.state.y = target
                    self.state.state = "arrived"
                    self.state.target_station_id = None
                else:
                    ratio = self.step_m / distance
                    self.state.x = round(cx + dx * ratio, 3)
                    self.state.y = round(cy + dy * ratio, 3)
        if self.state.battery_pct is not None and self.battery_drain_pct_per_tick > 0:
            self.state.battery_pct = round(max(0.0, self.state.battery_pct - self.battery_drain_pct_per_tick), 3)
            if self.state.battery_pct <= self.low_battery_pct and self.state.state not in ("fault", "offline"):
                self.state.state = "fault"
                self.state.fault_code = "LOW_BATTERY"
                self.state.target_station_id = None
        self.state.updated_at = self._now()
        return self.state
