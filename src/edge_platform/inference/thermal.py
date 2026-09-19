"""电机热积累估计器（负载×时间积分推算温度）——行业对标缺口「热积累模拟」。

为什么是"估计器"而不是"传感器读数"
--------------------------------
NXP1 线协议 TELEMETRY 帧不含温度字段（9×i16 姿态/力矩 + assist u8 + battery u8，
见 adapters/ny_exo_a1/protocol.py parse_telemetry_payload），真机也不上报电机温度。
行业惯例（外骨骼电机/电池热监控）在无温度传感时由负载×时间推算：本模块实现
一阶集总参数（first-order lumped-capacitance）热模型::

    dT/dt = k_heat · torque² − (T − T_ambient) / tau_cool

- ``k_heat``：焦耳热系数（°C/(s·Nm²)）——电阻热近似与力矩平方成正比；
- ``tau_cool``：散热时间常数（s）；稳态温升 dT_ss = k_heat · tau_cool · torque²。

诚实边界（不可掩盖）：系数是**假设值，待真机标定**。估计值只用于风险判定
（rules.THERMAL_ACCUMULATION），不是测量事实——事件 trigger.condition 必须带
模型版本与估计值，消费方按"模型推算"对待（与 docs/reviews/2026-09-14 行业对标
「热积累模拟：可从负载+时间推算」对应）。

对偶校验（仿真对抗）
--------------------
tools/exo_fleet_sim.py 的设备物理仿真用同族模型产生"真值"，边缘估计器只能从
torque 帧流推算；E2E 断言估计值在容差内跟踪真值——估计器与真值使用独立参数，
参数漂移会在容差断言上暴露。

纯 Python 标准库实现。
"""

from __future__ import annotations

import math

#: 模型版本（写入事件 trigger，供平台侧审计"这次判定用的是哪版模型"）。
MODEL_VERSION = "thermal-v1"

#: 缺省系数（假设值，待真机标定——含义见模块 docstring）。
DEFAULT_K_HEAT = 0.00105  # °C/(s·Nm²)：τ=20Nm 连续 → 稳态温升 ≈ 50°C
DEFAULT_TAU_COOL_SEC = 120.0  # s
DEFAULT_AMBIENT_C = 25.0  # °C


class ThermalEstimator:
    """单设备电机热积累估计器（逐帧积分，状态自持）。

    dt 语义：dt=None（首帧）不积分只建基线；dt>0 正常积分；dt 超过 dt_cap_sec
    的间隔（离线恢复/补传乱序）按上限积分——长时间缺帧不允许瞬间"冷却到底"
    或瞬间"加热到顶"，两次缺帧之间的物理过程本来就不可见。
    dt<0（时间戳倒退/补传乱序）按 0 处理：不积分、不变温（不伪造物理）。
    """

    def __init__(
        self,
        k_heat: float = DEFAULT_K_HEAT,
        tau_cool_sec: float = DEFAULT_TAU_COOL_SEC,
        ambient_c: float = DEFAULT_AMBIENT_C,
        dt_cap_sec: float = 5.0,
        initial_c: float | None = None,
    ):
        if k_heat < 0 or tau_cool_sec <= 0 or dt_cap_sec <= 0:
            raise ValueError("k_heat/dt_cap_sec 必须非负且 tau_cool_sec/dt_cap_sec 必须为正")
        self.k_heat = float(k_heat)
        self.tau_cool_sec = float(tau_cool_sec)
        self.ambient_c = float(ambient_c)
        self.dt_cap_sec = float(dt_cap_sec)
        self.temperature_c = float(initial_c) if initial_c is not None else float(ambient_c)

    def reset(self) -> None:
        """回到环境温度（设备换电/重启等物理状态重置场景）。"""
        self.temperature_c = self.ambient_c

    def update(self, torque_nm: float | None, dt_sec: float | None) -> float:
        """推进一个时间步，返回更新后的温度估计（°C）。

        torque_nm=None（字段缺失/哨兵 0x7FFF）按 0 处理：无力矩数据时不臆造加热，
        但散热照常进行（物理上电机仍在与环境换热）。
        torque_nm 为 NaN/Inf 等非有限值同样按 0 处理：一次坏读数不得让估计器
        永久变 NaN、静默解除 THERMAL_ACCUMULATION 武装（nan>=阈值 恒 False）。
        """
        if dt_sec is None:
            return self.temperature_c  # 首帧：只建基线
        if dt_sec < 0:
            return self.temperature_c  # 时间倒退：不积分（不伪造物理）
        dt = min(float(dt_sec), self.dt_cap_sec)
        torque = 0.0
        if torque_nm is not None:
            try:
                candidate = float(torque_nm)
                torque = candidate if math.isfinite(candidate) and candidate > 0 else 0.0
            except (TypeError, ValueError):
                torque = 0.0
        heat = self.k_heat * torque * torque
        cooling = (self.temperature_c - self.ambient_c) / self.tau_cool_sec
        # 显式欧拉一步；dt 被 dt_cap 约束，稳定性满足（dt << tau_cool）
        self.temperature_c += (heat - cooling) * dt
        return self.temperature_c


def steady_state_c(torque_nm: float, k_heat: float = DEFAULT_K_HEAT,
                   tau_cool_sec: float = DEFAULT_TAU_COOL_SEC,
                   ambient_c: float = DEFAULT_AMBIENT_C) -> float:
    """给定持续力矩下的稳态温度（解析解，供测试与标定对照）。"""
    return float(ambient_c) + float(k_heat) * float(tau_cool_sec) * float(torque_nm) ** 2


__all__ = ["ThermalEstimator", "steady_state_c", "MODEL_VERSION",
           "DEFAULT_K_HEAT", "DEFAULT_TAU_COOL_SEC", "DEFAULT_AMBIENT_C"]
