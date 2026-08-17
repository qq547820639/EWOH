"""统一设备适配层抽象基类。

对应 spec「多传感器适配扩展」：在现有外骨骼适配器与统一适配层契约（身份/心跳/
电量/故障/遥测/缓存补传/安全状态/real/controlled_test/simulated 来源隔离）基础上，
新增摄像头、UWB、MES/工单、环境传感器适配器，均继承本基类。

子类 MUST 实现 start/stop/health/device_info/read_message/reconnect；本基类仅提供
公共属性与未实现方法的 NotImplementedError 桩，便于在统一管理器中按统一契约调度。
纯 Python 标准库实现，不引入任何第三方依赖。
"""


class BaseAdapter:
    """设备适配器抽象基类：定义设备适配器的最小契约。

    device_id 唯一标识设备；source_type ∈ {real, controlled_test, simulated}，
    与真机数据物理/逻辑隔离（spec「来源隔离」）；model/firmware_version 用于
    设备元信息追溯。_running 标识是否已启动采集。
    """

    def __init__(self, device_id, source_type="real", model="", firmware_version=""):
        if source_type not in ("real", "controlled_test", "simulated"):
            raise ValueError(f"source_type 必须为 real/controlled_test/simulated, 实际: {source_type}")
        self.device_id = device_id
        self.source_type = source_type
        self.model = model
        self.firmware_version = firmware_version
        self._running = False
        self._started_at = None
        # R2-ECO-005：背压丢帧可观测——队列满丢弃计数（对齐 ny_exo_a1 基线）。
        self.dropped_frames = 0

    def record_dropped_frame(self, reason="queue_full"):
        """R2-ECO-005：记录一次背压丢帧（计数 + 限频 warning），替代静默 pass。"""
        import logging

        self.dropped_frames += 1
        if self.dropped_frames == 1 or self.dropped_frames % 100 == 0:
            logging.getLogger(__name__).warning(
                "adapter inbox full, dropped frames=%d (device_id=%s, reason=%s)",
                self.dropped_frames,
                self.device_id,
                reason,
            )

    # ---- 生命周期 ----
    def start(self):
        """启动设备采集/连接；子类实现具体逻辑并调用 super().start()。"""
        raise NotImplementedError

    def stop(self):
        """停止设备采集/连接；子类实现具体逻辑并调用 super().stop()。"""
        raise NotImplementedError

    def reconnect(self):
        """尝试重连设备；返回是否成功。"""
        raise NotImplementedError

    # ---- 状态与元信息 ----
    def health(self):
        """返回设备健康状态 dict：{device_id, type, status, source_type, last_seen, ...}。

        status ∈ {online, offline, degraded}。
        """
        raise NotImplementedError

    def health_extras(self):
        """health() 附加字段（R2-ECO-005）：暴露 dropped_frames 供健康页观测背压。"""
        return {"dropped_frames": self.dropped_frames}

    def device_info(self):
        """返回设备元信息 dict：{device_id, type, model, firmware_version, source_type, ...}。"""
        raise NotImplementedError

    # ---- 数据读取 ----
    def read_message(self, timeout=None):
        """读取并返回一条已规范化的统一语义消息 dict；超时返回 None。

        子类负责将厂商原始帧转换为统一语义后再返回（spec「统一语义转换」：
        厂商字段不泄漏到上层业务）。
        """
        raise NotImplementedError
