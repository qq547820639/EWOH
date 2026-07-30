"""设备适配器抽象基类与共享工具。

只读模式声明（受控试点阶段 1 安全红线）：
- 本适配层仅接收设备上行数据（IDENT / HEARTBEAT / TELEMETRY / BACKFILL / FAULT），
  不实现任何平台→设备业务命令。
- 急停、限扭、关节实时控制等安全闭环能力全部归属设备本地控制器，平台不得
  实现任何指向这些能力的写入路径。
- 平台仅允许通过白名单命令 IDENT_REQUEST(0x81) / TIME_SYNC(0x82) 与设备交互，
  且本阶段不实现发送，仅声明。
"""
import abc
import uuid
from datetime import datetime

# 数据质量状态常量
QUALITY_GOOD = "good"
QUALITY_DEGRADED = "degraded"
QUALITY_INVALID = "invalid"
QUALITY_UNKNOWN = "unknown"

# 默认设备型号（具体型号适配器可在自身模块覆盖）
DEVICE_MODEL = "NY-EXO-A1"


def make_record_id():
    """生成 record_id（uuid4 hex，32 字符无连字符），用于遥测/原始帧主键。"""
    return uuid.uuid4().hex


def now_iso():
    """当前 ISO 8601 时间（毫秒精度，本地时区），用于 ingested_at / last_seen。"""
    return datetime.now().astimezone().isoformat(timespec="milliseconds")


class DeviceAdapter(abc.ABC):
    """设备适配器抽象基类。

    子类需实现接收设备上行帧、解码为标准消息、写入持久层并发布到总线。
    不实现任何平台→设备写入命令。
    """

    @abc.abstractmethod
    def start(self):
        """启动适配器（开始接收数据，通常起后台线程）。"""

    @abc.abstractmethod
    def stop(self):
        """停止适配器（关闭连接与资源）。"""

    @abc.abstractmethod
    def health(self):
        """返回适配器健康状态 dict（含 connected/device_id 等）。"""

    @abc.abstractmethod
    def device_info(self):
        """返回当前已学习设备信息 dict（device_id/model/firmware 等）。"""

    @abc.abstractmethod
    def read_message(self):
        """读取一条已解码消息（无数据返回 None），供同步式调用方使用。"""

    @abc.abstractmethod
    def reconnect(self):
        """重连（TCP 由设备主动连接，平台默认不主动重连，子类可覆盖）。"""
