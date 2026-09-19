"""热模型参数标定（系统辨识）——「参数能优化就实际优化」的数字化闭环。

为什么需要
----------
``thermal.py`` 的 k_heat / tau_cool 出厂是**假设值，待真机标定**。标定这件事本身
完全可以数字化：给定一段 (torque, dt, temperature) 观测序列，模型

    dT/dt = k_heat · torque² − (T − T_ambient) / tau_cool

对 θ = (k_heat, 1/tau_cool) 是**线性**的（以观测温度代入右端），因此用普通最小
二乘即可闭式求解——不需要任何第三方库。本模块实现该辨识，并用仿真数据自证：
从已知参数的"真值设备"生成序列 → 辨识 → 参数还原误差与跟踪残差量化。

使用纪律（诚实边界）
--------------------
- 辨识质量取决于数据：必须覆盖足够大的 torque 变化范围（否则 k 与 1/tau 不可分），
  样本数与力矩方差有下限校验，不满足时显式失败（不返回漂亮但无据的参数）；
- 拟合优度（max 残差）随结果返回——消费方据此决定是否采信；
- 真机标定时把真机观测序列喂进来即可，流程与仿真数据完全一致。

输出接续：辨识出的参数可经 `EWOH_THERMAL_K_HEAT` / `EWOH_THERMAL_TAU_COOL_SEC` /
`EWOH_THERMAL_AMBIENT_C`（runtime/dependencies.build_rule_engine 读取）注入热规则，
替换出厂假设值。
"""

from __future__ import annotations

from dataclasses import dataclass

from .thermal import ThermalEstimator


@dataclass
class CalibrationResult:
    k_heat: float  # °C/(s·Nm²)
    tau_cool_sec: float  # s
    max_abs_residual_c: float  # 拟合段内单步温度残差最大值（°C）
    sample_count: int
    torque_span_nm: float  # 观测力矩跨度（可辨识性依据）

    @property
    def model_version(self) -> str:
        return "thermal-v1"


def _solve_2x2(a11: float, a12: float, a21: float, a22: float, b1: float, b2: float) -> tuple[float, float] | None:
    det = a11 * a22 - a12 * a21
    if abs(det) < 1e-12:
        return None
    return ((b1 * a22 - b2 * a12) / det, (a11 * b2 - a21 * b1) / det)


def calibrate(
    torque_series: list[float],
    dt_series: list[float],
    temperature_series: list[float],
    ambient_c: float,
    min_samples: int = 20,
) -> CalibrationResult:
    """从观测序列辨识 (k_heat, tau_cool_sec)。

    序列语义：temperature_series[i] 是在 torque_series[i] 作用 dt_series[i] 秒
    **之后**的温度（第 i 步的观测结果）。回归方程：
        (T[i] - T[i-1]) / dt[i] = k·torque[i]² − (T[i-1] − ambient)/tau
    以观测温度代入右端（显式欧拉口径，与估计器一致）。

    失败条件（显式异常，不返回无据参数）：样本不足 / 力矩无变化（k 不可辨识）/
    回归退化 / tau 非正。
    """
    n = min(len(torque_series), len(dt_series), len(temperature_series))
    if n - 1 < min_samples:
        raise ValueError(f"标定样本不足: {max(n - 1, 0)} 步 < {min_samples}")
    span = max(torque_series[:n]) - min(torque_series[:n])
    if span < 1e-6:
        raise ValueError("力矩无变化：k_heat 与 1/tau_cool 不可辨识（需要负载变化）")

    # OLS：y = θ1·x1 + θ2·x2，x1=torque²，x2=-(T-amb)
    s11 = s12 = s22 = b1 = b2 = 0.0
    used = 0
    for i in range(1, n):
        dt = dt_series[i]
        if dt <= 0:
            continue
        y = (temperature_series[i] - temperature_series[i - 1]) / dt
        x1 = max(float(torque_series[i]), 0.0) ** 2
        x2 = -(temperature_series[i - 1] - ambient_c)
        s11 += x1 * x1
        s12 += x1 * x2
        s22 += x2 * x2
        b1 += x1 * y
        b2 += x2 * y
        used += 1
    if used < min_samples:
        raise ValueError(f"有效样本不足: {used} < {min_samples}")
    solution = _solve_2x2(s11, s12, s12, s22, b1, b2)
    if solution is None:
        raise ValueError("回归退化（设计矩阵奇异）：数据不足以辨识两参数")
    k_heat, inv_tau = solution
    tau_cool = 1.0 / inv_tau if inv_tau > 0 else float("nan")
    if k_heat < 0 or not (tau_cool == tau_cool) or tau_cool <= 0:
        raise ValueError(
            f"辨识结果非物理（k_heat={k_heat:.3e}, tau_cool={tau_cool:.1f}s）："
            "数据质量不足或模型不适配，拒绝输出"
        )
    return CalibrationResult(
        k_heat=k_heat,
        tau_cool_sec=tau_cool,
        max_abs_residual_c=_max_residual(torque_series, dt_series, temperature_series, ambient_c, k_heat, tau_cool, n),
        sample_count=used,
        torque_span_nm=span,
    )


def _max_residual(
    torque_series: list[float], dt_series: list[float], temperature_series: list[float],
    ambient_c: float, k_heat: float, tau_cool_sec: float, n: int,
) -> float:
    worst = 0.0
    for i in range(1, n):
        dt = dt_series[i]
        if dt <= 0:
            continue
        predicted = temperature_series[i - 1] + (
            k_heat * max(torque_series[i], 0.0) ** 2
            - (temperature_series[i - 1] - ambient_c) / tau_cool_sec
        ) * dt
        worst = max(worst, abs(predicted - temperature_series[i]))
    return worst


def calibrate_and_track(
    torque_series: list[float],
    dt_series: list[float],
    temperature_series: list[float],
    ambient_c: float,
    track_torque: list[float],
    track_dt: list[float],
    track_temperature: list[float],
    min_samples: int = 20,
) -> dict:
    """辨识 + 跟踪对照：用辨识参数构建估计器，在**另一段**观测序列上跟踪真值。

    track_* 段是与标定段独立（时间上延续）的真值观测；返回
    track_max_abs_error_c = "标定后估计器 vs 真值"的最大偏差——标定有效性的
    直接证据（消费方据此决定参数是否可注入热规则）。
    """
    result = calibrate(torque_series, dt_series, temperature_series, ambient_c, min_samples)
    tracker = ThermalEstimator(
        k_heat=result.k_heat,
        tau_cool_sec=result.tau_cool_sec,
        ambient_c=ambient_c,
        initial_c=temperature_series[-1] if temperature_series else ambient_c,
    )
    worst_error = 0.0
    m = min(len(track_torque), len(track_dt), len(track_temperature))
    for i in range(m):
        estimate = tracker.update(track_torque[i], track_dt[i])
        worst_error = max(worst_error, abs(estimate - track_temperature[i]))
    return {
        "k_heat": result.k_heat,
        "tau_cool_sec": result.tau_cool_sec,
        "max_abs_residual_c": result.max_abs_residual_c,
        "track_max_abs_error_c": worst_error,
        "sample_count": result.sample_count,
        "torque_span_nm": result.torque_span_nm,
    }


__all__ = ["calibrate", "calibrate_and_track", "CalibrationResult"]
