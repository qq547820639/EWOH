"""thermal_calib 系统辨识单测——「参数能优化就实际优化」的数字化证据。

- 仿真真值（已知 k/tau 的 ThermalEstimator 生成序列）→ 辨识 → 参数还原误差量化；
- 标定后估计器在**独立跟踪段**上的最大偏差量化（标定有效性的直接证据）；
- 退化数据（样本不足 / 力矩无变化 / 非物理解）显式拒绝——不返回漂亮但无据的参数。
"""

import math
import unittest

from edge_platform.inference.thermal import ThermalEstimator
from edge_platform.inference.thermal_calib import calibrate, calibrate_and_track

AMBIENT = 25.0
TRUE_K = 0.00105
TRUE_TAU = 120.0


def _gen_truth(torque_by_step, dt=1.0, seed_ambient=AMBIENT):
    """已知参数真值设备：生成 (torque, dt, temperature) 观测序列。"""
    truth = ThermalEstimator(k_heat=TRUE_K, tau_cool_sec=TRUE_TAU, ambient_c=seed_ambient)
    torque_out, dt_out, temp_out = [], [], []
    for torque in torque_by_step:
        t0 = truth.temperature_c
        temp = truth.update(torque, dt)
        torque_out.append(torque)
        dt_out.append(dt)
        temp_out.append(temp)
        _ = t0
    return torque_out, dt_out, temp_out


class ThermalCalibrationTest(unittest.TestCase):
    def test_recovers_known_params_from_simulated_truth(self):
        """占空比负载序列 → 辨识 → 参数还原（k 误差 ≤3%、tau 误差 ≤5%）。"""
        pattern = [30.0] * 40 + [2.0] * 20 + [20.0] * 40 + [5.0] * 20 + [35.0] * 40
        torque, dt, temp = _gen_truth(pattern)
        result = calibrate(torque, dt, temp, AMBIENT)
        self.assertLess(abs(result.k_heat - TRUE_K) / TRUE_K, 0.03, f"k 还原误差过大: {result.k_heat}")
        self.assertLess(abs(result.tau_cool_sec - TRUE_TAU) / TRUE_TAU, 0.05, f"tau 还原误差过大: {result.tau_cool_sec}")
        self.assertLess(result.max_abs_residual_c, 0.5)

    def test_calibrated_estimator_tracks_holdout_tightly(self):
        """标定段之外（保持段）的跟踪最大偏差 ≤ 1°C（参数可注入的证据）。"""
        calib_pattern = [30.0] * 40 + [2.0] * 20 + [20.0] * 40 + [5.0] * 20 + [35.0] * 40
        track_pattern = [10.0] * 30 + [28.0] * 30 + [0.0] * 30
        torque, dt, temp = _gen_truth(calib_pattern)
        track_t, track_d, track_temp = _gen_truth(track_pattern)
        # 跟踪段真值要衔接标定段末温度（同一设备连续运转）
        bridge = ThermalEstimator(k_heat=TRUE_K, tau_cool_sec=TRUE_TAU, ambient_c=AMBIENT,
                                  initial_c=temp[-1])
        track_temp = [bridge.update(t, d) for t, d in zip(track_t, track_d)]
        out = calibrate_and_track(torque, dt, temp, AMBIENT, track_t, track_d, track_temp)
        self.assertLess(out["track_max_abs_error_c"], 1.0,
                        f"标定后跟踪偏差过大: {out}")

    def test_rejects_flat_torque(self):
        """力矩无变化 → k 不可辨识，显式拒绝。"""
        torque, dt, temp = _gen_truth([20.0] * 60)
        with self.assertRaises(ValueError):
            calibrate(torque, dt, temp, AMBIENT)

    def test_rejects_insufficient_samples(self):
        torque, dt, temp = _gen_truth([30.0] * 5 + [5.0] * 5)
        with self.assertRaises(ValueError):
            calibrate(torque, dt, temp, AMBIENT)

    def test_rejects_non_physical_solution(self):
        """温度只降不升（与力矩正相关的模型矛盾）→ 非物理解显式拒绝。"""
        n = 40
        torque = [30.0, 5.0] * (n // 2)
        dt = [1.0] * n
        temp = [AMBIENT + 30.0 - i * 0.5 for i in range(n)]  # 单调下降
        with self.assertRaises(ValueError):
            calibrate(torque, dt, temp, AMBIENT)

    def test_nan_free_guarantee(self):
        """正常数据下辨识结果必须有限（NaN 参数会静默解除热规则武装）。"""
        pattern = [25.0] * 30 + [3.0] * 20 + [32.0] * 30
        torque, dt, temp = _gen_truth(pattern)
        result = calibrate(torque, dt, temp, AMBIENT)
        self.assertTrue(math.isfinite(result.k_heat))
        self.assertTrue(math.isfinite(result.tau_cool_sec))


if __name__ == "__main__":
    unittest.main()
